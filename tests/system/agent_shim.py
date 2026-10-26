"""`pandabase-tools` with a synthetic Amazon behind the browser driver (system test, tier A).

Runs the real CLI (`pandabase_tools.cli.run`: argument parsing, API client, cart injector,
guard, lock, telemetry flush) with one substitution: `Env.driver_factory` returns `FakeAmazon`
instead of attaching to Chromium over CDP. Every URL the injector opens, or lands on, still goes
through `guard.check_url` / `browser.checked`, and the fake records them so the test can assert
that nothing went near checkout. Usage: `python agent_shim.py <pandabase-tools args>`.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence
from html import escape
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from pandabase_tools import cli, guard
from pandabase_tools.browser import Snapshot, checked

ADD_PATH = "/gp/aws/cart/add.html"
VIEW = "https://www.amazon.com/gp/cart/view.html"
# Where the fake writes the URLs it served (`FAKE_AMAZON_LOG`, JSON lines).
LOG_ENV = "FAKE_AMAZON_LOG"


def price_cents(asin: str) -> int:
    """A stable synthetic price per ASIN."""
    return 199 + sum(map(ord, asin)) % 700


class FakeAmazon:
    """Synthetic product, add-to-cart confirm and "added" pages, generated from the URL."""

    def __init__(self, log: Path | None) -> None:
        self.log = log
        self.pending: list[tuple[str, str]] = []
        self.current: str | None = None

    def _record(self, kind: str, url: str) -> None:
        if self.log:
            with self.log.open("a") as f:
                f.write(json.dumps({"kind": kind, "url": url}) + "\n")

    def _land(self, url: str, html: str) -> Snapshot:
        self._record("landed", url)
        self.current = url
        return checked(Snapshot(url, html))

    def open(self, url: str) -> Snapshot:
        guard.check_url(url)  # what CdpDriver does before page.goto
        self._record("opened", url)
        parts = urlsplit(url)
        if parts.path == ADD_PATH:
            q = dict(parse_qsl(parts.query))
            self.pending = [
                (q[k], q.get(f"Quantity.{k.split('.')[1]}", "1"))
                for k in sorted(q)
                if k.startswith("ASIN.")
            ]
            inputs = "".join(
                f'<input type="hidden" name="ASIN.{n}" value="{escape(a)}">'
                f'<input type="hidden" name="Quantity.{n}" value="{escape(qty)}">'
                for n, (a, qty) in enumerate(self.pending, 1)
            )
            rows = "".join(
                f'<div><a href="/dp/{escape(a)}">Synthetic product {escape(a)}</a> Qty: {qty}</div>'
                for a, qty in self.pending
            )
            html = (
                "<html><body><h1>Please confirm that you would like to add the following to "
                f'your cart</h1><form method="post" action="{ADD_PATH}">{inputs}{rows}'
                '<input type="submit" name="add" value="Continue"></form></body></html>'
            )
            return self._land(url, html)
        if "/dp/" in parts.path:
            asin = parts.path.rsplit("/dp/", 1)[1].split("/")[0]
            price = price_cents(asin)
            ld = json.dumps(
                {
                    "@context": "https://schema.org",
                    "@type": "Product",
                    "name": f"Synthetic product {asin}",
                    "offers": {
                        "@type": "Offer",
                        "price": f"{price / 100:.2f}",
                        "priceCurrency": "USD",
                    },
                }
            )
            html = (
                f'<html><head><script type="application/ld+json">{ld}</script></head>'
                f"<body><h1>Synthetic product {escape(asin)}</h1></body></html>"
            )
            return self._land(url, html)
        if parts.path == "/gp/cart/view.html":
            return self._land(url, "<html><body><h1>Shopping Cart</h1></body></html>")
        raise AssertionError(f"fake Amazon has no page for {url}")

    def click_confirm(self) -> Snapshot | None:
        if not self.current or urlsplit(self.current).path != ADD_PATH:
            return None
        self._record("clicked", self.current)
        n = len(self.pending)
        return self._land(
            VIEW,
            f"<html><body><h1>Added to Cart</h1><div>Cart subtotal ({n} items)</div>"
            '<a href="/gp/buy/spc/handlers/display.html">Proceed to checkout</a></body></html>',
        )

    def __enter__(self) -> FakeAmazon:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def main(argv: Sequence[str]) -> int:
    import os

    args = cli.build_parser().parse_args(argv)
    env = cli.Env(args)
    log = os.environ.get(LOG_ENV)
    env.driver_factory = lambda _cdp_url: FakeAmazon(Path(log) if log else None)
    code, out = cli.run(argv, env)
    print(out if isinstance(out, str) else json.dumps(out, indent=1, default=str))
    return code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
