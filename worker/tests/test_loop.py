"""Claim → media → model → complete loop against the fake State Engine (DESIGN §5 step 4)."""

import io
import json
import os
import signal
import threading
from datetime import timedelta

import httpx
import pytest
from conftest import Rig, fixture, receipt_image
from PIL import Image

from pandabase_worker.main import install_signal_handlers

MERGE_INPUT = {
    "items": [
        {"item_id": "01ITEMTOWEL", "name": "paper towel"},
        {"item_id": "01ITEMTOWELS", "name": "paper towels", "aliases": ["BOUNTY 6PK"]},
        {"item_id": "01ITEMOAT", "name": "oat milk"},
    ]
}


def test_paper_receipt_end_to_end(rig: Rig) -> None:
    job = rig.engine.add("paper_receipt", receipt_image(size=(1600, 3200)))
    rig.ollama.queue("paper_receipt.ok")

    assert rig.worker.run_once() is True

    assert job.status == "completed"
    (body,) = job.completes
    assert body["attempt"] == 1
    assert body["model"] == "qwen3.5:9b"
    assert body["prompt_version"] == "paper_receipt.v1"
    assert body["keyframe_r2_keys"] == [f"keyframes/{job.id}/0.jpg"]
    assert body["raw_model_response"] == {
        "responses": [fixture("paper_receipt.ok")["message"]["content"]]
    }
    result = body["result"]
    assert result["store"] == "SYNTHETIC FOODS MARKET"
    assert result["date"] == "2026-10-18"
    assert result["subtotal_cents"] == 1269
    assert result["totals_check"] == "pass"
    assert [ln["raw_text"] for ln in result["lines"]] == [
        "ORG BANANAS",
        "WHOLE MILK 1GAL",
        "GREEK YOGURT",
        "SOURDOUGH BREAD",
    ]
    assert result["lines"][0] == {
        "raw_text": "ORG BANANAS",
        "qty": 1.32,
        "unit_price_cents": 69,
        "line_total_cents": 91,
    }

    # Keyframe: normalized JPEG ≤ 2048px, uploaded to the presigned PUT.
    assert rig.r2.puts == [(f"keyframes/{job.id}/0.jpg", "image/jpeg")]
    with Image.open(io.BytesIO(rig.r2.objects[f"keyframes/{job.id}/0.jpg"])) as kf:
        assert kf.format == "JPEG"
        assert max(kf.size) == 2048

    # The VLM got the same keyframe, JSON-schema mode, keep_alive 2m, temperature 0.
    (req,) = rig.ollama.requests
    assert req["model"] == "qwen3.5:9b"
    assert req["keep_alive"] == "2m"
    assert req["stream"] is False
    assert req["think"] is False
    assert req["options"]["temperature"] == 0
    assert req["format"]["type"] == "object"
    assert "lines" in req["format"]["properties"]
    assert "Transcribe" in req["messages"][1]["content"]
    assert len(req["messages"][1]["images"]) == 1

    (inf,) = rig.engine.metrics("vlm_inference")
    assert inf["model"] == "qwen3.5:9b"
    assert inf["prompt_version"] == "paper_receipt.v1"
    assert inf["totals_check"] == "pass"
    assert inf["parse_failure"] is False
    assert isinstance(inf["latency_ms"], int)
    assert inf["job_id"] == job.id


def test_trash_cam_and_merge_suggest(rig: Rig) -> None:
    cam = rig.engine.add("trash_cam", receipt_image(size=(600, 800), fmt="JPEG"))
    merge = rig.engine.add("merge_suggest", input=MERGE_INPUT)
    rig.ollama.queue("trash_cam.ok", "merge_suggest.ok")

    assert rig.worker.run_once() and rig.worker.run_once()
    assert rig.worker.run_once() is False  # queue empty

    assert cam.result == {
        "detections": [
            {"name": "oat milk", "confidence": 0.93, "bbox": [0.31, 0.12, 0.68, 0.91]},
            {"name": "greek yogurt", "confidence": 0.41},  # malformed bbox dropped
        ]
    }
    assert cam.completes[0]["prompt_version"] == "trash_cam.v1"
    assert merge.result == {
        "suggestions": [
            {
                "item_id": "01ITEMTOWELS",
                "merge_into_item_id": "01ITEMTOWEL",
                "confidence": 0.94,
                "reason": "plural of the same product",
            }
        ]
    }
    m = merge.completes[0]
    assert (m["model"], m["prompt_version"]) == ("qwen3.5:4b", "merge_suggest.v1")
    assert "keyframe_r2_keys" not in m  # no media
    text_req = rig.ollama.requests[1]
    assert text_req["model"] == "qwen3.5:4b"
    assert "images" not in text_req["messages"][1]
    assert "01ITEMTOWELS" in text_req["messages"][1]["content"]
    infs = rig.engine.metrics("vlm_inference")
    assert [i["job_type"] for i in infs] == ["trash_cam", "merge_suggest"]
    assert "totals_check" not in infs[0]


