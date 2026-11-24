"""Digital receipts from Amazon / Whole Foods order history (DESIGN §6, PRD §4.2).

Two phases, both resumable from a per-member state file:

1. **Collect** — walk the order-history list newest-first until orders are older than the
   window (sweep: cursor date minus a lookback; backfill: 12 months), recording each order's id,
   date and status.
2. **Process** — oldest first (late receipts skip the EMA update, so order matters), open each
   final-state order (Delivered / Picked up / in-store), extract lines from its `/dp/` and
   `/gp/product/` links and the text around them, and ingest it. Orders still in flight are
   left for the next sweep; cancelled ones are skipped. A details page with zero ASINs is
   returned as `needs_agent_extraction` (page text) for the skill, and logged.

Re-ingesting is harmless (the API dedupes on `external_order_id`), so the window overlaps the
cursor on purpose; the state file's `done` set just avoids reopening pages.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import re
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, cast
from zoneinfo import ZoneInfo

from . import contracts as c
from . import dom, guard
from .api import ApiClient, ApiError
from .browser import Challenged, Driver, NotSignedIn, Snapshot
from .config import Member, ReceiptsConfig
from .telemetry import Telemetry

Status = Literal["final", "pending", "cancelled", "returned", "unknown"]
Fulfillment = Literal["delivery", "pickup", "in_store", "unknown"]

MONTHS = {
    m: i
    for i, names in enumerate(
        [
            ("jan", "january"),
            ("feb", "february"),
            ("mar", "march"),
            ("apr", "april"),
            ("may",),
            ("jun", "june"),
            ("jul", "july"),
            ("aug", "august"),
            ("sep", "sept", "september"),
            ("oct", "october"),
            ("nov", "november"),
            ("dec", "december"),
        ],
        start=1,
    )
    for m in names
}
DATE = r"(?:[A-Za-z]+day,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?"
ORDER_ID_PARAM = re.compile(r"[?&]order(?:ID|Id|id)=([A-Za-z0-9-]{6,40})")

# Not after "not be" / "can't be": live Whole Foods pickups say "Your order could not be cancelled"
# (2026-11-08), which made every picked-up order read as cancelled.
CANCELLED = re.compile(
    r"(?<!not be )(?<!can't be )(?<!can\u2019t be )(?<!cannot be )\bcancell?ed\b", re.I
)
# Live Whole Foods in-store purchases (2026-11-08) say only "Purchased at <store>" and
# "Purchased on <date>", each on its own line.
IN_STORE = re.compile(
    r"\b(?:purchased|bought|shopped) in[- ]store\b|\bin[- ]store (?:purchase|order)\b"
    r"|^\s*purchased (?:at|on)\b",
    re.I | re.M,
)
FINAL = re.compile(r"\b(?:delivered|picked up)\b", re.I)
PENDING = re.compile(
    r"\b(?:arriving|shipped|out for delivery|ready for pickup|preparing|not yet shipped|on the way"
    r"|order received|scheduled|in transit)\b",
    re.I,
)
STATUS_DATE = re.compile(
    r"\b(?:delivered|picked up|(?:purchased|bought) in[- ]store|purchased)\s*:?\s*(?:on\s+)?"
    + DATE,
    re.I,
)
ORDER_DATE = re.compile(
    r"\b(?:order placed|ordered(?: on)?|order date|placed on|purchased on)\s*:?\s*" + DATE, re.I
)
QTY = re.compile(r"\b(?:qty|quantity)\s*:?\s*(\d+(?:\.\d+)?)\b", re.I)
QTY_PREFIX = re.compile(r"^\s*(\d{1,3})\s*(?:of|x|\u00d7)\s", re.I)
PRICE = re.compile(r"\$\s?(\d{1,5}(?:,\d{3})*)\.(\d{2})")
GRAND_TOTAL = re.compile(
    r"\b(?:grand total|order total|total charged|total)\s*:?\s*\$\s?([\d,]+)\.(\d{2})", re.I
)
REFUND_TOTAL = re.compile(r"\brefund total\s*:?\s*\$\s?([\d,]+)\.(\d{2})", re.I)
SUBTOTAL = re.compile(r"\bitem\(?s\)?\s*subtotal\s*:?\s*\$\s?([\d,]+)\.(\d{2})", re.I)
NOT_ORDER_ITEMS = re.compile(
    r"\b(?:recommended|customers (?:who|also)|sponsored|inspired by|frequently bought|you might)\b",
    re.I,
)


def parse_date(match: re.Match[str] | None, default_year: int) -> date | None:
    if not match:
        return None
    month = MONTHS.get(match.group(1).lower())
    if not month:
        return None
    year = int(match.group(3)) if match.group(3) else default_year
    try:
        return date(year, month, int(match.group(2)))
    except ValueError:
        return None


def order_status(text: str) -> Status:
    if CANCELLED.search(text):
        return "cancelled"
    if IN_STORE.search(text) or FINAL.search(text):
        return "final"
    if PENDING.search(text):
        return "pending"
    return "unknown"


def _cents(m: re.Match[str] | None) -> int | None:
    return int(m.group(1).replace(",", "")) * 100 + int(m.group(2)) if m else None


def _only(ids: Callable[[dom.Node], set[str]], one: str) -> Callable[[dom.Node], bool]:
    """Predicate for `widest_ancestor`: the node mentions no id other than `one`."""
    return lambda n: ids(n) <= {one}


# Order list -----------------------------------------------------------------------------------


@dataclass
class OrderSummary:
    order_id: str
    ordered_on: str | None  # YYYY-MM-DD
    status: Status
    details_url: str


def _order_ids_in(node: dom.Node) -> set[str]:
    out: set[str] = set()
    for a in node.find_all("a"):
        m = ORDER_ID_PARAM.search(a.attrs.get("href", ""))
        if m:
            out.add(m.group(1))
    return out


def parse_order_list(snap: Snapshot, today: date) -> tuple[list[OrderSummary], str | None]:
    """Orders on one history page (by `orderID=` links) and the next page's URL."""
    root = dom.parse(snap.html)
    orders: dict[str, OrderSummary] = {}
    for a in root.find_all("a"):
        href = a.attrs.get("href", "")
        m = ORDER_ID_PARAM.search(href)
        if not m or m.group(1) in orders:
            continue
        oid = m.group(1)
        card = dom.widest_ancestor(a, _only(_order_ids_in, oid))
        text = card.text()
        ordered = parse_date(ORDER_DATE.search(text), today.year)
        if ordered and ordered > today:
            ordered = ordered.replace(year=ordered.year - 1)
        details = next(
            (
                dom.absolute(snap.url, x.attrs.get("href", ""))
                for x in card.find_all("a")
                if "order-details" in x.attrs.get("href", "")
                and ORDER_ID_PARAM.search(x.attrs.get("href", ""))
            ),
            None,
        )
        orders[oid] = OrderSummary(
            order_id=oid,
            ordered_on=ordered.isoformat() if ordered else None,
            status=order_status(text),
            details_url=details or "",
        )
    next_url = None
    for a in root.find_all("a"):
        if re.match(r"^\s*next\b", a.text(), re.I) and a.attrs.get("href"):
            next_url = dom.absolute(snap.url, a.attrs["href"])
            break
    return list(orders.values()), next_url


