"""The synthetic Costco pages (tests/fixtures/costco) stay consistent with what the live pages
showed: receipt lines add up to the subtotal, the barcode encodes the receipt's footer, and the
online order's lines add up to its subtotal. M10.3's parser tests build on these files."""

from __future__ import annotations

import re
from html.parser import HTMLParser
from pathlib import Path

COSTCO = Path(__file__).parent / "fixtures" / "costco"


class _Rows(HTMLParser):
    """Text of each `<td>` per `<tr>` inside the receipt table."""

    def __init__(self) -> None:
        super().__init__()
        self.in_table = False
        self.rows: list[list[str]] = []
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "table" and ("aria-label", "spanning table") in attrs:
            self.in_table = True
        elif self.in_table and tag == "tr":
            self.rows.append([])
        elif self.in_table and tag == "td":
            self._cell = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "table":
            self.in_table = False
        elif tag == "td" and self._cell is not None:
            self.rows[-1].append(" ".join("".join(self._cell).split()))
            self._cell = None

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)


def _cents(text: str) -> int:
    return round(float(text.replace("$", "").replace(",", "")) * 100)


def _receipt_rows() -> list[list[str]]:
    p = _Rows()
    p.feed((COSTCO / "orders_warehouse_receipt.html").read_text())
    return p.rows


def test_receipt_lines_add_up() -> None:
    rows = _receipt_rows()
    items = [r for r in rows if len(r) == 4 and re.fullmatch(r"\d+", r[1])]
    assert len(items) == 5
    lines = sum(_cents(r[3].split()[0]) for r in items)
    subtotal = next(_cents(r[2]) for r in rows if len(r) == 3 and r[1] == "SUBTOTAL")
    tax = next(_cents(r[2]) for r in rows if len(r) == 3 and r[1] == "TAX")
    total = next(_cents(r[3]) for r in rows if len(r) == 4 and r[2] == "Total")
    assert (lines, subtotal + tax) == (subtotal, total)


def test_multibuy_row_precedes_its_line_and_counts_units() -> None:
    rows = _receipt_rows()
    i = next(i for i, r in enumerate(rows) if r and re.fullmatch(r"\d+ @ [\d.]+", r[0]))
    qty, unit = rows[i][0].split(" @ ")
    assert _cents(rows[i + 1][3].split()[0]) == int(qty) * _cents(unit)
    units = sum(1 for r in rows if len(r) == 4 and re.fullmatch(r"\d+", r[1])) + int(qty) - 1
    assert any(r == [f"TOTAL NUMBER OF ITEMS SOLD = {units}"] for r in rows)


def test_barcode_encodes_the_receipt_footer() -> None:
    html = (COSTCO / "orders_warehouse_receipt.html").read_text()
    barcode = re.search(r'viewRecieptBtn_(\d{23})"', html)
    assert barcode is not None
    m = re.fullmatch(r"21(\d{4})(\d{3})(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)", barcode.group(1))
    assert m is not None
    whse, trm, trn, yy, mm, dd, hh, mi = m.groups()
    assert f"Whse: {int(whse)}<" in html and f"Trm: {int(trm)}<" in html
    assert f"Trn: {int(trn)}<" in html
    assert f"P7 {mm}/{dd}/20{yy} {hh}:{mi}" in html


def test_every_warehouse_card_has_a_barcode_id_and_total() -> None:
    html = (COSTCO / "orders_warehouse.html").read_text()
    cards = re.findall(r'id="viewRecieptBtn_(\d+)"', html)
    assert len(cards) == 3 and all(len(c) == 23 for c in cards)
    assert html.count('automation-id="totalPrice"') == 3


def test_online_order_lines_add_up() -> None:
    html = (COSTCO / "order_details_delivered.html").read_text()
    items = re.findall(
        r'automation-id="itemNumber">Item (\d+)</div>\s*<div[^>]*>(\$[\d.]+)</div>\s*'
        r"<div[^>]*><span>Quantity (\d+)</span><div>Total</div><div>(\$[\d.]+)</div>",
        html,
    )
    assert len(items) == 2
    assert all(_cents(price) * int(q) == _cents(total) for _, price, q, total in items)
    subtotal = re.search(r"<h3>Subtotal</h3><div>(\$[\d.]+)</div>", html)
    assert subtotal is not None
    assert sum(_cents(t) for *_, t in items) == _cents(subtotal.group(1))


def test_online_list_links_each_order_to_its_details() -> None:
    html = (COSTCO / "orders_online.html").read_text()
    for n in re.findall(r'id="orderNumber_(\d+)"', html):
        assert f"/orderdetails/{n}" in html
        assert f'id="totalPrice_{n}"' in html


def test_an_item_number_is_on_both_a_receipt_and_an_online_order() -> None:
    receipt = (COSTCO / "orders_warehouse_receipt.html").read_text()
    online = (COSTCO / "order_details_delivered.html").read_text()
    shared = set(re.findall(r"<td>(\d{7})</td>", receipt)) & set(
        re.findall(r"Item (\d{7})<", online)
    )
    assert shared == {"9000201"}