def test_failure_is_reported_and_retried_until_failed(rig: Rig) -> None:
    job = rig.engine.add("trash_cam", receipt_image(fmt="JPEG"))
    down = httpx.Response(500, json={"error": "model runner crashed"})
    rig.ollama.replies.extend([lambda _r: down, lambda _r: down])
    rig.ollama.queue("trash_cam.ok")

    assert rig.worker.run_once()
    assert job.status == "queued"
    first = job.completes[0]
    assert first["status"] == "failed"
    assert first["attempt"] == 1
    assert "ollama 500" in first["error"]
    assert first["keyframe_r2_keys"] == [f"keyframes/{job.id}/0.jpg"]
    assert first["prompt_version"] == "trash_cam.v1"

    assert rig.worker.run_once()  # attempt 2 fails too
    assert rig.worker.run_once()  # attempt 3 succeeds
    assert [c["attempt"] for c in job.completes] == [1, 2, 3]
    assert job.status == "completed"
    failed = rig.engine.metrics("worker_job_failed")
    assert [f["attempt"] for f in failed] == [1, 2]

    # A job that keeps failing ends `failed` after 3 attempts.
    bad = rig.engine.add("trash_cam", b"not an image")
    for _ in range(3):
        assert rig.worker.run_once()
    assert bad.status == "failed"
    assert all("unreadable image" in c["error"] for c in bad.completes)
    assert rig.worker.run_once() is False


def test_invalid_merge_input_fails_without_calling_the_model(rig: Rig) -> None:
    job = rig.engine.add("merge_suggest", input={"items": []})
    assert rig.worker.run_once()
    assert job.completes[0]["status"] == "failed"
    assert "merge_suggest input invalid" in job.completes[0]["error"]
    assert job.completes[0]["prompt_version"] == "merge_suggest.v1"
    assert rig.ollama.requests == []


@pytest.mark.parametrize(
    "items",
    [
        # MergeSuggestInput (generated): at most 150 items, names at most 200 chars.
        [{"item_id": f"01ITEM{i}", "name": f"item {i}"} for i in range(151)],
        [{"item_id": "01A", "name": "x" * 201}, {"item_id": "01B", "name": "b"}],
    ],
    ids=["151 items", "201-char name"],
)
def test_merge_input_follows_the_contract(rig: Rig, items: list[dict[str, str]]) -> None:
    job = rig.engine.add("merge_suggest", input={"items": items})
    assert rig.worker.run_once()
    assert job.completes[0]["status"] == "failed"
    assert "merge_suggest input invalid" in job.completes[0]["error"]
    assert rig.ollama.requests == []


def test_lease_lost_drops_the_result(rig: Rig) -> None:
    job = rig.engine.add("trash_cam", receipt_image(fmt="JPEG"))

    def slow(_req: httpx.Request) -> httpx.Response:
        # The lease expires mid-inference and another claim re-leases the job (attempt 2).
        rig.engine.now += timedelta(minutes=6)
        rig.engine.claim({})
        return httpx.Response(200, json=fixture("trash_cam.ok"))

    rig.ollama.replies.append(slow)
    assert rig.worker.run_once()
    assert job.attempts == 2
    assert job.status == "claimed"
    assert job.completes == []  # the late attempt-1 result was rejected (409)
    assert rig.engine.metrics("worker_lease_lost") == [
        {"job_id": job.id, "job_type": "trash_cam", "attempt": 1}
    ]


def test_complete_is_idempotent_across_retries(rig: Rig) -> None:
    job = rig.engine.add("trash_cam", receipt_image(fmt="JPEG"))
    rig.ollama.queue("trash_cam.ok")
    keys: list[str] = []

    def drop_reply(req: httpx.Request) -> httpx.Response | None:
        # The engine applies the result, then the connection drops before the reply arrives.
        keys.append(req.headers["idempotency-key"])
        res = rig.engine.complete(json.loads(req.content))
        rig.engine.idempotent[req.headers["idempotency-key"]] = res
        raise httpx.ReadError("connection reset", request=req)

    def five_hundred(req: httpx.Request) -> httpx.Response:
        keys.append(req.headers["idempotency-key"])
        return httpx.Response(503, json={"error": "busy"})

    rig.engine.faults["/api/jobs/complete"] = [five_hundred, drop_reply]
    assert rig.worker.run_once()
    assert job.status == "completed"
    assert rig.engine.applied == 1  # the retry was replayed, not applied twice
    assert keys == [f"complete:{job.id}:1"] * 2
    assert rig.engine.metrics("worker_complete_error") == []


