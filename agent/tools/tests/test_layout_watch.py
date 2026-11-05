"""Amazon layout watch: the build alert rule and the weekly add-button check (synthetic pages)."""

from __future__ import annotations

from collections.abc import Callable

from conftest import FakeDriver

from pandabase_tools.cart_injector import LineOutcome, Outcome
from pandabase_tools.config import CartConfig
from pandabase_tools.layout_watch import PAGE_REASONS, layout_alert, probe, probe_reply
from pandabase_tools.telemetry import Telemetry

DP = "https://www.amazon.com/dp/"
AMAZON = "B0SYNTH501"  # product_buy_box.html: the buy box's own "Add to cart"
WF = "B0SYNTH301"  # product_wholefoods.html: the Whole Foods buy-box widget
PROBES = {"amazon": AMAZON, "wholefoods": WF}


def _line(i: int, outcome: Outcome, reason: str | None) -> LineOutcome:
    return LineOutcome(
        index=i,
        name=f"line{i}",
        quantity=1,
        item_id=f"I{i}",
        product_id=f"P{i}",
        asin=f"B0SYNTH{i:03d}",
        vendor="amazon",
        free_text=None,
        outcome=outcome,
        reason=reason,
    )


def _build(*reasons: str | None) -> list[LineOutcome]:
    """Tier-1 lines of one build: `None` = added, a reason = not added for that reason."""
    return [
        _line(i, "added", None) if r is None else _line(i, "needs_agent", r)
        for i, r in enumerate(reasons)
    ]


# --- the alert rule: ≥ 2 page-related failures and ≥ half of the build ------------------------


def test_two_page_failures_out_of_three_lines_raise_the_alert() -> None:
    alert = layout_alert(_build("no_add_form", "unverified", None), CartConfig())
    assert alert is not None
    assert (alert["page_failures"], alert["attempted"]) == (2, 3)
    assert alert["reasons"] == {"no_add_form": 1, "unverified": 1}
    assert alert["asins"] == ["B0SYNTH000", "B0SYNTH001"]


def test_exactly_half_is_enough() -> None:
    assert layout_alert(_build("no_add_form", "no_add_form", None, None), CartConfig())


def test_one_page_failure_is_never_an_alert_even_when_it_is_the_whole_build() -> None:
    assert layout_alert(_build("no_add_form"), CartConfig()) is None
    assert layout_alert(_build("no_add_form", None), CartConfig()) is None


def test_two_page_failures_in_a_big_build_are_not_an_alert() -> None:
    assert layout_alert(_build("no_add_form", "unverified", None, None, None), CartConfig()) is None


def test_failures_that_are_not_about_the_page_never_count() -> None:
    lines = _build("no_add_form", None)
    lines += [
        _line(2, "failed", "not_signed_in"),  # the session, not the layout
        _line(3, "failed", "extra_items"),  # a bundle came along: a human looks
        _line(4, "failed", "refused_checkout"),  # the guard did its job
        _line(5, "needs_agent", "TimeoutError: page took too long"),  # network blip
        _line(6, "added", "already_in_cart"),
    ]
    assert layout_alert(lines, CartConfig()) is None
    assert not {"not_signed_in", "extra_items", "refused_checkout"} & PAGE_REASONS


def test_the_old_add_url_layout_signals_count_too() -> None:
    alert = layout_alert(_build("layout_changed", "not_offered", "confirm_not_found"), CartConfig())
    assert alert is not None and alert["page_failures"] == 3


def test_the_thresholds_are_tunable() -> None:
    cfg = CartConfig(layout_alert_min_lines=3, layout_alert_share=0.75)
    assert layout_alert(_build("no_add_form", "no_add_form", None), cfg) is None
    assert layout_alert(_build("no_add_form", "no_add_form", "no_add_form", None), cfg)


def test_an_empty_build_is_quiet() -> None:
    assert layout_alert([], CartConfig()) is None