# Order details --------------------------------------------------------------------------------


@dataclass
class ParsedOrder:
    order_id: str
    status: Status
    fulfillment: Fulfillment
    vendor: str
    ordered_on: date | None
    acquired_on: date | None
    lines: list[c.ReceiptLineIn]
    subtotal_cents: int | None
    total_cents: int | None
    text: str


# Amazon's page chrome — the header (`#navbar`, `#nav-…`: search box, store links, the
# delivery-location badge) and footer (`#navFooter`, `#rhf`) — wraps every page and names
# "Whole Foods Market" and links products ("Amazon Business Card"). Live, 2026-11-08: with no
# `<main>` on real order pages, every order read as Whole Foods (the location badge was a Whole
# Foods store) and the footer card link was "bought" on every order.
CHROME_IDS = re.compile(r"^(?:navbar|navFooter|nav-|rhf|skiplink)")


def strip_chrome(root: dom.Node) -> dom.Node:
    """Drop the page header/footer (`header`/`footer`/`nav` elements, `CHROME_IDS`) in place."""
    for node in list(root.iter()):
        chrome = node.tag in ("header", "footer", "nav") or CHROME_IDS.match(
            node.attrs.get("id", "")
        )
        if chrome and node.parent is not None and node in node.parent.children:
            node.parent.children.remove(node)
    return root


