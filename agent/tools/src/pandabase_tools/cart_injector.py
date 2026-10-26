"""Saturday cart build (DESIGN §6, PRD §4.1): price checks, tier-1 injection, cart result.

Tier 1 opens `https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=…&Quantity.1=…` (batched per
vendor), checks which ASINs the confirm page offers, clicks the single confirm control and looks
for an "added" signal. Lines it can't do this way — no ASIN, a vendor not enabled for tier 1, an
ASIN the page didn't offer, an unrecognized page — come back as `needs_agent` for the skill's
tier-2 fallback (OpenClaw browser tool). Errors are `failed`. Nothing here goes near checkout
(`guard`), and a build resumes from its state file instead of adding lines to the cart twice.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
from collections.abc import Callable, Iterable
from contextlib import AbstractContextManager
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlencode, urlsplit

from . import contracts as c
from . import dom, guard
from .api import ApiClient
from .browser import Driver, NotSignedIn, Snapshot
from .config import CartConfig
from .telemetry import Telemetry

ADD_URL = "https://www.amazon.com/gp/aws/cart/add.html"
PRODUCT_URL = "https://www.amazon.com/dp/{asin}"

ADDED_TEXT = re.compile(r"\badded to (?:your )?(?:cart|basket)\b|\b(?:item|items) added\b", re.I)
UNAVAILABLE_TEXT = re.compile(
    r"\b(?:currently unavailable|not available|unavailable|out of stock|cannot be added)\b", re.I
)
PRICE_TEXT = re.compile(r"\$\s?(\d{1,4}(?:,\d{3})*)(?:\.(\d{2}))?")

Outcome = Literal["added", "needs_agent", "failed"]


@dataclass
class LineOutcome:
    index: int
    name: str
    quantity: float
    item_id: str | None
    product_id: str | None
    asin: str | None
    vendor: str | None
    free_text: str | None
    outcome: Outcome
    reason: str | None = None
    reason_text: str | None = None


@dataclass
class InjectResult:
    added: list[LineOutcome] = field(default_factory=list)
    needs_agent: list[LineOutcome] = field(default_factory=list)
    failed: list[LineOutcome] = field(default_factory=list)

    def put(self, line: LineOutcome) -> None:
        getattr(self, line.outcome).append(line)

    def lines(self) -> list[LineOutcome]:
        return sorted([*self.added, *self.needs_agent, *self.failed], key=lambda x: x.index)

    def as_json(self) -> dict[str, list[dict[str, Any]]]:
        return {
            k: [asdict(x) for x in getattr(self, k)] for k in ("added", "needs_agent", "failed")
        }


def purchase_qty(quantity: float) -> int:
    """Whole purchase units for the add URL (plan quantities may be fractional)."""
    return max(1, math.ceil(quantity - 1e-9))


def add_url(items: Iterable[tuple[str, int]]) -> str:
    params: list[tuple[str, str]] = []
    for n, (asin, qty) in enumerate(items, start=1):
        params += [(f"ASIN.{n}", asin), (f"Quantity.{n}", str(qty))]
    if not params:
        raise ValueError("no items")
    return guard.check_url(ADD_URL + "?" + urlencode(params))


def outcome_for(line: c.CartLine, index: int, outcome: Outcome, reason: str | None) -> LineOutcome:
    product = line.product
    return LineOutcome(
        index=index,
        name=line.name,
        quantity=line.quantity,
        item_id=line.item_id,
        product_id=product.id if product else None,
        asin=product.asin if product else None,
        vendor=product.vendor if product else None,
        free_text=line.free_text,
        outcome=outcome,
        reason=reason,
        reason_text=line.reason_text,
    )


def tier1_vendors(cfg: CartConfig) -> set[str]:
    vendors = set(cfg.tier1_vendors)
    if cfg.wholefoods_tier1:
        vendors.add("wholefoods")
    return vendors


def plan(cart: c.CartResponse, cfg: CartConfig) -> tuple[list[LineOutcome], list[LineOutcome]]:
    """Split cart lines into tier-1 candidates and lines that go straight to the agent."""
    tier1: list[LineOutcome] = []
    agent: list[LineOutcome] = []
    vendors = tier1_vendors(cfg)
    for i, line in enumerate(cart.lines):
        p = line.product
        if p is None:
            agent.append(outcome_for(line, i, "needs_agent", "no_product"))
        elif not p.asin:
            agent.append(outcome_for(line, i, "needs_agent", "no_asin"))
        elif p.vendor not in vendors:
            agent.append(outcome_for(line, i, "needs_agent", f"vendor_not_tier1:{p.vendor}"))
        else:
            tier1.append(outcome_for(line, i, "added", None))
    return tier1, agent


def batches(lines: list[LineOutcome], size: int) -> list[list[LineOutcome]]:
    """Per-vendor batches (a Whole Foods ASIN and an Amazon ASIN never share one add URL)."""
    by_vendor: dict[str, list[LineOutcome]] = {}
    for line in lines:
        by_vendor.setdefault(line.vendor or "", []).append(line)
    out: list[list[LineOutcome]] = []
    for group in by_vendor.values():
        out += [group[i : i + size] for i in range(0, len(group), size)]
    return out


@dataclass(frozen=True)
class AddPage:
    kind: Literal["confirm", "added", "layout_changed"]
    offered: frozenset[str]


def _add_forms(root: dom.Node) -> list[dom.Node]:
    return [f for f in root.find_all("form") if "/cart/add" in f.attrs.get("action", "")]


def _has_submit(form: dom.Node) -> bool:
    return any(
        n.tag == "button" or (n.tag == "input" and n.attrs.get("type", "").lower() == "submit")
        for n in form.iter()
    )


def analyze_add_page(snapshot: Snapshot) -> AddPage:
    """What an add-to-cart page offers. Keys off the form action, `ASIN.n` inputs and text."""
    root = dom.parse(snapshot.html)
    forms = [f for f in _add_forms(root) if _has_submit(f)]
    if forms:
        offered: set[str] = set()
        for form in forms:
            inputs = [
                n
                for n in form.find_all("input")
                if re.fullmatch(r"ASIN\.\d+", n.attrs.get("name", "")) and n.attrs.get("value")
            ]
            asins = {n.attrs["value"] for n in inputs} or dom.asins_in(form)
            for asin in asins:
                if not _unavailable(form, asin):
                    offered.add(asin)
        return AddPage("confirm", frozenset(offered))
    if ADDED_TEXT.search(root.text()):
        return AddPage("added", frozenset())
    return AddPage("layout_changed", frozenset())


def _unavailable(form: dom.Node, asin: str) -> bool:
    """Is this ASIN's own block (widest ancestor mentioning only it) marked unavailable?"""
    anchors = [a for x, a in dom.asin_links(form) if x == asin]
    inputs = [n for n in form.find_all("input") if n.attrs.get("value") == asin]
    for start in anchors + inputs:
        block = dom.widest_ancestor(start, lambda n: dom.asins_in(n) <= {asin} and n is not form)
        if UNAVAILABLE_TEXT.search(block.text()):
            return True
    return False


