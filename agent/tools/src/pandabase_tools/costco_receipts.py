"""Costco receipts from costco.com's Orders & Purchases (PLAN M10.3, DESIGN §4.8, PRD §4.8).

One page, two tabs, read-only:

- **Warehouse** (in-store receipts): a card per receipt (`div#viewRecieptBtn_<barcode>`, sic);
  "View Receipt" opens the receipt as a dialog on the same page; the receipt's table is read and
  the dialog closed. The 23-digit barcode is the receipt's key (`external_order_id`).
- **Online** (costco.com 2-Day Delivery): a card per order linking `…/orderdetails/<n>`, which is
  opened (one page load) only for a delivered order not ingested yet.

Page loads stay low (Costco has bot checks): one load of the orders page, clicks for the
Warehouse tab, the period picker and each new receipt, and one load per new online order. A
backfill walks the period picker ("Last 3 Months", then quarters back ~2 years) on both tabs.

Privacy: everything under `data-private="true"` (member and card numbers, address, contact) is
dropped before parsing, except the receipt table itself (which is marked that way too), and its
header row (the member number). Card digits, approval codes and the like inside the table are
never read: only item rows, the multi-buy rows before them, SUBTOTAL / TAX / Total and the item
count. Nothing identifying goes to the API or telemetry (URLs carry the account id: never logged).

Instant savings (seen live 2026-11-16) print as `<coupon number> / <item number> <amount>-`
under the item: the amount comes off that item's line (its line total, and its unit price), so
the line is what was paid and the lines add up to SUBTOTAL. Online, an item's own fee (California's
"CA BEP FEE" sits inside the item's block, with its own price, quantity and total) is added to
that item's line total; its unit price stays the listed price.

Rows the parser doesn't recognise as an item, a multi-buy, an instant saving or a total — a
negative amount naming no item on the receipt, above all — are **reported, not guessed**: they go
to `unknown_lines` in the sweep result and telemetry, and the receipt's totals check fails in the
State Engine because its lines no longer add up to the subtotal.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime, timedelta
from functools import partial
from pathlib import Path
from typing import Any, Literal, Protocol
from zoneinfo import ZoneInfo

from . import contracts as c
from . import dom, guard
from .api import ApiClient, ApiError
from .browser import Challenged, NotSignedIn, Snapshot
from .config import CostcoReceiptsConfig, Member
from .receipt_parser import ingest_key, load_recheck, local_noon, prune_recheck
from .telemetry import Telemetry

VENDOR = "costco"
Tab = Literal["online", "warehouse"]
Mode = Literal["sweep", "backfill"]

BARCODE = re.compile(r"^\d{23}$")
WAREHOUSE_CARD_ID = re.compile(r"^viewRecieptBtn_(\d{23})$")
ORDER_LINK_ID = re.compile(r"^orderNumber_(\d{6,20})$")
# Digit-only boundaries, not `\b`: the live cards run inline texts together ("…2026Order …").
CARD_DATE = re.compile(r"(?<!\d)(\d{2})/(\d{2})/(\d{4})\s*-\s*(\d{1,2}):(\d{2})\s*([ap])m", re.I)
MDY = re.compile(r"(?<!\d)(\d{2})/(\d{2})/(\d{4})(?!\d)")
DELIVERED = re.compile(r"delivered on\s+(\d{2}/\d{2}/\d{4})(?!\d)", re.I)
MONEY = re.compile(r"\$\s?(\d{1,6}(?:,\d{3})*)\.(\d{2})")
AMOUNT = re.compile(r"^\s*(\d{1,6}(?:,\d{3})*)\.(\d{2})\s*(-)?\s*([A-Z])?\s*$")
MULTI_BUY = re.compile(r"^\s*(\d{1,3})\s*@\s*(\d{1,6})\.(\d{2})\s*$")
ITEM_NUMBER = re.compile(r"^\d{4,12}$")
ITEMS_SOLD = re.compile(r"total number of items sold\s*=\s*(\d+)", re.I)
QUANTITY = re.compile(r"\bquantity\s+(\d{1,3})\b", re.I)
TOTAL_LABELS = ("SUBTOTAL", "TAX", "TOTAL")
ITEM_LABEL = re.compile(r"^\s*item\s+(\d{4,12})\s*$", re.I)
# "389504 / 1977696 4.00-": coupon number / the item number it applies to, the saving.
INSTANT_SAVINGS = re.compile(
    r"^(?:[A-Z]\s+)?(\d{4,12})\s*/\s*(\d{4,12})\s+(\d{1,6}(?:,\d{3})*)\.(\d{2})\s*-\s*[A-Z]?\s*$"
)

# A page without Orders & Purchases is signed out unless it reads like a bot check (Akamai's
# "Access Denied" and similar; not seen on Costco yet — check the first live run).
CHALLENGE = re.compile(
    r"\baccess denied\b|\byou don't have permission to access\b|\bverify you are (?:a )?human\b"
    r"|\bpardon our interruption\b",
    re.I,
)


def cents(whole: str, frac: str) -> int:
    return int(whole.replace(",", "")) * 100 + int(frac)


def _attr(node: dom.Node, name: str) -> str:
    return node.attrs.get(name, "")


def _by_automation(root: dom.Node, value: str) -> list[dom.Node]:
    return [n for n in root.iter() if _attr(n, "automation-id") == value]


def _first_money(text: str) -> int | None:
    m = MONEY.search(text)
    return cents(m.group(1), m.group(2)) if m else None


def _mdy(text: str) -> date | None:
    m = MDY.search(text)
    if not m:
        return None
    try:
        return date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
    except ValueError:
        return None


# Privacy -------------------------------------------------------------------------------------


def _is_receipt_table(node: dom.Node) -> bool:
    return node.tag == "table" and _attr(node, "aria-label") == "spanning table"


def _row_kind(tr: dom.Node) -> Literal["item", "multi", "total", "sold", "other"]:
    cells = _cells(tr)
    joined = " ".join(x for x in cells if x)
    if ITEMS_SOLD.search(joined):
        return "sold"
    if cells and len(cells) <= 2 and MULTI_BUY.match(cells[0]):
        return "multi"
    if len(cells) >= 3 and AMOUNT.match(cells[-1]):
        if cells[-2].strip().upper() in TOTAL_LABELS:
            return "total"
        if len(cells) == 4 and ITEM_NUMBER.match(cells[1]):
            return "item"
        if AMOUNT.match(cells[-1]).group(3):  # type: ignore[union-attr]
            return "item"  # a negative row: kept so it is reported
    return "other"


def _keep_receipt_rows(table: dom.Node) -> None:
    """Only item, multi-buy, total and item-count rows survive: the header (member number), card
    digits, approval and tax-breakdown rows never reach a parser."""
    for section in list(table.children):
        if not isinstance(section, dom.Node):
            continue
        if section.tag != "tbody":
            table.children.remove(section)
            continue
        section.children = [
            tr
            for tr in section.children
            if isinstance(tr, dom.Node) and tr.tag == "tr" and _row_kind(tr) != "other"
        ]


def public_tree(html: str) -> dom.Node:
    """The page with every `data-private="true"` subtree removed — except the receipt table,
    whose header (the member number) is removed instead. Parsers only ever see this tree."""
    root = dom.parse(html)
    for node in list(root.iter()):
        parent = node.parent
        if parent is None or node not in parent.children:
            continue  # detached with an ancestor
        if _is_receipt_table(node):
            _keep_receipt_rows(node)
        elif _attr(node, "data-private") == "true":
            # A private wrapper keeps only a receipt table inside it, if any.
            kept: list[dom.Node | str] = [d for d in node.iter() if _is_receipt_table(d)]
            for t in kept:
                assert isinstance(t, dom.Node)
                t.parent = node
            node.children = kept
    return root


def page_problem(snap: Snapshot) -> Literal["signed_out", "challenge"] | None:
    """A page that isn't Orders & Purchases: a bot check or a signed-out page."""
    root = dom.parse(snap.html)
    if _by_automation(root, "myOrderHistory") or _by_automation(root, "orderNumber"):
        return None
    # Anything else (a sign-in page, an empty shell) stops the sweep as signed out.
    return "challenge" if CHALLENGE.search(root.text()) else "signed_out"


