"""Paper receipt (DESIGN §5): the VLM transcribes; the worker converts money to cents and runs
the totals check. No matching or interpretation happens here — that's the State Engine's job."""

from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Literal

from pydantic import BaseModel

from pandabase_worker.contracts import Line, PaperReceiptResult
from pandabase_worker.jobs import JobFailure, Outcome
from pandabase_worker.jobs.context import JobContext

# DESIGN §5: |Σ line_total - subtotal| ≤ 2¢ passes (rounding on per-line prices).
TOTALS_TOLERANCE_CENTS = 2
# Printed store name when the VLM couldn't read one (vendor slug `unknown`).
UNKNOWN_STORE = "UNKNOWN"
TotalsCheck = Literal["pass", "fail", "n/a"]
DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y", "%m-%d-%y", "%d.%m.%Y")


class VlmLine(BaseModel):
    raw_text: str
    qty: float | None = None
    unit_price: float | None = None
    line_total: float | None = None


class VlmReceipt(BaseModel):
    """What the prompt asks the model for: a transcription in printed dollars."""

    store: str | None = None
    date: str | None = None
    lines: list[VlmLine]
    subtotal: float | None = None
    tax: float | None = None
    total: float | None = None


def cents(amount: float | None) -> int | None:
    if amount is None:
        return None
    try:
        return int((Decimal(str(amount)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    except InvalidOperation:
        return None


def parse_date(text: str | None) -> date | None:
    if not text:
        return None
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text.strip(), fmt).date()
        except ValueError:
            continue
    return None


def totals_check(line_totals: list[int | None], subtotal: int | None) -> TotalsCheck:
    """`pass`/`fail` when every line total and the subtotal were read, else `n/a`."""
    if subtotal is None or not line_totals or any(t is None for t in line_totals):
        return "n/a"
    diff = abs(sum(t for t in line_totals if t is not None) - subtotal)
    return "pass" if diff <= TOTALS_TOLERANCE_CENTS else "fail"


def to_result(raw: VlmReceipt, today: date) -> tuple[PaperReceiptResult, dict[str, object]]:
    lines: list[Line] = []
    all_totals: list[int | None] = []
    discounts = 0
    for vl in raw.lines:
        text = vl.raw_text.strip()
        if not text:
            continue
        total = cents(vl.line_total)
        all_totals.append(total)
        # Discount/coupon lines (negative) count toward the totals check but aren't purchases,
        # and the contract's money fields are ≥ 0.
        if total is not None and total < 0:
            discounts += 1
            continue
        unit = cents(vl.unit_price)
        lines.append(
            Line(
                raw_text=text[:300],
                qty=vl.qty if vl.qty is not None and vl.qty > 0 else None,
                unit_price_cents=unit if unit is not None and unit >= 0 else None,
                line_total_cents=total,
            )
        )
    subtotal = cents(raw.subtotal)
    check = totals_check(all_totals, subtotal)
    receipt_date = parse_date(raw.date)
    store = (raw.store or "").strip() or UNKNOWN_STORE

    def nonneg(v: int | None) -> int | None:
        return v if v is not None and v >= 0 else None

    result = PaperReceiptResult(
        store=store,
        date=receipt_date or today,
        lines=lines[:300],
        subtotal_cents=nonneg(subtotal),
        tax_cents=nonneg(cents(raw.tax)),
        total_cents=nonneg(cents(raw.total)),
        totals_check=check,
    )
    telemetry: dict[str, object] = {
        "totals_check": check,
        "lines": len(lines),
        "discount_lines": discounts,
        "date_fallback": receipt_date is None,
        "store_missing": store == UNKNOWN_STORE,
    }
    return result, telemetry


def run(ctx: JobContext) -> Outcome:
    if not ctx.images:
        raise JobFailure("paper_receipt job has no image")
    inf = ctx.ollama.generate(
        ctx.settings.vlm_model,
        ctx.prompt.system,
        ctx.prompt.render(),
        VlmReceipt,
        images=ctx.images,
    )
    result, telemetry = to_result(inf.value, ctx.today())
    return Outcome(
        result=result.model_dump(mode="json"),
        model=inf.model,
        prompt_version=ctx.prompt.version,
        raw_model_response={"responses": inf.raw},
        latency_ms=inf.latency_ms,
        repaired=inf.repaired,
        telemetry=telemetry,
    )