def is_added(snapshot: Snapshot) -> bool:
    """After the confirm click: an "added" message, or a cart page without another add form."""
    root = dom.parse(snapshot.html)
    if ADDED_TEXT.search(root.text()):
        return True
    path = urlsplit(snapshot.url).path
    return "/cart" in path and "/cart/add" not in path and not _add_forms(root)


def inject(
    driver: Driver,
    lines: list[LineOutcome],
    cfg: CartConfig,
    tel: Telemetry,
    sleep: Callable[[float], None] = time.sleep,
) -> InjectResult:
    result = InjectResult()
    for n, batch in enumerate(batches(lines, cfg.batch_size)):
        if n:
            sleep(cfg.page_delay_seconds)
        for line in _inject_batch(driver, batch, tel):
            tel.emit(
                "cart_tier1_line",
                asin=line.asin,
                item_id=line.item_id,
                product_id=line.product_id,
                vendor=line.vendor,
                outcome=line.outcome,
                error=line.reason,
            )
            result.put(line)
    return result


def _set(lines: list[LineOutcome], outcome: Outcome, reason: str | None) -> list[LineOutcome]:
    for line in lines:
        line.outcome, line.reason = outcome, reason
    return lines


def _inject_batch(driver: Driver, batch: list[LineOutcome], tel: Telemetry) -> list[LineOutcome]:
    url = add_url((line.asin or "", purchase_qty(line.quantity)) for line in batch)
    try:
        page = analyze_add_page(driver.open(url))
        if page.kind == "added":  # this layout adds on open, without a confirm step
            return _set(batch, "added", None)
        if page.kind == "layout_changed":
            tel.emit("selector_error", selector="cart_add_form", error="layout_changed", page=url)
            return _set(batch, "needs_agent", "layout_changed")
        offered = [x for x in batch if x.asin in page.offered]
        missing = [x for x in batch if x.asin not in page.offered]
        _set(missing, "needs_agent", "not_offered")
        if not offered:
            return batch
        after = driver.click_confirm()
        if after is None:
            tel.emit("selector_error", selector="cart_add_confirm", error="not_found", page=url)
            _set(offered, "needs_agent", "confirm_not_found")
        elif is_added(after):
            _set(offered, "added", None)
        else:
            tel.emit("selector_error", selector="cart_add_result", error="unverified", page=url)
            _set(offered, "needs_agent", "unverified")
        return batch
    except NotSignedIn:
        return _set(batch, "failed", "not_signed_in")
    except guard.UnsafeUrl as err:
        return _set(batch, "failed", f"refused_{err.reason}")
    except Exception as err:
        tel.emit("selector_error", selector="cart_add", error=type(err).__name__, page=url)
        return _set(batch, "failed", f"{type(err).__name__}: {err}"[:200])