def check_page(snap: Snapshot) -> Snapshot:
    problem = page_problem(snap)
    if problem == "challenge":
        raise Challenged("costco")
    if problem == "signed_out":
        raise NotSignedIn("costco")
    return snap


# Warehouse -----------------------------------------------------------------------------------


@dataclass
class WarehouseCard:
    barcode: str
    purchased_at: str  # local "YYYY-MM-DDTHH:MM"
    total_cents: int | None


def _card_datetime(text: str) -> str | None:
    m = CARD_DATE.search(text)
    if not m:
        return None
    month, day, year, hour, minute, ap = m.groups()
    h = int(hour) % 12 + (12 if ap.lower() == "p" else 0)
    try:
        return datetime(int(year), int(month), int(day), h, int(minute)).strftime("%Y-%m-%dT%H:%M")
    except ValueError:
        return None


def parse_warehouse_list(html: str) -> list[WarehouseCard]:
    """The Warehouse tab's receipt cards (in page order)."""
    root = public_tree(html)
    out: list[WarehouseCard] = []
    for node in root.iter():
        m = WAREHOUSE_CARD_ID.match(_attr(node, "id"))
        if not m:
            continue
        text = node.text()
        when = _card_datetime(text)
        if when is None:
            continue
        totals = _by_automation(node, "totalPrice")
        out.append(
            WarehouseCard(
                barcode=m.group(1),
                purchased_at=when,
                total_cents=_first_money(totals[0].text()) if totals else None,
            )
        )
    return out


