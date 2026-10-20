"""Tier-1 injection: URL building/batching, result classification, layout-changed fallback."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from conftest import FakeDriver, fixture

from pandabase_tools import contracts as c
from pandabase_tools.browser import Snapshot
from pandabase_tools.cart_injector import (
    BuildState,
    LineOutcome,
    add_url,
    analyze_add_page,
    batches,
    extract_price_cents,
    inject,
    plan,
    price_checks,
    purchase_qty,
    result_request,
)
from pandabase_tools.config import CartConfig
from pandabase_tools.telemetry import Telemetry

ADD = "https://www.amazon.com/gp/aws/cart/add.html"
VIEW = "https://www.amazon.com/gp/cart/view.html"


def product(pid: str, asin: str | None, vendor: str = "amazon") -> dict[str, Any]:
    return {
        "id": pid,
        "asin": asin,
        "title": pid,
        "vendor": vendor,
        "stance": "preferred",
        "unit_quantity": 1,
        "last_price_cents": None,
        "quote_cents": None,
    }


def line(name: str, prod: dict[str, Any] | None, qty: float = 1, **kw: Any) -> dict[str, Any]:
    return {
        "item_id": kw.get("item_id", "I-" + name),
        "name": name,
        "free_text": kw.get("free_text"),
        "product": prod,
        "quantity": qty,
        "reason_text": f"{name}: running low",
        "switched": False,
    }


def cart(*lines: dict[str, Any]) -> c.CartResponse:
    return c.CartResponse.model_validate({"cycle_id": "C1", "lines": list(lines)})


def items_of(url: str) -> list[tuple[str, str]]:
    return parse_qsl(urlsplit(url).query)


def test_add_url_and_quantities() -> None:
    url = add_url([("B0SYNTH001", 2), ("B0SYNTH002", 1)])
    assert url.startswith(ADD + "?")
    assert items_of(url) == [
        ("ASIN.1", "B0SYNTH001"),
        ("Quantity.1", "2"),
        ("ASIN.2", "B0SYNTH002"),
        ("Quantity.2", "1"),
    ]
    assert [purchase_qty(q) for q in (0.2, 1, 1.0000000001, 1.5, 3)] == [1, 1, 1, 2, 3]


def test_plan_routes_lines_without_asin_or_tier1_vendor_to_the_agent() -> None:
    res = cart(
        line("oats", product("P1", "B0SYNTH001")),
        line("candles", None, free_text="birthday candles"),
        line("cheese", product("P2", None)),
        line("bananas", product("P3", "B0SYNTHWF1", "wholefoods"), 6),
    )
    tier1, agent = plan(res, CartConfig())
    assert [x.name for x in tier1] == ["oats"]
    assert {x.name: x.reason for x in agent} == {
        "candles": "no_product",
        "cheese": "no_asin",
        "bananas": "vendor_not_tier1:wholefoods",
    }
    tier1, _ = plan(res, CartConfig(wholefoods_tier1=True))
    assert [x.name for x in tier1] == ["oats", "bananas"]


def test_batches_split_by_vendor_and_size() -> None:
    res = cart(
        *[line(f"a{i}", product(f"P{i}", f"B0SYNTHA{i:02d}")) for i in range(5)],
        *[line(f"w{i}", product(f"W{i}", f"B0SYNTHW{i:02d}", "wholefoods")) for i in range(3)],
    )
    tier1, _ = plan(res, CartConfig(wholefoods_tier1=True))
    groups = batches(tier1, 2)
    assert [[x.name for x in g] for g in groups] == [
        ["a0", "a1"],
        ["a2", "a3"],
        ["a4"],
        ["w0", "w1"],
        ["w2"],
    ]


def test_confirm_page_analysis() -> None:
    page = analyze_add_page(Snapshot(ADD, fixture("cart_add_confirm.html")))
    assert page.kind == "confirm"
    assert page.offered == {"B0SYNTH001", "B0SYNTH002"}  # 003 is unavailable
    assert analyze_add_page(Snapshot(VIEW, fixture("cart_added.html"))).kind == "added"
    changed = analyze_add_page(Snapshot(ADD, fixture("cart_add_layout_changed.html")))
    assert changed.kind == "layout_changed"


def _driver(
    confirm_page: str = "cart_added.html",
    add_page: str = "cart_add_confirm.html",
    landing: str = VIEW,
) -> FakeDriver:
    def pages(url: str) -> tuple[str, str] | None:
        return (url, add_page) if url.startswith(ADD + "?") else None

    def confirm(_: str) -> tuple[str, str] | None:
        return (landing, confirm_page) if confirm_page else None

    return FakeDriver(pages, confirm)


def _lines() -> list[LineOutcome]:
    tier1, _ = plan(
        cart(
            line("oats", product("P1", "B0SYNTH001"), 2),
            line("towels", product("P2", "B0SYNTH002")),
            line("water", product("P3", "B0SYNTH003")),
            line("soap", product("P4", "B0SYNTH009")),  # not on the confirm page at all
        ),
        CartConfig(),
    )
    return tier1


def test_inject_classifies_added_needs_agent_failed(no_sleep: Callable[[float], None]) -> None:
    driver, tel = _driver(), Telemetry()
    res = inject(driver, _lines(), CartConfig(), tel, no_sleep)
    assert [x.name for x in res.added] == ["oats", "towels"]
    assert {x.name: x.reason for x in res.needs_agent} == {
        "water": "not_offered",
        "soap": "not_offered",
    }
    assert res.failed == []
    assert driver.clicks == 1 and len(driver.opened) == 1
    assert items_of(driver.opened[0])[:2] == [("ASIN.1", "B0SYNTH001"), ("Quantity.1", "2")]
    per_line = tel.metrics("cart_tier1_line")
    assert [m["outcome"] for m in per_line] == ["added", "added", "needs_agent", "needs_agent"]
    driver.assert_never_checkout()


def test_layout_changed_falls_back_to_the_agent(no_sleep: Callable[[float], None]) -> None:
    driver, tel = _driver(add_page="cart_add_layout_changed.html"), Telemetry()
    res = inject(driver, _lines(), CartConfig(), tel, no_sleep)
    assert res.added == [] and res.failed == []
    assert {x.reason for x in res.needs_agent} == {"layout_changed"}
    assert driver.clicks == 0
    assert tel.metrics("selector_error")[0]["error"] == "layout_changed"


def test_unverified_after_click_goes_to_the_agent(no_sleep: Callable[[float], None]) -> None:
    # No "added" message and not a cart page: we can't tell, so the agent checks.
    driver = _driver(confirm_page="cart_add_layout_changed.html", landing=ADD)
    tel = Telemetry()
    res = inject(driver, _lines(), CartConfig(), tel, no_sleep)
    assert {x.name: x.reason for x in res.needs_agent}["oats"] == "unverified"
    assert tel.metrics("selector_error")[0]["selector"] == "cart_add_result"


def test_confirm_control_missing(no_sleep: Callable[[float], None]) -> None:
    driver, tel = _driver(confirm_page=""), Telemetry()
    res = inject(driver, _lines(), CartConfig(), tel, no_sleep)
    assert {x.name: x.reason for x in res.needs_agent}["oats"] == "confirm_not_found"


def test_redirect_to_checkout_after_click_is_refused(no_sleep: Callable[[float], None]) -> None:
    def pages(url: str) -> tuple[str, str]:
        return (url, "cart_add_confirm.html")

    spc = "https://www.amazon.com/gp/buy/spc/handlers/display.html"
    driver = FakeDriver(pages, lambda _: (spc, "cart_added.html"))
    res = inject(driver, _lines(), CartConfig(), Telemetry(), no_sleep)
    assert {x.reason for x in res.failed} == {"refused_checkout"}
    assert len(driver.opened) == 1  # nothing else was opened after landing there


def test_signed_out_profile_fails_without_logging_in(no_sleep: Callable[[float], None]) -> None:
    signin = "https://www.amazon.com/ap/signin?openid.return_to=cart"
    driver = FakeDriver(lambda url: (signin, "cart_add_confirm.html"))
    res = inject(driver, _lines(), CartConfig(), Telemetry(), no_sleep)
    assert {x.reason for x in res.failed} == {"not_signed_in"}
    assert driver.clicks == 0


def test_result_request_maps_outcomes() -> None:
    lines = _lines()
    lines[0].outcome = "added"
    lines[1].outcome, lines[1].reason = "failed", "boom"
    lines[2].outcome, lines[2].reason = "needs_agent", "not_offered"
    lines[3].outcome, lines[3].reason = "needs_agent", "not_offered"
    body = result_request(lines, {2: "tier2"})
    assert [(x.outcome, x.error) for x in body.lines] == [
        ("tier1", None),
        ("failed", "boom"),
        ("tier2", None),
        ("failed", "not_offered"),  # the agent didn't report it
    ]
    assert body.model_dump(mode="json", exclude_unset=True)["lines"][0]["item_id"] == "I-oats"


def test_build_state_round_trip(tmp_path: Any) -> None:
    from pandabase_tools.cart_injector import InjectResult

    state = BuildState(tmp_path, "C1")
    res = InjectResult()
    for x in _lines():
        res.put(x)
    state.save(res, posted=False)
    assert [x.name for x in state.lines()] == ["oats", "towels", "water", "soap"]


def test_price_extraction() -> None:
    assert extract_price_cents(fixture("product_jsonld.html")) == 479
    assert extract_price_cents(fixture("product_offscreen.html")) == 749
    assert extract_price_cents(fixture("product_no_price.html")) is None


def test_price_checks_quote_candidates_and_log_failures(no_sleep: Callable[[float], None]) -> None:
    preds = c.PredictionsResponse.model_validate(
        {
            "cycle_id": "C1",
            "generated_at": "2026-10-24T17:00:00Z",
            "needs_price_check_item_ids": ["I-eggs"],
            "skipped_item_ids": [],
            "lines": [
                {
                    "item_id": "I-eggs",
                    "name": "Eggs",
                    "free_text": None,
                    "base_unit": "egg",
                    "quantity": 1,
                    "reason": "runout",
                    "overrides": [],
                    "product": None,
                    "needs_price_check": True,
                    "choice_reason": None,
                    "candidates": [
                        product("P1", "B0SYNTH001"),
                        product("P5", "B0SYNTH005"),
                        product("P6", "B0SYNTH006"),
                        product("P7", None),
                    ],
                },
            ],
        }
    )
    files = {"B0SYNTH001": "product_jsonld.html", "B0SYNTH005": "product_offscreen.html"}

    def pages(url: str) -> tuple[str, str]:
        asin = url.rsplit("/", 1)[-1]
        return (url, files.get(asin, "product_no_price.html"))

    tel = Telemetry()
    quotes = price_checks(FakeDriver(pages), preds, CartConfig(), tel, no_sleep)
    assert [(q.product_id, q.price_cents) for q in quotes] == [("P1", 479), ("P5", 749)]
    assert [m["error"] for m in tel.metrics("price_lookup_failed")] == ["no_price", "no_asin"]