# Price checks ---------------------------------------------------------------------------------


def _cents(text: str) -> int | None:
    m = PRICE_TEXT.search(text)
    if not m:
        try:
            value = float(text.strip().replace(",", ""))
        except ValueError:
            return None
        return round(value * 100) if value > 0 else None
    dollars = int(m.group(1).replace(",", ""))
    return dollars * 100 + int(m.group(2) or 0)


def _jsonld_prices(root: dom.Node) -> Iterable[Any]:
    for script in root.find_all("script"):
        if script.attrs.get("type", "").lower() != "application/ld+json":
            continue
        raw = "".join(ch for ch in script.children if isinstance(ch, str))
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        stack: list[Any] = [data]
        while stack:
            cur = stack.pop()
            if isinstance(cur, list):
                stack += cur
            elif isinstance(cur, dict):
                if "price" in cur and isinstance(cur["price"], str | int | float):
                    yield cur["price"]
                stack += [v for k, v in cur.items() if k in ("offers", "@graph", "itemOffered")]


def extract_price_cents(html: str) -> int | None:
    """Price of one unit on a product page: JSON-LD offer → `itemprop=price` → the price block.

    The last step is the one place we read a class name (`a-offscreen`, Amazon's screen-reader
    price) and only inside an element whose id mentions "price"; it's a fallback, not the rule.
    """
    root = dom.parse(html)
    for price in _jsonld_prices(root):
        cents = _cents(str(price))
        if cents:
            return cents
    for node in root.iter():
        if node.attrs.get("itemprop") == "price":
            cents = _cents(node.attrs.get("content") or node.text())
            if cents:
                return cents
    for node in root.iter():
        if "price" in node.attrs.get("id", "").lower():
            for inner in node.iter():
                if "a-offscreen" in inner.attrs.get("class", "").split():
                    cents = _cents(inner.text())
                    if cents:
                        return cents
    return None


def price_checks(
    driver: Driver,
    preds: c.PredictionsResponse,
    cfg: CartConfig,
    tel: Telemetry,
    sleep: Callable[[float], None] = time.sleep,
) -> list[c.Quote]:
    """Observe prices for every candidate of the lines that need a price check."""
    wanted = set(preds.needs_price_check_item_ids)
    seen: set[str] = set()
    quotes: list[c.Quote] = []
    opened = 0
    for line in preds.lines:
        if line.item_id not in wanted:
            continue
        for cand in line.candidates:
            if cand.id in seen or cand.stance == "rejected":
                continue
            seen.add(cand.id)
            if not cand.asin:  # nothing to open: doesn't count against the page budget
                tel.emit("price_lookup_failed", product_id=cand.id, error="no_asin")
                continue
            if opened >= cfg.max_price_checks:
                return quotes
            if opened:
                sleep(cfg.page_delay_seconds)
            opened += 1
            try:
                snap = driver.open(guard.check_url(PRODUCT_URL.format(asin=cand.asin)))
                cents = extract_price_cents(snap.html)
            except (NotSignedIn, guard.UnsafeUrl) as err:
                tel.emit("price_lookup_failed", asin=cand.asin, product_id=cand.id, error=str(err))
                continue
            except Exception as err:
                tel.emit(
                    "price_lookup_failed",
                    asin=cand.asin,
                    product_id=cand.id,
                    error=type(err).__name__,
                )
                continue
            if cents is None:
                tel.emit(
                    "price_lookup_failed", asin=cand.asin, product_id=cand.id, error="no_price"
                )
                continue
            quotes.append(
                c.Quote(product_id=cand.id, price_cents=cents, observed_at=datetime.now(UTC))
            )
    return quotes


# Cart result & build state -------------------------------------------------------------------


def result_request(
    lines: list[LineOutcome], tier2: dict[int, Literal["tier2", "failed"]]
) -> c.CartResultRequest:
    """`needs_agent` lines take the agent's outcome; any it didn't report count as failed."""
    out: list[c.CartResultLine] = []
    vendors: set[str] = set()
    for line in lines:
        api_outcome: Literal["tier1", "tier2", "failed"]
        if line.outcome == "needs_agent":
            api_outcome = tier2.get(line.index, "failed")
            error = None if api_outcome == "tier2" else (line.reason or "not added")
        else:
            api_outcome = "tier1" if line.outcome == "added" else "failed"
            error = line.reason if line.outcome == "failed" else None
        if api_outcome != "failed" and line.vendor:
            vendors.add(line.vendor)
        out.append(
            c.CartResultLine(
                item_id=line.item_id,
                product_id=line.product_id,
                asin=line.asin,
                free_text=line.free_text,
                quantity=line.quantity if line.quantity > 0 else 1,
                outcome=api_outcome,
                error=error,
            )
        )
    return c.CartResultRequest(lines=out, vendors=sorted(vendors))


