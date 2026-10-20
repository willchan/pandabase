"""Order history → receipts: extraction, final-state filtering, cursor/backfill resume, fallback."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import FakeApi, FakeDriver, fixture

from pandabase_tools import guard
from pandabase_tools.browser import Snapshot
from pandabase_tools.config import Member, ReceiptsConfig
from pandabase_tools.receipt_parser import (
    Sweeper,
    ingest_request,
    order_status,
    parse_order_details,
    parse_order_list,
)
from pandabase_tools.telemetry import Telemetry

TODAY = date(2026, 10, 20)
BASE = "https://www.amazon.com"
LIST = BASE + "/your-orders/orders?timeFilter=months-3"
PAGE2 = LIST + "&startIndex=10"
WILL = Member(name="will", discord_id="1001", profile="will", cart_member=True)


def details_url(oid: str) -> str:
    return f"{BASE}/your-orders/order-details?orderID={oid}"


DETAILS = {
    "111-0000001-0000001": "order_details_arriving.html",
    "112-0000002-0000002": "order_details_pickup.html",
    "113-0000003-0000003": "order_details_instore.html",
    "114-0000004-0000004": "order_details_delivery.html",
    "116-0000006-0000006": "order_details_layout_changed.html",
    "117-0000007-0000007": "order_details_delivery.html",
}


def site(url: str) -> tuple[str, str] | None:
    if url == LIST:
        return (url, "orders_list_p1.html")
    if url == PAGE2:
        return (url, "orders_list_p2.html")
    for oid, name in DETAILS.items():
        if url == details_url(oid):
            return (url, name)
    return None


def parse(name: str, oid: str) -> Any:
    return parse_order_details(Snapshot(details_url(oid), fixture(name)), oid, TODAY)


def test_order_list_page() -> None:
    orders, next_url = parse_order_list(Snapshot(LIST, fixture("orders_list_p1.html")), TODAY)
    assert [(o.order_id, o.ordered_on, o.status) for o in orders] == [
        ("111-0000001-0000001", "2026-10-18", "pending"),
        ("112-0000002-0000002", "2026-10-17", "final"),
        ("113-0000003-0000003", "2026-10-14", "final"),
        ("114-0000004-0000004", "2026-10-12", "final"),
        ("115-0000005-0000005", "2026-10-10", "cancelled"),
    ]
    assert orders[1].details_url == details_url("112-0000002-0000002")
    assert next_url == PAGE2
    _, last = parse_order_list(Snapshot(PAGE2, fixture("orders_list_p2.html")), TODAY)
    assert last is None


@pytest.mark.parametrize(
    ("text", "status"),
    [
        ("Delivered October 13", "final"),
        ("Picked up Oct 17", "final"),
        ("Purchased in store", "final"),
        ("Arriving tomorrow", "pending"),
        ("Ready for pickup", "pending"),
        ("Order was cancelled", "cancelled"),
        ("Something new", "unknown"),
    ],
)
def test_order_status(text: str, status: str) -> None:
    assert order_status(text) == status


def test_delivery_details_skip_nav_and_recommendations() -> None:
    o = parse("order_details_delivery.html", "114-0000004-0000004")
    assert (o.status, o.fulfillment, o.vendor) == ("final", "delivery", "amazon")
    assert (o.ordered_on, o.acquired_on) == (date(2026, 10, 12), date(2026, 10, 13))
    assert [(x.asin, x.title, x.qty, x.unit_price_cents, x.line_total_cents) for x in o.lines] == [
        ("B0SYNTH001", "Synthetic Rolled Oats, 32 oz", 2.0, 499, 998),
        ("B0SYNTH004", "Synthetic Creamy Peanut Butter, 16 oz", 1.0, 349, 349),
    ]
    assert (o.subtotal_cents, o.total_cents) == (1347, 1420)


def test_whole_foods_pickup_details() -> None:
    o = parse("order_details_pickup.html", "112-0000002-0000002")
    assert (o.status, o.fulfillment, o.vendor) == ("final", "pickup", "wholefoods")
    assert o.acquired_on == date(2026, 10, 17)
    assert [(x.asin, x.qty, x.unit_price_cents) for x in o.lines] == [
        ("B0SYNTHWF1", 6.0, 29),
        ("B0SYNTHWF2", 1.0, 395),
        ("B0SYNTHWF5", 1.0, 479),
    ]
    assert o.total_cents == 1048


def test_whole_foods_in_store_details_use_gp_product_links() -> None:
    o = parse("order_details_instore.html", "113-0000003-0000003")
    assert (o.status, o.fulfillment, o.vendor) == ("final", "in_store", "wholefoods")
    assert o.acquired_on == date(2026, 10, 14)
    assert [(x.asin, x.title, x.qty, x.line_total_cents) for x in o.lines] == [
        ("B0SYNTHWF3", "Synthetic Sourdough Loaf", 1.0, 599),
        ("B0SYNTHWF4", "Synthetic Oat Milk, 64 oz", 2.0, 738),
    ]
    assert o.total_cents == 1337


def test_ingest_request_is_contract_shaped() -> None:
    o = parse("order_details_pickup.html", "112-0000002-0000002")
    body = ingest_request(o, WILL, "America/Los_Angeles").model_dump(
        mode="json", exclude_unset=True
    )
    assert body["account"] == body["actor_discord_id"] == "1001"
    assert body["source"] == "digital" and body["external_order_id"] == "112-0000002-0000002"
    assert body["acquired_at"] == "2026-10-17T19:00:00Z"  # local noon, PDT
    assert body["fulfillment"] == "pickup" and body["vendor"] == "wholefoods"


class Server:
    """Fake State Engine for the receipts routes."""

    def __init__(self, cursor_ordered_at: str | None) -> None:
        self.cursor = cursor_ordered_at
        self.ingested: dict[str, dict[str, Any]] = {}
        self.fail_once: set[str] = set()
        self.api = FakeApi(
            {
                "GET /api/receipts/cursor": lambda _: {
                    "account_member_id": "M1",
                    "external_order_id": None,
                    "ordered_at": self.cursor,
                    "acquired_at": self.cursor,
                },
                "POST /api/receipts/ingest": self.ingest,
            }
        )

    def ingest(self, body: dict[str, Any] | None) -> Any:
        assert body is not None
        oid = body["external_order_id"]
        if oid in self.fail_once:
            self.fail_once.discard(oid)
            return httpx.Response(500, json={"error": "boom"})
        dup = oid in self.ingested
        self.ingested[oid] = body
        return {
            "receipt_id": "R-" + oid,
            "duplicate": dup,
            "status": "applied",
            "totals_check": "n/a",
            "lines": [],
            "new_item_ids": [],
            "review_ids": [],
            "closed_cycle_id": None,
        }


def sweeper(
    server: Server, driver: FakeDriver, tmp: Path, sleep: Callable[[float], None], **cfg: Any
) -> Sweeper:
    return Sweeper(
        server.api.client(),
        driver,
        ReceiptsConfig(**cfg),
        WILL,
        "America/Los_Angeles",
        tmp,
        Telemetry(),
        today=TODAY,
        sleep=sleep,
    )


def test_sweep_ingests_final_orders_oldest_first(tmp_path: Path) -> None:
    server = Server("2026-10-01T19:00:00Z")  # window: since 2026-09-17
    sleeps: list[float] = []
    driver = FakeDriver(site)
    res = sweeper(server, driver, tmp_path, sleeps.append).run("sweep")
    assert [x["order_id"] for x in res.ingested] == [
        "114-0000004-0000004",  # Oct 12 delivered
        "113-0000003-0000003",  # Oct 14 in-store
        "112-0000002-0000002",  # Oct 17 pickup
    ]
    assert res.pending == ["111-0000001-0000001"]
    assert res.skipped == [{"order_id": "115-0000005-0000005", "reason": "cancelled"}]
    # Sep 1 order is older than the window: never opened.
    assert details_url("117-0000007-0000007") not in driver.opened
    assert [x["order_id"] for x in res.needs_agent_extraction] == ["116-0000006-0000006"]
    assert res.pages == 2 and res.complete  # the fallback order is handed to the agent
    # Throttled: one sleep between every page load.
    assert len(sleeps) == len(driver.opened) - 1 and set(sleeps) == {3.0}
    # Every POST carried an Idempotency-Key; the actor is the account's member.
    posts = [r for r in server.api.requests if r.method == "POST"]
    assert posts and all(
        r.headers.get("Idempotency-Key", "").startswith("receipt:1001:") for r in posts
    )
    driver.assert_never_checkout()


def test_zero_asin_fallback_output(tmp_path: Path) -> None:
    res = sweeper(Server("2026-10-01T19:00:00Z"), FakeDriver(site), tmp_path, lambda _: None).run(
        "sweep"
    )
    fb = res.needs_agent_extraction[0]
    assert fb["account"] == "1001" and fb["vendor"] == "amazon"
    assert fb["acquired_at"] == "2026-10-06T19:00:00+00:00"
    assert "Synthetic Dish Soap" in fb["text"] and "Grand Total: $9.07" in fb["text"]


def test_second_sweep_skips_done_orders(tmp_path: Path) -> None:
    server = Server("2026-10-01T19:00:00Z")
    sweeper(server, FakeDriver(site), tmp_path, lambda _: None).run("sweep")
    driver = FakeDriver(site)
    res = sweeper(server, driver, tmp_path, lambda _: None).run("sweep")
    assert res.ingested == []
    opened = {u for u in driver.opened if "order-details" in u}
    # Only the in-flight and the fallback orders are looked at again.
    assert opened == {details_url("116-0000006-0000006")}
    assert res.pending == ["111-0000001-0000001"]


def test_no_cursor_uses_initial_window(tmp_path: Path) -> None:
    driver = FakeDriver(site)
    res = sweeper(Server(None), driver, tmp_path, lambda _: None, initial_sweep_days=7).run("sweep")
    assert res.since == "2026-10-13"
    assert [x["order_id"] for x in res.ingested] == ["113-0000003-0000003", "112-0000002-0000002"]
    assert PAGE2 not in driver.opened  # page 1 already reached orders older than the window


def test_backfill_resumes_after_interruption(tmp_path: Path) -> None:
    urls = {
        BASE + "/your-orders/orders?timeFilter=year-2026": "orders_list_p1.html",
        BASE + "/your-orders/orders?timeFilter=year-2025": "orders_list_p2.html",
    }
    calls = {"n": 0}

    def flaky(url: str) -> tuple[str, str] | None:
        if url in urls:
            return (url, urls[url])
        if url == PAGE2:
            return (url, "orders_list_p2.html")
        if url == details_url("113-0000003-0000003"):
            calls["n"] += 1
            if calls["n"] == 1:
                raise guard.UnsafeUrl(url, "checkout")  # simulate the run dying mid-way
        return site(url)

    server = Server(None)
    first = sweeper(server, FakeDriver(flaky), tmp_path, lambda _: None).run("backfill")
    assert first.complete is False and first.errors
    assert [x["order_id"] for x in first.ingested] == ["117-0000007-0000007", "114-0000004-0000004"]
    state = json.loads((tmp_path / "receipts-will.json").read_text())
    assert state["run"]["mode"] == "backfill" and state["run"]["collect_done"] is True

    driver = FakeDriver(flaky)
    second = sweeper(server, driver, tmp_path, lambda _: None).run("backfill")
    # Resumed: no list pages re-walked, nothing re-ingested, picks up where it stopped.
    assert not any("your-orders/orders" in u for u in driver.opened)
    assert [x["order_id"] for x in second.ingested] == [
        "113-0000003-0000003",
        "112-0000002-0000002",
    ]
    assert set(server.ingested) == {
        "117-0000007-0000007",
        "114-0000004-0000004",
        "113-0000003-0000003",
        "112-0000002-0000002",
    }


def test_backfill_max_orders_then_resume(tmp_path: Path) -> None:
    server = Server(None)
    pages = {BASE + "/your-orders/orders?timeFilter=year-2026": (LIST, "orders_list_p1.html")}

    def nav(url: str) -> tuple[str, str] | None:
        return pages.get(url) or site(url) or (url, "orders_list_p2.html")

    first = sweeper(server, FakeDriver(nav), tmp_path, lambda _: None).run("backfill", max_orders=1)
    assert len(first.ingested) == 1 and first.complete is False
    second = sweeper(server, FakeDriver(nav), tmp_path, lambda _: None).run("backfill")
    assert len(first.ingested) + len(second.ingested) == 4


def test_signed_out_profile_reports_error(tmp_path: Path) -> None:
    signin = "https://www.amazon.com/ap/signin?return=orders"
    driver = FakeDriver(lambda url: (signin, "orders_list_p1.html"))
    res = sweeper(Server(None), driver, tmp_path, lambda _: None).run("sweep")
    assert res.errors == [{"error": "not_signed_in", "profile": "will"}]
    assert res.ingested == []


def test_transient_api_error_retries_with_same_key(tmp_path: Path) -> None:
    server = Server("2026-10-01T19:00:00Z")
    server.fail_once.add("114-0000004-0000004")
    sweeper(server, FakeDriver(site), tmp_path, lambda _: None).run("sweep")
    keys = [
        r.headers["Idempotency-Key"]
        for r in server.api.requests
        if r.method == "POST" and b"114-0000004-0000004" in r.content
    ]
    assert len(keys) == 2 and keys[0] == keys[1]
    assert "114-0000004-0000004" in server.ingested
