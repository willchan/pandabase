"""Add one ASIN to the cart from its product page — the add path tiers 1 and 2 share (DESIGN §6).

Amazon's `/gp/aws/cart/add.html?ASIN.1=…` stopped adding anything (2026-11-04: it redirects to
the cart), so each line is added the way a person would: open `/dp/{ASIN}` and use *that ASIN's
own* add control — its add-to-cart form (action `/cart/add-to-cart…`, an input whose value is the
ASIN, an allowed submit), or on a Whole Foods page the buy-box widget bound to the ASIN (no form
there; the page's only add forms are sponsored `spAddToCart` ads, which are never used).
`browser.control_allowed` never lets Buy Now / 1-Click / Turbo / subscribe be the control. Then
re-read the vendor's cart and count it as added only if the ASIN is now one of its active rows
(`#nav-cart-count` is not trusted: live, it jumped 1 → 4 for one item). An ASIN already in the
active cart is not added again, so a re-run never doubles a line. Every navigation goes through
the guard; no page text is returned to the model.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from . import dom, guard
from .browser import (
    ADD_FORM_ACTION,
    ASIN_RE,
    SPONSORED_FORM,
    WF_BUTTON_ID,
    WF_BUY_BOX_IDS,
    WF_PAGE_BUY_BOX_ID,
    WF_WIDGET_ID,
    Driver,
    NotSignedIn,
    buy_box_bound,
    control_allowed,
)
from .telemetry import Telemetry

PRODUCT_URL = "https://www.amazon.com/dp/{asin}"
CART_URL = "https://www.amazon.com/gp/cart/view.html"
# Whole Foods items live in their own cart. `/cart/localmarket` alone shows the grocery cart of
# whichever local-market brand Amazon picks (Amazon Fresh or Whole Foods); `almBrandId` is base64
# "UFG Whole Foods", the id Amazon's Whole Foods storefront links carry. Not yet seen live with
# Whole Foods rows on it (PLAN Notes); the smoke check reads the same URL.
WF_CART_URL = "https://www.amazon.com/cart/localmarket?almBrandId=VUZHIFdob2xlIEZvb2Rz"
CART_URLS = {"amazon": CART_URL, "wholefoods": WF_CART_URL}
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


def _describe(node: dom.Node) -> dict[str, str]:
    """What `browser.DESCRIBE_JS` reports for a control, from the parsed page."""
    form = next((a for a in node.ancestors() if a.tag == "form"), None)
    return {
        **node.attrs,
        "text": node.text(),
        "form_action": form.attrs.get("action", "") if form else "",
    }


def sponsored(form: dom.Node) -> bool:
    """A sponsored ad's add form (`spAddToCart`): never this page's add control."""
    return bool(
        SPONSORED_FORM.search(" ".join(form.attrs.get(k, "") for k in ("action", "id", "name")))
    )


def add_form(root: dom.Node, asin: str) -> dom.Node | None:
    """The add-to-cart form for `asin` with a control the driver may click, if the page has one.
    Sponsored ads are never it, even for the same ASIN."""
    for form in root.find_all("form"):
        action = form.attrs.get("action", "")
        if ADD_FORM_ACTION not in action or sponsored(form):
            continue
        if not any(n.tag == "input" and n.attrs.get("value") == asin for n in form.iter()):
            continue
        if any(
            control_allowed({**n.attrs, "text": n.text(), "form_action": action})
            for n in _submits(form)
        ):
            return form
    return None


def _widget_asin(node: dom.Node) -> str | None:
    m = WF_WIDGET_ID.match(node.attrs.get("id", ""))
    return m.group(1) if m else None


def wf_add_control(root: dom.Node, asin: str, page_url: str | None = None) -> dom.Node | None:
    """A Whole Foods buy box's add control for `asin` (`CdpDriver` applies the same rule).

    The buy box (`#almAddToCart_feature_div` / `#core-dp-alm-atc-wf`) must be `asin`'s
    (`browser.buy_box_bound`): any `qs-widget-summary-atc-…QuantityAndCadenceSelector-<ASIN>`
    widget inside or around it names only `asin`; if none names an ASIN (live pickup offers: the
    ids carry a random number), it must sit in the page's `#buybox` and `page_url` must be
    `/dp/<asin>`. The control is the first button/input of `#freshAddToCartButton` in that box,
    else the widget's own `qs-widget-summary-atc-…` button, and must pass `control_allowed`.
    Another item's box elsewhere on the page and sponsored ads are never it.
    """
    page_asin = dom.asin_from_href(page_url) if page_url else None
    for box in root.iter():
        if box.attrs.get("id") not in WF_BUY_BOX_IDS:
            continue
        bound = {a for n in [*box.iter(), *box.ancestors()] if (a := _widget_asin(n))}
        in_buybox = any(a.attrs.get("id") == WF_PAGE_BUY_BOX_ID for a in box.ancestors())
        if not buy_box_bound(bound, in_buybox, page_asin, asin):
            continue
        holders = [n for n in box.iter() if n.attrs.get("id") == WF_BUTTON_ID]
        fresh = [c for h in holders for c in h.iter() if c.tag in ("button", "input")][:1]
        summary = [
            n
            for n in box.iter()
            if n.tag in ("button", "input")
            and n.attrs.get("id", "").startswith("qs-widget-summary-atc-")
        ][:1]
        for control in (*fresh, *summary):
            if control_allowed(_describe(control)):
                return control
    return None


def add_control(root: dom.Node, asin: str, page_url: str | None = None) -> dom.Node | None:
    """`asin`'s own add control on its product page (at `page_url`): its add form, else a Whole
    Foods buy box."""
    return add_form(root, asin) or wf_add_control(root, asin, page_url)


def cart_state(html: str) -> tuple[int | None, set[str]]:
    """(item count, ASINs in the active cart). Saved-for-later and recommendations don't count:
    only `data-asin` rows inside a cart form whose `data-itemtype` isn't `saved`. The count
    (`#nav-cart-count`, else "Subtotal (N items)") is reported, never used to decide an add."""
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
        if add_control(dom.parse(page.html), asin, page.url) is None:
            tel.emit("selector_error", selector="product_add_form", error="not_found", page=url)
            out.reason = "no_add_form"
            return out
        if driver.add_to_cart(asin, qty) is None:
            tel.emit("selector_error", selector="product_add_form", error="no_control", page=url)
            out.reason = "no_add_form"
            return out
        after, now_in = cart_state(driver.open(cart_url).html)
        out.cart_count_after = after
        # Only the ASIN in this vendor's active rows counts: `nav-cart-count` jumped 1 → 4 for one
        # Amazon item while the cart held 8 (live, 2026-11-04).
        if asin in now_in:
            out.outcome = "added"
        else:
            tel.emit("selector_error", selector="cart_rows", error="unverified", page=url)
            out.reason = "unverified"
    except NotSignedIn:
        out.reason = "not_signed_in"
    except guard.UnsafeUrl as err:
        out.reason = f"refused_{err.reason}"
    except Exception as err:
        tel.emit("selector_error", selector="product_add", error=type(err).__name__, page=url)
        out.reason = f"{type(err).__name__}: {err}"[:200]
    return out
