"""Amazon layout watch (DESIGN §6): notice when Amazon's page layout breaks the cart tools.

Two signals, both in the weekly diagnostics report (`cart_layout_alert`, `cart_probe`):

- **Build alert** (`layout_alert`): after Saturday's tier 1, if at least
  `cart.layout_alert_min_lines` lines (2) were not added for a *page* reason (`PAGE_REASONS`: no
  add button found, the add didn't show in the cart, the old add-URL page signals) and they are at
  least `cart.layout_alert_share` (half) of the lines tier 1 tried, the build's output carries a
  `layout_alert` and the skill posts one ⚠️ to the ops channel. Sign-in, guard refusals, extra
  items and exceptions (timeouts, network) are not page reasons: they'd alarm on the wrong thing.
- **Weekly check** (`probe`): before Saturday, open one Amazon and one Whole Foods product page
  (`cart.probe_asins`) and confirm that ASIN's own add control is still found by the same rule
  tier 1 uses (`cart_add.add_control`). Nothing is clicked and no cart page is opened.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from . import cart_add, dom, guard
from .browser import Driver, NotSignedIn
from .config import CartConfig
from .telemetry import Telemetry

if TYPE_CHECKING:  # cart_injector imports this module
    from .cart_injector import LineOutcome

# Tier-1 reasons that mean "the page wasn't what the tools expect".
PAGE_REASONS = frozenset(
    {
        "no_add_form",  # product page: this ASIN's add control not found
        "unverified",  # clicked add, but the ASIN isn't in the cart's active rows
        "layout_changed",  # add-URL path: not the add page / no form, no "added" message
        "not_offered",  # add-URL path: the confirm page didn't offer the ASIN
        "confirm_not_found",  # add-URL path: no confirm control
    }
)
STORE_NAMES = {"amazon": "Amazon", "wholefoods": "Whole Foods"}


def layout_alert(lines: list[LineOutcome], cfg: CartConfig) -> dict[str, Any] | None:
    """The alert for one build's tier-1 `lines` (only lines tier 1 actually tried), or `None`."""
    hits = [x for x in lines if x.outcome != "added" and x.reason in PAGE_REASONS]
    if not lines or len(hits) < cfg.layout_alert_min_lines:
        return None
    if len(hits) < cfg.layout_alert_share * len(lines):
        return None
    reasons: dict[str, int] = {}
    for x in hits:
        reasons[x.reason or ""] = reasons.get(x.reason or "", 0) + 1
    return {
        "page_failures": len(hits),
        "attempted": len(lines),
        "reasons": dict(sorted(reasons.items())),
        "asins": sorted(x.asin for x in hits if x.asin),
    }


def _check(driver: Driver, store: str, asin: str) -> dict[str, Any]:
    url = cart_add.PRODUCT_URL.format(asin=asin)
    out: dict[str, Any] = {"store": store, "asin": asin, "found": False, "reason": None}
    try:
        page = driver.open(guard.check_url(url))
        if dom.asin_from_href(urlsplit(page.url).path) != asin:
            out["reason"] = "not_product_page"  # a redirect or bot check, not the product
        elif cart_add.add_control(dom.parse(page.html), asin, page.url) is None:
            out["reason"] = "no_add_form"
        else:
            out["found"] = True
    except NotSignedIn:
        out["reason"] = "not_signed_in"
    except guard.UnsafeUrl as err:
        out["reason"] = f"refused_{err.reason}"
    except Exception as err:
        out["reason"] = type(err).__name__
    return out


def probe(
    driver: Driver,
    asins: Mapping[str, str],
    tel: Telemetry,
    sleep: Callable[[float], None],
    delay: float = 0.0,
) -> dict[str, Any]:
    """Open each configured store's product page and look for its add control. Never clicks."""
    checks: list[dict[str, Any]] = []
    for n, store in enumerate(s for s in STORE_NAMES if asins.get(s)):
        if n:
            sleep(delay)
        check = _check(driver, store, asins[store])
        tel.emit("cart_probe", **check)
        checks.append(check)
    if not checks:
        return {"ok": False, "status": "not_configured", "checks": []}
    bad = [c for c in checks if not c["found"]]
    if not bad:
        status = "ok"
    elif any(c["reason"] == "not_signed_in" for c in bad):
        status = "not_signed_in"
    elif any(c["reason"] in ("no_add_form", "not_product_page") for c in bad):
        status = "layout_changed"
    else:
        status = "error"
    return {"ok": not bad, "status": status, "checks": checks}


def probe_reply(res: Mapping[str, Any]) -> str:
    """One line for the ops channel, or `NO_REPLY` when all is well (OpenClaw command payload)."""
    status = res["status"]
    if status == "ok":
        return "NO_REPLY"
    if status == "not_configured":
        return (
            "⚠️ Weekly Amazon check isn't set up: add `cart.probe_asins` to pandabase.config.json."
        )
    if status == "not_signed_in":
        return (
            "⚠️ Weekly Amazon check: the cart profile is signed out of Amazon — "
            "sign in before Saturday's cart."
        )
    bad = [c for c in res["checks"] if not c["found"]]
    where = " and ".join(f"{STORE_NAMES[c['store']]} ({c['reason']})" for c in bad)
    if status == "layout_changed":
        return (
            f"⚠️ Weekly Amazon check: couldn't find the add button on the {where} product page — "
            "Amazon's layout probably changed; Saturday's cart may need adding by hand."
        )
    return f"⚠️ Weekly Amazon check couldn't finish: {where}. It runs again next week."
