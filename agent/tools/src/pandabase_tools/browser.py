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
import time
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
# Costco (M10.3): the page's own hooks for the tabs, the order history and order details.
COSTCO_TABS = {
    "online": "[automation-id='myOnlineOrdersTab']",
    "warehouse": "[automation-id='myWarehouseOrdersTab']",
}
COSTCO_READY = {
    "orders": "[automation-id='myOrderHistory']",
    "details": "[automation-id='orderNumber']",
}
COSTCO_BARCODE = re.compile(r"^\d{23}$")
COSTCO_WAIT_MS = 15_000
# Each tab's cards render after its frame (live, 2026-11): wait for one before reading the list.
# An empty period has none, so this is also how long an empty tab costs (then a network settle).
COSTCO_CARDS = {
    "online": "a[id^='orderNumber_']",
    "warehouse": "[id^='viewRecieptBtn_']",
}
COSTCO_LIST_WAIT_MS = 8_000
# Subscribe & Save (`subscriptions`): the "Your Subscriptions" grid and its category pills render
# after the page's frame; wait (bounded) for a tile's edit link, then for the pills.
SUBSCRIPTIONS_READY = (
    "[data-edit-url*='/auto-deliveries/ajax/subscription/']",
    "[data-category-id]",
)
SUBSCRIPTIONS_WAIT_MS = 15_000


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


# Costco's silent session refresh (`guard.COSTCO_REFRESH_PATH`): how long `open` waits for it to
# land back on an account page (live: ~6 s), and how many refresh posts one `open` lets through.
COSTCO_REFRESH_WAIT_MS = 15_000
COSTCO_REFRESH_MAX = 2
COSTCO_REFRESH_POLL_MS = 200


