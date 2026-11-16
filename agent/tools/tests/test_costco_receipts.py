"""Costco receipt parser and sweep (PLAN M10.3, DESIGN §4.8) on the synthetic pages in
tests/fixtures/costco (structure of the owner's saved pages, every value invented)."""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import FakeApi

from pandabase_tools import costco_receipts as cr
from pandabase_tools import guard
from pandabase_tools.browser import Snapshot
from pandabase_tools.config import CostcoReceiptsConfig, Member
from pandabase_tools.telemetry import Telemetry

COSTCO = Path(__file__).parent / "fixtures" / "costco"
ACCOUNT = "https://www.costco.com/myaccount/#/app/00000000-0000-0000-0000-000000000000"
ORDERS_URL = f"{ACCOUNT}/ordersandpurchases"
WILL = Member(name="will", discord_id="1001", profile="pandabase", cart_member=True)
TZ = "America/Los_Angeles"
FIRST = "21099920100422611071815"


def page(name: str) -> str:
    return (COSTCO / name).read_text()


# Privacy ---------------------------------------------------------------------------------------


def test_private_subtrees_never_reach_the_parsers() -> None:
    for name in ("orders_warehouse_receipt.html", "order_details_delivered.html"):
        text = cr.public_tree(page(name)).text()
        for private in (
            "000000000000",  # member number
            "XXXXXXXXXXXXX0000",  # card
            "1 EXAMPLE WAY",
            "(555) 555-0100",
            "alex@example.com",
            "Ending in",
            "Alex Example",
        ):
            assert private not in text, (name, private)
    # The receipt table is kept (it is marked private too), without its member-number header.
    assert "KS ORG EGGS" in cr.public_tree(page("orders_warehouse_receipt.html")).text()


def test_request_bodies_carry_no_member_card_or_contact_details() -> None:
    receipt = cr.parse_warehouse_receipt(page("orders_warehouse_receipt.html"))
    card = cr.parse_warehouse_list(page("orders_warehouse.html"))[0]
    order = cr.parse_order_details(page("order_details_delivered.html"))
    assert receipt is not None and order is not None
    bodies = [
        cr.warehouse_request(card, receipt, WILL, TZ).model_dump_json(),
        cr.online_request(order, WILL, TZ).model_dump_json(),
    ]
    for body in bodies:
        for private in (
            "000000000000",
            '0000"',
            "EXAMPLE WAY",
            "(555)",
            "example.com",
            "VISA",
            "APPROVED",
        ):
            assert private not in body


# Warehouse -------------------------------------------------------------------------------------


def test_warehouse_cards() -> None:
    cards = cr.parse_warehouse_list(page("orders_warehouse.html"))
    assert [(c.barcode, c.purchased_at, c.total_cents) for c in cards] == [
        (FIRST, "2026-11-07T18:15", 7009),
        ("21099920200172610240905", "2026-10-24T09:05", 5410),
        ("21099920100082610031430", "2026-10-03T14:30", 8860),
    ]
    # The hidden generic modal and header/footer links are not receipts.
    assert cr.parse_warehouse_list(page("orders_online.html")) == []


def test_warehouse_receipt_lines_multi_buy_and_totals() -> None:
    r = cr.parse_warehouse_receipt(page("orders_warehouse_receipt.html"))
    assert r is not None
    assert [
        (x.vendor_sku, x.raw_text, x.qty, x.unit_price_cents, x.line_total_cents) for x in r.lines
    ] == [
        ("9000101", "KS ORG EGGS", 1, 949, 949),
        ("9000102", "BANANAS", 1, 199, 199),
        ("9000103", "KS ALMOND MLK", 2, 699, 1398),  # "2 @ 6.99" before the line
        ("9000104", "CHKN THIGHS", 1, 1842, 1842),
        ("9000201", "KS BATH TISS", 1, 2399, 2399),  # "**…**" stripped
    ]
    assert (r.subtotal_cents, r.tax_cents, r.total_cents, r.items_sold) == (6787, 222, 7009, 6)
    assert r.units() == 6
    assert r.unknown_lines == []
    assert sum(x.line_total_cents or 0 for x in r.lines) == r.subtotal_cents
    # No receipt dialog open: nothing to read.
    assert cr.parse_warehouse_receipt(page("orders_warehouse.html")) is None


