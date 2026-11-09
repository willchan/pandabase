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
from urllib.parse import urljoin, urlsplit

from . import dom, guard

if TYPE_CHECKING:
    from playwright.sync_api import Browser, Page, Playwright, Route

# The one control a tier-1 batch clicks: the confirm/submit button of the add-to-cart form.
# Located by form action and input type, with an accessible-name fallback — no class names.
CONFIRM_SELECTOR = "form[action*='/cart/add'] [type=submit], form[action*='/cart/add'] button"
CONFIRM_NAME = re.compile(r"^\s*(continue|add to (your )?cart|add all to cart)\s*$", re.I)
# Product-page add (tiers 1 and 2, `cart_add`): the ASIN's own add-to-cart form ...
ADD_FORM_ACTION = "/cart/add-to-cart"
ASIN_RE = re.compile(r"^[A-Z0-9]{10}$")
# ... carrying that ASIN alone (a bundle form with more is never "its own": live, 2026-11-04, a
# sponsored bundle ad added three items) and never a sponsored ad's (`spAddToCart`, `ref=sspa_…`;
# matched against the form's action, id and name) ...
SPONSORED_FORM = re.compile(r"spAddToCart|sspa", re.I)
ASIN_INPUT = re.compile(r"asin", re.I)  # input names: items[0.base][asin], ASIN, snsAsin
# ... or the page's own buy-box form (`#addToCart`, action `/gp/product/handle-buy-box`: Buy Now's
# endpoint, which the guard refuses): only its `submit.add-to-cart` button, which posts to
# `/cart/add-to-cart` through its `formaction` (live, 2026-11-05; `buy_box_add_allowed`), in a form
# carrying this ASIN alone and no subscription (`snsAsin`; live, its add button has the same name).
BUY_BOX_FORM_ACTION = "/gp/product/handle-buy-box"
BUY_BOX_ADD_NAME = "submit.add-to-cart"
SUBSCRIPTION = re.compile(r"subscri|^sns|\bsns", re.I)
# ... or, on a Whole Foods page (no form), the buy-box widget bound to the ASIN.
WF_BUY_BOX_IDS = ("almAddToCart_feature_div", "core-dp-alm-atc-wf")
WF_WIDGET_ID = re.compile(r"^qs-widget-summary-atc-.*QuantityAndCadenceSelector-([A-Z0-9]{10})$")
WF_BUTTON_ID = "freshAddToCartButton"
# The page's main buy box. Live pickup offers' widget ids carry a random instance number, not the
# ASIN (probe, 2026-11-04): such a box is bound by the page — inside `#buybox` on `/dp/<ASIN>`.
WF_PAGE_BUY_BOX_ID = "buybox"
# The widget's own add button, used when `#freshAddToCartButton` has no visible control.
WF_SUMMARY_ATC = "[id^='qs-widget-summary-atc-']:is(button, input)"
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
  return {asins: [...asins], inBuybox: !!box.closest("[id='buybox']")};
}"""
FORM_IDENT_JS = """f => ({
  ident: [f.getAttribute("action") || "", f.id || "", f.getAttribute("name") || ""].join(" "),
  asins: [...new Set([...f.querySelectorAll("input")]
    .filter(e => /asin/i.test(e.getAttribute("name") || "")).map(e => e.value))],
  names: [...f.querySelectorAll("input, select, button")].map(e => e.getAttribute("name") || ""),
})"""
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


def buy_box_bound(
    widget_asins: set[str], in_buybox: bool, page_asin: str | None, asin: str
) -> bool:
    """Is a Whole Foods buy box `asin`'s? Its widgets may name no ASIN but `asin`; if they name
    none, it must be the page's main buy box on `asin`'s own product page."""
    if widget_asins:
        return widget_asins == {asin}
    return in_buybox and page_asin == asin


def subscription_form(input_names: list[str]) -> bool:
    """A buy-box form that would add a Subscribe & Save subscription (live: an `snsAsin` input)."""
    return any(SUBSCRIPTION.search(n) for n in input_names)


def buy_box_add_allowed(desc: Mapping[str, str]) -> bool:
    """The one control in a buy-box (`handle-buy-box`) form the tools may click: its plain "Add to
    cart" (`submit.add-to-cart`), which posts to `/cart/add-to-cart` through its `formaction`.
    Never Buy Now / 1-Click / checkout / subscription; never one that would post to the buy box
    itself or anywhere else. The form's other checks (ASIN, subscription) are the caller's."""
    if desc.get("name") != BUY_BOX_ADD_NAME:
        return False
    if BUY_BOX_FORM_ACTION not in (desc.get("form_action") or ""):
        return False
    words = " ".join(desc.get(k) or "" for k in _DESC_TEXT if k != "name")
    if DENY_CONTROL.search(words) or SUBSCRIPTION.search(words):
        return False
    target = urljoin("https://www.amazon.com/", desc.get("formaction") or "")
    parts = urlsplit(target)
    return parts.path.startswith(ADD_FORM_ACTION) and guard.classify_url(target) is None


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


class Challenged(NotSignedIn):
    """Amazon's bot check (`/checkpoint`, captcha): a human must clear it in that profile. A
    `NotSignedIn`, so every tool already stops on it; the receipt sweep reports it by name."""


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
    if reason == "challenge":
        raise Challenged(snapshot.url)
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
        from playwright.sync_api import Error as PlaywrightError

        guard.check_url(url)
        blocked = len(self.blocked)
        try:
            self.page.goto(url, wait_until="domcontentloaded")
        except PlaywrightError:
            # `_route` aborted a redirect (sign-in, bot check, checkout): say which.
            if len(self.blocked) > blocked:
                return checked(Snapshot(self.blocked[-1], ""))
            raise
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
        return (
            self._add_by_buy_box(asin, qty)
            or self._add_by_form(asin, qty)
            or self._add_by_widget(asin, qty)
        )

    def _add_by_buy_box(self, asin: str, qty: int) -> Snapshot | None:
        """The buy box's own "Add to cart" (`buy_box_add_allowed`), in a visible `handle-buy-box`
        form that carries `asin` alone and no subscription. Same rule as `cart_add.buy_box_add`.
        Its POST goes to `/cart/add-to-cart`; the buy box's own endpoint stays refused."""
        forms = self.page.locator(f"form[action*='{BUY_BOX_FORM_ACTION}']").filter(
            has=self.page.locator(f"input[value='{asin}']")
        )
        for i in range(forms.count()):
            form = forms.nth(i)
            ident = form.evaluate(FORM_IDENT_JS)
            if ident["asins"] != [asin] or subscription_form(ident["names"]):
                continue
            controls = form.locator(f"[name='{BUY_BOX_ADD_NAME}']:is(input, button)")
            control = next(
                (
                    c
                    for c in (controls.nth(j) for j in range(controls.count()))
                    if c.is_visible() and buy_box_add_allowed(c.evaluate(DESCRIBE_JS))
                ),
                None,
            )
            if control is None:
                continue
            if form.evaluate(SET_QTY_JS, qty) == 0 and qty != 1:
                continue  # can't set the quantity: don't add the wrong amount
            control.click()
            # A form POST (lands on the cart) or an in-page add: either way, wait a bounded time.
            self.page.wait_for_load_state("domcontentloaded")
            self._settle()
            return self._snapshot()
        return None

    def _add_by_form(self, asin: str, qty: int) -> Snapshot | None:
        forms = self.page.locator(f"form[action*='{ADD_FORM_ACTION}']").filter(
            has=self.page.locator(f"input[value='{asin}']")
        )
        for i in range(forms.count()):
            form = forms.nth(i)
            ident = form.evaluate(FORM_IDENT_JS)
            if SPONSORED_FORM.search(ident["ident"]) or ident["asins"] != [asin]:
                continue  # a sponsored ad or a bundle, even with this ASIN in it
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
        """The Whole Foods buy box bound to `asin` (`buy_box_bound`); its first control in
        `#freshAddToCartButton` (else the widget's own add button) that is visible and
        `control_allowed`. Same rule as `cart_add.wf_add_control`."""
        page_asin = dom.asin_from_href(self.page.url)
        boxes = self.page.locator(", ".join(f"[id='{b}']" for b in WF_BUY_BOX_IDS))
        for i in range(boxes.count()):
            box = boxes.nth(i)
            bound = box.evaluate(WIDGET_BOUND_JS)
            if not buy_box_bound(set(bound["asins"]), bound["inBuybox"], page_asin, asin):
                continue
            candidates = (
                box.locator(f"[id='{WF_BUTTON_ID}'] :is(button, input)").first,
                box.locator(WF_SUMMARY_ATC).first,
            )
            control = next((c for c in candidates if c.count() and c.is_visible()), None)
            if control is None or not control_allowed(control.evaluate(DESCRIBE_JS)):
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