def _item_scope(root: dom.Node) -> dom.Node:
    mains = root.find_all("main")
    return mains[0] if mains else root


def _in_recommendations(node: dom.Node) -> bool:
    """Inside a carousel/section headed "Recommended…", "Customers also…" etc.?"""
    for anc in node.ancestors():
        for child in anc.children:
            heading = isinstance(child, dom.Node) and child.tag in ("h1", "h2", "h3", "h4")
            if heading and NOT_ORDER_ITEMS.search(cast(dom.Node, child).text()):
                return True
    return False


# The live Whole Foods item grid (2026-11): one `{ASIN}-item-grid-row` per item with Quantity |
# Weight | Total cells, the charged total in `{ASIN}-item-total-price`, and a status box
# ("Weight adjusted from est. 1.00 lb", "Out of stock (1) -$5.99", "Refunded (1) -$8.49").
GRID_QTY = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(lb|lbs|oz)?\s*$", re.I)
GRID_UNSUPPLIED = re.compile(
    r"\b(out of stock|refunded)\s*\((\d+)\)\s*-\s*\$\s?([\d,]+)\.(\d{2})", re.I
)


@dataclass
class GridLines:
    lines: list[c.ReceiptLineIn]
    refunded_cents: int  # in the page's Item(s) Subtotal, but not received


def _by_id(root: dom.Node, node_id: str) -> dom.Node | None:
    return next((n for n in root.iter() if n.attrs.get("id") == node_id), None)


def _grid_qty(row: dom.Node, weight_cell: dom.Node) -> float | None:
    """The Quantity cell: the gridcell just before the one holding the weight."""
    cells = [n for n in row.iter() if n.attrs.get("role") == "gridcell"]
    for prev, cell in itertools.pairwise(cells):
        if cell is weight_cell or weight_cell in cell.iter():
            m = GRID_QTY.match(prev.text())
            return float(m.group(1)) if m else None
    return None


def extract_grid_lines(scope: dom.Node) -> GridLines | None:
    """Lines from the item grid, or None when the page has none (older layouts). Each line is
    what was charged: a weighed item's total (not its per-lb price), a quantity that is the weight
    when the item was ordered by weight, out-of-stock units left out (the subtotal leaves them
    out too) and refunded units left out (the subtotal counts them: `refunded_cents`)."""
    rows = [n for n in scope.iter() if n.attrs.get("id", "").endswith("-item-grid-row")]
    out: list[c.ReceiptLineIn] = []
    refunded = 0
    found = False
    for row in rows:
        asin = row.attrs["id"].removesuffix("-item-grid-row")
        total_el = _by_id(row, f"{asin}-item-total-price")
        weight_el = _by_id(row, f"{asin}-item-priced-by-quantity")
        if total_el is None or weight_el is None:
            continue
        found = True
        weight_cell = next(
            (a for a in weight_el.ancestors() if a.attrs.get("role") == "gridcell"), weight_el
        )
        qty = _grid_qty(row, weight_cell)
        total = _cents(PRICE.search(total_el.text()))
        titles = [t for x, a in dom.asin_links(row) if x == asin and (t := a.text().strip())]
        if qty is None or total is None or not titles:
            continue
        title = max(titles, key=len)
        for m in GRID_UNSUPPLIED.finditer(row.text()):
            units = float(m.group(2))
            amount = int(m.group(3).replace(",", "")) * 100 + int(m.group(4))
            if m.group(1).lower() == "refunded":
                refunded += min(amount, total)
            qty, total = qty - units, max(0, total - amount)
        if qty <= 0 or total <= 0:
            continue
        out.append(
            c.ReceiptLineIn(
                asin=asin,
                raw_text=title[:300],
                title=title[:300],
                qty=qty,
                unit_price_cents=round(total / qty),
                line_total_cents=total,
            )
        )
    return GridLines(out, refunded) if found else None