def _with_row(row: str, subtotal: str) -> str:
    return page("orders_warehouse_receipt.html").replace(
        '<tr><td colspan="2"></td><td>SUBTOTAL</td><td>67.87</td></tr>',
        f'{row}<tr><td colspan="2"></td><td>SUBTOTAL</td><td>{subtotal}</td></tr>',
    )


# Bug: the first live sweep (2026-11-16) reported an instant-savings row ("<coupon> / <item>
# 4.00-") as unknown, and that receipt failed its totals check: the item stayed at full price.
@pytest.mark.parametrize(
    "row",
    [
        "<tr><td></td><td>356001</td><td>/9000103</td><td>3.00-</td></tr>",
        "<tr><td>356001</td><td>/ 9000103</td><td>3.00-</td></tr>",  # the live spacing
    ],
)
def test_instant_savings_come_off_the_item_they_name(row: str) -> None:
    r = cr.parse_warehouse_receipt(_with_row(row, "64.87"))
    assert r is not None
    assert r.unknown_lines == [] and r.instant_savings == 1
    milk = next(x for x in r.lines if x.vendor_sku == "9000103")
    assert (milk.qty, milk.line_total_cents, milk.unit_price_cents) == (2.0, 1098, 549)
    assert sum(x.line_total_cents or 0 for x in r.lines) == r.subtotal_cents


@pytest.mark.parametrize(
    "row",
    [
        "<tr><td></td><td>356001</td><td>/9999999</td><td>3.00-</td></tr>",  # no such item
        "<tr><td></td><td>356001</td><td>/9000102</td><td>3.00-</td></tr>",  # more than its line
        "<tr><td></td><td>REFUND</td><td>SYNTHETIC</td><td>3.00-</td></tr>",  # another format
    ],
)
def test_an_unknown_negative_line_is_reported_not_guessed(row: str) -> None:
    """A negative row that names no item on the receipt (or more than that item's line) must not
    be folded into any item or dropped silently."""
    r = cr.parse_warehouse_receipt(_with_row(row, "64.87"))
    assert r is not None
    assert len(r.lines) == 5 and r.instant_savings == 0
    assert [u.amount_cents for u in r.unknown_lines] == [-300]
    # The lines no longer add up to the subtotal: the State Engine's totals check fails.
    assert sum(x.line_total_cents or 0 for x in r.lines) != r.subtotal_cents


def test_warehouse_request() -> None:
    receipt = cr.parse_warehouse_receipt(page("orders_warehouse_receipt.html"))
    card = cr.parse_warehouse_list(page("orders_warehouse.html"))[0]
    assert receipt is not None
    req = cr.warehouse_request(card, receipt, WILL, TZ)
    assert req.vendor == "costco"
    assert req.external_order_id == FIRST
    assert req.fulfillment == "in_store"
    assert req.acquired_at == datetime(2026, 11, 8, 2, 15, tzinfo=UTC)  # 6:15pm PST
    assert (req.subtotal_cents, req.tax_cents, req.total_cents) == (6787, 222, 7009)


# Online ----------------------------------------------------------------------------------------


def test_online_cards() -> None:
    snap = Snapshot(ORDERS_URL, page("orders_online.html"))
    cards = cr.parse_online_list(snap)
    assert [(c.order_number, c.ordered_on, c.delivered_on) for c in cards] == [
        ("1000000002", "2026-10-20", "2026-10-22"),
        ("1000000001", "2026-10-05", "2026-10-07"),
    ]
    assert cards[1].details_url == f"{ACCOUNT}/orderdetails/1000000001"
    assert guard.classify_url(cards[1].details_url) is None


def test_delivered_date_run_into_the_next_inline_text() -> None:
    # Regression (first live sweep, 2026-11): the live card's status is inline, so its text read
    # "Delivered on 11/10/2026Order 1000000002"; `\b` after the year never matched and every
    # delivered order looked undelivered (pending forever).
    html = re.sub(
        r'<div class="o3-st">(Delivered on [\d/]+)</div>\s*<span>',
        r"<span>\1</span><span>",
        page("orders_online.html"),
    )
    assert "2026</span><span>Order" in html
    cards = cr.parse_online_list(Snapshot(ORDERS_URL, html))
    assert [c.delivered_on for c in cards] == ["2026-10-22", "2026-10-07"]


def test_warehouse_card_date_run_into_inline_text() -> None:
    # Same live pattern as above on a warehouse card: "11/07/2026 - 6:15pmWarehouse…" and
    # "Receipt11/07/2026" both lost their `\b`, so the card was skipped.
    assert cr._card_datetime("Receipt11/07/2026 - 6:15pmSynthetic Warehouse") == "2026-11-07T18:15"


