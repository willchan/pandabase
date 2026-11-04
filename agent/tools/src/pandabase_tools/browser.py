"""Browser access for the tools: a small `Driver` protocol and its CDP implementation.

`CdpDriver` attaches over CDP to a member's already-running, already-signed-in Chromium
(`--remote-debugging-port`, see `profiles.json`). It never launches a browser, never signs in and
never stores credentials. It opens its own tab in the existing context, routes every document
request through `guard.check_url` (aborting checkout/payment/sign-in and non-Amazon navigations),
and closes only that tab. Tests use a fixture-backed fake with the same protocol.
"""

from __future__ import annotations

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
