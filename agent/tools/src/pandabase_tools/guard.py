"""Cart only, never checkout (PRD §3 #4).

Every URL a tool opens, and every URL the browser lands on after a click, passes `check_url`.
Anything that isn't plain Amazon `https`, or that looks like checkout, payment or sign-in, is
refused before the request is made. `CdpDriver` also installs this as a Playwright route so a
redirect or script-initiated navigation to checkout is aborted in the browser itself.
"""

from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit

ALLOWED_HOSTS = frozenset({"www.amazon.com", "amazon.com", "smile.amazon.com"})

# Matched against the lower-cased, URL-decoded path + query.
CHECKOUT_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p)
    for p in (
        r"checkout",  # /checkout/…, go-to-checkout, proceedToRetailCheckout, checkoutportal
        r"/gp/buy/",  # classic + single-page checkout (/gp/buy/spc/…)
        r"/buy/",
        r"/spc/",
        r"/gp/payment",
        r"/payments?/",
        r"/cpe/",  # payment instrument pages
        r"/wallet",
        r"/pay/",
        r"place-?your-?order",
        r"placeorder",
        r"/gp/cart/desktop/go-to",
        r"/alm/(?:byg|checkout|confirm)",  # Whole Foods / Fresh checkout flow
        r"/afx/(?:checkout|slot)",  # delivery/pickup slot selection precedes checkout
    )
)
# We never sign in: a sign-in page means the profile's session expired; a human fixes it.
SIGNIN_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^/ap/(?:signin|mfa|cvf|challenge)"),
    re.compile(r"^/ax/claim"),
)


class UnsafeUrl(Exception):
    """A navigation the tools must never make. `reason` is `checkout`, `signin` or `host`."""

    def __init__(self, url: str, reason: str) -> None:
        super().__init__(f"refused {reason} URL: {url}")
        self.url = url
        self.reason = reason


def classify_url(url: str) -> str | None:
    """`None` when safe, else the refusal reason."""
    if url in ("about:blank", ""):
        return None
    parts = urlsplit(url)
    if parts.scheme != "https" or (parts.hostname or "").lower() not in ALLOWED_HOSTS:
        return "host"
    path = unquote(parts.path).lower()
    target = path + "?" + unquote(parts.query).lower()
    if any(p.search(target) for p in CHECKOUT_PATTERNS):
        return "checkout"
    if any(p.search(path) for p in SIGNIN_PATTERNS):
        return "signin"
    return None


def check_url(url: str) -> str:
    """Return `url` if the tools may open it; raise `UnsafeUrl` otherwise."""
    reason = classify_url(url)
    if reason:
        raise UnsafeUrl(url, reason)
    return url
