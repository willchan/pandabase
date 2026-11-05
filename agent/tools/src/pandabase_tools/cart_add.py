"""Add one ASIN to the cart from its product page — the add path tiers 1 and 2 share (DESIGN §6).

Amazon's `/gp/aws/cart/add.html?ASIN.1=…` stopped adding anything (2026-11-04: it redirects to
the cart), so each line is added the way a person would: open `/dp/{ASIN}`, submit *that ASIN's
own* add-to-cart form (action `/cart/add-to-cart…`, an input whose value is the ASIN, an allowed
submit — `browser.control_allowed` never lets Buy Now / 1-Click / Turbo be the control), then
re-read the cart page and count it as added only if the cart count rose. An ASIN already in the
active cart is not added again, so a re-run never doubles a line. Every navigation goes through
the guard; no page text is returned to the model.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from . import dom, guard
from .browser import ADD_FORM_ACTION, ASIN_RE, Driver, NotSignedIn, control_allowed
from .telemetry import Telemetry

PRODUCT_URL = "https://www.amazon.com/dp/{asin}"
CART_URL = "https://www.amazon.com/gp/cart/view.html"
# Whole Foods items live in their own cart (the smoke check reads the same page). Unverified live:
# whether `nav-cart-count` there counts the Whole Foods cart (README smoke; PLAN Notes).
CART_URLS = {"amazon": CART_URL, "wholefoods": "https://www.amazon.com/cart/localmarket"}
SUBTOTAL_COUNT = re.compile(r"subtotal\s*\(\s*(\d+)\s+items?\s*\)", re.I)

AddResult = Literal["added", "already_in_cart", "failed"]


@dataclass
class AddOutcome:
    outcome: AddResult
    reason: str | None = None
    cart_count_before: int | None = None
    cart_count_after: int | None = None


def _submits(form: dom.Node) -> list[dom.Node]:
    return [
        n
        for n in form.iter()
        if n.tag == "button" or (n.tag == "input" and n.attrs.get("type", "").lower() == "submit")
    ]


def add_form(root: dom.Node, asin: str) -> dom.Node | None:
    """The add-to-cart form for `asin` with a control the driver may click, if the page has one."""
    for form in root.find_all("form"):
        action = form.attrs.get("action", "")
        if ADD_FORM_ACTION not in action:
            continue
        if not any(n.tag == "input" and n.attrs.get("value") == asin for n in form.iter()):
            continue
        if any(
            control_allowed({**n.attrs, "text": n.text(), "form_action": action})
            for n in _submits(form)
        ):
            return form
    return None


def cart_state(html: str) -> tuple[int | None, set[str]]:
    """(item count, ASINs in the active cart). Saved-for-later and recommendations don't count:
    only `data-asin` rows inside a cart form whose `data-itemtype` isn't `saved`."""
    root = dom.parse(html)
    count: int | None = None
    for node in root.iter():
        if node.attrs.get("id") == "nav-cart-count":
            digits = re.sub(r"\D", "", node.text())
            count = int(digits) if digits else None
            break
    if count is None:
        m = SUBTOTAL_COUNT.search(root.text())
        count = int(m.group(1)) if m else None
    asins: set[str] = set()
    for form in root.find_all("form"):
        action = form.attrs.get("action", "")
        if "/cart" not in action or ADD_FORM_ACTION in action:
            continue
        for node in form.iter():
            asin = node.attrs.get("data-asin", "")
            if ASIN_RE.match(asin) and node.attrs.get("data-itemtype", "active") == "active":
                asins.add(asin)
    return count, asins


def add_one(
    driver: Driver, asin: str, qty: int, tel: Telemetry, vendor: str | None = None
) -> AddOutcome:
    """Never raises for page trouble: refusals and layout problems come back as `failed`."""
    if not ASIN_RE.match(asin):
        raise ValueError(f"not an ASIN: {asin!r} (10 upper-case letters/digits)")
    out = AddOutcome("failed")
    url = PRODUCT_URL.format(asin=asin)
    cart_url = CART_URLS.get(vendor or "amazon", CART_URL)
    try:
        before, in_cart = cart_state(driver.open(cart_url).html)
        out.cart_count_before = before
        if asin in in_cart:
            out.outcome = "already_in_cart"
            return out
        page = driver.open(guard.check_url(url))
        if add_form(dom.parse(page.html), asin) is None:
            tel.emit("selector_error", selector="product_add_form", error="not_found", page=url)
            out.reason = "no_add_form"
            return out
        if driver.add_to_cart(asin, qty) is None:
            tel.emit("selector_error", selector="product_add_form", error="no_control", page=url)
            out.reason = "no_add_form"
            return out
        after, now_in = cart_state(driver.open(cart_url).html)
        out.cart_count_after = after
        # No count on the page: fall back to the ASIN appearing in the active cart.
        known = before is not None and after is not None
        rose = (after or 0) > (before or 0) if known else asin in now_in
        if rose:
            out.outcome = "added"
        else:
            tel.emit("selector_error", selector="cart_count", error="unverified", page=url)
            out.reason = "unverified"
    except NotSignedIn:
        out.reason = "not_signed_in"
    except guard.UnsafeUrl as err:
        out.reason = f"refused_{err.reason}"
    except Exception as err:
        tel.emit("selector_error", selector="product_add", error=type(err).__name__, page=url)
        out.reason = f"{type(err).__name__}: {err}"[:200]
    return out