# Amazon's order page (2026-11) lays items out by `data-component`: one `purchasedItems` per item
# with `itemImage` (an /dp/ link, then a bare-integer badge: the quantity), `itemTitle`, `quantity`
# (empty on the page, "Quantity: 2" on some) and `unitPrice` (the price twice: an offscreen copy and
# an aria-hidden one). The order summary comes before the items. Select by these names only: class
# names are random.
BARE_QTY = re.compile(r"^\s*(\d{1,3})\s*$")


def _components(root: dom.Node, name: str) -> list[dom.Node]:
    return [n for n in root.iter() if n.attrs.get("data-component") == name]


def _component_qty(block: dom.Node) -> float:
    for q in _components(block, "quantity"):
        m = QTY.search(q.text()) or BARE_QTY.match(q.text())
        if m:
            return float(m.group(1))
    for image in _components(block, "itemImage"):
        for n in image.iter():
            m = BARE_QTY.match(n.text()) if n.tag != "a" else None
            if m and not any(isinstance(ch, dom.Node) for ch in n.children):
                return float(m.group(1))
    return 1.0


def extract_component_lines(scope: dom.Node) -> list[c.ReceiptLineIn] | None:
    """One line per `purchasedItems` block (unit price x quantity), or None when the page has no
    such blocks (older layouts). The same ASIN in two blocks (two shipments) is one line."""
    blocks = [b for b in _components(scope, "purchasedItems") if not _in_recommendations(b)]
    if not blocks:
        return None
    seen: dict[str, c.ReceiptLineIn] = {}
    for block in blocks:
        links = [(x, a) for x, a in dom.asin_links(block) if a.text().strip()]
        if not links:
            continue
        asin = links[0][0]
        title = max((a.text().strip() for x, a in links if x == asin), key=len)
        price_el = next(iter(_components(block, "unitPrice")), None)
        if price_el is not None:
            price = _cents(PRICE.search(price_el.text()))
        else:  # no unit price: the old per-block rule, never wider than the block
            price = _cents(PRICE.search(block.text()))
        qty = _component_qty(block)
        prev = seen.get(asin)
        if prev is not None:
            qty += prev.qty
            price = price if price is not None else prev.unit_price_cents
        seen[asin] = c.ReceiptLineIn(
            asin=asin,
            raw_text=title[:300],
            title=title[:300],
            qty=qty,
            unit_price_cents=price,
            line_total_cents=round(price * qty) if price is not None else None,
        )
    return list(seen.values())


def extract_lines(root: dom.Node) -> list[c.ReceiptLineIn]:
    scope = _item_scope(root)
    seen: dict[str, c.ReceiptLineIn] = {}
    for asin, a in dom.asin_links(scope):
        if asin in seen or _in_recommendations(a):
            continue
        block = dom.widest_ancestor(a, _only(dom.asins_in, asin))
        text = block.text()
        titles = [
            t for x, link in dom.asin_links(block) if x == asin and (t := link.text().strip())
        ]
        title = max(titles, key=len) if titles else (text.splitlines() or [asin])[0]
        title = QTY_PREFIX.sub("", title).strip() or asin
        qty_match = QTY.search(text) or QTY_PREFIX.search(text)
        qty = float(qty_match.group(1)) if qty_match else 1.0
        price = _cents(PRICE.search(text))
        seen[asin] = c.ReceiptLineIn(
            asin=asin,
            raw_text=title[:300],
            title=title[:300],
            qty=qty if qty > 0 else 1.0,
            unit_price_cents=price,
            line_total_cents=round(price * qty) if price is not None else None,
        )
    return list(seen.values())