@dataclass
class UnknownLine:
    text: str
    amount_cents: int | None


@dataclass
class ParsedReceipt:
    lines: list[c.ReceiptLineIn]
    subtotal_cents: int | None
    tax_cents: int | None
    total_cents: int | None
    items_sold: int | None
    unknown_lines: list[UnknownLine] = field(default_factory=list)
    instant_savings: int = 0  # instant-savings rows taken off their item's line

    def units(self) -> float:
        return sum(line.qty for line in self.lines)


def _cells(tr: dom.Node) -> list[str]:
    return [td.text().strip() for td in tr.children if isinstance(td, dom.Node) and td.tag == "td"]


def _clean_description(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().strip("*").strip())


def parse_warehouse_receipt(html: str) -> ParsedReceipt | None:
    """The open "In-Warehouse Receipt" dialog's table; None when no receipt dialog is open."""
    root = public_tree(html)
    tables = [n for n in root.iter() if _is_receipt_table(n)]
    if not tables:
        return None
    rows = [tr for tbody in tables[0].find_all("tbody") for tr in tbody.find_all("tr")]
    lines: list[c.ReceiptLineIn] = []
    unknown: list[UnknownLine] = []
    subtotal = tax = total = sold = None
    multi: tuple[int, int] | None = None
    savings: list[tuple[str, int, str]] = []  # (item number, cents, row text)
    for tr in rows:
        cells = _cells(tr)
        joined = " ".join(x for x in cells if x)
        kind = _row_kind(tr)
        if kind == "sold":
            sold = int(ITEMS_SOLD.search(joined).group(1))  # type: ignore[union-attr]
        elif kind == "multi":
            mb = MULTI_BUY.match(cells[0])
            assert mb is not None
            multi = (int(mb.group(1)), cents(mb.group(2), mb.group(3)))
        elif kind == "total":
            amount = AMOUNT.match(cells[-1])
            assert amount is not None
            value, label = cents(amount.group(1), amount.group(2)), cells[-2].strip().upper()
            if label == "SUBTOTAL":
                subtotal = value
            elif label == "TAX" and tax is None:
                tax = value
            elif label == "TOTAL" and total is None:
                total = value
        elif kind == "item":
            amount = AMOUNT.match(cells[-1])
            assert amount is not None
            line_total = cents(amount.group(1), amount.group(2))
            saving = INSTANT_SAVINGS.match(joined) if amount.group(3) else None
            if saving:
                savings.append((saving.group(2), line_total, joined[:120]))
                multi = None
                continue
            if amount.group(3) or len(cells) != 4 or not ITEM_NUMBER.match(cells[1]):
                # "5.00-" naming no item: a refund or another format not seen yet.
                unknown.append(UnknownLine(joined[:120], -line_total))
                multi = None
                continue
            qty, unit = multi if multi else (1, line_total)
            multi = None
            lines.append(
                c.ReceiptLineIn(
                    raw_text=_clean_description(cells[2])[:300] or cells[1],
                    vendor_sku=cells[1],
                    qty=float(qty),
                    unit_price_cents=unit,
                    line_total_cents=line_total,
                )
            )
    applied = 0
    for sku, off, text in savings:
        target = next((x for x in reversed(lines) if x.vendor_sku == sku), None)
        if target is None or target.line_total_cents is None or off > target.line_total_cents:
            unknown.append(UnknownLine(text, -off))
            continue
        net = target.line_total_cents - off
        target.line_total_cents = net
        target.unit_price_cents = round(net / target.qty)
        applied += 1
    return ParsedReceipt(lines, subtotal, tax, total, sold, unknown, applied)


# Online --------------------------------------------------------------------------------------


@dataclass
class OnlineCard:
    order_number: str
    ordered_on: str | None  # YYYY-MM-DD
    delivered_on: str | None
    details_url: str


