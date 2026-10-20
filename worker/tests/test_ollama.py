"""Structured output: validation, one repair retry, then a reported parse failure."""

import httpx
import pytest
from conftest import OLLAMA, FakeOllama, Rig, fixture, receipt_image

from pandabase_worker.jobs.paper_receipt import VlmReceipt
from pandabase_worker.jobs.trash_cam import VlmTrashCam
from pandabase_worker.ollama import OllamaClient, OllamaError, ParseFailure


def client(fake: FakeOllama) -> OllamaClient:
    ticks = iter(range(0, 10_000, 3))  # every clock read advances 3s
    return OllamaClient(
        OLLAMA, transport=httpx.MockTransport(fake.handle), clock=lambda: float(next(ticks))
    )


def test_fenced_json_is_accepted_without_repair() -> None:
    fake = FakeOllama()
    fake.queue("paper_receipt.fenced")
    inf = client(fake).generate("qwen3.5:9b", "sys", "user", VlmReceipt)
    assert inf.value.store == "SYNTHETIC FOODS MARKET"
    assert inf.repaired is False
    assert inf.latency_ms == 3000
    assert len(fake.requests) == 1


def test_malformed_json_is_repaired_once() -> None:
    fake = FakeOllama()
    fake.queue("paper_receipt.truncated", "paper_receipt.ok")
    inf = client(fake).generate("qwen3.5:9b", "sys", "user", VlmReceipt, images=[b"jpeg"])
    assert inf.repaired is True
    assert len(inf.raw) == 2
    repair = fake.requests[1]["messages"]
    # The repair turn replays the bad reply and names the problem; the image stays in context.
    assert [m["role"] for m in repair] == ["system", "user", "assistant", "user"]
    assert repair[2]["content"] == fixture("paper_receipt.truncated")["message"]["content"]
    assert "not valid JSON" in repair[3]["content"]
    assert repair[1]["images"] == ["anBlZw=="]
    assert fake.requests[1]["format"] == fake.requests[0]["format"]


def test_schema_errors_are_named_in_the_repair_prompt() -> None:
    fake = FakeOllama()
    fake.queue("paper_receipt.wrong_shape", "paper_receipt.ok")
    client(fake).generate("qwen3.5:9b", "sys", "user", VlmReceipt)
    assert "lines: Field required" in fake.requests[1]["messages"][3]["content"]


def test_second_bad_reply_raises_parse_failure() -> None:
    fake = FakeOllama()
    fake.queue("prose", "paper_receipt.truncated")
    with pytest.raises(ParseFailure) as exc:
        client(fake).generate("qwen3.5:9b", "sys", "user", VlmReceipt)
    assert exc.value.model == "qwen3.5:9b"
    assert exc.value.error == "not valid JSON"
    assert len(exc.value.raw) == 2
    assert len(fake.requests) == 2  # exactly one repair


def test_http_errors_raise_ollama_error() -> None:
    fake = FakeOllama()  # nothing queued → 500
    with pytest.raises(OllamaError, match="ollama 500"):
        client(fake).generate("qwen3.5:9b", "sys", "user", VlmReceipt)

    def refuse(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=req)

    down = OllamaClient(OLLAMA, transport=httpx.MockTransport(refuse))
    with pytest.raises(OllamaError, match="unreachable"):
        down.generate("qwen3.5:9b", "sys", "user", VlmReceipt)
    assert down.available_models() is None


def test_parse_failure_fails_the_job_with_telemetry(rig: Rig) -> None:
    job = rig.engine.add("paper_receipt", receipt_image())
    rig.ollama.queue("prose", "paper_receipt.truncated")
    assert rig.worker.run_once()
    (body,) = job.completes
    assert body["status"] == "failed"
    assert body["error"] == "model output invalid after one repair: not valid JSON"
    assert body["model"] == "qwen3.5:9b"
    assert body["prompt_version"] == "paper_receipt.v1"
    assert len(body["raw_model_response"]["responses"]) == 2
    assert job.status == "queued"  # retried on the next claim
    (inf,) = rig.engine.metrics("vlm_inference")
    assert inf["parse_failure"] is True
    assert "totals_check" not in inf
    (pf,) = rig.engine.metrics("vlm_parse_failure")
    assert pf == {
        "job_id": job.id,
        "job_type": "paper_receipt",
        "attempt": 1,
        "model": "qwen3.5:9b",
        "prompt_version": "paper_receipt.v1",
        "error": "not valid JSON",
    }


def test_think_flag_is_dropped_for_models_without_thinking() -> None:
    fake = FakeOllama()
    no_think = httpx.Response(400, json={"error": '"gemma4:e4b" does not support thinking'})
    fake.replies.append(lambda _r: no_think)
    fake.queue("trash_cam.ok")
    inf = client(fake).generate("gemma4:e4b", "sys", "user", VlmTrashCam)
    assert inf.value.detections[0].name == "oat milk"
    assert fake.requests[0]["think"] is False
    assert "think" not in fake.requests[1]
