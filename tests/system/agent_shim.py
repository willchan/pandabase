"""`pandabase-tools` with a synthetic Amazon behind the browser driver (system test, tier A).

Runs the real CLI (`pandabase_tools.cli.run`: argument parsing, API client, cart injector,
guard, lock, telemetry flush) with one substitution: `Env.driver_factory` returns `FakeAmazon`
instead of attaching to Chromium over CDP. Every URL the injector opens, or lands on, still goes
through `guard.check_url` / `browser.checked`, and the fake records them so the test can assert
that nothing went near checkout. It also serves search results (`cart search`) and a cart page
whose contents persist across processes next to the log (`cart add` checks the count rose).
Usage: `python agent_shim.py <pandabase-tools args>`.
"""

from __future__ import annotations

import hashlib
import json
import sys
from collections.abc import Sequence
from html import escape
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from pandabase_tools import cli, guard
from pandabase_tools.browser import Snapshot, checked

# Synthetic Costco (M10.3): the committed fixtures, one receipt dated today and one online order.
COSTCO_FIXTURES = Path(__file__).resolve().parents[2] / "agent" / "tools" / "tests" / "fixtures"
COSTCO_FIXTURES = COSTCO_FIXTURES / "costco"
COSTCO_BARCODE = "21099920100422611071815"

ADD_PATH = "/gp/aws/cart/add.html"
VIEW = "https://www.amazon.com/gp/cart/view.html"
# Where the fake writes the URLs it served (`FAKE_AMAZON_LOG`, JSON lines).
LOG_ENV = "FAKE_AMAZON_LOG"


def price_cents(asin: str) -> int:
    """A stable synthetic price per ASIN."""
    return 199 + sum(map(ord, asin)) % 700


class FakeAmazon:
    """Synthetic product (with its add-to-cart form), add-URL confirm, cart and search pages."""

    def __init__(self, log: Path | None) -> None:
        self.log = log
        self.cart_file = log.with_suffix(".cart.json") if log else None
        self.pending: list[tuple[str, str]] = []
        self.current: str | None = None
        self.costco_tab_name = "online"

    def _cart(self) -> dict[str, int]:
        if self.cart_file and self.cart_file.exists():
            data: dict[str, int] = json.loads(self.cart_file.read_text())
            return data
        return {}

    def _cart_html(self) -> str:
        cart = self._cart()
        rows = "".join(
            f'<div data-asin="{escape(a)}" data-itemtype="active">'
            f'<a href="/dp/{escape(a)}">Synthetic product {escape(a)}</a> Qty: {q}</div>'
            for a, q in cart.items()
        )
        return (
            f'<html><body><span id="nav-cart-count">{sum(cart.values())}</span>'
            f'<h1>Shopping Cart</h1><form action="/cart/ref=ox_sc_upd">{rows}</form></body></html>'
        )

    @staticmethod
    def _search_html(query: str) -> str:
        rows = ""
        for n in range(3):
            asin = "B0SR" + hashlib.sha256(f"{query}:{n}".encode()).hexdigest()[:6].upper()
            rows += (
                f'<div data-asin="{asin}"><h2><a href="/dp/{asin}">Synthetic {escape(query)} '
                f"#{n + 1}, 16 oz</a></h2><span>${(price_cents(asin) / 100):.2f}</span></div>"
            )
        return f'<html><body><div id="search">{rows}</div></body></html>'

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
                f"<body><h1>Synthetic product {escape(asin)}</h1>"
                '<form action="/cart/add-to-cart/ref=dp_start" method="post">'
                f'<input type="hidden" name="items[0.base][asin]" value="{escape(asin)}">'
                '<select name="items[0.base][quantity]"><option value="1">1</option></select>'
                '<input type="submit" name="submit.buy-now" value="Buy Now">'
                '<input type="submit" name="submit.addToCart" value="Add to Cart"></form>'
                "</body></html>"
            )
            return self._land(url, html)
        if parts.path in ("/gp/cart/view.html", "/cart/localmarket"):  # one cart in the fake
            return self._land(url, self._cart_html())
        if parts.hostname == "www.costco.com":
            self.costco_tab_name = "online"
            self.current = url
            return Snapshot(url, "<html><body>loading</body></html>")
        if parts.path == "/s":
            return self._land(url, self._search_html(dict(parse_qsl(parts.query))["k"]))
        raise AssertionError(f"fake Amazon has no page for {url}")

    def click_confirm(self) -> Snapshot | None:
        if not self.current or urlsplit(self.current).path != ADD_PATH:
            return None
        self._record("clicked", self.current)
        cart = self._cart()
        for asin, qty in self.pending:
            cart[asin] = cart.get(asin, 0) + int(qty)
        if self.cart_file:
            self.cart_file.write_text(json.dumps(cart))
        n = len(self.pending)
        return self._land(
            VIEW,
            f"<html><body><h1>Added to Cart</h1><div>Cart subtotal ({n} items)</div>"
            '<a href="/gp/buy/spc/handlers/display.html">Proceed to checkout</a></body></html>',
        )

    def add_to_cart(self, asin: str, qty: int) -> Snapshot | None:
        """The product page's own add form (never its Buy Now): the cart gains `qty`."""
        if not self.current or f"/dp/{asin}" not in urlsplit(self.current).path:
            return None
        self._record("clicked", self.current)
        cart = self._cart()
        cart[asin] = cart.get(asin, 0) + qty
        if self.cart_file:
            self.cart_file.write_text(json.dumps(cart))
        return self._land(self.current, "<html><body><h1>Added to cart</h1></body></html>")

    # Costco Orders & Purchases (`costco_receipts.CostcoDriver`) ------------------------------

    def _costco(self, name: str) -> str:
        return (COSTCO_FIXTURES / name).read_text()

    def _costco_today(self, html: str) -> str:
        """The first warehouse card dated today (household TZ), so it is the trip's receipt;
        the other two cards dropped (their receipts would re-stock the same items)."""
        from datetime import datetime
        from zoneinfo import ZoneInfo

        today = datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%m/%d/%Y")
        html = html.replace("11/07/2026 - 6:15pm", f"{today} - 6:15am")
        for other in ("21099920200172610240905", "21099920100082610031430"):
            html = html.replace(f"viewRecieptBtn_{other}", "gone")
        return html

    def _costco_list(self) -> Snapshot:
        if self.costco_tab_name == "warehouse":
            html = self._costco_today(self._costco("orders_warehouse.html"))
        else:  # the online tab: only the grocery order (the glue gun stays out)
            html = self._costco("orders_online.html").replace("orderNumber_1000000002", "gone")
        return self._land(self.current or "", html)

    def costco_ready(self, page: str) -> Snapshot:
        assert self.current is not None
        if page == "details":
            return self._land(self.current, self._costco("order_details_delivered.html"))
        return self._costco_list()

    def costco_tab(self, tab: str) -> Snapshot:
        self._record("clicked", f"costco:tab:{tab}")
        self.costco_tab_name = tab
        return self._costco_list()

    def costco_period(self, label: str) -> Snapshot:
        raise AssertionError("a sweep only reads the current period")

    def costco_open_receipt(self, barcode: str) -> Snapshot:
        assert barcode == COSTCO_BARCODE, barcode
        self._record("clicked", "costco:receipt")
        html = self._costco_today(self._costco("orders_warehouse_receipt.html"))
        return self._land(self.current or "", html)

    def costco_close_receipt(self) -> Snapshot:
        self._record("clicked", "costco:close")
        return self._costco_list()

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
