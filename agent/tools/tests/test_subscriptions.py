"""Subscribe & Save page → subscription list → `POST /api/subscriptions/sync` (DESIGN §4.9).

Regression (2026-11): the Amazon cart filled with one-time buys of items the household already gets
on Subscribe & Save — nothing told the State Engine which items those were.
"""

from __future__ import annotations

import re
from datetime import date

import pytest
from conftest import FakeApi, FakeDriver, fixture

from pandabase_tools import subscriptions
from pandabase_tools.browser import Challenged
from pandabase_tools.config import Member, ReceiptsConfig
from pandabase_tools.subscriptions import outcome_of, parse_subscriptions
from pandabase_tools.telemetry import Telemetry

TODAY = date(2026, 11, 22)
URL = "https://www.amazon.com/auto-deliveries"
PAGE = fixture("subscriptions.html")
MEMBER = Member(name="will", discord_id="100000000000000001", profile="pandabase")
SYNCED = {
    "account_member_id": "m1",
    "synced_at": "2026-11-22T18:00:00.000Z",
    "active": 4,
    "added": 4,
    "ended": 0,
    "reopened": 0,
}


def test_reads_only_the_subscription_tiles() -> None:
    page = parse_subscriptions(PAGE, TODAY)
    # Not the delivery cards, the "Subscribe now" recommendations (one of them already
    # subscribed), the recently-viewed header link, the footer or the script.
    assert [s.asin for s in page.subscriptions] == [
        "B0SYNTHS01",
        "B0SYNTHS02",
        "B0SYNTHS03",
        "B0SYNTHS04",
    ]
    assert (page.tiles, page.expected) == (4, 4)
    first, _, third, fourth = page.subscriptions
    assert first.title == "Synthetic Bottle Washer Tablets, 120 Count"
    assert first.next_delivery_on == date(2026, 11, 29)
    assert first.schedule == "3 units every 3 weeks"
    assert third.title == "Synthetic Calcium & Magnesium Tablets, 300 Count"
    # "Jan 17" read in November is next year's.
    assert fourth.next_delivery_on == date(2027, 1, 17)
    assert outcome_of(page) == "synced"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Next delivery: Nov 29", date(2026, 11, 29)),
        ("Next delivery: Nov 20", date(2026, 11, 20)),  # a little late: still this year
        ("Next delivery: Oct 1", date(2027, 10, 1)),
        ("Next delivery: Sun, Dec 6", date(2026, 12, 6)),
        ("Next delivery: September 3, 2027", date(2027, 9, 3)),
        ("Next delivery: Feb 30", None),
        ("Arriving Sun, Nov 29", None),
    ],
)
def test_next_delivery_dates(text: str, expected: date | None) -> None:
    assert subscriptions._next_delivery(text, TODAY) == expected


def _drop_last_tile(html: str) -> str:
    start = html.rindex('<div class="_myd-hub-subscriptions-card-desktop_style_clickableTile')
    end = html.index('<div id="edit-subscription-modal-skeleton"')
    return html[:start] + "</div>\n" + html[end:]


@pytest.mark.parametrize(
    ("html", "outcome"),
    [
        # Half-rendered grid: fewer tiles than the pills count. Syncing it would end a
        # subscription that still delivers.
        (_drop_last_tile(PAGE), "incomplete"),
        (re.sub(r'data-category-id="[^"]+"', "", PAGE), "no_count"),
        (
            PAGE.replace("/auto-deliveries/ajax/subscription/", "/auto-deliveries/ajax/edit/"),
            "no_tiles",
        ),
        ("<html><body>Your Subscriptions</body></html>", "no_tiles"),
    ],
)
def test_only_a_whole_list_is_synced(html: str, outcome: str) -> None:
    assert outcome_of(parse_subscriptions(html, TODAY)) == outcome


def _sync(html: str, api: FakeApi) -> tuple[subscriptions.SyncResult, Telemetry, FakeDriver]:
    driver = FakeDriver({URL: (URL, html)})
    tel = Telemetry()
    result = subscriptions.sync(
        api.client(), driver, ReceiptsConfig(), MEMBER, tel, today=TODAY, sleep=lambda _: None
    )
    return result, tel, driver


def test_sync_posts_the_whole_list() -> None:
    api = FakeApi({"POST /api/subscriptions/sync": lambda _: SYNCED})
    result, tel, driver = _sync(PAGE, api)
    assert result.outcome == "synced"
    assert result.synced and result.synced["active"] == 4
    [body] = api.bodies("POST /api/subscriptions/sync")
    assert body["account"] == MEMBER.discord_id and body["vendor"] == "amazon"
    assert body["subscriptions"][0] == {
        "asin": "B0SYNTHS01",
        "title": "Synthetic Bottle Washer Tablets, 120 Count",
        "next_delivery_on": "2026-11-29",
        "schedule": "3 units every 3 weeks",
    }
    assert driver.opened == [URL] and driver.clicks == 0
    assert tel.metrics("subscription_page") == [
        {"member": "will", "outcome": "synced", "tiles": 4, "found": 4, "expected": 4}
    ]


def test_an_incomplete_page_posts_nothing() -> None:
    api = FakeApi({})
    result, tel, _ = _sync(_drop_last_tile(PAGE), api)
    assert (result.outcome, result.found, result.expected) == ("incomplete", 3, 4)
    assert api.requests == []
    assert tel.metrics("subscription_page")[0]["outcome"] == "incomplete"


def test_an_api_failure_is_reported_not_raised() -> None:
    import httpx

    api = FakeApi({"POST /api/subscriptions/sync": lambda _: httpx.Response(400, json={})})
    result, tel, _ = _sync(PAGE, api)
    assert result.outcome == "error" and result.errors[0]["error"] == "sync_failed"
    assert tel.metrics("subscription_page")[0]["outcome"] == "error"


def test_a_bot_check_stops_the_sync() -> None:
    checkpoint = "https://www.amazon.com/checkpoint?x=1"
    driver = FakeDriver({URL: (checkpoint, "<html></html>")})
    with pytest.raises(Challenged):
        subscriptions.sync(
            FakeApi({}).client(),
            driver,
            ReceiptsConfig(),
            MEMBER,
            Telemetry(),
            today=TODAY,
            sleep=lambda _: None,
        )
