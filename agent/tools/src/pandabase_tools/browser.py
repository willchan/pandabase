"""Browser access for the tools: a small `Driver` protocol and its CDP implementation.

`CdpDriver` attaches over CDP to a member's already-running, already-signed-in Chromium
(`--remote-debugging-port`, see `profiles.json`). It never launches a browser, never signs in and
never stores credentials. It opens its own tab in the existing context, routes every document
request through `guard.check_url` (aborting checkout/payment/sign-in and non-Amazon navigations),
and closes only that tab. Tests use a fixture-backed fake with the same protocol.
"""

from __future__ import annotations

import contextlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import TracebackType
from typing import TYPE_CHECKING, Protocol, Self
from urllib.parse import urljoin

from . import guard

if TYPE_CHECKING:
    from playwright.sync_api import Browser, Page, Playwright, Route

# The one control a tier-1 batch clicks: the confirm/submit button of the add-to-cart form.
# Located by form action and input type, with an accessible-name fallback — no class names.
CONFIRM_SELECTOR = "form[action*='/cart/add'] [type=submit], form[action*='/cart/add'] button"
CONFIRM_NAME = re.compile(r"^\s*(continue|add to (your )?cart|add all to cart)\s*$", re.I)
# Product-page add (tiers 1 and 2, `cart_add`): the ASIN's own add-to-cart form ...
ADD_FORM_ACTION = "/cart/add-to-cart"
ASIN_RE = re.compile(r"^[A-Z0-9]{10}$")
# ... never a sponsored ad's (matched against the form's action, id and name) ...
SPONSORED_FORM = re.compile(r"spAddToCart", re.I)
# ... or, on a Whole Foods page (no form), the buy-box widget bound to the ASIN.
WF_BUY_BOX_IDS = ("almAddToCart_feature_div", "core-dp-alm-atc-wf")
WF_WIDGET_ID = re.compile(r"^qs-widget-summary-atc-.*QuantityAndCadenceSelector-([A-Z0-9]{10})$")
WF_BUTTON_ID = "freshAddToCartButton"
# The widget adds without a page load; wait (bounded) for its request before re-reading the cart.
WIDGET_SETTLE_MS = 5_000
WIDGET_BOUND_JS = r"""box => {
  const re = /^qs-widget-summary-atc-.*QuantityAndCadenceSelector-([A-Z0-9]{10})$/;
  const asins = new Set();
  for (let n = box.parentElement; n; n = n.parentElement) {
    const m = re.exec(n.id || ""); if (m) asins.add(m[1]);
  }
  for (const n of box.querySelectorAll("[id^='qs-widget-summary-atc-']")) {
    const m = re.exec(n.id); if (m) asins.add(m[1]);
  }
  return [...asins];
}"""
FORM_IDENT_JS = (
    """f => [f.getAttribute("action") || "", f.id || "", f.getAttribute("name") || ""].join(" ")"""
)
SET_QTY_JS = """(form, q) => {
  let n = 0;
  for (const el of form.querySelectorAll("input, select")) {
    if (!/quantity/i.test(el.getAttribute("name") || "")) continue;
    if (el.tagName === "SELECT" && ![...el.options].some(o => o.value === String(q))) {
      el.add(new Option(String(q), String(q)));
    }
    el.value = String(q);
    n++;
  }
  return n;
}"""
# Controls that must never be clicked, whatever page we're on and whatever the model asked for:
# Buy Now / 1-Click / Turbo checkout / anything that orders or checks out. Matched against a
# control's id, name, value, label and text; its form's action also has to pass the URL guard.
DENY_CONTROL = re.compile(
    r"buy[\s._-]*now|turbo|check[\s_-]*out|place[\s_-]*(?:your[\s_-]*)?order|"
    r"(?:1|one)[\s_-]*click|buy[\s_-]*box|subscribe",
    re.I,
)
DESCRIBE_JS = """e => ({
  id: e.id || "", name: e.getAttribute("name") || "", value: e.value || "",
  "aria-label": e.getAttribute("aria-label") || "", title: e.getAttribute("title") || "",
  text: (e.innerText || e.textContent || "").slice(0, 200),
  formaction: e.getAttribute("formaction") || "",
  form_action: e.form ? (e.form.getAttribute("action") || "") : ""
})"""
_DESC_TEXT = ("id", "name", "value", "aria-label", "title", "text")


def control_allowed(desc: Mapping[str, str]) -> bool:
    """May the tools click this control? Never Buy Now / 1-Click / checkout (PRD §3 #4)."""
    if DENY_CONTROL.search(" ".join(desc.get(k) or "" for k in _DESC_TEXT)):
        return False
    for key in ("formaction", "form_action"):
        target = desc.get(key) or ""
        if target and guard.classify_url(urljoin("https://www.amazon.com/", target)):
            return False
        if DENY_CONTROL.search(target):
            return False
    return True


@dataclass(frozen=True)
class Snapshot:
    url: str
    html: str


class NotSignedIn(Exception):
    """The profile's Amazon session is gone; a human must sign in to that Chromium profile."""


class Driver(Protocol):
    def open(self, url: str) -> Snapshot: ...

    def click_confirm(self) -> Snapshot | None:
        """Click the add-to-cart confirm control; `None` when there isn't one."""
        ...

    def add_to_cart(self, asin: str, qty: int) -> Snapshot | None:
        """On a product page: set the quantity in `asin`'s own add-to-cart form and submit it
        with an allowed control (never Buy Now). `None` when there's no such form/control."""
        ...