def _order_numbers(node: dom.Node) -> set[str]:
    return {m.group(1) for a in node.find_all("a") if (m := ORDER_LINK_ID.match(_attr(a, "id")))}


def _only_order(number: str, node: dom.Node) -> bool:
    return _order_numbers(node) <= {number}


def parse_online_list(snap: Snapshot) -> list[OnlineCard]:
    root = public_tree(snap.html)
    out: dict[str, OnlineCard] = {}
    for a in root.find_all("a"):
        m = ORDER_LINK_ID.match(_attr(a, "id"))
        if not m or m.group(1) in out:
            continue
        number = m.group(1)
        card = dom.widest_ancestor(a, partial(_only_order, number))
        ordered = next(
            (_mdy(n.text()) for n in card.iter() if _attr(n, "id") == f"orderDate_{number}"),
            None,
        )
        m_delivered = DELIVERED.search(card.text())
        delivered = _mdy(m_delivered.group(1)) if m_delivered else None
        out[number] = OnlineCard(
            order_number=number,
            ordered_on=ordered.isoformat() if ordered else None,
            delivered_on=delivered.isoformat() if delivered else None,
            details_url=dom.absolute(snap.url, _attr(a, "href")),
        )
    return list(out.values())


@dataclass
class ParsedOnlineOrder:
    order_number: str
    ordered_on: date | None
    delivered_on: date | None
    lines: list[c.ReceiptLineIn]
    subtotal_cents: int | None
    shipping_cents: int | None
    tax_cents: int | None
    total_cents: int | None
    discount_cents: int | None = None  # "Discount on Order" (below the subtotal)
    fees: int = 0  # item fees added to their item's line ("CA BEP FEE PERCENT")


@dataclass
class _ItemAmounts:
    unit: int | None = None
    qty: int = 1
    total: int | None = None
    fees: list[int] = field(default_factory=list)


def _item_amounts(block: dom.Node, label: dom.Node) -> _ItemAmounts:
    """The item's price, "Quantity n", "Total" $x, then any fee printed inside the item's block
    (a name, then its own price, quantity and total), read from the text after the item number.
    Other text (delivery notes, buttons) is skipped."""
    leaves = [n for n in block.iter() if not [k for k in n.children if isinstance(k, dom.Node)]]
    start = next((i for i, n in enumerate(leaves) if n is label), None)
    if start is None:
        return _ItemAmounts()
    texts = [t for n in leaves[start + 1 :] if (t := n.text().strip())]
    item = _ItemAmounts()
    in_fee = expect_total = False
    for i, text in enumerate(texts):
        money = MONEY.search(text)
        if money:
            value = cents(money.group(1), money.group(2))
            if expect_total and in_fee:
                item.fees.append(value)
            elif expect_total:
                item.total = value
            elif item.unit is None:
                item.unit = value
            expect_total = False
        elif text.lower() == "total":
            expect_total = True
        elif (q := QUANTITY.search(text)) and not in_fee:
            item.qty = int(q.group(1))
        elif item.total is not None and i + 1 < len(texts) and MONEY.search(texts[i + 1]):
            in_fee = True  # a fee's name, followed by its price
    return item


def _labelled_money(box: dom.Node, label: str) -> int | None:
    for n in box.iter():
        if n is box:
            continue
        kids = [k for k in n.children if isinstance(k, dom.Node)]
        if len(kids) >= 2 and kids[0].text().strip().lower() == label:
            return _first_money(" ".join(k.text() for k in kids[1:]))
    return None