def test_order_details() -> None:
    o = cr.parse_order_details(page("order_details_delivered.html"))
    assert o is not None
    assert (o.order_number, o.ordered_on, o.delivered_on) == (
        "1000000001",
        date(2026, 10, 5),
        date(2026, 10, 7),
    )
    assert [(x.vendor_sku, x.qty, x.unit_price_cents, x.line_total_cents) for x in o.lines] == [
        ("9000201", 1, 2799, 2799),
        ("9000301", 2, 1249, 2498),
    ]
    assert o.lines[0].title == "Kirkland Signature Bath Tissue, 2-Ply, 380 Sheets, 30 Rolls"
    assert (o.subtotal_cents, o.shipping_cents, o.tax_cents, o.total_cents) == (
        5297,
        0,
        259,
        5556,
    )
    req = cr.online_request(o, WILL, TZ)
    assert (req.fulfillment, req.tax_cents, req.external_order_id) == (
        "delivery",
        259,
        "1000000001",
    )


def test_online_request_drops_tax_when_shipping_is_charged() -> None:
    html = page("order_details_delivered.html").replace(
        "<div>Shipping</div><div>$0.00</div>", "<div>Shipping</div><div>$5.00</div>"
    )
    o = cr.parse_order_details(html)
    assert o is not None and o.shipping_cents == 500
    assert cr.online_request(o, WILL, TZ).tax_cents is None


def test_period_options() -> None:
    assert cr.period_options(page("orders_warehouse.html")) == [
        "Last 3 Months",
        "2026 June - August",
        "2026 March - May",
        "2026 December - February",
        "2025 September - November",
    ]


# Pages that aren't Orders & Purchases ---------------------------------------------------------


@pytest.mark.parametrize(
    ("html", "problem"),
    [
        (
            "<html><body><h1>Sign In</h1><form>Email Address Password</form></body></html>",
            "signed_out",
        ),
        ("<html><body><h1>Access Denied</h1>Reference #18.abc</body></html>", "challenge"),
        ("<html><body></body></html>", "signed_out"),
    ],
)
def test_page_problems(html: str, problem: str) -> None:
    assert cr.page_problem(Snapshot(ORDERS_URL, html)) == problem


def test_orders_pages_are_fine() -> None:
    for name in (
        "orders_online.html",
        "orders_warehouse_receipt.html",
        "order_details_delivered.html",
    ):
        assert cr.page_problem(Snapshot(ORDERS_URL, page(name))) is None


# Sweep -----------------------------------------------------------------------------------------


class FakeCostco:
    """The Orders & Purchases page: Online first, a click to Warehouse, receipt dialogs, period
    picker. Every URL it opens must pass the guard."""

    def __init__(self, online_html: str | None = None, first_page: str | None = None) -> None:
        self.tab: cr.Tab = "online"
        self.period = "Last 3 Months"
        self.receipt: str | None = None
        self.opened: list[str] = []
        self.actions: list[str] = []
        self.online_html = online_html or page("orders_online.html")
        self.first_page = first_page
        self.last: Snapshot | None = None

    def _list(self) -> Snapshot:
        if self.period != "Last 3 Months":  # older quarters: nothing in these fixtures
            html = re.sub(
                r'<div class="(r7|o3)-card">.*?</div></div>\s*(?=<div class="(?:r7|o3)-card"|<div)',
                "",
                page("orders_warehouse.html") if self.tab == "warehouse" else self.online_html,
                flags=re.S,
            )
            html = re.sub(r'id="(viewRecieptBtn|orderNumber)_\d+"', 'id="gone"', html)
            return Snapshot(ORDERS_URL, html)
        html = page("orders_warehouse.html") if self.tab == "warehouse" else self.online_html
        return Snapshot(ORDERS_URL, html)

    def open(self, url: str) -> Snapshot:
        self.last = self._open(url)
        return self.last

    def _open(self, url: str) -> Snapshot:
        guard.check_url(url)
        self.opened.append(url)
        if self.first_page is not None:
            return Snapshot(url, self.first_page)
        if url == ORDERS_URL:
            self.tab, self.period = "online", "Last 3 Months"
            return self._list()
        if url == f"{ACCOUNT}/orderdetails/1000000001":
            return Snapshot(url, page("order_details_delivered.html"))
        if url == f"{ACCOUNT}/orderdetails/1000000002":
            html = (
                page("order_details_delivered.html")
                .replace("1000000001", "1000000002")
                .replace("9000301", "9100001")
            )
            return Snapshot(url, html)
        raise AssertionError(f"unexpected navigation: {url}")

    def costco_ready(self, page: str) -> Snapshot:
        assert self.last is not None
        return self.last

    def costco_tab(self, tab: cr.Tab) -> Snapshot:
        self.actions.append(f"tab:{tab}")
        self.tab, self.period = tab, "Last 3 Months"
        return self._list()

    def costco_period(self, label: str) -> Snapshot:
        self.actions.append(f"period:{label}")
        self.period = label
        return self._list()

    def costco_open_receipt(self, barcode: str) -> Snapshot:
        assert cr.BARCODE.match(barcode)
        self.actions.append(f"receipt:{barcode[-4:]}")
        html = page("orders_warehouse_receipt.html").replace(FIRST, barcode)
        return Snapshot(ORDERS_URL, html)

    def costco_close_receipt(self) -> Snapshot:
        self.actions.append("close")
        return self._list()