# --- the weekly check: open one product page per store, find the add button, click nothing ----


def _pages(amazon: tuple[str, str] | None = None, wf: tuple[str, str] | None = None) -> FakeDriver:
    pages = {
        DP + AMAZON: amazon or (DP + AMAZON, "product_buy_box.html"),
        DP + WF: wf or (DP + WF, "product_wholefoods.html"),
    }
    return FakeDriver(pages)


def test_probe_finds_both_add_buttons_without_clicking(no_sleep: Callable[[float], None]) -> None:
    driver = _pages()
    tel = Telemetry()
    res = probe(driver, PROBES, tel, no_sleep)
    assert res["ok"] is True and res["status"] == "ok"
    assert [(c["store"], c["found"], c["reason"]) for c in res["checks"]] == [
        ("amazon", True, None),
        ("wholefoods", True, None),
    ]
    assert driver.opened == [DP + AMAZON, DP + WF]  # no cart page, nothing else
    assert driver.clicks == 0 and driver.added == []
    assert [(m["store"], m["found"]) for m in tel.metrics("cart_probe")] == [
        ("amazon", True),
        ("wholefoods", True),
    ]
    assert probe_reply(res) == "NO_REPLY"
    driver.assert_never_checkout()


def test_probe_reports_a_missing_whole_foods_add_button(no_sleep: Callable[[float], None]) -> None:
    driver = _pages(wf=(DP + WF, "product_unavailable.html"))
    res = probe(driver, PROBES, Telemetry(), no_sleep)
    assert res["ok"] is False and res["status"] == "layout_changed"
    assert [(c["store"], c["reason"]) for c in res["checks"]] == [
        ("amazon", None),
        ("wholefoods", "no_add_form"),
    ]
    reply = probe_reply(res)
    assert reply.startswith("⚠️") and "Whole Foods" in reply and "layout" in reply
    assert "Amazon product page" not in reply


def test_probe_off_the_product_page_is_a_layout_problem(no_sleep: Callable[[float], None]) -> None:
    # e.g. a bot check or a redirect: whatever page we land on, it isn't /dp/<ASIN>.
    captcha = "https://www.amazon.com/errors/validateCaptcha"
    driver = _pages(amazon=(captcha, "product_buy_box.html"))
    res = probe(driver, PROBES, Telemetry(), no_sleep)
    assert res["checks"][0]["reason"] == "not_product_page"
    assert res["status"] == "layout_changed"


def test_probe_signed_out_says_sign_in_not_layout(no_sleep: Callable[[float], None]) -> None:
    signin = "https://www.amazon.com/ap/signin?openid.return_to=x"
    driver = FakeDriver(lambda _url: (signin, "product_buy_box.html"))
    res = probe(driver, PROBES, Telemetry(), no_sleep)
    assert res["status"] == "not_signed_in"
    assert {c["reason"] for c in res["checks"]} == {"not_signed_in"}
    reply = probe_reply(res)
    assert "sign" in reply.lower() and "layout" not in reply


def test_probe_page_error_is_reported_not_raised(no_sleep: Callable[[float], None]) -> None:
    def boom(_url: str) -> tuple[str, str]:
        raise TimeoutError("slow")

    res = probe(FakeDriver(boom), {"amazon": AMAZON}, Telemetry(), no_sleep)
    assert res["checks"] == [
        {"store": "amazon", "asin": AMAZON, "found": False, "reason": "TimeoutError"}
    ]
    assert res["status"] == "error"
    assert probe_reply(res).startswith("⚠️")


def test_probe_without_configured_asins_says_so(no_sleep: Callable[[float], None]) -> None:
    driver = FakeDriver({})
    res = probe(driver, {}, Telemetry(), no_sleep)
    assert res == {"ok": False, "status": "not_configured", "checks": []}
    assert driver.opened == []
    assert "cart.probe_asins" in probe_reply(res)
