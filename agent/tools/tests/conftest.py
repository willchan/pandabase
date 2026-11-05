"""Shared test doubles: a fixture-backed browser driver and a recording fake API."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from pandabase_tools import cart_add, dom, guard
from pandabase_tools.api import ApiClient
from pandabase_tools.browser import Snapshot, checked

FIXTURES = Path(__file__).parent / "fixtures" / "amazon"
REPO = Path(__file__).resolve().parents[3]


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text()


Page = tuple[str, str]  # (final URL, fixture file)


class FakeDriver:
    """Serves fixtures by URL. Every URL it's asked to open, or lands on, must pass the guard."""

    def __init__(
        self,
        pages: dict[str, Page] | Callable[[str], Page | None],
        confirm: Callable[[str], Page | None] | None = None,
        add: Callable[[str, int], Page | None] | None = None,
    ) -> None:
        self.pages = pages
        self.confirm = confirm
        self.add = add
        self.opened: list[str] = []
        self.landed: list[str] = []
        self.clicks = 0
        self.added: list[tuple[str, int]] = []
        self.controls: list[dom.Node] = []  # what `add_to_cart` clicked
        self.current: str | None = None
        self.html = ""

    def _land(self, page: Page) -> Snapshot:
        url, name = page  # `name` is a fixture file, or inline HTML when it starts with "<"
        self.landed.append(url)
        self.current = url
        self.html = name if name.lstrip().startswith("<") else fixture(name)
        return checked(Snapshot(url, self.html))

    def open(self, url: str) -> Snapshot:
        guard.check_url(url)  # what CdpDriver does before page.goto
        self.opened.append(url)
        page = self.pages(url) if callable(self.pages) else self.pages.get(url)
        if page is None:
            raise AssertionError(f"unexpected navigation: {url}")
        return self._land(page)

    def click_confirm(self) -> Snapshot | None:
        self.clicks += 1
        page = self.confirm(self.current or "") if self.confirm else None
        return None if page is None else self._land(page)

    def add_to_cart(self, asin: str, qty: int) -> Snapshot | None:
        """What `CdpDriver.add_to_cart` does: this ASIN's own add form, else its Whole Foods buy
        box; never Buy Now, never a sponsored ad."""
        control = cart_add.add_control(dom.parse(self.html), asin, self.current)
        if control is None:
            return None
        self.clicks += 1
        self.controls.append(control)
        self.added.append((asin, qty))
        page = self.add(asin, qty) if self.add else None
        return self._land(page) if page else checked(Snapshot(self.current or "", self.html))

    def __enter__(self) -> FakeDriver:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def assert_never_checkout(self) -> None:
        for url in self.opened + self.landed:
            assert guard.classify_url(url) != "checkout", url


PRODUCT = "https://www.amazon.com/dp/"
VIEW_URL = "https://www.amazon.com/gp/cart/view.html"


def product_html(asin: str, *, available: bool = True) -> str:
    """A synthetic product page: its own add form (Buy Now inside it) + a related item's form."""
    own = (
        f'<form action="/cart/add-to-cart/ref=dp_start" method="post">'
        f'<input type="hidden" name="items[0.base][asin]" value="{asin}">'
        '<select name="items[0.base][quantity]"><option value="1">1</option></select>'
        '<input type="submit" name="submit.buy-now" value="Buy Now">'
        '<input type="submit" name="submit.addToCart" value="Add to Cart"></form>'
        if available
        else "<div>Currently unavailable.</div>"
    )
    return (
        f"<html><body><h1>Synthetic product {asin}</h1><span>$4.99</span>{own}"
        '<form action="/cart/add-to-cart/ref=dp_rec" method="post">'
        '<input type="hidden" name="items[0.base][asin]" value="B0SYNTH210">'
        '<button type="submit" name="submit.addToCart">Add to cart</button></form></body></html>'
    )


class FakeShop:
    """A stateful synthetic Amazon: product pages, add-to-cart, and a cart page whose count
    follows what was added (`stuck=True`: adds don't land, as if Amazon ignored them)."""

    def __init__(
        self, cart: dict[str, int] | None = None, unavailable: frozenset[str] = frozenset()
    ) -> None:
        self.cart = dict(cart or {})
        self.unavailable = unavailable
        self.stuck = False
        self.driver = FakeDriver(self.page, add=self.add)

    def cart_html(self) -> str:
        rows = "".join(
            f'<div data-asin="{a}" data-itemtype="active"><a href="/dp/{a}">{a}</a> Qty: {q}</div>'
            for a, q in self.cart.items()
        )
        count = sum(self.cart.values())
        return (
            f'<html><body><span id="nav-cart-count">{count}</span>'
            f'<form action="/cart/ref=ox_sc_upd">{rows}</form></body></html>'
        )

    def page(self, url: str) -> Page | None:
        if url == VIEW_URL:
            return (url, self.cart_html())
        if url.startswith(PRODUCT):
            asin = url[len(PRODUCT) :].split("/")[0]
            return (url, product_html(asin, available=asin not in self.unavailable))
        return None

    def add(self, asin: str, qty: int) -> Page | None:
        if not self.stuck:
            self.cart[asin] = self.cart.get(asin, 0) + qty
        return None


class FakeApi:
    """httpx MockTransport that records requests and answers from a handler table."""

    def __init__(self, handlers: dict[str, Callable[[Any], Any]]) -> None:
        self.handlers = handlers
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = f"{request.method} {request.url.path}"
        body = json.loads(request.content) if request.content else None
        handler = self.handlers.get(key)
        if handler is None:
            return httpx.Response(404, json={"error": f"no handler for {key}"})
        out = handler(body)
        if isinstance(out, httpx.Response):
            return out
        return httpx.Response(200, json=out)

    def client(self) -> ApiClient:
        return ApiClient(
            "https://pandabase.test",
            "token",
            transport=httpx.MockTransport(self),
            sleep=lambda _: None,
        )

    def bodies(self, key: str) -> list[Any]:
        return [
            json.loads(r.content) if r.content else None
            for r in self.requests
            if f"{r.method} {r.url.path}" == key
        ]


@pytest.fixture
def no_sleep() -> Callable[[float], None]:
    return lambda _: None