def parse_order_details(
    snap: Snapshot, order_id: str, today: date, *, assume_final_after_days: int | None = None
) -> ParsedOrder:
    """`assume_final_after_days`: an order with no status wording at all (live Whole Foods pickups
    never say "picked up" once they're old) that was placed at least this many days ago is final,
    acquired on its order date. `None` assumes nothing."""
    root = strip_chrome(dom.parse(snap.html))
    text = root.text()
    ordered = parse_date(ORDER_DATE.search(text), today.year)
    acquired = parse_date(STATUS_DATE.search(text), (ordered or today).year)
    if acquired and ordered and acquired < ordered:  # "Delivered Jan 2" for a Dec 30 order
        acquired = acquired.replace(year=acquired.year + 1)
    total = _cents(GRAND_TOTAL.search(text))
    refund = _cents(REFUND_TOTAL.search(text))
    grid = extract_grid_lines(_item_scope(root))
    components = None if grid is not None else extract_component_lines(_item_scope(root))
    subtotal = _cents(SUBTOTAL.search(text))
    if grid is not None and subtotal is not None:
        subtotal -= grid.refunded_cents
    status = order_status(text)
    if status != "cancelled" and refund is not None and total and refund >= total:
        status = "returned"  # refunded in full: nothing to stock
    elif (
        status == "unknown"
        and assume_final_after_days is not None
        and ordered is not None
        and (today - ordered).days >= assume_final_after_days
    ):
        status = "final"
        acquired = acquired or ordered
    if IN_STORE.search(text):
        fulfillment: Fulfillment = "in_store"
    elif re.search(r"\bpick(?:ed)?[- ]?up\b", text, re.I):
        fulfillment = "pickup"
    elif re.search(r"\bdeliver(?:ed|y)\b", text, re.I):
        fulfillment = "delivery"
    else:
        fulfillment = "unknown"
    return ParsedOrder(
        order_id=order_id,
        status=status,
        fulfillment=fulfillment,
        vendor="wholefoods" if re.search(r"whole\s*foods", text, re.I) else "amazon",
        ordered_on=ordered,
        acquired_on=acquired or (ordered if IN_STORE.search(text) else None),
        lines=grid.lines if grid is not None else components or extract_lines(root),
        subtotal_cents=subtotal,
        total_cents=total,
        text=text,
    )


def local_noon(day: date, tz: str) -> datetime:
    return datetime(day.year, day.month, day.day, 12, tzinfo=ZoneInfo(tz)).astimezone(UTC)


def ingest_request(order: ParsedOrder, member: Member, tz: str) -> c.ReceiptIngestRequest:
    acquired = order.acquired_on or order.ordered_on
    if acquired is None:
        raise ValueError(f"order {order.order_id}: no date found")
    body: dict[str, Any] = {
        "source": "digital",
        "vendor": order.vendor,
        "account": member.discord_id,
        "actor_discord_id": member.discord_id,
        "external_order_id": order.order_id,
        "fulfillment": order.fulfillment,
        "acquired_at": local_noon(acquired, tz),
        "lines": order.lines,
    }
    if order.ordered_on:
        body["ordered_at"] = local_noon(order.ordered_on, tz)
    if order.subtotal_cents is not None:
        body["subtotal_cents"] = order.subtotal_cents
    if order.total_cents is not None:
        body["total_cents"] = order.total_cents
    return c.ReceiptIngestRequest(**body)


def ingest_key(discord_id: str, order_id: str, body: c.ReceiptIngestRequest) -> str:
    """The ingest `Idempotency-Key`: `receipt:{discord id}:{body hash}:{order id}`. The request's
    hash is in it so a changed read (a fixed parser re-reading a failing order) is never answered
    with the stored reply of an earlier read for 24 h: the State Engine replaces the order with it
    (DESIGN §4.5 *Re-read orders*), and the same read again stays idempotent. `db:reset-imports`
    reads the order id after the last colon."""
    digest = hashlib.sha256(body.model_dump_json(exclude_none=True).encode()).hexdigest()[:12]
    return f"receipt:{discord_id}:{digest}:{order_id}"


RECHECK_DAYS = 14  # how long an order whose lines don't add up is re-read on every sweep


def prune_recheck(recheck: dict[str, str], done: dict[str, str], now: datetime) -> None:
    """Orders re-read for `RECHECK_DAYS` without adding up count as done: they were applied as
    read (DESIGN §10 #90), and re-reading them on every sweep costs a page load each. After a
    parser fix, `db:reset-imports` or removing their `done` entries brings them back."""
    for key, since in list(recheck.items()):
        if now - datetime.fromisoformat(since) > timedelta(days=RECHECK_DAYS):
            del recheck[key]
            done.setdefault(key, now.isoformat())


