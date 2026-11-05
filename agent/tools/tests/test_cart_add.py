"""`cart_add` — the product-page add path tiers 1 and 2 share (DESIGN §6).

Regressions from the live test on 2026-11-04:

- Whole Foods items always came back `no_add_form` (`cart add --asin … --store wholefoods`): a
  Whole Foods buy box is a widget (`#almAddToCart_feature_div` / `#core-dp-alm-atc-wf`, a
  `qs-widget-summary-atc-…QuantityAndCadenceSelector-<ASIN>` widget, `#freshAddToCartButton`), not a
  `<form>`, and the only add forms on the page are sponsored `spAddToCart` ads, never clicked.
- "added" was decided by `#nav-cart-count`, which jumped 1 → 4 for one Amazon item while the cart
  held 8: it now takes the ASIN appearing in the right cart's active rows.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from conftest import FakeDriver, fixture

from pandabase_tools import cart_add, dom, guard
from pandabase_tools.browser import CdpDriver
from pandabase_tools.cart_add import add_control, add_form, add_one, cart_state, wf_add_control
from pandabase_tools.telemetry import Telemetry

WF = "B0SYNTH301"
P301 = "https://www.amazon.com/dp/" + WF
P202 = "https://www.amazon.com/dp/B0SYNTH202"
VIEW = "https://www.amazon.com/gp/cart/view.html"
WF_CART = cart_add.CART_URLS["wholefoods"]
WF_PAGE = fixture("product_wholefoods.html")


def _cart(rows: list[str], count: int) -> str:
    items = "".join(f'<div data-asin="{a}" data-itemtype="active">{a}</div>' for a in rows)
    return (
        f'<html><body><span id="nav-cart-count">{count}</span>'
        f'<form action="/cart/ref=ox_sc_upd">{items}</form></body></html>'
    )


def _driver(product: str, views: list[str], product_url: str = P301) -> FakeDriver:
    pages = iter(views)

    def page(url: str) -> tuple[str, str] | None:
        if url == product_url:
            return (url, product)
        if url in (VIEW, WF_CART):
            return (url, next(pages))
        return None

    return FakeDriver(page)


# --- Bug 1: the Whole Foods buy box is a widget, not a form -----------------------------------


def test_whole_foods_cart_is_the_whole_foods_local_market_cart() -> None:
    # `/cart/localmarket` alone is the grocery cart of whichever local-market brand Amazon picks
    # (Amazon Fresh or Whole Foods); `almBrandId` is base64 "UFG Whole Foods".
    assert WF_CART == "https://www.amazon.com/cart/localmarket?almBrandId=VUZHIFdob2xlIEZvb2Rz"
    assert guard.classify_url(WF_CART) is None
    assert cart_add.CART_URLS["amazon"] == VIEW


def test_whole_foods_buy_box_widget_is_the_add_control() -> None:
    root = dom.parse(WF_PAGE)
    assert add_form(root, WF) is None  # the bug: only sponsored forms, so `no_add_form`
    control = add_control(root, WF)
    assert control is not None and control.tag == "button" and control.text() == "Add to Cart"
    ids = {a.attrs.get("id") for a in control.ancestors()}
    assert {"freshAddToCartButton", "almAddToCart_feature_div", "core-dp-alm-atc-wf"} <= ids
    assert wf_add_control(root, WF) is control


@pytest.mark.parametrize("asin", ["B0SYNTH310", "B0SYNTH311", "B0SYNTH999"])
def test_no_control_for_sponsored_or_other_items_widgets(asin: str) -> None:
    # B0SYNTH310: only a sponsored spAddToCart form; B0SYNTH311: a widget outside the buy box.
    assert add_control(dom.parse(WF_PAGE), asin) is None


def test_sponsored_add_form_is_never_the_add_form() -> None:
    # A sponsored spAddToCart ad for the page's own ASIN is still an ad.
    sponsored_only = WF_PAGE.replace('id="core-dp-alm-atc-wf"', 'id="gone"').replace(
        'id="almAddToCart_feature_div"', 'id="gone2"'
    )
    root = dom.parse(sponsored_only)
    assert add_form(root, WF) is None and add_control(root, WF) is None


@pytest.mark.parametrize(
    ("change", "why"),
    [
        (
            ("QuantityAndCadenceSelector-B0SYNTH301", "QuantityAndCadenceSelector-B0SYNTH399"),
            "asin",
        ),
        (('id="freshAddToCartButton">\n', 'id="other">\n'), "no button"),
        (('aria-label="Add to Cart">Add to Cart', 'aria-label="Buy Now">Buy Now'), "buy now"),
    ],
)
def test_buy_box_widget_must_be_this_asins_and_allowed(change: tuple[str, str], why: str) -> None:
    page = WF_PAGE.replace(*change)
    assert page != WF_PAGE, why
    assert add_control(dom.parse(page), WF) is None, why


def test_whole_foods_add_clicks_the_buy_box_and_finds_it_in_the_whole_foods_cart() -> None:
    # Live: `cart add --asin B000P6L3K0 --store wholefoods` → failed / no_add_form, on a page
    # whose only add forms were sponsored ads for other products (this page minus the same-item ad).
    live_shape = WF_PAGE.replace(
        'value="B0SYNTH301">\n    <input type="hidden" name="items[0.base][quantity]"',
        'value="B0SYNTH312">\n    <input type="hidden" name="items[0.base][quantity]"',
        1,
    )
    assert live_shape != WF_PAGE and add_form(dom.parse(live_shape), WF) is None
    driver = _driver(live_shape, [_cart([], 1), _cart([WF], 2)])
    tel = Telemetry()
    out = add_one(driver, WF, 2, tel, "wholefoods")
    assert (out.outcome, out.reason) == ("added", None), out
    assert driver.opened == [WF_CART, P301, WF_CART]
    assert driver.added == [(WF, 2)] and driver.clicks == 1
    (clicked,) = driver.controls
    assert clicked.tag == "button" and "freshAddToCartButton" in {
        a.attrs.get("id") for a in clicked.ancestors()
    }
    assert tel.metrics("selector_error") == []
    driver.assert_never_checkout()


# Live probe after the first fix (2026-11-04, `B000P6L3K0` still `no_add_form`): on a pickup offer
# the widget ids carry a random instance number, never the ASIN, so binding by widget id rejected
# the right box. The box inside the page's `#buybox` on `/dp/<ASIN>` is that ASIN's.
PICKUP = "B0SYNTH302"
P302 = "https://www.amazon.com/dp/" + PICKUP
PICKUP_PAGE = fixture("product_wholefoods_pickup.html")


def test_pickup_buy_box_without_asin_in_ids_is_bound_by_the_page() -> None:
    root = dom.parse(PICKUP_PAGE)
    control = add_control(root, PICKUP, P302)
    assert control is not None and control.tag == "input"
    assert "freshAddToCartButton" in {a.attrs.get("id") for a in control.ancestors()}
    assert "buybox" in {a.attrs.get("id") for a in control.ancestors()}


@pytest.mark.parametrize(
    "landed",
    [
        "https://www.amazon.com/dp/B0SYNTH399",  # redirected to another product
        "https://www.amazon.com/s?k=eggs",
        None,  # page unknown
    ],
)
def test_pickup_buy_box_needs_the_page_to_be_this_asins(landed: str | None) -> None:
    assert add_control(dom.parse(PICKUP_PAGE), PICKUP, landed) is None


def test_box_outside_the_buybox_is_never_bound_by_the_page() -> None:
    no_buybox = PICKUP_PAGE.replace('<div id="buybox">', '<div id="elsewhere">')
    assert add_control(dom.parse(no_buybox), PICKUP, P302) is None


def test_a_widget_naming_another_asin_still_refuses_the_box() -> None:
    other = PICKUP_PAGE.replace(
        'id="qs-widget-summary-atc-atfc-alm-mod-dp-pickup-111222333444555-announce"',
        'id="qs-widget-summary-atc-xQuantityAndCadenceSelector-B0SYNTH399"',
    )
    assert add_control(dom.parse(other), PICKUP, P302) is None


def test_pickup_add_end_to_end() -> None:
    driver = _driver(PICKUP_PAGE, [_cart([], 1), _cart([PICKUP], 2)], product_url=P302)
    out = add_one(driver, PICKUP, 1, Telemetry(), "wholefoods")
    assert (out.outcome, out.reason) == ("added", None), out
    (clicked,) = driver.controls
    assert clicked.tag == "input" and clicked.attrs.get("type") == "submit"
    driver.assert_never_checkout()


# --- Bug 2: verify by the ASIN in the cart's active rows, not by #nav-cart-count ---------------


def test_count_jump_without_the_asin_in_the_cart_is_unverified() -> None:
    # Live: nav-cart-count went 1 → 4 for one Amazon item while the cart held 8 items.
    driver = _driver(
        fixture("product_add_form.html"),
        [_cart(["B0SYNTH001"], 1), _cart(["B0SYNTH001"], 4)],
        product_url=P202,
    )
    tel = Telemetry()
    out = add_one(driver, "B0SYNTH202", 1, tel, "amazon")
    assert (out.outcome, out.reason) == ("failed", "unverified")
    assert tel.metrics("selector_error")[0]["selector"] == "cart_rows"


@pytest.mark.parametrize("after_count", [1, 0, 8])
def test_asin_in_the_active_rows_is_added_whatever_the_count_says(after_count: int) -> None:
    driver = _driver(
        fixture("product_add_form.html"),
        [_cart(["B0SYNTH001"], 1), _cart(["B0SYNTH001", "B0SYNTH202"], after_count)],
        product_url=P202,
    )
    out = add_one(driver, "B0SYNTH202", 1, Telemetry(), "amazon")
    assert out.outcome == "added", out


def test_asin_only_saved_for_later_after_the_add_is_unverified() -> None:
    after = fixture("cart_view.html").replace("B0SYNTH209", "B0SYNTH202")  # the saved row
    driver = _driver(
        fixture("product_add_form.html"), [fixture("cart_view.html"), after], product_url=P202
    )
    out = add_one(driver, "B0SYNTH202", 1, Telemetry(), "amazon")
    assert (out.outcome, out.reason) == ("failed", "unverified")


def test_cart_state_rows_ignore_add_forms_and_saved() -> None:
    _count, asins = cart_state(fixture("cart_view_recs.html"))
    assert asins == {"B0SYNTH099"}  # recommendation add forms are not cart rows


# --- The live driver's click, in a real browser on the synthetic page ------------------------

RECORD_CLICKS = """() => {
  window.__clicked = []; window.__clickedIn = [];
  document.addEventListener("click", e => {
    const el = e.target.closest("button, input");
    window.__clicked.push(
      (el.closest("[id^='qs-widget'], form")?.id || el.closest("form")?.action || "?")
      + " | " + (el.getAttribute("aria-label") || el.textContent.trim()));
    window.__clickedIn.push(["freshAddToCartButton", "buybox"]
      .filter(id => el.closest(`[id='${id}']`)).join("|"));
    e.preventDefault();
  }, true);
}"""


@pytest.fixture(scope="module")
def browser_page() -> Iterator[Any]:
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as err:  # no browser installed: `uv run playwright install chromium`
            pytest.skip(f"chromium unavailable: {str(err).splitlines()[0]}")
        yield browser.new_page()
        browser.close()


def _live(page: Any, html: str, url: str = P301) -> CdpDriver:
    """`html` served at `url` (routed, no network): the driver checks the page it landed on."""
    page.unroute("**/*")
    page.route("**/*", lambda route: route.fulfill(body=html, content_type="text/html"))
    page.goto(url)
    page.evaluate(RECORD_CLICKS)
    driver = CdpDriver("http://127.0.0.1:9222", timeout_ms=2_000)  # never entered
    driver._page = page
    return driver


def test_cdp_clicks_the_whole_foods_buy_box_with_the_quantity(browser_page: Any) -> None:
    driver = _live(browser_page, WF_PAGE)
    assert driver.add_to_cart(WF, 2) is not None
    assert browser_page.evaluate("window.__clicked") == [
        "qs-widget-summary-atc-k3QuantityAndCadenceSelector-B0SYNTH301 | Add to Cart"
    ]
    assert browser_page.eval_on_selector("#qs-qty-B0SYNTH301", "e => e.value") == "2"


@pytest.mark.parametrize("asin", ["B0SYNTH310", "B0SYNTH311"])
def test_cdp_never_clicks_sponsored_or_other_widgets(browser_page: Any, asin: str) -> None:
    driver = _live(browser_page, WF_PAGE)
    assert driver.add_to_cart(asin, 1) is None
    assert browser_page.evaluate("window.__clicked") == []


def test_cdp_never_clicks_a_sponsored_ad_for_the_same_item(browser_page: Any) -> None:
    no_buy_box = WF_PAGE.replace('id="almAddToCart_feature_div"', 'id="gone"').replace(
        'id="core-dp-alm-atc-wf"', 'id="gone2"'
    )
    driver = _live(browser_page, no_buy_box)
    assert driver.add_to_cart(WF, 1) is None
    assert browser_page.evaluate("window.__clicked") == []


def test_cdp_clicks_the_pickup_buy_box_bound_by_the_page(browser_page: Any) -> None:
    driver = _live(browser_page, PICKUP_PAGE, url=P302)
    assert driver.add_to_cart(PICKUP, 1) is not None
    assert browser_page.evaluate("window.__clicked") == ["? | "]  # the unlabelled submit input
    assert browser_page.evaluate("window.__clickedIn") == ["freshAddToCartButton|buybox"]


def test_cdp_pickup_box_on_another_products_page_is_not_clicked(browser_page: Any) -> None:
    driver = _live(browser_page, PICKUP_PAGE, url="https://www.amazon.com/dp/B0SYNTH399")
    assert driver.add_to_cart(PICKUP, 1) is None
    assert browser_page.evaluate("window.__clicked") == []


def test_cdp_pickup_box_wont_add_more_than_one(browser_page: Any) -> None:
    # The live widget's quantity is an unnamed number input behind a "Qty" dropdown: unverified,
    # so a quantity > 1 is not added rather than added wrong.
    driver = _live(browser_page, PICKUP_PAGE, url=P302)
    assert driver.add_to_cart(PICKUP, 2) is None
    assert browser_page.evaluate("window.__clicked") == []


def test_cdp_wont_add_a_wrong_quantity_through_a_widget(browser_page: Any) -> None:
    no_qty = WF_PAGE.replace('name="quantity" ', 'name="size" ')
    driver = _live(browser_page, no_qty)
    assert driver.add_to_cart(WF, 3) is None
    assert browser_page.evaluate("window.__clicked") == []
