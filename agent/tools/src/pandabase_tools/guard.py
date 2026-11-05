"""Cart only, never checkout (PRD §3 #4).

Every URL a tool opens, and every URL the browser lands on after a click, passes `check_url`.
Anything that isn't plain Amazon `https`, or that looks like checkout, payment or sign-in, is
refused before the request is made (Buy Now, 1-Click and Turbo checkout count as checkout).
`CdpDriver` also installs this as a Playwright route so a redirect or script-initiated navigation to
checkout is aborted in the browser itself.

One exception, in the browser only: the product page's own "Add to cart" posts its buy-box form to
`/gp/product/handle-buy-box`, the endpoint Buy Now posts to as well. `buy_box_add` lets that one
POST through when the button pressed was `submit.add-to-cart` and nothing else in the form data
asks to buy, check out or subscribe. A tool never *opens* that URL; `check_url` still refuses it.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, unquote, urlsplit, urlunsplit

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
        r"handle-buy-box",  # product-page buy box: the form behind "Buy Now"
        r"buy-?now",
    )
)
# Path-only: these words can legitimately appear in a search query ("turbo" dog food).
CHECKOUT_PATH_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p) for p in (r"/turbo", r"/(?:1|one)-?click")
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
    if any(p.search(target) for p in CHECKOUT_PATTERNS) or any(
        p.search(path) for p in CHECKOUT_PATH_PATTERNS
    ):
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


BUY_BOX_PATH = re.compile(r"^/gp/product/handle-buy-box(?=/|$)")
BUY_BOX_ADD_FIELD = "submit.add-to-cart"
# Form fields that make a buy-box POST something other than a plain add: another submit button
# (Buy Now, wishlist, ...), or anything about buying now, checkout, 1-Click, Turbo or subscribing.
BUY_BOX_REFUSED_FIELD = re.compile(
    r"^submit\.|buy[\s._-]*now|check[\s._-]*out|turbo|(?:1|one)[\s._-]*click|subscri|^sns", re.I
)


def is_buy_box_url(url: str) -> bool:
    """A product page's buy-box form endpoint (`handle-buy-box`) on an allowed host."""
    parts = urlsplit(url)
    return (
        parts.scheme == "https"
        and (parts.hostname or "").lower() in ALLOWED_HOSTS
        and bool(BUY_BOX_PATH.match(unquote(parts.path).lower()))
    )


def buy_box_add(url: str, method: str, post_data: str | None) -> bool:
    """Is this request the buy box's own "Add to cart" POST, and nothing more? Only the pressed
    submit button's name is in a form's data, so Buy Now (`submit.buy-now`) never passes."""
    if method.upper() != "POST" or not post_data or not is_buy_box_url(url):
        return False
    parts = urlsplit(url)
    rest = BUY_BOX_PATH.sub("/gp/product/add", unquote(parts.path).lower(), count=1)
    if classify_url(urlunsplit(("https", parts.netloc, rest, parts.query, ""))):
        return False  # checkout or sign-in elsewhere in the URL
    try:
        fields = parse_qsl(post_data, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        return False  # not form-encoded: can't tell what it asks for
    names = [name for name, _ in fields]
    return BUY_BOX_ADD_FIELD in names and not any(
        BUY_BOX_REFUSED_FIELD.search(n) for n in names if n != BUY_BOX_ADD_FIELD
    )