class BuildState:
    """`cart-{cycle_id}.json`: line outcomes so far. Lines once `added` are never re-injected."""

    def __init__(self, state_dir: Path, cycle_id: str) -> None:
        self.path = state_dir / f"cart-{cycle_id}.json"

    def load(self) -> dict[str, Any] | None:
        try:
            data = json.loads(self.path.read_text())
        except FileNotFoundError:
            return None
        return data if isinstance(data, dict) else None

    def save(self, result: InjectResult, *, posted: bool) -> None:
        self.path.write_text(
            json.dumps(
                {"lines": [asdict(x) for x in result.lines()], "result_posted": posted}, indent=1
            )
        )

    def lines(self) -> list[LineOutcome]:
        data = self.load() or {}
        return [LineOutcome(**x) for x in data.get("lines", [])]


def _line_key(line: LineOutcome) -> tuple[str | None, str | None, str | None]:
    return (line.item_id, line.product_id, line.free_text)


def build(
    api: ApiClient,
    open_driver: Callable[[], AbstractContextManager[Driver]],
    cfg: CartConfig,
    cycle_id: str,
    state: BuildState,
    tel: Telemetry,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """open → building → price checks → cart → tier 1 → cart-result (when nothing needs the agent).

    Re-running after a crash resumes: a `building` cycle isn't re-transitioned, and lines the
    state file records as added are not added again. A `ready` cycle is left alone.
    """
    current = api.call("GET", "/api/grocery/cycle/current")
    assert isinstance(current, c.CycleCurrentResponse)
    cycle = current.cycle
    if cycle is None or cycle.id != cycle_id:
        return {"cycle_id": cycle_id, "status": "not_current", "result_posted": False}
    if cycle.status == "ready":
        return {"cycle_id": cycle_id, "status": "already_built", "result_posted": True}
    if cycle.status == "open":
        moved = api.cycle_status(cycle_id, "building", key=f"build:{cycle_id}")
        if moved.cycle.status != "building":  # away on the build date → skipped
            return {"cycle_id": cycle_id, "status": moved.cycle.status, "result_posted": False}
    elif cycle.status != "building":
        return {"cycle_id": cycle_id, "status": cycle.status, "result_posted": False}

    done = {_line_key(x) for x in state.lines() if x.outcome == "added"}
    preds = api.predictions(cycle_id)
    with open_driver() as driver:
        quotes = price_checks(driver, preds, cfg, tel, sleep)
        accepted = 0
        if quotes:
            accepted = api.price_quotes(
                c.PriceQuotesRequest(cycle_id=cycle_id, quotes=quotes),
                key=f"quotes:{cycle_id}:{_digest([q.model_dump(mode='json') for q in quotes])}",
            )
        cart = api.cart(cycle_id)
        tier1, agent = plan(cart, cfg)
        resumed = [x for x in tier1 if _line_key(x) in done]
        todo = [x for x in tier1 if _line_key(x) not in done]
        result = inject(driver, todo, cfg, tel, sleep)
    for line in _set(resumed, "added", "resumed") + agent:
        result.put(line)
    posted = False
    if not result.needs_agent:
        api.cart_result(cycle_id, result_request(result.lines(), {}), key=f"cart:{cycle_id}")
        posted = True
    state.save(result, posted=posted)
    return {
        "cycle_id": cycle_id,
        "status": "ready" if posted else "needs_agent",
        "quotes_accepted": accepted,
        "result_posted": posted,
        **result.as_json(),
    }


def finish(
    api: ApiClient,
    cycle_id: str,
    state: BuildState,
    tier2: dict[int, Literal["tier2", "failed"]],
    order_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Post the cart result once the agent has handled the `needs_agent` lines."""
    lines = state.lines()
    if not lines:
        raise ValueError(f"no build state for cycle {cycle_id}: run `cart build` first")
    body = result_request(lines, tier2)
    if order_ids:
        body.order_ids = order_ids
    payload = body.model_dump(mode="json", exclude_unset=True)
    res = api.cart_result(cycle_id, body, key=f"cart:{cycle_id}:{_digest(payload)}")
    data = state.load() or {}
    data["result_posted"] = True
    data["tier2"] = {str(k): v for k, v in tier2.items()}
    state.path.write_text(json.dumps(data, indent=1))
    counts: dict[str, int] = {}
    for line in body.lines:
        counts[line.outcome] = counts.get(line.outcome, 0) + 1
    return {"cycle_id": cycle_id, "status": res.cycle.status, "counts": counts}


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:16]