def parse_order_details(html: str) -> ParsedOnlineOrder | None:
    root = public_tree(html)
    numbers = _by_automation(root, "orderNumber")
    if not numbers:
        return None
    number = re.sub(r"\D", "", numbers[0].text())
    dates = _by_automation(root, "orderDate")
    ordered = _mdy(dates[0].text()) if dates else None
    delivered = DELIVERED.search(root.text())
    summary = _by_automation(root, "orderTotalOutput")
    subtotal = shipping = tax = None
    if summary:
        box = summary[0]
        subtotal = _labelled_money(box, "subtotal")
        shipping = _labelled_money(box, "shipping")
        taxes = _by_automation(box, "taxOutput")
        tax = _first_money(taxes[0].text()) if taxes else None
    totals = _by_automation(root, "orderTotal")
    total = _first_money(totals[0].text()) if totals else None
    discounts = _by_automation(root, "totalDiscountOutput")
    discount = _first_money(discounts[0].text()) if discounts else None
    lines: list[c.ReceiptLineIn] = []
    fees = 0
    for label in _by_automation(root, "itemNumber"):
        m = ITEM_LABEL.match(label.text())
        if not m:
            continue
        sku = m.group(1)

        def one_item(n: dom.Node, sku: str = sku) -> bool:
            # One item's block, never the order summary: with a single item the widest such
            # ancestor was the whole page, so its prices were the summary's (live, 2026-11-16).
            if _by_automation(n, "orderTotalOutput") or _by_automation(n, "orderNumber"):
                return False
            found = {
                mm.group(1)
                for x in _by_automation(n, "itemNumber")
                if (mm := ITEM_LABEL.match(x.text()))
            }
            return found <= {sku}

        block = dom.widest_ancestor(label, one_item)
        titles = [
            t
            for a in block.find_all("a")
            if f".product.{sku}." in _attr(a, "href") and (t := a.text().strip())
        ]
        title = max(titles, key=len) if titles else f"Item {sku}"
        amounts = _item_amounts(block, label)
        qty, unit = amounts.qty, amounts.unit
        line_total = (
            amounts.total
            if amounts.total is not None
            else (unit * qty if unit is not None else None)
        )
        if line_total is not None and amounts.fees:
            line_total += sum(amounts.fees)
            fees += len(amounts.fees)
        lines.append(
            c.ReceiptLineIn(
                raw_text=title[:300],
                title=title[:300],
                vendor_sku=sku,
                qty=float(qty if qty > 0 else 1),
                unit_price_cents=unit,
                line_total_cents=line_total,
            )
        )
    return ParsedOnlineOrder(
        order_number=number,
        ordered_on=ordered,
        delivered_on=_mdy(delivered.group(1)) if delivered else None,
        lines=lines,
        subtotal_cents=subtotal,
        shipping_cents=shipping,
        tax_cents=tax,
        total_cents=total,
        discount_cents=discount,
        fees=fees,
    )


def period_options(html: str) -> list[str]:
    """The period picker's labels ("Last 3 Months", "2026 June - August", …), in order."""
    root = dom.parse(html)
    for sel in root.find_all("select"):
        if _attr(sel, "id") == "Showing":
            return [o.text().strip() for o in sel.find_all("option") if o.text().strip()]
    return []


# Ingest bodies -------------------------------------------------------------------------------


def local_instant(local: str, tz: str) -> datetime:
    """`YYYY-MM-DDTHH:MM` household-local → UTC."""
    return datetime.fromisoformat(local).replace(tzinfo=ZoneInfo(tz)).astimezone(UTC)


def warehouse_request(
    card: WarehouseCard, receipt: ParsedReceipt, member: Member, tz: str
) -> c.ReceiptIngestRequest:
    at = local_instant(card.purchased_at, tz)
    return c.ReceiptIngestRequest(
        source="digital",
        vendor=VENDOR,
        account=member.discord_id,
        actor_discord_id=member.discord_id,
        external_order_id=card.barcode,
        fulfillment="in_store",
        ordered_at=at,
        acquired_at=at,
        subtotal_cents=receipt.subtotal_cents,
        tax_cents=receipt.tax_cents,
        total_cents=receipt.total_cents if receipt.total_cents is not None else card.total_cents,
        lines=receipt.lines,
    )


def online_request(order: ParsedOnlineOrder, member: Member, tz: str) -> c.ReceiptIngestRequest:
    acquired = order.delivered_on or order.ordered_on
    if acquired is None:
        raise ValueError(f"order {order.order_number}: no date found")
    body: dict[str, Any] = {
        "source": "digital",
        "vendor": VENDOR,
        "account": member.discord_id,
        "actor_discord_id": member.discord_id,
        "external_order_id": order.order_number,
        "fulfillment": "delivery",
        "acquired_at": local_noon(acquired, tz),
        "subtotal_cents": order.subtotal_cents,
        "total_cents": order.total_cents,
        "lines": order.lines,
    }
    if order.ordered_on:
        body["ordered_at"] = local_noon(order.ordered_on, tz)
    # subtotal + tax = total only holds without shipping or an order discount ("Discount on
    # Order" sits below the subtotal); with either, only the line sum is checked.
    if not order.shipping_cents and not order.discount_cents:
        body["tax_cents"] = order.tax_cents
    return c.ReceiptIngestRequest(**body)


# Driver --------------------------------------------------------------------------------------