class Server:
    def __init__(self) -> None:
        self.ingested: dict[str, dict[str, Any]] = {}
        self.trip_for: set[str] = set()
        self.api = FakeApi({"POST /api/receipts/ingest": self.ingest})

    def ingest(self, body: dict[str, Any] | None) -> Any:
        assert body is not None
        oid = body["external_order_id"]
        dup = oid in self.ingested
        self.ingested[oid] = body
        return {
            "receipt_id": "R-" + oid,
            "duplicate": dup,
            "status": "applied",
            "totals_check": "pass",
            "lines": [],
            "new_item_ids": [],
            "review_ids": [],
            "closed_cycle_id": None,
            "costco_trip_id": "T1" if oid in self.trip_for else None,
        }


def sweeper(server: Server, driver: FakeCostco, tmp: Path, **cfg: Any) -> cr.CostcoSweeper:
    return cr.CostcoSweeper(
        server.api.client(),
        driver,
        CostcoReceiptsConfig(**{"orders_url": ORDERS_URL, **cfg}),
        WILL,
        TZ,
        tmp,
        Telemetry(),
        sleep=lambda _: None,
    )


def test_sweep_reads_both_tabs_with_few_page_loads(tmp_path: Path) -> None:
    server, driver = Server(), FakeCostco()
    sleeps: list[float] = []
    s = sweeper(server, driver, tmp_path)
    s.sleep = sleeps.append
    res = s.run("sweep")
    assert res.complete and res.errors == []
    # One orders page + one details page per delivered online order; the rest are clicks.
    assert driver.opened == [
        ORDERS_URL,
        f"{ACCOUNT}/orderdetails/1000000001",
        f"{ACCOUNT}/orderdetails/1000000002",
    ]
    assert driver.actions[0] == "tab:warehouse"
    # Warehouse oldest first, each opened and closed.
    assert driver.actions[1:] == [
        "receipt:1430",
        "close",
        "receipt:0905",
        "close",
        "receipt:1815",
        "close",
    ]
    assert (res.pages, res.clicks) == (3, 7)
    assert len(sleeps) == 9 and set(sleeps) == {4.0}
    kinds = [(x["kind"], x["lines"]) for x in res.ingested]
    assert kinds == [("warehouse", 5)] * 3 + [("online", 2)] * 2
    body = server.ingested[FIRST]
    assert body["fulfillment"] == "in_store" and body["tax_cents"] == 222
    assert body["lines"][2] == {
        "raw_text": "KS ALMOND MLK",
        "vendor_sku": "9000103",
        "qty": 2.0,
        "unit_price_cents": 699,
        "line_total_cents": 1398,
    }
    assert server.ingested["1000000001"]["fulfillment"] == "delivery"
    (tel,) = s.tel.metrics("receipt_sweep")
    assert tel["vendor"] == "costco"
    assert (tel["warehouse"], tel["online"], tel["pages"], tel["clicks"]) == (3, 2, 3, 7)
    assert (tel["instant_savings"], tel["item_fees"]) == (0, 0)
    # No URL (it carries the account id) in telemetry.
    assert "costco.com" not in json.dumps([e.payload for e in s.tel.events])