class CdpDriver:
    def __init__(self, cdp_url: str, *, timeout_ms: float = 30_000) -> None:
        self.cdp_url = cdp_url
        self.timeout_ms = timeout_ms
        self._pw: Playwright | None = None
        self._browser: Browser | None = None
        self._page: Page | None = None
        self.blocked: list[str] = []
        self.refreshes = 0  # Costco session-refresh posts let through (`_route`)
        self._refresh_budget = 0

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
            # Costco's sign-in page posting the refreshed session back: the main frame only, a
            # POST, during an `open` that still has budget. Every other refused page is aborted.
            if (
                guard.costco_session_refresh(request.url)
                and request.method == "POST"
                and request.frame.parent_frame is None
                and self._refresh_budget > 0
            ):
                self._refresh_budget -= 1
                self.refreshes += 1
                route.fallback()
                return
            self.blocked.append(request.url)
            route.abort("blockedbyclient")
        else:
            route.fallback()  # = continue_() with no other handler (tests stack a fake server)

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
        blocked, refreshes = len(self.blocked), self.refreshes
        self._refresh_budget = COSTCO_REFRESH_MAX if guard.costco_account_page(url) else 0
        try:
            try:
                self.page.goto(url, wait_until="domcontentloaded")
            except PlaywrightError:
                # `_route` aborted a redirect (sign-in, bot check, checkout): say which.
                if len(self.blocked) > blocked:
                    return self._blocked_page(self.blocked[-1])
                # The refresh post interrupted the first navigation: wait for it below.
                if self.refreshes == refreshes and not guard.costco_signin_page(self.page.url):
                    raise
            if self.refreshes > refreshes or guard.costco_signin_page(self.page.url):
                self._await_costco_refresh(blocked)
        finally:
            self._refresh_budget = 0
        return self._snapshot()

    @staticmethod
    def _blocked_page(url: str) -> Snapshot:
        """Raise for a page `_route` aborted. A Costco refresh post past its budget is a refresh
        that loops: signed out, not an unsafe page."""
        if guard.costco_session_refresh(url):
            raise NotSignedIn(url)
        return checked(Snapshot(url, ""))

    def _await_costco_refresh(self, blocked: int) -> None:
        """On Costco's sign-in pages after `open`: wait for its silent refresh to land back on an
        account page. Nothing is read or clicked there. A sign-in form that waits for a person
        (the session really expired) or a refresh that loops is `NotSignedIn`."""
        from playwright.sync_api import Error as PlaywrightError

        deadline = time.monotonic() + COSTCO_REFRESH_WAIT_MS / 1000
        while time.monotonic() < deadline and len(self.blocked) == blocked:
            if guard.costco_account_page(self.page.url):
                with contextlib.suppress(PlaywrightError):
                    self.page.wait_for_load_state("domcontentloaded")
                break
            self.page.wait_for_timeout(COSTCO_REFRESH_POLL_MS)
        if len(self.blocked) > blocked:
            self._blocked_page(self.blocked[-1])
        if not guard.costco_account_page(self.page.url):
            raise NotSignedIn(self.page.url)

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

    # Costco Orders & Purchases (M10.3, `costco_receipts`): four clicks on one read-only page.
    # Located by `automation-id` / `id` (the live page's own hooks; its class names are hashed),
    # never by text a model chose. None of them can navigate anywhere: the guard route still
    # aborts any document request off `costco.com/myaccount`.

    def _costco_wait(self, selector: str) -> Snapshot:
        from playwright.sync_api import TimeoutError as PlaywrightTimeout

        with contextlib.suppress(PlaywrightTimeout):  # the snapshot decides what's there
            self.page.wait_for_selector(selector, timeout=COSTCO_WAIT_MS)
        return self._snapshot()

    def _costco_click(self, selector: str) -> None:
        control = self.page.locator(selector).first
        if not control_allowed(control.evaluate(DESCRIBE_JS)):
            raise guard.UnsafeUrl(self.page.url, "checkout")
        control.click()

    def costco_ready(self, page: str) -> Snapshot:
        """After `open`: wait (bounded) for the SPA to render `orders` (Orders & Purchases) or
        `details` (an order's details; a hash route on the same document). `orders` opens on the
        Online tab, whose cards are waited for too."""
        snap = self._costco_wait(COSTCO_READY[page])
        return self._costco_list("online") if page == "orders" else snap

    def costco_tab(self, tab: str) -> Snapshot:
        self._costco_click(COSTCO_TABS[tab])
        self._costco_wait(f"{COSTCO_TABS[tab]}[aria-selected='true']")
        return self._costco_list(tab)

    def _costco_list(self, tab: str) -> Snapshot:
        """The tab's list once a card has rendered; an empty list after a bounded wait and a
        network settle (the snapshot decides what's there)."""
        from playwright.sync_api import TimeoutError as PlaywrightTimeout

        try:
            self.page.wait_for_selector(COSTCO_CARDS[tab], timeout=COSTCO_LIST_WAIT_MS)
        except PlaywrightTimeout:
            self._settle()
        return self._snapshot()

    def costco_period(self, label: str) -> Snapshot:
        self.page.locator("select#Showing").first.select_option(label=label)
        self._settle()
        return self._snapshot()

    def costco_open_receipt(self, barcode: str) -> Snapshot:
        if not COSTCO_BARCODE.match(barcode):  # it goes into a selector below
            raise ValueError(f"not a Costco receipt barcode: {barcode!r}")
        self._costco_click(
            f"[id='viewRecieptBtn_{barcode}'] [automation-id='ViewInWareHouseReciept']"
        )
        return self._costco_wait("table[aria-label='spanning table'] tbody tr")

    def costco_close_receipt(self) -> Snapshot:
        self._costco_click("[automation-id='closePopup']")
        from playwright.sync_api import TimeoutError as PlaywrightTimeout

        with contextlib.suppress(PlaywrightTimeout):
            self.page.wait_for_selector(
                "table[aria-label='spanning table']", state="detached", timeout=COSTCO_WAIT_MS
            )
        return self._snapshot()

    def subscriptions_ready(self) -> Snapshot:
        """After `open` on the Subscribe & Save page: the snapshot once a subscription tile and the
        category pills have rendered, or after a bounded wait and a network settle (the parser's
        count check decides whether the list is whole). Nothing is clicked."""
        from playwright.sync_api import TimeoutError as PlaywrightTimeout

        try:
            for selector in SUBSCRIPTIONS_READY:
                self.page.wait_for_selector(selector, timeout=SUBSCRIPTIONS_WAIT_MS)
        except PlaywrightTimeout:
            self._settle()
        return self._snapshot()

    def _settle(self) -> None:
        from playwright.sync_api import TimeoutError as PlaywrightTimeout

        with contextlib.suppress(PlaywrightTimeout):  # never idle: the cart check decides
            self.page.wait_for_load_state("networkidle", timeout=WIDGET_SETTLE_MS)