class CostcoDriver(Protocol):
    """What the sweep needs from the browser: open a (guarded) page, and the four clicks on the
    Orders & Purchases page. Each returns a snapshot of the page afterwards."""

    def open(self, url: str) -> Snapshot: ...

    def costco_ready(self, page: Literal["orders", "details"]) -> Snapshot:
        """After `open`, wait (bounded) for the single-page app to render `page`."""
        ...

    def costco_tab(self, tab: Tab) -> Snapshot: ...

    def costco_period(self, label: str) -> Snapshot: ...

    def costco_open_receipt(self, barcode: str) -> Snapshot: ...

    def costco_close_receipt(self) -> Snapshot: ...


# Sweep ---------------------------------------------------------------------------------------


@dataclass
class CostcoState:
    """`receipts-costco.json`: receipts/orders already ingested, the scheduled sweeps (household
    dates, "back from Costco" → next morning + one retry), and the last ops warning."""

    done: dict[str, str] = field(default_factory=dict)  # "warehouse:<barcode>" / "online:<n>"
    due: list[str] = field(default_factory=list)
    due_trip: str | None = None  # the trip date the scheduled sweeps are for
    last_warning: dict[str, str] = field(default_factory=dict)  # error → ISO time
    # key → first read whose lines didn't add up (`totals_check: fail`, §10 #90): applied as read
    # but not done, so every sweep re-reads it for `RECHECK_DAYS` (a fixed read replaces it)
    recheck: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> CostcoState:
        try:
            data = json.loads(path.read_text())
        except FileNotFoundError:
            return cls()
        return cls(
            done=dict(data.get("done", {})),
            due=list(data.get("due", [])),
            due_trip=data.get("due_trip"),
            last_warning=dict(data.get("last_warning", {})),
            recheck=load_recheck(data),
        )

    def save(self, path: Path) -> None:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self), indent=1))
        tmp.replace(path)


def state_path(state_dir: Path) -> Path:
    return state_dir / "receipts-costco.json"


def schedule_after_trip(state_dir: Path, today: date, trip_date: str) -> list[str]:
    """ "Back from Costco": the next morning's sweep and one retry the day after (receipts
    "appear within 24 hours"). Returns the scheduled dates."""
    path = state_path(state_dir)
    state = CostcoState.load(path)
    state.due = [(today + timedelta(days=d)).isoformat() for d in (1, 2)]
    state.due_trip = trip_date
    state.save(path)
    return state.due


@dataclass
class CostcoSweepResult:
    member: str
    mode: Mode
    complete: bool = False
    pages: int = 0
    clicks: int = 0
    periods: list[str] = field(default_factory=list)
    ingested: list[dict[str, Any]] = field(default_factory=list)
    duplicates: list[str] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)  # online orders not delivered yet
    unknown_lines: list[dict[str, Any]] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)
    instant_savings: int = 0  # warehouse instant-savings rows taken off their item's line
    item_fees: int = 0  # online item fees added to their item's line
    # §10 #90: reads whose lines don't add up (`totals_check: fail`), applied as read; `held` set
    # when a State Engine from before #90 stored one without applying it
    totals_fail: list[dict[str, Any]] = field(default_factory=list)

    def trip_receipts(self) -> list[dict[str, Any]]:
        return [x for x in self.ingested if x.get("costco_trip_id")]


