"""Tier-2 cart fallback through the guarded driver: `cart search` (read-only) and `cart add`.

Tier 2 used to drive OpenClaw's raw browser tool on the signed-in profile, where nothing but the
skill's wording kept a prompt-injected model away from Buy Now / checkout. These commands are the
only browser access tier 2 has now (DESIGN §6, §10).
"""

from __future__ import annotations

from urllib.parse import parse_qsl, urlsplit

import pytest
from conftest import FakeDriver

from pandabase_tools import dom, guard
from pandabase_tools.cart_add import add_form, cart_state
from pandabase_tools.cart_tier2 import (
    NOTICE,
    add,
    clean_query,
    parse_search,
    search,
    search_url,
    untrusted_text,
)
from pandabase_tools.config import CartConfig
from pandabase_tools.telemetry import Telemetry

PRODUCT = "https://www.amazon.com/dp/"
VIEW = "https://www.amazon.com/gp/cart/view.html"
SEARCH = "https://www.amazon.com/s"


def test_search_url_per_store_and_guarded() -> None:
    url = search_url("cake flour", "amazon")
    assert url == SEARCH + "?k=cake+flour"
    wf = search_url("cake flour", "wholefoods")
    assert parse_qsl(urlsplit(wf).query) == [("k", "cake flour"), ("i", "wholefoods")]
    assert guard.classify_url(url) is None and guard.classify_url(wf) is None


def test_query_is_cleaned_before_it_reaches_a_url() -> None:
    # Path-like or scripted text in a line name can't steer the search URL anywhere else.
    assert clean_query("  /gp/buy/spc  ") == "gp buy spc"
    assert clean_query("Ben & Jerry's 16oz <script>") == "Ben & Jerry's 16oz script"
    assert len(clean_query("flour " * 50)) <= 80
    with pytest.raises(ValueError):
        clean_query(" /// ")
    with pytest.raises(ValueError):
        search_url("flour", "costco")


def test_untrusted_text_strips_controls_and_truncates() -> None:
    assert untrusted_text("a‮​b\n\tc", 50) == "ab c"
    out = untrusted_text("x" * 300, 20)
    assert len(out) == 20 and out.endswith("…")


def _search_page() -> str:
    from conftest import fixture

    return fixture("search_results.html")


def test_parse_search_candidates() -> None:
    cands = parse_search(_search_page(), limit=10, title_chars=160)
    assert [c.asin for c in cands] == [
        "B0SYNTH201",
        "B0SYNTH202",
        "B0SYNTH204",
        "B0SYNTH205",
        "B0SYNTH206",
    ]  # the size swatch (203) inside 202's result and the <script> ASIN are not candidates
    by = {c.asin: c for c in cands}
    assert by["B0SYNTH201"].sponsored and not by["B0SYNTH202"].sponsored
    assert by["B0SYNTH201"].title == "Synthetic Premium Cake Flour, 32 oz"
    assert (by["B0SYNTH202"].price_cents, by["B0SYNTH202"].size) == (399, "2 lb")
    assert by["B0SYNTH202"].unit_price == "$0.12/Ounce"
    assert by["B0SYNTH204"].availability == "unavailable"
    assert by["B0SYNTH202"].availability == "available"
    assert (by["B0SYNTH206"].price_cents, by["B0SYNTH206"].size) == (200, "12 oz")
    long = by["B0SYNTH205"].title
    assert len(long) <= 160 and long.endswith("…") and "‮" not in long


def test_parse_search_respects_limit() -> None:
    assert len(parse_search(_search_page(), limit=2, title_chars=160)) == 2


def test_search_opens_one_page_and_clicks_nothing() -> None:
    url = search_url("cake flour", "amazon")
    driver = FakeDriver({url: (url, "search_results.html")})
    tel = Telemetry()
    out = search(driver, "cake flour", "amazon", CartConfig(tier2_search_limit=3), tel)
    assert driver.opened == [url] and driver.clicks == 0
    assert out["notice"] == NOTICE and "untrusted" in NOTICE.lower()
    assert out["store"] == "amazon" and out["query"] == "cake flour"
    assert [c["asin"] for c in out["candidates"]] == ["B0SYNTH201", "B0SYNTH202", "B0SYNTH204"]
    assert set(out["candidates"][0]) == {
        "asin",
        "title",
        "size",
        "price_cents",
        "unit_price",
        "availability",
        "sponsored",
    }
    assert tel.metrics("cart_tier2_search") == [{"store": "amazon", "results": 3}]


def test_search_with_no_results_logs_a_selector_error() -> None:
    url = search_url("zzz", "amazon")
    driver = FakeDriver({url: (url, "search_no_results.html")})
    tel = Telemetry()
    out = search(driver, "zzz", "amazon", CartConfig(), tel)
    assert out["candidates"] == []
    assert tel.metrics("selector_error")[0]["selector"] == "search_results"


def test_cart_state_reads_count_and_active_asins_only() -> None:
    from conftest import fixture

    count, asins = cart_state(fixture("cart_view.html"))
    assert count == 3
    # Saved-for-later and recommendations are not "in the cart".
    assert asins == {"B0SYNTH001", "B0SYNTH002"}


