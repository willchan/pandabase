"""Cart only, never checkout: the URL guard and the browser route that enforces it."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from pandabase_tools import guard
from pandabase_tools.browser import CdpDriver, NotSignedIn, Snapshot, checked, control_allowed
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


class _Route:
    def __init__(self, url: str, resource_type: str = "document") -> None:
        self.request = _Req(url, resource_type)
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