def test_a_second_sweep_opens_nothing_new(tmp_path: Path) -> None:
    server = Server()
    sweeper(server, FakeCostco(), tmp_path).run("sweep")
    driver = FakeCostco()
    res = sweeper(server, driver, tmp_path).run("sweep")
    assert driver.opened == [ORDERS_URL]
    assert driver.actions == ["tab:warehouse"]
    assert res.ingested == [] and res.complete


def test_an_order_not_delivered_yet_is_left_for_the_next_sweep(tmp_path: Path) -> None:
    html = page("orders_online.html").replace("Delivered on 10/22/2026", "Shipped on 10/21/2026")
    server, driver = Server(), FakeCostco(online_html=html)
    res = sweeper(server, driver, tmp_path).run("sweep")
    assert res.pending == ["1000000002"]
    assert f"{ACCOUNT}/orderdetails/1000000002" not in driver.opened


def test_backfill_walks_the_period_picker(tmp_path: Path) -> None:
    server, driver = Server(), FakeCostco()
    res = sweeper(server, driver, tmp_path, backfill_periods=3).run("backfill")
    assert res.periods == ["Last 3 Months", "2026 June - August", "2026 March - May"]
    assert driver.actions.count("period:2026 June - August") == 2  # both tabs
    assert len(res.ingested) == 5


@pytest.mark.parametrize(
    ("html", "error"),
    [
        ("<html><body>Sign In Email Password</body></html>", "not_signed_in"),
        ("<html><body><h1>Access Denied</h1></body></html>", "costco_challenge"),
    ],
)
def test_signed_out_or_challenged_stops_at_once(tmp_path: Path, html: str, error: str) -> None:
    server, driver = Server(), FakeCostco(first_page=html)
    res = sweeper(server, driver, tmp_path).run("sweep")
    assert res.errors == [{"error": error}]
    assert driver.opened == [ORDERS_URL] and driver.actions == []
    assert server.ingested == {}
    assert not res.complete


def test_no_orders_url_configured(tmp_path: Path) -> None:
    server, driver = Server(), FakeCostco()
    res = sweeper(server, driver, tmp_path, orders_url=None).run("sweep")
    assert res.errors == [{"error": "costco_orders_url_missing"}]
    assert driver.opened == []


def test_an_ingest_error_is_retried_next_sweep(tmp_path: Path) -> None:
    server = Server()
    calls = {"n": 0}
    original = server.ingest

    def flaky(body: dict[str, Any] | None) -> Any:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(400, json={"error": "bad"})
        return original(body)

    server.api.handlers["POST /api/receipts/ingest"] = flaky
    res = sweeper(server, FakeCostco(), tmp_path).run("sweep")
    assert res.errors[0]["error"] == "ingest_failed"
    assert len(res.ingested) == 4
    res = sweeper(server, FakeCostco(), tmp_path).run("sweep")
    assert len(res.ingested) == 1 and res.complete


# Scheduling and replies -------------------------------------------------------------------------


def test_back_from_costco_schedules_next_morning_and_one_retry(tmp_path: Path) -> None:
    due = cr.schedule_after_trip(tmp_path, date(2026, 11, 7), "2026-11-07")
    assert due == ["2026-11-08", "2026-11-09"]
    assert cr.CostcoState.load(cr.state_path(tmp_path)).due_trip == "2026-11-07"


def test_reply_names_the_trip_receipt(tmp_path: Path) -> None:
    server = Server()
    server.trip_for.add(FIRST)
    res = sweeper(server, FakeCostco(), tmp_path).run("sweep")
    state = cr.CostcoState()
    now = datetime(2026, 11, 8, 17, tzinfo=UTC)
    assert cr.sweep_reply(res, state, now, last_try=False) == (
        "🧾 Costco receipt from Sat 11/7 is in: 5 lines stocked, and the trip is closed."
    )


def test_reply_warns_once_a_week_and_is_silent_otherwise() -> None:
    res = cr.CostcoSweepResult("will", "sweep", errors=[{"error": "not_signed_in"}])
    state = cr.CostcoState()
    now = datetime(2026, 11, 8, 17, tzinfo=UTC)
    assert cr.sweep_reply(res, state, now, last_try=False).startswith("⚠️ Costco is signed out")
    assert cr.sweep_reply(res, state, now, last_try=False) == cr.NO_REPLY
    assert cr.sweep_reply(cr.CostcoSweepResult("will", "sweep"), state, now, last_try=False) == (
        cr.NO_REPLY
    )


