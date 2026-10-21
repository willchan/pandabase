"""Smoke: tier-1 add-to-cart for one Amazon ASIN and one Whole Foods ASIN (PLAN M7 Notes).

Runs with the agent tools' venv (`scripts/smoke/run.sh` calls it). Attaches over CDP to the cart
member's Chromium, holds that profile's lock, and for each ASIN:

1. refuses an ASIN that is already in a cart (deleting it afterwards would remove yours too);
2. runs the real `cart_injector.inject` on a one-line cart (quantity 1);
3. finds the line on the cart page and clicks its Delete control, then re-checks it's gone.

Never touches checkout: every page goes through `guard` like the tools themselves. Prints one JSON
object; exit 0 when every added test item was removed again, 1 otherwise. The Whole Foods result
tells you whether `cart.wholefoods_tier1` can be turned on (DESIGN §10 #37).

Usage: python cart_check.py amazon=B0XXXXXXXX wholefoods=B0YYYYYYYY
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

from pandabase_tools import cart_injector, config, guard
from pandabase_tools.browser import CdpDriver, NotSignedIn
from pandabase_tools.lock import ProfileLock, ProfileLocked
from pandabase_tools.telemetry import Telemetry

CART_URLS = {
    "amazon": os.environ.get("SMOKE_CART_URL", "https://www.amazon.com/gp/cart/view.html"),
    "wholefoods": os.environ.get("SMOKE_WF_CART_URL", "https://www.amazon.com/cart/localmarket"),
}
ASIN = re.compile(r"^[A-Z0-9]{10}$")
# Delete controls on a cart line, most specific first (no class names).
DELETE_SELECTORS = (
    "input[name^='submit.delete']",
    "[data-action='delete'] input",
    "[data-action='delete-active'] input",
    "input[value='Delete']",
)


def in_cart(driver: CdpDriver, vendor: str, asin: str) -> bool:
    driver.open(CART_URLS[vendor])
    return driver.page.locator(f"[data-asin='{asin}']").count() > 0


def remove(driver: CdpDriver, vendor: str, asin: str) -> bool:
    driver.open(CART_URLS[vendor])
    row = driver.page.locator(f"[data-asin='{asin}']")
    if row.count() == 0:
        return True
    for selector in DELETE_SELECTORS:
        control = row.first.locator(selector)
        if control.count():
            control.first.click()
            driver.page.wait_for_load_state("domcontentloaded")
            driver.page.wait_for_timeout(1500)
            break
    return not in_cart(driver, vendor, asin)


def check(driver: CdpDriver, cfg: config.CartConfig, vendor: str, asin: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "vendor": vendor,
        "asin": asin,
        "url": cart_injector.add_url([(asin, 1)]),
    }
    if in_cart(driver, vendor, asin):
        return out | {"ok": False, "error": "already in the cart: pick an ASIN that isn't"}
    line = cart_injector.LineOutcome(
        index=0,
        name=f"smoke {vendor}",
        quantity=1,
        item_id=None,
        product_id=None,
        asin=asin,
        vendor=vendor,
        free_text=None,
        outcome="added",
    )
    result = cart_injector.inject(driver, [line], cfg, Telemetry())
    got = result.lines()[0]
    out |= {"outcome": got.outcome, "reason": got.reason}
    # Remove whatever landed in the cart, even when the add wasn't verified.
    removed = remove(driver, vendor, asin)
    out["removed"] = removed
    if not removed:
        out["error"] = f"remove {asin} from the {vendor} cart by hand ({CART_URLS[vendor]})"
    out["ok"] = removed and got.outcome != "failed"
    return out


def failed(error: str, code: int = 1) -> int:
    print(json.dumps({"ok": False, "error": error}))
    return code


def main(argv: list[str]) -> int:
    targets: list[tuple[str, str]] = []
    for arg in argv:
        vendor, _, asin = arg.partition("=")
        if vendor not in CART_URLS or not ASIN.match(asin):
            return failed(f"bad argument {arg!r} (want amazon=ASIN wholefoods=ASIN)", 2)
        targets.append((vendor, asin))
    loaded = config.load()
    member = loaded.config.cart_member()
    profile = loaded.profile(member)
    results: list[dict[str, Any]] = []
    try:
        with (
            ProfileLock(loaded.state_dir()).held(member.profile, "smoke cart"),
            CdpDriver(profile.cdp_url) as driver,
        ):
            for vendor, asin in targets:
                results.append(check(driver, loaded.config.cart, vendor, asin))
    except ProfileLocked as err:
        return failed(f"profile {err.profile} busy ({err.owner})")
    except NotSignedIn:
        return failed(f"{member.name}'s Chromium is signed out of Amazon")
    except guard.UnsafeUrl as err:
        return failed(f"refused {err.url} ({err.reason})")
    except Exception as err:  # attach/navigation errors: one line, like the other checks
        return failed(f"{type(err).__name__}: {str(err).splitlines()[0]}")
    ok = all(r["ok"] for r in results)
    wf = next((r for r in results if r["vendor"] == "wholefoods"), None)
    hint = None
    if wf is not None:
        hint = (
            "Whole Foods tier 1 works: set cart.wholefoods_tier1 to true in pandabase.config.json"
            if wf.get("outcome") == "added"
            else "Whole Foods tier 1 unverified: keep cart.wholefoods_tier1 false"
        )
    print(json.dumps({"ok": ok, "member": member.name, "results": results, "wholefoods": hint}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