def checked(snapshot: Snapshot) -> Snapshot:
    """Refuse to go on from a page we should never be on (e.g. a redirect we didn't catch)."""
    reason = guard.classify_url(snapshot.url)
    if reason == "signin":
        raise NotSignedIn(snapshot.url)
    if reason:
        raise guard.UnsafeUrl(snapshot.url, reason)
    return snapshot


class CdpDriver:
    def __init__(self, cdp_url: str, *, timeout_ms: float = 30_000) -> None:
        self.cdp_url = cdp_url
        self.timeout_ms = timeout_ms
        self._pw: Playwright | None = None
        self._browser: Browser | None = None
        self._page: Page | None = None
        self.blocked: list[str] = []

    def __enter__(self) -> Self:
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.connect_over_cdp(self.cdp_url, timeout=self.timeout_ms)
        if not self._browser.contexts:
            raise RuntimeError(f"no browser context at {self.cdp_url}: is the profile running?")
        context = self._browser.contexts[0]
        self._page = context.new_page()
        self._page.set_default_timeout(self.timeout_ms)
        self._page.route("**/*", self._route)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        try:
            if self._page is not None:
                self._page.close()
        finally:
            # Disconnects from the browser without closing it (we created no contexts).
            if self._pw is not None:
                self._pw.stop()

    def _route(self, route: Route) -> None:
        request = route.request
        if request.resource_type == "document" and guard.classify_url(request.url):
            self.blocked.append(request.url)
            route.abort("blockedbyclient")
        else:
            route.continue_()

    @property
    def page(self) -> Page:
        if self._page is None:
            raise RuntimeError("CdpDriver used outside its context manager")
        return self._page

    def _snapshot(self) -> Snapshot:
        return checked(Snapshot(self.page.url, self.page.content()))

    def open(self, url: str) -> Snapshot:
        guard.check_url(url)
        self.page.goto(url, wait_until="domcontentloaded")
        return self._snapshot()

    def click_confirm(self) -> Snapshot | None:
        """Click the first add-to-cart control that passes `control_allowed`; never Buy Now."""
        for found in (
            self.page.locator(CONFIRM_SELECTOR),
            self.page.get_by_role("button", name=CONFIRM_NAME),
        ):
            for i in range(found.count()):
                control = found.nth(i)
                if control_allowed(control.evaluate(DESCRIBE_JS)):
                    control.click()
                    self.page.wait_for_load_state("domcontentloaded")
                    return self._snapshot()
        return None

    def add_to_cart(self, asin: str, qty: int) -> Snapshot | None:
        """`asin`'s own add form, else its Whole Foods buy-box widget (`cart_add.add_control`)."""
        if not ASIN_RE.match(asin):  # it goes into a selector below
            raise ValueError(f"not an ASIN: {asin!r}")
        return self._add_by_form(asin, qty) or self._add_by_widget(asin, qty)

    def _add_by_form(self, asin: str, qty: int) -> Snapshot | None:
        forms = self.page.locator(f"form[action*='{ADD_FORM_ACTION}']").filter(
            has=self.page.locator(f"input[value='{asin}']")
        )
        for i in range(forms.count()):
            form = forms.nth(i)
            if SPONSORED_FORM.search(form.evaluate(FORM_IDENT_JS)):
                continue  # a sponsored ad, even for this ASIN
            controls = form.locator("[type=submit], button")
            allowed = [
                controls.nth(j)
                for j in range(controls.count())
                if control_allowed(controls.nth(j).evaluate(DESCRIBE_JS))
            ]
            if not allowed:
                continue
            if form.evaluate(SET_QTY_JS, qty) == 0 and qty != 1:
                continue  # can't set the quantity: don't add the wrong amount
            allowed[0].click()
            self.page.wait_for_load_state("domcontentloaded")
            return self._snapshot()
        return None

    def _add_by_widget(self, asin: str, qty: int) -> Snapshot | None:
        """The Whole Foods buy box bound to `asin` alone; its first control in
        `#freshAddToCartButton`, if `control_allowed`. Same rule as `cart_add.wf_add_control`."""
        boxes = self.page.locator(", ".join(f"[id='{b}']" for b in WF_BUY_BOX_IDS))
        for i in range(boxes.count()):
            box = boxes.nth(i)
            if box.evaluate(WIDGET_BOUND_JS) != [asin]:
                continue
            control = box.locator(
                f"[id='{WF_BUTTON_ID}']:is(button, input), [id='{WF_BUTTON_ID}'] :is(button, input)"
            ).first
            if control.count() == 0 or not control_allowed(control.evaluate(DESCRIBE_JS)):
                continue
            if box.evaluate(SET_QTY_JS, qty) == 0 and qty != 1:
                continue  # can't set the quantity: don't add the wrong amount
            control.click()
            self._settle()
            return self._snapshot()
        return None

    def _settle(self) -> None:
        from playwright.sync_api import TimeoutError as PlaywrightTimeout

        with contextlib.suppress(PlaywrightTimeout):  # never idle: the cart check decides
            self.page.wait_for_load_state("networkidle", timeout=WIDGET_SETTLE_MS)