def test_media_download_retries_transient_errors(rig: Rig) -> None:
    job = rig.engine.add("trash_cam", receipt_image(fmt="JPEG"))
    rig.r2.get_failures = 2
    rig.ollama.queue("trash_cam.ok")
    assert rig.worker.run_once()
    assert job.status == "completed"


def test_concurrency_is_one(rig: Rig) -> None:
    for _ in range(3):
        rig.engine.add("trash_cam", receipt_image(fmt="JPEG"))
    rig.ollama.queue("trash_cam.ok", "trash_cam.ok", "trash_cam.ok")
    while rig.worker.run_once():
        pass
    # Each job is completed before the next claim; never two inferences at once.
    assert rig.engine.calls == [
        ("claim", "01JOB00"),
        ("complete", "01JOB00"),
        ("claim", "01JOB01"),
        ("complete", "01JOB01"),
        ("claim", "01JOB02"),
        ("complete", "01JOB02"),
        ("claim", ""),
    ]
    assert rig.ollama.max_active == 1
    assert threading.active_count() == 1


def test_no_claim_while_ollama_is_down_or_model_missing(rig: Rig) -> None:
    rig.engine.add("trash_cam", receipt_image(fmt="JPEG"))
    rig.ollama.tags = None
    assert rig.worker.run_once() is False
    assert rig.engine.calls == []  # claiming would have cost the job an attempt
    assert rig.worker.run_once() is False
    assert rig.engine.metrics("worker_ollama_unavailable") == [
        {"reason": "unreachable", "missing_models": ["qwen3.5:4b", "qwen3.5:9b"]}
    ]  # once per outage

    # Only the text model pulled: merge_suggest only.
    rig.ollama.tags = {"models": [{"name": "qwen3.5:4b", "model": "qwen3.5:4b"}]}
    assert rig.worker.claimable_types() == ["merge_suggest"]
    assert rig.worker.run_once() is False
    assert rig.engine.calls == [("claim", "")]
    assert rig.engine.metrics("worker_ollama_unavailable")[-1] == {
        "reason": "models missing",
        "missing_models": ["qwen3.5:9b"],
    }


def test_sigterm_finishes_the_current_job_then_stops(rig: Rig) -> None:
    for _ in range(2):
        rig.engine.add("trash_cam", receipt_image(fmt="JPEG"))
    previous = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
    install_signal_handlers(rig.worker.stop)

    def sigterm_mid_inference(_req: httpx.Request) -> httpx.Response:
        os.kill(os.getpid(), signal.SIGTERM)
        return httpx.Response(200, json=fixture("trash_cam.ok"))

    rig.ollama.replies.append(sigterm_mid_inference)
    try:
        rig.worker.run()  # returns once stopped
        assert rig.worker.stop.is_set()
        # The in-flight job completed; the second was never claimed.
        assert [j.status for j in rig.engine.jobs] == ["completed", "queued"]
        assert rig.engine.calls == [("claim", "01JOB00"), ("complete", "01JOB00")]

        with pytest.raises(SystemExit):  # a second signal exits at once
            os.kill(os.getpid(), signal.SIGTERM)
    finally:
        signal.signal(signal.SIGTERM, previous[0])
        signal.signal(signal.SIGINT, previous[1])


def test_heartbeat_at_startup_and_every_ten_minutes(rig: Rig) -> None:
    now = [1000.0]
    rig.worker._clock = lambda: now[0]
    rig.worker.heartbeat()
    rig.worker.heartbeat()  # too soon
    now[0] += 599
    rig.worker.heartbeat()
    now[0] += 1
    rig.worker.heartbeat()
    beats = rig.engine.metrics("worker_heartbeat")
    assert len(beats) == 2
    assert beats[0] == {
        "version": "0.0.0",
        "vlm_model": "qwen3.5:9b",
        "text_model": "qwen3.5:4b",
        "ollama_ok": None,  # not checked yet
    }
    rig.ollama.tags = None
    rig.worker.claimable_types()
    now[0] += 600
    rig.worker.heartbeat()
    assert rig.engine.metrics("worker_heartbeat")[-1]["ollama_ok"] is False
