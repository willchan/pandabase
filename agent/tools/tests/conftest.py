"""Shared test doubles: a fixture-backed browser driver and a recording fake API."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from pandabase_tools import guard
from pandabase_tools.api import ApiClient
from pandabase_tools.browser import Snapshot, checked

FIXTURES = Path(__file__).parent / "fixtures" / "amazon"
REPO = Path(__file__).resolve().parents[3]


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text()


Page = tuple[str, str]  # (final URL, fixture file)


class FakeDriver:
    """Serves fixtures by URL. Every URL it's asked to open, or lands on, must pass the guard."""

    def __init__(
        self,
        pages: dict[str, Page] | Callable[[str], Page | None],
        confirm: Callable[[str], Page | None] | None = None,
    ) -> None:
        self.pages = pages
        self.confirm = confirm
        self.opened: list[str] = []
        self.landed: list[str] = []
        self.clicks = 0
        self.current: str | None = None

    def _land(self, page: Page) -> Snapshot:
        url, name = page
        self.landed.append(url)
        self.current = url
        return checked(Snapshot(url, fixture(name)))

    def open(self, url: str) -> Snapshot:
        guard.check_url(url)  # what CdpDriver does before page.goto
        self.opened.append(url)
        page = self.pages(url) if callable(self.pages) else self.pages.get(url)
        if page is None:
            raise AssertionError(f"unexpected navigation: {url}")
        return self._land(page)

    def click_confirm(self) -> Snapshot | None:
        self.clicks += 1
        page = self.confirm(self.current or "") if self.confirm else None
        return None if page is None else self._land(page)

    def __enter__(self) -> FakeDriver:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def assert_never_checkout(self) -> None:
        for url in self.opened + self.landed:
            assert guard.classify_url(url) != "checkout", url


class FakeApi:
    """httpx MockTransport that records requests and answers from a handler table."""

    def __init__(self, handlers: dict[str, Callable[[Any], Any]]) -> None:
        self.handlers = handlers
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = f"{request.method} {request.url.path}"
        body = json.loads(request.content) if request.content else None
        handler = self.handlers.get(key)
        if handler is None:
            return httpx.Response(404, json={"error": f"no handler for {key}"})
        out = handler(body)
        if isinstance(out, httpx.Response):
            return out
        return httpx.Response(200, json=out)

    def client(self) -> ApiClient:
        return ApiClient(
            "https://pandabase.test",
            "token",
            transport=httpx.MockTransport(self),
            sleep=lambda _: None,
        )

    def bodies(self, key: str) -> list[Any]:
        return [
            json.loads(r.content) if r.content else None
            for r in self.requests
            if f"{r.method} {r.url.path}" == key
        ]


@pytest.fixture
def no_sleep() -> Callable[[float], None]:
    return lambda _: None