def test_reply_on_the_last_try_without_a_receipt() -> None:
    state = cr.CostcoState(due_trip="2026-11-07")
    now = datetime(2026, 11, 9, 17, tzinfo=UTC)
    res = cr.CostcoSweepResult("will", "sweep")
    assert cr.sweep_reply(res, state, now, last_try=True) == (
        "🧾 No Costco receipt for the Sat 11/7 trip yet — the weekly sweep will look again."
    )


# CdpDriver on a real Chromium (skipped without one) ---------------------------------------------

# Orders & Purchases as the live SPA renders it: the frame (`myOrderHistory`, the tabs) at once,
# each tab's cards a moment later (the first live sweep read the frame alone: 0 orders, 0 receipts).
LATE_LIST = """<!doctype html><html><body><div automation-id="myOrderHistory">
<button automation-id="myOnlineOrdersTab" role="tab" aria-selected="true">Online</button>
<button automation-id="myWarehouseOrdersTab" role="tab" aria-selected="false">Warehouse</button>
<div id="list"></div></div><script>
const CARDS = {
  online: '<a id="orderNumber_1000000001" href="#/orderdetails/1000000001">Order</a>',
  warehouse: '<div id="viewRecieptBtn_21099920100422611071815">11/07/2026 - 6:15pm</div>',
};
function show(tab) {
  document.getElementById("list").innerHTML = "";
  setTimeout(() => { document.getElementById("list").innerHTML = CARDS[tab] || ""; }, %(delay)d);
}
for (const tab of ["online", "warehouse"]) {
  document.querySelector(`[automation-id=my${tab[0].toUpperCase() + tab.slice(1)}OrdersTab]`)
    .addEventListener("click", (e) => {
      const tabs = document.querySelectorAll("[role=tab]");
      for (const t of tabs) t.setAttribute("aria-selected", "false");
      e.target.setAttribute("aria-selected", "true");
      show(tab);
    });
}
show("%(first)s");
</script></body></html>"""


@pytest.fixture(scope="module")
def browser_page() -> Any:
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as err:  # no browser installed: `uv run playwright install chromium`
            pytest.skip(f"chromium unavailable: {str(err).splitlines()[0]}")
        yield browser.new_page()
        browser.close()


def _late_list(page_: Any, delay_ms: int = 400, first: str = "online") -> Any:
    from pandabase_tools.browser import CdpDriver

    page_.unroute("**/*")
    html = LATE_LIST % {"delay": delay_ms, "first": first}
    page_.route("**/*", lambda route: route.fulfill(body=html, content_type="text/html"))
    page_.goto("https://www.costco.com/myaccount/")
    driver = CdpDriver("http://127.0.0.1:9222", timeout_ms=2_000)  # never entered
    driver._page = page_
    return driver


def test_cdp_orders_page_waits_for_the_online_cards(browser_page: Any) -> None:
    snap = _late_list(browser_page).costco_ready("orders")
    assert [c.order_number for c in cr.parse_online_list(snap)] == ["1000000001"]


def test_cdp_warehouse_tab_waits_for_the_receipt_cards(browser_page: Any) -> None:
    driver = _late_list(browser_page)
    driver.costco_ready("orders")
    snap = driver.costco_tab("warehouse")
    assert [c.barcode for c in cr.parse_warehouse_list(snap.html)] == [FIRST]


