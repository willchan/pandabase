"""The generated contracts (`pnpm contracts:gen`) parse the State Engine's payloads."""

from datetime import date

from pandabase_worker.contracts import (
    JobClaimResponse,
    JobCompleteRequest,
    PaperReceiptResult,
    TrashCamResult,
)


def test_claim_response_parses() -> None:
    claim = JobClaimResponse.model_validate(
        {
            "job": {
                "id": "01JOB",
                "job_type": "paper_receipt",
                "attempt": 1,
                "lease_expires_at": "2026-10-20T16:05:00.000Z",
                "media_r2_key": "media/2026/10/a.jpg",
                "media_url": "https://r2.test/media/2026/10/a.jpg",
                "input": None,
                "expected_state_snapshot": None,
                "keyframe_uploads": [{"key": "keyframes/01JOB/0.jpg", "url": "https://r2.test/k"}],
            }
        }
    )
    assert claim.job is not None
    assert claim.job.attempt == 1
    assert JobClaimResponse.model_validate({"job": None}).job is None


def test_complete_request_round_trips() -> None:
    result = PaperReceiptResult(
        store="WHOLE FOODS MARKET",
        date=date(2026, 10, 19),
        lines=[],
        subtotal_cents=None,
        tax_cents=None,
        total_cents=1258,
        totals_check="n/a",
    )
    req = JobCompleteRequest(
        job_id="01JOB",
        attempt=1,
        status="completed",
        result=result.model_dump(mode="json"),
        model="qwen-vl:8b",
        prompt_version="paper_receipt.v1",
    )
    body = req.model_dump(mode="json", exclude_none=True)
    assert body["result"]["date"] == "2026-10-19"
    assert TrashCamResult.model_validate({"detections": []}).detections == []
