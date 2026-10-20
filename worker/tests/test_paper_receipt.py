"""Money → cents and the totals check (DESIGN §5: |Σ line_total - subtotal| ≤ 2¢)."""

from datetime import date

import pytest
from conftest import Rig, receipt_image

from pandabase_worker.jobs.paper_receipt import (
    VlmLine,
    VlmReceipt,
    cents,
    parse_date,
    to_result,
    totals_check,
)

TODAY = date(2026, 10, 20)


def receipt(lines: list[float | None], subtotal: float | None, **kw: object) -> VlmReceipt:
    return VlmReceipt.model_validate(
        {
            "store": "SYNTHETIC FOODS MARKET",
            "date": "2026-10-18",
            "lines": [{"raw_text": f"ITEM {n}", "line_total": t} for n, t in enumerate(lines)],
            "subtotal": subtotal,
            **kw,
        }
    )


@pytest.mark.parametrize(
    ("amount", "expected"),
    [(4.29, 429), (0.1 + 0.2, 30), (12.345, 1235), (19.99, 1999), (-1.0, -100), (None, None)],
)
def test_cents(amount: float | None, expected: int | None) -> None:
    assert cents(amount) == expected


@pytest.mark.parametrize(
    ("lines", "subtotal", "expected"),
    [
        ([1.00, 2.50], 3.50, "pass"),
        ([1.00, 2.50], 3.52, "pass"),  # 2¢ off: within tolerance
        ([1.00, 2.50], 3.48, "pass"),
        ([1.00, 2.50], 3.53, "fail"),  # 3¢ off
        ([1.00, 2.50], 4.50, "fail"),
        ([1.00, None], 3.50, "n/a"),  # a line total unreadable
        ([1.00, 2.50], None, "n/a"),  # no subtotal printed
        ([], 0.0, "n/a"),
        ([5.00, -1.00], 4.00, "pass"),  # discounts count toward the check
    ],
)
def test_totals_check(lines: list[float | None], subtotal: float | None, expected: str) -> None:
    result, telemetry = to_result(receipt(lines, subtotal), TODAY)
    assert result.totals_check == expected
    assert telemetry["totals_check"] == expected


def test_totals_check_on_cents() -> None:
    assert totals_check([100, 250], 352) == "pass"
    assert totals_check([100, 250], 347) == "fail"


def test_discount_lines_are_not_posted_as_purchases() -> None:
    result, telemetry = to_result(receipt([5.00, -1.00], 4.00), TODAY)
    assert [ln.raw_text for ln in result.lines] == ["ITEM 0"]
    assert telemetry["discount_lines"] == 1


def test_fallbacks_for_unreadable_fields() -> None:
    raw = VlmReceipt(
        store="  ",
        date="sometime",
        lines=[
            VlmLine(raw_text="  "),
            VlmLine(raw_text="MILK", qty=0, unit_price=-2, line_total=3.99),
        ],
        subtotal=-5,
        tax=None,
        total=3.99,
    )
    result, telemetry = to_result(raw, TODAY)
    assert result.store == "UNKNOWN"
    assert result.date == TODAY
    assert telemetry["date_fallback"] is True
    assert telemetry["store_missing"] is True
    (line,) = result.lines
    assert (line.qty, line.unit_price_cents, line.line_total_cents) == (None, None, 399)
    assert result.subtotal_cents is None  # negative subtotal is not a valid read
    assert result.total_cents == 399


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("2026-10-18", date(2026, 10, 18)),
        ("10/18/2026", date(2026, 10, 18)),
        ("10/18/26", date(2026, 10, 18)),
        (" 2026-10-18 ", date(2026, 10, 18)),
        ("Oct 18", None),
        (None, None),
    ],
)
def test_parse_date(text: str | None, expected: date | None) -> None:
    assert parse_date(text) == expected


def test_totals_fail_is_posted_and_reported(rig: Rig) -> None:
    job = rig.engine.add("paper_receipt", receipt_image())
    rig.ollama.queue("paper_receipt.totals_fail")
    assert rig.worker.run_once()
    assert job.status == "completed"  # the app applies it; a failed check is a signal, not an error
    assert job.result is not None and job.result["totals_check"] == "fail"
    assert rig.engine.metrics("vlm_inference")[0]["totals_check"] == "fail"