def test_cdp_an_empty_tab_still_returns(browser_page: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from pandabase_tools import browser

    monkeypatch.setattr(browser, "COSTCO_LIST_WAIT_MS", 300, raising=False)
    monkeypatch.setattr(browser, "WIDGET_SETTLE_MS", 300)
    snap = _late_list(browser_page, first="none").costco_ready("orders")
    assert cr.parse_online_list(snap) == [] and cr.page_problem(snap) is None


# Costco's silent session refresh, as seen live (2026-11-16): an expired token sends /myaccount/
# (by redirects, which the driver's route never sees) to signin.costco.com, whose page posts back
# to /OAuthLogonCmd, which sends the browser to /myaccount/ again, signed in. Faked here without
# 3xx responses: Playwright doesn't route a redirect's target, so a fake 302 would reach the real
# costco.com. Every request must be one the fake served (`_no_network`).
ORDERS_URL = "https://www.costco.com/myaccount/#/app/synthetic/ordersandpurchases"
SIGNIN_URL = "https://signin.costco.com/synthetic/oauth2/v2.0/authorize?state=s"
SIGNED_IN = '<html><body><div automation-id="myOrderHistory">Orders</div></body></html>'
AUTO_POST = """<html><body><form id="f" method="post" action="https://www.costco.com/OAuthLogonCmd">
<input type="hidden" name="state" value="synthetic"></form>
<script>document.getElementById("f").submit()</script></body></html>"""
BACK_TO_ACCOUNT = '<html><body><script>location.replace("/myaccount/")</script></body></html>'
SIGNIN_FORM = '<html><body><form><input name="email"><input type="password"></form></body></html>'


@pytest.fixture
def costco_page(browser_page: Any) -> Any:
    """A fresh page per test: a refresh chain left mid-navigation must not leak into the next."""
    page_ = browser_page.context.browser.new_page()
    yield page_
    page_.close()


def _costco_signin(page_: Any, *, loops: bool = False) -> tuple[Any, list[str], list[str]]:
    """A fake costco.com whose session refreshes once (or, `loops`, never), and the driver.
    Returns the driver, the requests the fake served and every request the page made."""
    from pandabase_tools.browser import CdpDriver

    served: list[str] = []
    made: list[str] = []
    state = {"fresh": False}

    def server(route: Any) -> None:
        req = route.request
        url = req.url.split("#")[0].split("?")[0]
        served.append(f"{req.method} {url}")
        if url == "https://www.costco.com/myaccount/":
            body = SIGNED_IN if state["fresh"] else AUTO_POST
        elif url.startswith("https://signin.costco.com/"):
            body = SIGNIN_FORM
        elif url == "https://www.costco.com/OAuthLogonCmd":
            state["fresh"] = not loops
            body = BACK_TO_ACCOUNT
        else:
            route.fulfill(status=404, body="")
            return
        route.fulfill(body=body, content_type="text/html")

    def log(req: Any) -> None:
        made.append(f"{req.method} {req.url.split('#')[0].split('?')[0]}")

    page_.on("request", log)
    page_.route("**/*", server)
    driver = CdpDriver("http://127.0.0.1:9222", timeout_ms=5_000)  # never entered
    driver._page = page_
    return driver, served, made


def _no_network(served: list[str], made: list[str], blocked: Sequence[str] = ()) -> None:
    aborted = {u.split("#")[0].split("?")[0] for u in blocked}
    left = [m for m in made if m not in served and m.split(" ", 1)[1] not in aborted]
    assert made and not left, left


# Bug: the guard aborted the refresh post (`/OAuthLogonCmd`), so the sweep stopped with
# `refused_host` although Costco was still signed in (live sweeps, 2026-11-16).
def test_cdp_costco_silent_session_refresh_lands_on_the_orders_page(costco_page: Any) -> None:
    driver, served, made = _costco_signin(costco_page)
    costco_page.route("**/*", driver._route)  # registered last: it sees each request first
    snap = driver.open(ORDERS_URL)
    assert guard.costco_account_page(snap.url)
    assert "myOrderHistory" in snap.html
    assert driver.refreshes == 1 and driver.blocked == []
    assert served.count("POST https://www.costco.com/OAuthLogonCmd") == 1
    _no_network(served, made)


def test_cdp_costco_refresh_that_never_signs_in_is_not_signed_in(costco_page: Any) -> None:
    # Each refresh lands on a page that posts again: at most COSTCO_REFRESH_MAX posts go out
    # (later ones are aborted), and the sweep's page check says signed out.
    from pandabase_tools import browser

    driver, served, made = _costco_signin(costco_page, loops=True)
    costco_page.route("**/*", driver._route)
    with pytest.raises(browser.NotSignedIn):
        cr.check_page(driver.open(ORDERS_URL))
    costco_page.wait_for_timeout(500)
    posts = served.count("POST https://www.costco.com/OAuthLogonCmd")
    assert 1 <= posts <= browser.COSTCO_REFRESH_MAX
    assert any(guard.costco_session_refresh(u) for u in driver.blocked)
    _no_network(served, made, driver.blocked)


def test_cdp_costco_sign_in_form_waiting_for_a_person_is_not_signed_in(
    costco_page: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Live, the redirects land the page on signin.costco.com; here the page is put there first.
    from pandabase_tools import browser

    monkeypatch.setattr(browser, "COSTCO_REFRESH_WAIT_MS", 1_000)
    driver, served, made = _costco_signin(costco_page)
    costco_page.goto(SIGNIN_URL)
    costco_page.route("**/*", driver._route)
    with pytest.raises(browser.NotSignedIn):
        driver._await_costco_refresh(0)
    assert driver.refreshes == 0
    _no_network(served, made)


def test_cdp_no_refresh_post_outside_a_costco_open(costco_page: Any) -> None:
    # A page posting to /OAuthLogonCmd on its own (no `open` of a Costco account page) is aborted.
    driver, served, made = _costco_signin(costco_page)
    costco_page.route("**/*", driver._route)
    costco_page.goto(ORDERS_URL)  # the auto-post page, not through `driver.open`
    costco_page.wait_for_timeout(300)
    assert driver.refreshes == 0
    assert any(guard.costco_session_refresh(u) for u in driver.blocked)
    _no_network(served, made, driver.blocked)


def test_costco_refresh_page_is_never_opened_or_read() -> None:
    # Only the browser's own post from the sign-in page goes through; no tool may open it.
    url = "https://www.costco.com/OAuthLogonCmd"
    assert guard.costco_session_refresh(url)
    assert guard.classify_url(url) == "host"
    with pytest.raises(guard.UnsafeUrl):
        guard.check_url(url)
    assert not guard.costco_session_refresh("https://www.costco.com.evil.test/OAuthLogonCmd")
    assert not guard.costco_session_refresh("http://www.costco.com/OAuthLogonCmd")
    assert not guard.costco_session_refresh("https://www.costco.com/OAuthLogonCmd/cart")


def _one_item_order_with_fee_and_discount() -> str:
    """The committed order cut to its first item, with a fee inside that item's block and a
    "Discount on Order" row: the live one-item order's shape (2026-11-16), synthetic numbers."""
    html = page("order_details_delivered.html")
    second = re.search(
        r'\s*<div class="d6-item">(?:(?!<div class="d6-item">).)*?9000301.*?</button>\s*</div>',
        html,
        re.S,
    )
    assert second is not None
    html = html.replace(second.group(0), "")
    fee = (
        '<div>CA BEP FEE PERCENT</div><div class="d6-p">$1.20</div>'
        '<div class="d6-q"><span>Quantity 1</span><div>Total</div><div>$1.20</div></div>'
    )
    html = html.replace(
        '<div class="d6-q"><span>Quantity 1</span><div>Total</div><div>$27.99</div></div>',
        '<div class="d6-q"><span>Quantity 1</span><div>Total</div><div>$27.99</div></div>' + fee,
    )
    return (
        html.replace(
            "<div><h3>Subtotal</h3><div>$52.97</div></div>",
            "<div><h3>Subtotal</h3><div>$29.19</div></div><div><h4>Discount on Order</h4>"
            '<div automation-id="totalDiscountOutput">-$5.00</div></div>',
        )
        .replace(
            '<div automation-id="taxOutput">$2.59</div>',
            '<div automation-id="taxOutput">$2.00</div>',
        )
        .replace("<h3>Total</h3><div>$55.56</div>", "<h3>Total</h3><div>$26.19</div>")
    )


# Bug: on the live one-item order (2026-11-16) the item's block grew to the whole page (no second
# item to stop it), so its price was the summary's first amount and its line total the fee's: the
# totals check failed. And "Discount on Order" broke subtotal + tax = total.
def test_one_item_order_reads_the_item_and_adds_its_fee() -> None:
    o = cr.parse_order_details(_one_item_order_with_fee_and_discount())
    assert o is not None and len(o.lines) == 1
    line = o.lines[0]
    assert (line.vendor_sku, line.qty, line.unit_price_cents, line.line_total_cents) == (
        "9000201",
        1.0,
        2799,
        2919,
    )
    assert o.fees == 1 and o.discount_cents == 500
    assert sum(x.line_total_cents or 0 for x in o.lines) == o.subtotal_cents
    req = cr.online_request(o, WILL, TZ)
    assert req.tax_cents is None  # subtotal + tax ≠ total with an order discount


def test_two_item_order_is_unchanged() -> None:
    o = cr.parse_order_details(page("order_details_delivered.html"))
    assert o is not None
    assert [(x.unit_price_cents, x.line_total_cents) for x in o.lines] == [
        (2799, 2799),
        (1249, 2498),
    ]
    assert o.fees == 0 and o.discount_cents is None
    assert cr.online_request(o, WILL, TZ).tax_cents == 259