def load_recheck(data: dict[str, Any]) -> dict[str, str]:
    """`recheck`, plus `held` from a state file written before §10 #90 (orders the State Engine
    held: their totals didn't add up either)."""
    return {**dict(data.get("held", {})), **dict(data.get("recheck", {}))}


# Sweep / backfill -----------------------------------------------------------------------------

Mode = Literal["sweep", "backfill"]


@dataclass
class SweepState:
    """Per member: orders already ingested, plus the in-progress run (collected orders + paging)."""

    done: dict[str, str] = field(default_factory=dict)  # order_id → ingested_at
    run: dict[str, Any] | None = None
    # order_id → first read whose lines didn't add up to the subtotal (`totals_check: fail`,
    # DESIGN §4.5, §10 #90): applied as read but not done, so every sweep re-reads it for
    # `RECHECK_DAYS` and a fixed parser's read replaces the receipt
    recheck: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> SweepState:
        try:
            data = json.loads(path.read_text())
        except FileNotFoundError:
            return cls()
        return cls(done=dict(data.get("done", {})), run=data.get("run"), recheck=load_recheck(data))

    def save(self, path: Path) -> None:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"done": self.done, "run": self.run, "recheck": self.recheck}, indent=1)
        )
        tmp.replace(path)


@dataclass
class SweepResult:
    member: str
    mode: Mode
    since: str
    complete: bool = False
    pages: int = 0
    ingested: list[dict[str, Any]] = field(default_factory=list)
    duplicates: list[str] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)
    skipped: list[dict[str, str]] = field(default_factory=list)
    needs_agent_extraction: list[dict[str, Any]] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)
    # §10 #90: orders whose lines don't add up (`totals_check: fail`); re-read next time
    totals_fail: list[str] = field(default_factory=list)
    # §10 #94: in-store orders whose details page has no subtotal: printable invoices opened,
    # read instead of the details page, and failed to open (the details read is kept)
    printable_reads: int = 0
    printable_used: int = 0
    printable_failed: list[str] = field(default_factory=list)