class CostcoSweeper:
    def __init__(
        self,
        api: ApiClient,
        driver: CostcoDriver,
        cfg: CostcoReceiptsConfig,
        member: Member,
        tz: str,
        state_dir: Path,
        tel: Telemetry,
        *,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.api, self.driver, self.cfg, self.member, self.tz = api, driver, cfg, member, tz
        self.tel, self.sleep, self.now = tel, sleep, now
        self.path = state_path(state_dir)
        self.state = CostcoState.load(self.path)
        self._actions = 0

    def _pace(self) -> None:
        if self._actions:
            self.sleep(self.cfg.throttle_seconds)
        self._actions += 1

    def _open(
        self, url: str, page: Literal["orders", "details"], result: CostcoSweepResult
    ) -> Snapshot:
        self._pace()
        result.pages += 1
        self.driver.open(guard.check_url(url))
        return check_page(self.driver.costco_ready(page))

    def _click(self, fn: Callable[[], Snapshot], result: CostcoSweepResult) -> Snapshot:
        self._pace()
        result.clicks += 1
        return check_page(fn())

    def run(self, mode: Mode) -> CostcoSweepResult:
        result = CostcoSweepResult(self.member.name, mode)
        if not self.cfg.orders_url:
            result.errors.append({"error": "costco_orders_url_missing"})
            return self._finish(result)
        try:
            self._sweep(mode, result)
        except Challenged:
            result.errors.append({"error": "costco_challenge"})
        except NotSignedIn:
            result.errors.append({"error": "not_signed_in"})
        except guard.UnsafeUrl as err:
            result.errors.append({"error": f"refused_{err.reason}"})
        finally:
            self.state.save(self.path)
        result.complete = not result.errors
        return self._finish(result)

    def _finish(self, result: CostcoSweepResult) -> CostcoSweepResult:
        self.tel.emit(
            "receipt_sweep",
            vendor=VENDOR,
            member=self.member.name,
            mode=result.mode,
            pages=result.pages,
            clicks=result.clicks,
            ingested=len(result.ingested),
            warehouse=sum(1 for x in result.ingested if x["kind"] == "warehouse"),
            online=sum(1 for x in result.ingested if x["kind"] == "online"),
            duplicates=len(result.duplicates),
            pending=len(result.pending),
            unknown_lines=len(result.unknown_lines),
            instant_savings=result.instant_savings,
            item_fees=result.item_fees,
            totals_fail=len(result.totals_fail),
            trip_receipts=len(result.trip_receipts()),
            errors=len(result.errors),
            error_kinds=sorted({e["error"] for e in result.errors}),
            complete=result.complete,
        )
        return result

    def _periods(self, snap: Snapshot, mode: Mode) -> list[str]:
        options = period_options(snap.html)
        if mode == "sweep" or not options:
            return options[:1]
        return options[: self.cfg.backfill_periods]

    def _sweep(self, mode: Mode, result: CostcoSweepResult) -> None:
        prune_recheck(self.state.recheck, self.state.done, self.now())
        snap = self._open(self.cfg.orders_url or "", "orders", result)  # opens on the Online tab
        online: dict[str, OnlineCard] = {}
        periods = self._periods(snap, mode)
        result.periods = periods
        for i, label in enumerate(periods):
            if i > 0:
                snap = self._click(partial(self.driver.costco_period, label), result)
            for ocard in parse_online_list(snap):
                online.setdefault(ocard.order_number, ocard)

        snap = self._click(partial(self.driver.costco_tab, "warehouse"), result)
        for i, label in enumerate(periods):
            if i > 0:
                snap = self._click(partial(self.driver.costco_period, label), result)
            cards = parse_warehouse_list(snap.html)
            if not cards and i == 0:
                self.tel.emit("selector_error", selector="costco_warehouse_cards", error="zero")
            # Oldest first: a late receipt skips the EMA step (§4.1), so order matters.
            for wcard in sorted(cards, key=lambda x: x.purchased_at):
                self._warehouse_receipt(wcard, result)

        for ocard in sorted(online.values(), key=lambda x: x.ordered_on or "9999"):
            self._online_order(ocard, result)

    def _warehouse_receipt(self, card: WarehouseCard, result: CostcoSweepResult) -> None:
        key = f"warehouse:{card.barcode}"
        if key in self.state.done:
            return
        dialog = self._click(partial(self.driver.costco_open_receipt, card.barcode), result)
        receipt = parse_warehouse_receipt(dialog.html)
        self._click(self.driver.costco_close_receipt, result)
        if receipt is None or not receipt.lines:
            self.tel.emit("selector_error", selector="costco_receipt", error="no_lines")
            result.errors.append({"error": "receipt_unreadable", "receipt": card.barcode[-6:]})
            return
        self._report_unknown(receipt, card.barcode, result)
        result.instant_savings += receipt.instant_savings
        self._ingest(
            key,
            "warehouse",
            warehouse_request(card, receipt, self.member, self.tz),
            result,
            extra={"purchased_at": card.purchased_at, "items_sold": receipt.items_sold},
        )

    def _online_order(self, card: OnlineCard, result: CostcoSweepResult) -> None:
        key = f"online:{card.order_number}"
        if key in self.state.done:
            return
        if card.delivered_on is None:
            result.pending.append(card.order_number)
            return
        details = self._open(card.details_url, "details", result)
        order = parse_order_details(details.html)
        if order is None or not order.lines:
            self.tel.emit("selector_error", selector="costco_order_details", error="no_lines")
            result.errors.append({"error": "order_unreadable", "order": card.order_number})
            return
        result.item_fees += order.fees
        self._ingest(key, "online", online_request(order, self.member, self.tz), result)

    def _report_unknown(
        self, receipt: ParsedReceipt, barcode: str, result: CostcoSweepResult
    ) -> None:
        problems = [asdict(u) for u in receipt.unknown_lines]
        if receipt.items_sold is not None and round(receipt.units()) != receipt.items_sold:
            problems.append({"text": f"items sold {receipt.items_sold}", "amount_cents": None})
        for p in problems:
            result.unknown_lines.append({"receipt": barcode[-6:], **p})

    def _ingest(
        self,
        key: str,
        kind: Literal["warehouse", "online"],
        body: c.ReceiptIngestRequest,
        result: CostcoSweepResult,
        extra: dict[str, Any] | None = None,
    ) -> None:
        order_id = body.external_order_id or ""
        try:
            res = self.api.ingest_receipt(
                body,
                key=ingest_key(self.member.discord_id, order_id, body),
            )
        except (ApiError, ValueError) as err:
            result.errors.append({"error": "ingest_failed", "detail": str(err)[:300]})
            return
        if res.totals_check == "fail":
            # §4.5 / §10 #90: its lines don't add up; applied as read (a State Engine from before
            # #90 answers `held` and applies nothing). Not done: every sweep re-reads it, and a
            # fixed parser's read replaces the receipt.
            first = key not in self.state.recheck
            self.state.recheck.setdefault(key, self.now().isoformat())
            result.totals_fail.append(
                {
                    "kind": kind,
                    "lines": len(body.lines),
                    "first": first,
                    "held": res.status == "held",
                    **(extra or {}),
                }
            )
        else:
            self.state.recheck.pop(key, None)
            self.state.done[key] = self.now().isoformat()
        self.state.save(self.path)
        if res.status == "held":
            return
        if res.duplicate:
            result.duplicates.append(key)
            return
        result.ingested.append(
            {
                "kind": kind,
                "receipt_id": res.receipt_id,
                "lines": len(body.lines),
                "status": res.status,
                "totals_check": res.totals_check,
                "new_items": len(res.new_item_ids),
                "costco_trip_id": res.costco_trip_id,
                **(extra or {}),
            }
        )


# Discord replies (command payloads, DESIGN §10 #60) ------------------------------------------

NO_REPLY = "NO_REPLY"
WARNING_QUIET_DAYS = 7


def _short_day(local: str) -> str:
    d = date.fromisoformat(local[:10])
    return f"{d:%a} {d.month}/{d.day}"


def sweep_reply(
    result: CostcoSweepResult, state: CostcoState, now: datetime, *, last_try: bool
) -> str:
    """One line for the ops channel, or NO_REPLY. Warns about a signed-out page or a bot check at
    most once a week (`state.last_warning`); says when a trip's receipt arrived; on the last
    scheduled try with no receipt, says the weekly sweep will look again."""
    lines: list[str] = []
    for err in sorted({e["error"] for e in result.errors}):
        message = {
            "not_signed_in": "⚠️ Costco is signed out in the pandabase browser on the Mac Mini — "
            "please sign in there (Orders & Purchases). I'll pick up the receipts on the next run.",
            "costco_challenge": "⚠️ Costco showed a bot check in the pandabase browser on the Mac "
            "Mini — please open it there and clear it. I'll try again on the next run.",
            "costco_orders_url_missing": "⚠️ The Costco receipt sweep has no orders page set "
            "(receipts.costco.orders_url in pandabase.config.json; docs/SETUP-MAC.md).",
        }.get(err)
        if message is None:
            continue
        last = state.last_warning.get(err)
        if last and now - datetime.fromisoformat(last) < timedelta(days=WARNING_QUIET_DAYS):
            continue
        state.last_warning[err] = now.isoformat()
        lines.append(message)
    for r in result.trip_receipts():
        lines.append(
            f"🧾 Costco receipt from {_short_day(r['purchased_at'])} is in: {r['lines']} lines "
            "stocked, and the trip is closed."
        )
    for h in result.totals_fail:
        if h["first"]:
            what = (
                f"Costco receipt from {_short_day(h['purchased_at'])}"
                if h["kind"] == "warehouse"
                else "A Costco online order"
            )
            done = (
                "so I've held it (nothing stocked yet)"
                if h["held"]
                else "so I've stocked it as read"
            )
            lines.append(
                f"🧾 {what} doesn't add up to its total, {done} — I'll re-read it on later sweeps."
            )
    if result.unknown_lines:
        lines.append(
            f"⚠️ {len(result.unknown_lines)} Costco receipt line(s) I couldn't read (a discount?) — "
            "they're in the weekly diagnostics."
        )
    held_warehouse = any(h["kind"] == "warehouse" and h["held"] for h in result.totals_fail)
    if (
        last_try
        and not result.errors
        and not result.trip_receipts()
        and not held_warehouse
        and state.due_trip
    ):
        lines.append(
            f"🧾 No Costco receipt for the {_short_day(state.due_trip)} trip yet — the weekly "
            "sweep will look again."
        )
    return "\n".join(lines) if lines else NO_REPLY
