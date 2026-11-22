"""Subscribe & Save (DESIGN §4.9): read a member's subscriptions and sync them to the State Engine.

Items Amazon already delivers on a schedule show up in the order history like any purchase, so
without this the cart plan buys them again. The receipt sweep reads the member's Subscribe & Save
page (`/auto-deliveries`, read-only: nothing is clicked) after the orders, and posts the whole list
to `POST /api/subscriptions/sync`, which replaces the stored one.

What counts as a subscription: an element whose `data-edit-url` is the page's subscription editor
(`/auto-deliveries/ajax/subscription/`) and carries `subAsin=` — never the upcoming-delivery cards,
the "Subscribe now" recommendations (`data-asin`, `/dp/` links) or the header and footer. The
category pills above the grid count the subscriptions ("Grocery (1)"); a list is only synced when
the tiles found add up to those counts, because a short list would end subscriptions that still
deliver. Anything else is reported and left for the next sweep; the State Engine stops trusting a
list nobody has confirmed for `subscriptions.staleAfterDays`.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from typing import Any, Literal, Protocol

from . import contracts as c
from . import dom, guard
from .api import ApiClient, ApiError
from .browser import Snapshot
from .config import Member, ReceiptsConfig
from .receipt_parser import MONTHS
from .telemetry import Telemetry

EDIT_URL = "/auto-deliveries/ajax/subscription/"
ASIN = re.compile(r"^[A-Z0-9]{10}$")
PILL_COUNT = re.compile(r"\((\d{1,4})\)\s*$")
NEXT_DELIVERY = re.compile(
    r"^next delivery:?\s*(?:[a-z]{3,9},?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?$", re.I
)
SCHEDULE = re.compile(r"^\d+\s+units?\s+every\s+\d+\s+(?:days?|weeks?|months?)$", re.I)
# A next delivery can be a little late ("Nov 20" read on Nov 22); further back it means next year.
PAST_GRACE_DAYS = 31

Outcome = Literal["synced", "incomplete", "no_count", "no_tiles", "error"]


@dataclass(frozen=True)
class Subscription:
    asin: str
    title: str | None
    next_delivery_on: date | None
    schedule: str | None


@dataclass
class SubscriptionsPage:
    subscriptions: list[Subscription]
    #: What the category pills add up to; None when the page shows no pills.
    expected: int | None
    #: Edit links that carried an ASIN (duplicates included), for the count check.
    tiles: int


def _next_delivery(text: str, today: date) -> date | None:
    m = NEXT_DELIVERY.match(text)
    if not m:
        return None
    month = MONTHS.get(m.group(1).lower()) or MONTHS.get(m.group(1).lower()[:3])
    if not month:
        return None
    year = int(m.group(3)) if m.group(3) else today.year
    try:
        day = date(year, month, int(m.group(2)))
    except ValueError:
        return None
    if not m.group(3) and day < today - timedelta(days=PAST_GRACE_DAYS):
        day = date(year + 1, month, day.day)
    return day


def _title(tile: dom.Node) -> str | None:
    for img in tile.find_all("img"):
        alt = " ".join((img.attrs.get("alt") or "").split())
        if alt:
            return alt[:500]
    return None


def parse_subscriptions(html: str, today: date) -> SubscriptionsPage:
    root = dom.parse(html)
    subs: dict[str, Subscription] = {}
    tiles = 0
    for node in root.iter():
        href = node.attrs.get("data-edit-url") or ""
        if EDIT_URL not in href:
            continue
        asin = dom.query_param(href, "subAsin")
        if not asin or not ASIN.match(asin):
            continue
        tiles += 1
        lines = node.text().split("\n")
        nxt = next((d for d in (_next_delivery(t, today) for t in lines) if d), None)
        schedule = next((t for t in lines if SCHEDULE.match(t)), None)
        subs.setdefault(asin, Subscription(asin, _title(node), nxt, schedule))
    counts = [
        int(m.group(1))
        for n in root.iter()
        if "data-category-id" in n.attrs and (m := PILL_COUNT.search(n.text()))
    ]
    return SubscriptionsPage(list(subs.values()), sum(counts) if counts else None, tiles)


def outcome_of(page: SubscriptionsPage) -> Outcome:
    if page.tiles == 0:
        return "no_tiles"  # layout changed, nothing rendered, or no subscriptions: can't tell
    if page.expected is None:
        return "no_count"
    return "synced" if page.tiles == page.expected else "incomplete"


class SubscriptionsDriver(Protocol):
    def open(self, url: str) -> Snapshot: ...

    def subscriptions_ready(self) -> Snapshot: ...


@dataclass
class SyncResult:
    member: str
    outcome: Outcome
    found: int = 0
    expected: int | None = None
    synced: dict[str, Any] | None = None
    errors: list[dict[str, str]] = field(default_factory=list)


def sync(
    api: ApiClient,
    driver: SubscriptionsDriver,
    cfg: ReceiptsConfig,
    member: Member,
    tel: Telemetry,
    *,
    today: date,
    sleep: Callable[[float], None],
) -> SyncResult:
    """Read `member`'s Subscribe & Save page and, if the list is whole, sync it. A sign-in page or
    bot check raises (the caller stops, as for orders); everything else is a result."""
    sleep(cfg.throttle_seconds)  # after the sweep's own page loads
    driver.open(guard.check_url(cfg.subscriptions_url))
    page = parse_subscriptions(driver.subscriptions_ready().html, today)
    result = SyncResult(
        member.name, outcome_of(page), found=len(page.subscriptions), expected=page.expected
    )
    if result.outcome == "synced":
        body = c.SubscriptionSyncRequest(
            account=member.discord_id,
            vendor="amazon",
            subscriptions=[
                c.SubscriptionIn(
                    asin=s.asin,
                    title=s.title,
                    next_delivery_on=s.next_delivery_on,
                    schedule=s.schedule,
                )
                for s in page.subscriptions
            ],
        )
        try:
            res = api.sync_subscriptions(body)
            result.synced = res.model_dump(mode="json", exclude={"account_member_id"})
        except ApiError as err:
            result.outcome = "error"
            result.errors.append({"error": "sync_failed", "detail": str(err)[:300]})
    tel.emit(
        "subscription_page",
        member=member.name,
        outcome=result.outcome,
        tiles=page.tiles,
        found=len(page.subscriptions),
        expected=page.expected,
    )
    return result


def as_dict(result: SyncResult) -> dict[str, Any]:
    return asdict(result)