def test_add_form_is_the_products_own_and_never_buy_now() -> None:
    from conftest import fixture

    root = dom.parse(fixture("product_add_form.html"))
    form = add_form(root, "B0SYNTH202")
    assert form is not None and "dp_start" in form.attrs["action"]
    assert add_form(root, "B0SYNTH999") is None
    assert add_form(dom.parse(fixture("product_unavailable.html")), "B0SYNTH204") is None
    # The old add-URL confirm form isn't an add-to-cart form; a Buy-Now-only form isn't either.
    assert add_form(dom.parse(fixture("cart_add_confirm_one.html")), "B0SYNTH202") is None
    assert add_form(dom.parse(BUY_NOW_ONLY), "B0SYNTH202") is None


BUY_NOW_ONLY = (
    '<html><body><form action="/cart/add-to-cart/ref=x" method="post">'
    '<input type="hidden" name="items[0.base][asin]" value="B0SYNTH202">'
    '<button type="submit" id="buy-now-button">Buy now with 1-Click</button>'
    "</form></body></html>"
)
P202 = PRODUCT + "B0SYNTH202"


def _add_driver(
    product_page: str = "product_add_form.html",
    after_view: str = "cart_view_after.html",
    landing: tuple[str, str] | None = None,
) -> FakeDriver:
    views = iter(["cart_view.html", after_view])

    def pages(url: str) -> tuple[str, str] | None:
        if url.startswith(PRODUCT):
            return (url, product_page)
        if url == VIEW:
            return (url, next(views))
        return None

    return FakeDriver(pages, add=lambda _a, _q: landing)


def test_add_by_asin_from_the_product_page_confirms_the_count_rose() -> None:
    driver, tel = _add_driver(), Telemetry()
    out = add(driver, "B0SYNTH202", 2, "amazon", CartConfig(), tel)
    assert out["outcome"] == "added", out
    assert (out["cart_count_before"], out["cart_count_after"]) == (3, 4)
    assert driver.opened == [VIEW, P202, VIEW]
    assert driver.added == [("B0SYNTH202", 2)] and driver.clicks == 1
    driver.assert_never_checkout()
    assert tel.metrics("cart_tier2_line") == [
        {"asin": "B0SYNTH202", "vendor": "amazon", "quantity": 2, "outcome": "added"}
    ]


def test_add_skips_an_asin_already_in_the_cart() -> None:
    # A re-run of tier 2 after a crash must not add the same line twice.
    driver = _add_driver()
    out = add(driver, "B0SYNTH001", 1, "amazon", CartConfig(), Telemetry())
    assert out["outcome"] == "already_in_cart"
    assert driver.opened == [VIEW] and driver.clicks == 0


@pytest.mark.parametrize("asin", ["B0SYNTH209", "B0SYNTH210"])
def test_saved_for_later_or_recommended_is_not_in_the_cart(asin: str) -> None:
    driver = _add_driver()
    out = add(driver, asin, 1, "amazon", CartConfig(), Telemetry())
    assert out["outcome"] != "already_in_cart"
    assert PRODUCT + asin in driver.opened


def test_add_unverified_when_the_asin_is_not_in_the_cart() -> None:
    driver = _add_driver(after_view="cart_view.html")
    out = add(driver, "B0SYNTH202", 1, "amazon", CartConfig(), Telemetry())
    assert (out["outcome"], out["reason"]) == ("failed", "unverified")


@pytest.mark.parametrize("page", ["product_unavailable.html", BUY_NOW_ONLY])
def test_add_clicks_nothing_without_an_add_form(page: str) -> None:
    driver = _add_driver(product_page=page)
    out = add(driver, "B0SYNTH202", 1, "amazon", CartConfig(), Telemetry())
    assert (out["outcome"], out["reason"]) == ("failed", "no_add_form")
    assert driver.clicks == 0


def test_add_redirected_to_checkout_is_refused() -> None:
    spc = "https://www.amazon.com/gp/buy/spc/handlers/display.html"
    driver = _add_driver(landing=(spc, "cart_added.html"))
    out = add(driver, "B0SYNTH202", 1, "amazon", CartConfig(), Telemetry())
    assert (out["outcome"], out["reason"]) == ("failed", "refused_checkout")


def test_add_signed_out_fails_without_signing_in() -> None:
    signin = "https://www.amazon.com/ap/signin?openid.return_to=cart"
    driver = FakeDriver(lambda url: (signin, "cart_view.html"))
    out = add(driver, "B0SYNTH202", 1, "amazon", CartConfig(), Telemetry())
    assert (out["outcome"], out["reason"]) == ("failed", "not_signed_in")


@pytest.mark.parametrize(
    ("asin", "qty"),
    [
        ("b0synth202", 1),
        ("../checkout", 1),
        ("B0SYNTH202&x", 1),
        ("B0SYNTH202", 0),
        ("B0SYNTH202", 11),
    ],
)
def test_add_rejects_bad_input_before_opening_anything(asin: str, qty: int) -> None:
    driver = _add_driver()
    with pytest.raises(ValueError):
        add(driver, asin, qty, "amazon", CartConfig(tier2_max_qty=10), Telemetry())
    assert driver.opened == []


def test_whole_foods_add_checks_the_whole_foods_cart() -> None:
    wf_cart = "https://www.amazon.com/cart/localmarket?almBrandId=VUZHIFdob2xlIEZvb2Rz"
    views = iter(["cart_view.html", "cart_view_after.html"])
    driver = FakeDriver(
        lambda u: (
            (u, "product_add_form.html")
            if u == P202
            else ((u, next(views)) if u == wf_cart else None)
        )
    )
    out = add(driver, "B0SYNTH202", 1, "wholefoods", CartConfig(), Telemetry())
    assert out["outcome"] == "added" and driver.opened == [wf_cart, P202, wf_cart]
