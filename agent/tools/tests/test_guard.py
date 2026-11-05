"""Cart only, never checkout: the URL guard and the browser route that enforces it."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import pytest

from pandabase_tools import guard
from pandabase_tools.browser import (
    CdpDriver,
    NotSignedIn,
    Snapshot,
    buy_box_add_allowed,
    checked,
    control_allowed,
)
from pandabase_tools.cart_injector import add_url

CHECKOUT = [
    "https://www.amazon.com/gp/buy/spc/handlers/display.html?hasWorkingJavascript=1",
    "https://www.amazon.com/checkout/entry/cart?proceedToRetailCheckout=Proceed+to+checkout",
    "https://www.amazon.com/gp/cart/desktop/go-to-checkout.html/ref=ox_sc_proceed",
    "https://www.amazon.com/gp/buy/payselect/handlers/display.html",
    "https://www.amazon.com/cpe/yourpayments/wallet",
    "https://www.amazon.com/gp/checkoutportal/enter-checkout.html",
    "https://www.amazon.com/alm/byg?almBrandId=VUZHIFdob2xlIEZvb2Rz",
    "https://www.amazon.com/afx/slotselection?brand=wholefoods",
    "https://www.amazon.com/gp/buy/placeorder",
    "https://www.amazon.com/Some%2FCheckout/x",
]
SIGNIN = [
    "https://www.amazon.com/ap/signin?openid.return_to=x",
    "https://www.amazon.com/ap/mfa?arb=1",
]
OTHER_HOST = [
    "http://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B0SYNTH001",
    "https://amazon.com.evil.example/dp/B0SYNTH001",
    "https://pay.amazon.com/",
    "file:///etc/passwd",
]
SAFE = [
    "https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B0SYNTH001&Quantity.1=1",
    "https://www.amazon.com/dp/B0SYNTH001",
    "https://www.amazon.com/your-orders/orders?timeFilter=months-3&startIndex=10",
    "https://www.amazon.com/your-orders/order-details?orderID=111-0000001-0000001",
    "https://www.amazon.com/gp/cart/view.html",
    "about:blank",
]


@pytest.mark.parametrize("url", CHECKOUT)
def test_refuses_checkout_and_payment(url: str) -> None:
    assert guard.classify_url(url) == "checkout"
    with pytest.raises(guard.UnsafeUrl):
        guard.check_url(url)


@pytest.mark.parametrize("url", SIGNIN)
def test_refuses_signin(url: str) -> None:
    assert guard.classify_url(url) == "signin"


@pytest.mark.parametrize("url", OTHER_HOST)
def test_refuses_other_hosts_and_plain_http(url: str) -> None:
    assert guard.classify_url(url) == "host"


@pytest.mark.parametrize("url", SAFE)
def test_allows_cart_add_product_and_orders(url: str) -> None:
    assert guard.check_url(url) == url


def test_add_url_always_passes_the_guard() -> None:
    url = add_url([("B0SYNTH001", 2), ("B0SYNTH002", 1)])
    assert guard.classify_url(url) is None


def test_landing_on_checkout_or_signin_is_refused() -> None:
    with pytest.raises(guard.UnsafeUrl):
        checked(Snapshot(CHECKOUT[0], ""))
    with pytest.raises(NotSignedIn):
        checked(Snapshot(SIGNIN[0], ""))


@dataclass
class _Req:
    url: str
    resource_type: str
    method: str = "GET"
    post_data: str | None = None


class _Route:
    def __init__(
        self,
        url: str,
        resource_type: str = "document",
        method: str = "GET",
        post_data: str | None = None,
    ) -> None:
        self.request = _Req(url, resource_type, method, post_data)
        self.aborted: str | None = None
        self.continued = False

    def abort(self, reason: str) -> None:
        self.aborted = reason

    def continue_(self) -> None:
        self.continued = True


def test_cdp_route_aborts_checkout_documents_in_the_browser() -> None:
    driver = CdpDriver("http://127.0.0.1:9222")
    for url in CHECKOUT + SIGNIN:
        route = _Route(url)
        driver._route(route)  # type: ignore[arg-type]
        assert route.aborted == "blockedbyclient" and not route.continued
    ok = _Route(SAFE[0])
    driver._route(ok)  # type: ignore[arg-type]
    assert ok.continued
    # Subresources (images, XHR) aren't navigations; only documents are policed.
    img = _Route("https://images.example.net/x.jpg", "image")
    driver._route(img)  # type: ignore[arg-type]
    assert img.continued
    assert driver.blocked == CHECKOUT + SIGNIN


# The buy box's "Add to cart" posts to handle-buy-box, Buy Now's endpoint too (live, 2026-11-04).
# The browser lets that POST through only when the pressed button was `submit.add-to-cart`.
HBB = "https://www.amazon.com/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance"
ADD_POST = "items%5B0.base%5D%5Basin%5D=B0SYNTH501&ASIN=B0SYNTH501&submit.add-to-cart=Add+to+cart"


def test_buy_box_add_post_is_allowed() -> None:
    assert guard.buy_box_add(HBB, "POST", ADD_POST)
    assert guard.buy_box_add(HBB.replace("/ref=dp_start-bbf_1_glance", ""), "post", ADD_POST)


@pytest.mark.parametrize(
    ("url", "method", "data", "why"),
    [
        (HBB, "GET", None, "a GET is a navigation, not the form's add"),
        (HBB, "POST", None, "no form data"),
        (HBB, "POST", "ASIN=B0SYNTH501&submit.buy-now=Buy+Now", "Buy Now"),
        (HBB, "POST", ADD_POST + "&submit.buy-now=", "two submitters"),
        (HBB, "POST", ADD_POST + "&snsAsin=B0SYNTH501", "a subscription"),
        (HBB, "POST", ADD_POST + "&submit.add-to-registry.wishlist=", "another submit"),
        (HBB, "POST", ADD_POST + "&isBuyNow=1", "buy-now field"),
        (HBB, "POST", ADD_POST + "&proceedToCheckout=1", "checkout field"),
        (HBB, "POST", "submit.add-to-cart", "not form-encoded fields"),
        (HBB + "?next=/checkout/entry", "POST", ADD_POST, "checkout in the URL"),
        (HBB.replace("www.amazon.com", "evil.example"), "POST", ADD_POST, "host"),
        (HBB.replace("https", "http"), "POST", ADD_POST, "scheme"),
        ("https://www.amazon.com/gp/buy/spc/handle-buy-box", "POST", ADD_POST, "other path"),
        ("https://www.amazon.com/checkout/entry", "POST", ADD_POST, "checkout"),
    ],
)
def test_other_buy_box_posts_are_refused(url: str, method: str, data: str | None, why: str) -> None:
    assert not guard.buy_box_add(url, method, data), why


def test_cdp_route_lets_only_the_buy_box_add_post_through() -> None:
    driver = CdpDriver("http://127.0.0.1:9222")
    add = _Route(HBB, method="POST", post_data=ADD_POST)
    driver._route(add)  # type: ignore[arg-type]
    assert add.continued and add.aborted is None
    for data in ("ASIN=B0SYNTH501&submit.buy-now=Buy+Now", ADD_POST + "&snsAsin=B0SYNTH501"):
        buy = _Route(HBB, method="POST", post_data=data)
        driver._route(buy)  # type: ignore[arg-type]
        assert buy.aborted == "blockedbyclient" and not buy.continued
    get = _Route(HBB)
    driver._route(get)  # type: ignore[arg-type]
    assert get.aborted == "blockedbyclient"
    assert driver.blocked == [HBB, HBB, HBB]
    with pytest.raises(guard.UnsafeUrl):
        driver.open(HBB)  # tools still never open it


def test_cdp_driver_refuses_before_navigating() -> None:
    driver = CdpDriver("http://127.0.0.1:9222")  # never entered: no browser needed
    with pytest.raises(guard.UnsafeUrl):
        driver.open(CHECKOUT[1])


# Tier 2 (`cart add`) shares this guard: Buy Now / 1-Click / Turbo checkout are refused too.
BUY_NOW = [
    "https://www.amazon.com/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance",
    "https://www.amazon.com/checkout/turbo/entry?asin=B0SYNTH001",
    "https://www.amazon.com/gp/buy-now/B0SYNTH001",
    "https://www.amazon.com/gp/turbo/checkout",
    "https://www.amazon.com/gp/1-click/order",
]


@pytest.mark.parametrize("url", BUY_NOW)
def test_refuses_buy_now_and_one_click(url: str) -> None:
    assert guard.classify_url(url) == "checkout"


def test_search_pages_are_allowed() -> None:
    assert guard.classify_url("https://www.amazon.com/s?k=cake+flour&i=wholefoods") is None


DENIED_CONTROLS = [
    {"name": "submit.buy-now", "value": "Buy Now"},
    {"id": "turbo-checkout-pyo-button", "text": "Place your order"},
    {"text": "Buy now with 1-Click"},
    {"name": "proceedToRetailCheckout", "value": "Proceed to checkout"},
    {"value": "Continue", "form_action": "/gp/product/handle-buy-box/ref=x"},
    {"value": "Continue", "formaction": "/gp/buy/spc/handlers/display.html"},
]
ALLOWED_CONTROLS = [
    {"name": "add", "value": "Continue", "form_action": "/gp/aws/cart/add.html"},
    {"text": "Add to cart", "form_action": "/gp/aws/cart/add.html"},
]


@pytest.mark.parametrize("desc", DENIED_CONTROLS)
def test_buy_now_and_checkout_controls_are_never_clickable(desc: dict[str, str]) -> None:
    assert not control_allowed(desc)


@pytest.mark.parametrize("desc", ALLOWED_CONTROLS)
def test_add_to_cart_controls_are_clickable(desc: dict[str, str]) -> None:
    assert control_allowed(desc)


BUY_BOX_ADD = {
    "name": "submit.add-to-cart",
    "id": "add-to-cart-button",
    "value": "Add to cart",
    "form_action": "/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance",
}


def test_buy_box_add_to_cart_is_the_one_buy_box_control_allowed() -> None:
    assert not control_allowed(BUY_BOX_ADD)  # the general rule still refuses the buy box
    assert buy_box_add_allowed(BUY_BOX_ADD)


@pytest.mark.parametrize(
    "change",
    [
        {"name": "submit.buy-now"},
        {"value": "Buy Now"},
        {"value": "Add subscription to cart"},
        {"id": "rcx-subscribe-submit-button-announce"},
        {"formaction": "/checkout/turbo/entry"},
        {"form_action": "/cart/add-to-cart/ref=x"},
        {"form_action": "/gp/product/handle-buy-box/ref=x?next=/checkout"},
        {"text": "Buy now with 1-Click"},
    ],
)
def test_other_buy_box_controls_are_never_clickable(change: dict[str, str]) -> None:
    assert not buy_box_add_allowed({**BUY_BOX_ADD, **change})


class _Loc:
    """Just enough of a Playwright locator for `CdpDriver.click_confirm`."""

    def __init__(self, descs: list[dict[str, str]], clicked: list[int], base: int = 0) -> None:
        self.descs, self.clicked, self.base = descs, clicked, base

    def count(self) -> int:
        return len(self.descs)

    def nth(self, i: int) -> _Loc:
        return _Loc([self.descs[i]], self.clicked, self.base + i)

    def evaluate(self, _js: str) -> dict[str, str]:
        return self.descs[0]

    def click(self) -> None:
        self.clicked.append(self.base)


class _Page:
    def __init__(self, descs: list[dict[str, str]]) -> None:
        self.descs = descs
        self.clicked: list[int] = []
        self.url = "https://www.amazon.com/gp/cart/view.html"

    def locator(self, _sel: str) -> _Loc:
        return _Loc(self.descs, self.clicked)

    def get_by_role(self, *_a: object, **_k: object) -> _Loc:
        return _Loc([], self.clicked)

    def wait_for_load_state(self, *_a: object) -> None:
        return None

    def content(self) -> str:
        return ""


def test_cdp_click_confirm_skips_buy_now_and_clicks_continue() -> None:
    driver = CdpDriver("http://127.0.0.1:9222")
    page = _Page([DENIED_CONTROLS[0], ALLOWED_CONTROLS[0]])
    driver._page = page  # type: ignore[assignment]
    assert driver.click_confirm() is not None
    assert page.clicked == [1]


def test_cdp_click_confirm_clicks_nothing_when_only_buy_now() -> None:
    driver = CdpDriver("http://127.0.0.1:9222")
    page = _Page([DENIED_CONTROLS[0], DENIED_CONTROLS[2]])
    driver._page = page  # type: ignore[assignment]
    assert driver.click_confirm() is None
    assert page.clicked == []


class _Ctl:
    def __init__(self, desc: dict[str, str], log: list[str]) -> None:
        self.desc, self.log = desc, log

    def evaluate(self, _js: str) -> dict[str, str]:
        return self.desc

    def click(self) -> None:
        self.log.append("click:" + (self.desc.get("name") or self.desc.get("text") or ""))


class _Many:
    def __init__(self, items: list[Any]) -> None:
        self.items = items

    def count(self) -> int:
        return len(self.items)

    def nth(self, i: int) -> Any:
        return self.items[i]


class _Form:
    def __init__(
        self,
        controls: list[dict[str, str]],
        qty_fields: int,
        log: list[str],
        ident: str = "/cart/add-to-cart/ref=dp_start addToCart",
    ) -> None:
        self.controls = [_Ctl(d, log) for d in controls]
        self.qty_fields, self.log, self.ident = qty_fields, log, ident
        self.asins = ["B0SYNTH202"]

    def locator(self, _sel: str) -> _Many:
        return _Many(self.controls)

    def evaluate(self, _js: str, qty: int | None = None) -> Any:
        if qty is None:  # FORM_IDENT_JS: the form's action, id and name, and its ASINs
            return {"ident": self.ident, "asins": self.asins, "names": []}
        self.log.append(f"qty:{qty}")
        return self.qty_fields


class _FormPage(_Page):
    def __init__(self, forms: list[_Form]) -> None:
        super().__init__([])
        self.forms = forms
        self.selectors: list[str] = []

    def locator(self, sel: str) -> Any:
        self.selectors.append(sel)
        action = re.search(r"form\[action\*='([^']+)'\]", sel)
        forms = [f for f in self.forms if action is None or action.group(1) in f.ident]

        class _Filterable(_Many):
            def filter(self, has: object) -> _Many:
                return _Many(forms)

        return _Filterable([])


def test_cdp_add_to_cart_sets_qty_and_never_clicks_buy_now() -> None:
    log: list[str] = []
    buy = {"name": "submit.buy-now", "value": "Buy Now"}
    add = {"name": "submit.addToCart", "value": "Add to Cart", "form_action": "/cart/add-to-cart/x"}
    page = _FormPage([_Form([buy], 1, log), _Form([buy, add], 1, log)])
    driver = CdpDriver("http://127.0.0.1:9222")
    driver._page = page  # type: ignore[assignment]
    assert driver.add_to_cart("B0SYNTH202", 2) is not None
    assert log == ["qty:2", "click:submit.addToCart"]  # the Buy-Now-only form was passed over
    assert "input[value='B0SYNTH202']" in page.selectors


def test_cdp_add_to_cart_passes_over_a_sponsored_form_for_the_same_asin() -> None:
    log: list[str] = []
    add = {"name": "submit.addToCart", "value": "Add to cart"}
    ad = _Form([add], 1, log, ident="/cart/add-to-cart/ref=spAddToCart_dp_1  spAddToCart")
    driver = CdpDriver("http://127.0.0.1:9222")
    driver._page = _FormPage([ad])  # type: ignore[assignment]
    assert driver.add_to_cart("B0SYNTH202", 1) is None and log == []


def test_cdp_add_to_cart_wont_add_a_wrong_quantity() -> None:
    log: list[str] = []
    add = {"name": "submit.addToCart", "value": "Add to Cart"}
    driver = CdpDriver("http://127.0.0.1:9222")
    driver._page = _FormPage([_Form([add], 0, log)])  # type: ignore[assignment]
    assert driver.add_to_cart("B0SYNTH202", 3) is None and not any("click" in x for x in log)
    with pytest.raises(ValueError):
        driver.add_to_cart("B0SYNTH202']", 1)