class Sweeper:
    def __init__(
        self,
        api: ApiClient,
        driver: Driver,
        cfg: ReceiptsConfig,
        member: Member,
        tz: str,
        state_dir: Path,
        tel: Telemetry,
        *,
        today: date,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.api, self.driver, self.cfg, self.member, self.tz = api, driver, cfg, member, tz
        self.tel, self.today, self.sleep, self.now = tel, today, sleep, now
        self.path = state_dir / f"receipts-{member.name}.json"
        self.state = SweepState.load(self.path)
        self._opened = 0
        self._threads: dict[str, str | None] | None = None

    def _closed_thread(self, cycle_id: str | None) -> str | None:
        """The Discord thread of the cycle an ingest closed. Read before the first ingest: once
        the cycle is closed, `cycle/current` no longer returns it."""
        if cycle_id is None or self._threads is None:
            return None
        return self._threads.get(cycle_id)

    def _remember_cycle(self) -> None:
        if self._threads is not None:
            return
        self._threads = {}
        try:
            cycle = self.api.current_cycle()
        except ApiError:
            return  # only the closure post needs it; the sweep carries on
        if cycle is not None:
            self._threads[cycle.id] = cycle.discord_thread_id

    def _open(self, url: str) -> Snapshot:
        if self._opened:
            self.sleep(self.cfg.throttle_seconds)
        self._opened += 1
        return self.driver.open(guard.check_url(url))

    def _since(self, mode: Mode) -> date:
        if mode == "backfill":
            return self.today - timedelta(days=round(self.cfg.backfill_months * 30.44))
        cursor = self.api.receipt_cursor(self.member.discord_id)
        last = cursor.ordered_at or cursor.acquired_at
        if last is None:
            return self.today - timedelta(days=self.cfg.initial_sweep_days)
        return last.astimezone(ZoneInfo(self.tz)).date() - timedelta(
            days=self.cfg.sweep_lookback_days
        )

    def _list_urls(self, mode: Mode, since: date) -> list[str]:
        if mode == "sweep":
            return [self.cfg.order_list_url]
        years = range(self.today.year, since.year - 1, -1)
        return [u.format(year=y) for y in years for u in self.cfg.backfill_list_urls]

    def run(self, mode: Mode, *, max_orders: int | None = None) -> SweepResult:
        run = self.state.run
        # Only a backfill resumes; a sweep re-collects (cheap) so it always sees new orders.
        if not run or run.get("mode") != mode or mode == "sweep":
            since = self._since(mode)
            urls = self._list_urls(mode, since)
            run = {
                "mode": mode,
                "since": since.isoformat(),
                "urls": urls,
                "url_index": 0,
                "page_url": urls[0],
                "collected": {},
                "collect_done": False,
                "fallback": [],
            }
            self.state.run = run
        result = SweepResult(self.member.name, mode, run["since"])
        try:
            if not run["collect_done"]:
                self._collect(run, result)
            self._process(run, result, max_orders)
        except Challenged:
            result.errors.append(
                {"error": "amazon_challenge", "profile": self.member.profile_name()}
            )
        except NotSignedIn:
            result.errors.append({"error": "not_signed_in", "profile": self.member.profile_name()})
        except guard.UnsafeUrl as err:
            result.errors.append({"error": f"refused_{err.reason}", "url": err.url})
        finally:
            self.state.save(self.path)
        remaining = [
            o
            for o in run["collected"].values()
            if o["status"] in ("final", "unknown")
            and o["order_id"] not in self.state.done
            and o["order_id"] not in self.state.recheck
            and o["order_id"] not in run["fallback"]
        ]
        result.complete = bool(run["collect_done"]) and not remaining and not result.errors
        if result.complete:
            self.state.run = None
            self.state.save(self.path)
        self.tel.emit(
            "receipt_sweep",
            member=self.member.name,
            mode=mode,
            pages=result.pages,
            ingested=len(result.ingested),
            duplicates=len(result.duplicates),
            pending=len(result.pending),
            needs_agent=len(result.needs_agent_extraction),
            totals_fail=len(result.totals_fail),
            printable_reads=result.printable_reads,
            printable_used=result.printable_used,
            printable_failed=len(result.printable_failed),
            errors=len(result.errors),
            complete=result.complete,
        )
        return result

    def _collect(self, run: dict[str, Any], result: SweepResult) -> None:
        since = date.fromisoformat(run["since"])
        url: str | None = run["page_url"]
        while url and result.pages < self.cfg.max_pages:
            snap = self._open(url)
            result.pages += 1
            orders, next_url = parse_order_list(snap, self.today)
            if not orders and result.pages == 1:
                self.tel.emit(
                    "selector_error", selector="order_list", error="zero_orders", page=url
                )
            older = False
            for o in orders:
                if o.ordered_on and date.fromisoformat(o.ordered_on) < since:
                    older = True
                    continue
                run["collected"][o.order_id] = asdict(o)
            if older or not next_url:
                run["url_index"] += 1
                url = run["urls"][run["url_index"]] if run["url_index"] < len(run["urls"]) else None
            else:
                url = next_url
            run["page_url"] = url
            self.state.save(self.path)  # resumable after every page
        if url is None:
            run["collect_done"] = True

    def _process(self, run: dict[str, Any], result: SweepResult, max_orders: int | None) -> None:
        # Orders whose lines didn't add up (§10 #90) are re-read on every sweep, even once the
        # order list's window has moved past them; their details page is enough.
        prune_recheck(self.state.recheck, self.state.done, self.now())
        for oid, since in self.state.recheck.items():
            run["collected"].setdefault(
                oid,
                {"order_id": oid, "ordered_on": since[:10], "status": "final", "details_url": ""},
            )
        orders = sorted(
            run["collected"].values(), key=lambda o: (o["ordered_on"] or "9999", o["order_id"])
        )
        handled = 0
        for o in orders:
            oid = o["order_id"]
            if oid in self.state.done:
                continue
            if o["status"] in ("cancelled", "returned"):
                result.skipped.append({"order_id": oid, "reason": o["status"]})
                continue
            if o["status"] == "pending":  # in flight per the list; "unknown" gets a closer look
                result.pending.append(oid)
                continue
            if max_orders is not None and handled >= max_orders:
                return
            handled += 1
            url = o["details_url"] or self.cfg.order_details_url.format(order_id=oid)
            snap = self._open(url)
            order = parse_order_details(
                snap, oid, self.today, assume_final_after_days=self.cfg.assume_final_after_days
            )
            order = self._with_printable(order, result)
            if order.status in ("cancelled", "returned"):
                result.skipped.append({"order_id": oid, "reason": order.status})
                o["status"] = order.status
                continue
            if order.status != "final":
                result.pending.append(oid)
                o["status"] = "pending"
                continue
            o["status"] = "final"
            if not order.lines:
                self.tel.emit("selector_error", selector="asin_links", error="zero_asins", page=url)
                result.needs_agent_extraction.append(self._fallback(order, url))
                if oid not in run["fallback"]:
                    run["fallback"].append(oid)
                continue
            self._remember_cycle()
            body = ingest_request(order, self.member, self.tz)
            try:
                res = self.api.ingest_receipt(
                    body,
                    key=ingest_key(self.member.discord_id, oid, body),
                )
            except (ApiError, ValueError) as err:
                result.errors.append({"order_id": oid, "error": str(err)[:300]})
                continue
            if res.totals_check == "fail":
                # §4.5 / §10 #90: applied as read (a State Engine from before #90 answers `held`
                # and applies nothing). Not done: the next sweep reads it again, and a fixed
                # parser's read replaces the receipt.
                self.state.recheck.setdefault(oid, self.now().isoformat())
                result.totals_fail.append(oid)
            else:
                self.state.recheck.pop(oid, None)
                self.state.done[oid] = self.now().isoformat()
            self.state.save(self.path)
            if res.status == "held":
                continue
            if res.duplicate:
                result.duplicates.append(oid)
            else:
                result.ingested.append(
                    {
                        "order_id": oid,
                        "receipt_id": res.receipt_id,
                        "vendor": order.vendor,
                        "fulfillment": order.fulfillment,
                        "lines": len(order.lines),
                        "status": res.status,
                        "closed_cycle_id": res.closed_cycle_id,
                        "closed_cycle_thread_id": self._closed_thread(res.closed_cycle_id),
                    }
                )

    def _with_printable(self, order: ParsedOrder, result: SweepResult) -> ParsedOrder:
        """§10 #94: an in-store purchase's details page has no subtotal, so its lines are checked
        against nothing; the printable invoice has one. Read it, and use that read when it is final,
        has lines and has a subtotal. Any failure opening it keeps the details read."""
        if not (
            order.status == "final"
            and order.fulfillment == "in_store"
            and order.subtotal_cents is None
            and order.lines
        ):
            return order
        result.printable_reads += 1
        try:
            printed = parse_order_details(
                self._open(self.cfg.order_printable_url.format(order_id=order.order_id)),
                order.order_id,
                self.today,
                assume_final_after_days=self.cfg.assume_final_after_days,
            )
        except NotSignedIn, Challenged:
            raise
        except Exception as err:  # refused URL, navigation error: the details read stands
            result.printable_failed.append(order.order_id)
            self.tel.emit(
                "selector_error",
                selector="order_printable",
                error=type(err).__name__,
                page=order.order_id,
            )
            return order
        if printed.status != "final" or not printed.lines or printed.subtotal_cents is None:
            return order
        result.printable_used += 1
        return replace(
            printed,
            ordered_on=printed.ordered_on or order.ordered_on,
            acquired_on=printed.acquired_on or order.acquired_on,
            fulfillment=order.fulfillment,
            vendor=order.vendor,
        )

    def _fallback(self, order: ParsedOrder, url: str) -> dict[str, Any]:
        acquired = order.acquired_on or order.ordered_on
        return {
            "order_id": order.order_id,
            "url": url,
            "vendor": order.vendor,
            "fulfillment": order.fulfillment,
            "ordered_at": local_noon(order.ordered_on, self.tz).isoformat()
            if order.ordered_on
            else None,
            "acquired_at": local_noon(acquired, self.tz).isoformat() if acquired else None,
            "account": self.member.discord_id,
            "text": order.text[: self.cfg.page_text_limit],
        }

    def mark_done(self, order_id: str) -> None:
        """The skill ingested a `needs_agent_extraction` order itself."""
        self.state.done[order_id] = self.now().isoformat()
        self.state.save(self.path)
