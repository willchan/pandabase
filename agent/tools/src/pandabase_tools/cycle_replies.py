"""Discord text for the scheduled grocery-cycle steps that run without a model (DESIGN §6).

The Friday nudge and the Saturday cart build are OpenClaw *command* automations: `pandabase-tools
cycle nudge --reply` and `cart build --reply` do the work and print the message, and OpenClaw
announces it to the `#pandabase` channel. The local model only gets the steps that need judgment
(tier-2 search for lines the build couldn't add). Live, 2026-11-06/07: given "Use $grocery-cycle:
run the Saturday cart build", the model never opened the skill, invented a cart from old memory
notes and posted it, and its Friday check-in skipped the API — both runs reported "ok".

Output is `NO_REPLY` when there is nothing to say (OpenClaw's silent reply). Item names come from
the household's own data; nothing here is page text.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from . import contracts as c

NO_REPLY = "NO_REPLY"
CART_LINKS = {
    "amazon": "https://www.amazon.com/gp/cart/view.html",
    "wholefoods": "https://www.amazon.com/cart/localmarket?almBrandId=VUZHIFdob2xlIEZvb2Rz",
}
STORE_NAMES = {"amazon": "Amazon", "wholefoods": "Whole Foods"}
MAX_NAMES = 8  # per line; the rest become "+N more"
WRONG_STORE = {"in_amazon_cart": "amazon", "in_wholefoods_cart": "wholefoods"}
FAIL_TEXT = {
    "not_signed_in": "signed out of Amazon",
    "extra_items": "other items came with it, check the cart",
    "no_add_form": "no add button",
    "unverified": "didn't show up in the cart",
}


def thread_ref(cycle: c.Cycle | None) -> str:
    """` in <#thread>` (Discord renders a channel mention as a link), or nothing."""
    return f" in <#{cycle.discord_thread_id}>" if cycle and cycle.discord_thread_id else ""


def _names(names: Sequence[str]) -> str:
    shown = ", ".join(names[:MAX_NAMES])
    more = len(names) - MAX_NAMES
    return f"{shown} +{more} more" if more > 0 else shown


def _qty(line: Mapping[str, Any]) -> str:
    q = float(line.get("quantity") or 1)
    n = int(q) if q.is_integer() else q
    return f" ×{n}" if q != 1 else ""  # noqa: RUF001 (multiplication sign, as in the skill)


def nudge(cycle: c.Cycle, checkin: c.CheckinResponse, web_url: str | None) -> str:
    """The Friday check-in (grocery-cycle skill §3)."""
    lines = ["🛒 **Friday check-in** — I'll fill the cart tomorrow at 10am."]
    if checkin.likely_needed:
        lines.append(
            "**Likely needed:** "
            + _names(
                [f"{x.name} (out)" if x.status == "out" else x.name for x in checkin.likely_needed]
            )
        )
    if checkin.please_check:
        lines.append(
            "**Please check:** "
            + " · ".join(
                f"❓ {x.name}" + (f" — {x.audit_hint}" if x.audit_hint else "")
                for x in checkin.please_check[:MAX_NAMES]
            )
        )
    if checkin.freezer:
        lines.append(
            "**Freezer:** "
            + _names(
                [
                    f"{x.name} ({x.frozen_at:%b} {x.frozen_at.day})" if x.frozen_at else x.name
                    for x in checkin.freezer
                ]
            )
        )
    if checkin.pending_review_count > 0 and web_url:
        n = checkin.pending_review_count
        lines.append(
            f"{n} review item{'s' if n != 1 else ''} waiting → {web_url.rstrip('/')}/cleanup"
        )
    lines.append(
        f'Reply{thread_ref(cycle)} with changes or counts ("6 eggs"), or a photo. '
        "No reply needed — I'll go with the plan."
    )
    return "\n".join(lines)


def build(res: Mapping[str, Any], cycle: c.Cycle | None) -> str:
    """The Saturday 10:00 message for `cart build`'s result."""
    status = res.get("status")
    if status == "already_built":
        return NO_REPLY
    if status in ("no_cycle", "not_current"):
        return "⚠️ No grocery list was open this week, so no cart was built."
    if status == "skipped":
        return "⏸️ Away on build day — no cart this week."
    if status not in ("ready", "needs_agent"):
        return f"⚠️ The cart wasn't built: the week's list is `{status}`."
    added = list(res.get("added", []))
    pending = list(res.get("needs_agent", []))
    failed = list(res.get("failed", []))
    wrong = [x for x in added if x.get("reason") in WRONG_STORE]
    stores = {str(x.get("vendor") or "amazon") for x in added if x not in wrong}
    stores |= {WRONG_STORE[str(x["reason"])] for x in wrong}
    out = [f"🛒 **Cart built**{thread_ref(cycle)} — nothing is checked out."]
    if added:
        out.append(f"✅ **Added ({len(added)}):** " + _names([x["name"] + _qty(x) for x in added]))
    for store in sorted({WRONG_STORE[str(x["reason"])] for x in wrong}):
        names = [x["name"] for x in wrong if WRONG_STORE[str(x["reason"])] == store]
        out.append(
            f"↪️ In the {STORE_NAMES[store]} cart, not the store on the list: {_names(names)}"
        )
    if pending:
        out.append(
            f"🔎 **Still to find ({len(pending)}):** "
            + _names([x["name"] for x in pending])
            + " — I'll search for these at 10:30."
        )
    if failed:
        out.append(
            f"⚠️ **Couldn't add ({len(failed)}):** "
            + _names(
                [f"{x['name']} — {FAIL_TEXT.get(str(x.get('reason')), 'error')}" for x in failed]
            )
        )
    if res.get("layout_alert"):
        out.append("⚠️ Most product pages didn't work — Amazon's layout may have changed.")
    if stores:
        out.append(
            "Review & check out: "
            + " · ".join(f"[{STORE_NAMES[s]}](<{CART_LINKS[s]}>)" for s in sorted(stores))
        )
    return "\n".join(out)
