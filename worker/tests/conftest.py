"""Test doubles: an in-memory State Engine (jobs, leases, 409s, idempotency), R2 presigned
URLs and Ollama — all as `httpx.MockTransport`s, so no test touches the network."""

import io
import json
import socket
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from PIL import Image, ImageDraw
from pydantic import BaseModel, ValidationError

from pandabase_worker.api import ApiClient
from pandabase_worker.config import Settings
from pandabase_worker.contracts import MergeSuggestResult, PaperReceiptResult, TrashCamResult
from pandabase_worker.main import Worker
from pandabase_worker.media import MediaClient
from pandabase_worker.ollama import OllamaClient

FIXTURES = Path(__file__).parent / "fixtures" / "ollama"
TOKEN = "test-worker-token"
API = "http://engine.test"
OLLAMA = "http://ollama.test"
R2 = "https://r2.test"
MAX_ATTEMPTS = 3
LEASE = timedelta(minutes=5)
RESULTS: dict[str, type[BaseModel]] = {
    "paper_receipt": PaperReceiptResult,
    "trash_cam": TrashCamResult,
    "merge_suggest": MergeSuggestResult,
}


def fixture(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    return data


def no_sleep(_: float) -> None:
    pass


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests talk to mock transports only; a real connection attempt is a bug."""

    def refuse(self: socket.socket, address: object) -> None:
        raise AssertionError(f"test tried to open a network connection to {address!r}")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)


# -- synthetic media ---------------------------------------------------------------------------


def receipt_image(size: tuple[int, int] = (900, 1800), fmt: str = "PNG") -> bytes:
    """A fake receipt rendered with Pillow (the content of `paper_receipt.ok.json`)."""
    im = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(im)
    rows = [
        "SYNTHETIC FOODS MARKET",
        "123 TEST ST  10/18/2026",
        "ORG BANANAS",
        "  1.32 lb @ 0.69/lb      0.91",
        "WHOLE MILK 1GAL          4.29",
        "GREEK YOGURT",
        "  2 @ 1.25               2.50",
        "SOURDOUGH BREAD          5.99",
        "COUPON WHOLE MILK       -1.00",
        "SUBTOTAL                12.69",
        "TAX                      0.00",
        "TOTAL                   12.69",
    ]
    for n, row in enumerate(rows):
        d.text((40, 40 + n * 60), row, fill="black", font_size=36)
    out = io.BytesIO()
    im.save(out, fmt)
    return out.getvalue()


# -- fake R2 -----------------------------------------------------------------------------------


@dataclass
class FakeR2:
    objects: dict[str, bytes] = field(default_factory=dict)
    puts: list[tuple[str, str]] = field(default_factory=list)  # (key, content-type)
    get_failures: int = 0

    def url(self, key: str) -> str:
        return f"{R2}/bucket/{key}?X-Amz-Credential=abc%2F20261020%2Fauto%2Fs3&X-Amz-Signature=f00"

    def handle(self, req: httpx.Request) -> httpx.Response:
        key = req.url.path.removeprefix("/bucket/")
        if "X-Amz-Signature" not in req.url.params:
            return httpx.Response(403)
        if req.method == "GET":
            if self.get_failures:
                self.get_failures -= 1
                return httpx.Response(503)
            data = self.objects.get(key)
            return httpx.Response(200, content=data) if data is not None else httpx.Response(404)
        if req.method == "PUT":
            self.objects[key] = req.content
            self.puts.append((key, req.headers.get("content-type", "")))
            return httpx.Response(200)
        return httpx.Response(405)


# -- fake State Engine -------------------------------------------------------------------------


@dataclass
class FakeJob:
    id: str
    job_type: str
    media_key: str | None
    input: dict[str, Any] | None = None
    status: str = "queued"
    attempts: int = 0
    lease_expires_at: datetime | None = None
    result: dict[str, Any] | None = None
    errors: list[str] = field(default_factory=list)
    completes: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class FakeEngine:
    r2: FakeR2
    now: datetime = field(default_factory=lambda: datetime(2026, 10, 20, 16, 0, tzinfo=UTC))
    jobs: list[FakeJob] = field(default_factory=list)
    calls: list[tuple[str, str]] = field(default_factory=list)  # (path, job id or "")
    telemetry: list[dict[str, Any]] = field(default_factory=list)
    idempotent: dict[str, httpx.Response] = field(default_factory=dict)
    # Hooks to inject faults: path → callable(request) returning a response or raising.
    faults: dict[str, list[Callable[[httpx.Request], httpx.Response | None]]] = field(
        default_factory=dict
    )
    applied: int = 0

    def add(self, job_type: str, image: bytes | None = None, **kw: Any) -> FakeJob:
        n = len(self.jobs)
        key = None
        if image is not None:
            key = f"media/2026/10/{n:02d}.png"
            self.r2.objects[key] = image
        job = FakeJob(id=f"01JOB{n:02d}", job_type=job_type, media_key=key, **kw)
        self.jobs.append(job)
        return job

    def handle(self, req: httpx.Request) -> httpx.Response:
        if req.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401, json={"error": "unauthorized"})
        path = req.url.path
        for fault in self.faults.get(path, [])[:1]:
            self.faults[path].pop(0)
            res = fault(req)
            if res is not None:
                return res
        key = req.headers.get("idempotency-key")
        if key and key in self.idempotent:
            return self.idempotent[key]
        body = json.loads(req.content or b"{}")
        if path == "/api/jobs/claim":
            res = self.claim(body)
        elif path == "/api/jobs/complete":
            res = self.complete(body)
        elif path == "/api/telemetry":
            self.telemetry.extend(body["events"])
            res = httpx.Response(200, json={"accepted": len(body["events"])})
        else:
            res = httpx.Response(404, json={"error": "not found"})
        if key and res.status_code < 500:
            self.idempotent[key] = res
        return res

    def claim(self, body: dict[str, Any]) -> httpx.Response:
        for j in self.jobs:  # release expired leases (DESIGN §5)
            if j.status == "claimed" and j.lease_expires_at and j.lease_expires_at <= self.now:
                j.status = "failed" if j.attempts >= MAX_ATTEMPTS else "queued"
        types = body.get("job_types")
        job = next(
            (j for j in self.jobs if j.status == "queued" and (not types or j.job_type in types)),
            None,
        )
        self.calls.append(("claim", job.id if job else ""))
        if job is None:
            return httpx.Response(200, json={"job": None})
        job.status = "claimed"
        job.attempts += 1
        job.lease_expires_at = self.now + LEASE
        return httpx.Response(
            200,
            json={
                "job": {
                    "id": job.id,
                    "job_type": job.job_type,
                    "attempt": job.attempts,
                    "lease_expires_at": job.lease_expires_at.isoformat(),
                    "media_r2_key": job.media_key,
                    "media_url": self.r2.url(job.media_key) if job.media_key else None,
                    "input": job.input,
                    "expected_state_snapshot": None,
                    "keyframe_uploads": [
                        {
                            "key": f"keyframes/{job.id}/{n}.jpg",
                            "url": self.r2.url(f"keyframes/{job.id}/{n}.jpg"),
                        }
                        for n in range(8)
                    ],
                }
            },
        )

    def complete(self, body: dict[str, Any]) -> httpx.Response:
        job = next(j for j in self.jobs if j.id == body["job_id"])
        self.calls.append(("complete", job.id))
        if job.status != "claimed" or job.attempts != body["attempt"]:
            return httpx.Response(409, json={"error": "stale attempt"})
        job.completes.append(body)
        failure = (body.get("error") or "failed") if body["status"] == "failed" else None
        if failure is None:
            try:
                RESULTS[job.job_type].model_validate(body.get("result") or {})
            except ValidationError as err:
                failure = f"invalid result: {err}"
        if failure is not None:
            job.errors.append(failure)
            job.status = "queued" if job.attempts < MAX_ATTEMPTS else "failed"
            outcome = "retry" if job.status == "queued" else "failed"
        else:
            self.applied += 1
            job.status, job.result, outcome = "completed", body["result"], "applied"
        return httpx.Response(
            200,
            json={
                "job": {
                    "id": job.id,
                    "job_type": job.job_type,
                    "status": job.status,
                    "media_r2_key": job.media_key,
                    "attempts": job.attempts,
                    "error": job.errors[-1] if failure else None,
                    "cycle_id": None,
                    "discord_channel_id": None,
                    "discord_message_id": None,
                    "created_at": self.now.isoformat(),
                    "completed_at": None,
                    "notified_at": None,
                },
                "outcome": outcome,
                "receipt_id": None,
                "review_ids": [],
            },
        )

    def metrics(self, name: str) -> list[dict[str, Any]]:
        return [e["payload"] for e in self.telemetry if e["metric_type"] == name]


# -- fake Ollama -------------------------------------------------------------------------------


@dataclass
class FakeOllama:
    """Replies to `/api/chat` with queued fixtures (or callables), in order."""

    replies: list[dict[str, Any] | Callable[[httpx.Request], httpx.Response]] = field(
        default_factory=list
    )
    tags: dict[str, Any] | None = field(default_factory=lambda: fixture("tags"))
    requests: list[dict[str, Any]] = field(default_factory=list)
    active: int = 0
    max_active: int = 0

    def queue(self, *names: str) -> None:
        self.replies.extend(fixture(n) for n in names)

    def handle(self, req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/tags":
            if self.tags is None:
                raise httpx.ConnectError("connection refused", request=req)
            return httpx.Response(200, json=self.tags)
        if req.url.path != "/api/chat":
            return httpx.Response(404)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            self.requests.append(json.loads(req.content))
            if not self.replies:
                return httpx.Response(500, json={"error": "no fixture queued"})
            reply = self.replies.pop(0)
            return reply(req) if callable(reply) else httpx.Response(200, json=reply)
        finally:
            self.active -= 1


@dataclass
class Rig:
    engine: FakeEngine
    r2: FakeR2
    ollama: FakeOllama
    worker: Worker
    settings: Settings


@pytest.fixture
def rig(tmp_path: Path) -> Iterator[Rig]:
    r2 = FakeR2()
    engine = FakeEngine(r2)
    ollama = FakeOllama()
    settings = Settings(api_url=API, api_token=TOKEN, ollama_url=OLLAMA, poll_interval_seconds=0)
    api = ApiClient(API, TOKEN, transport=httpx.MockTransport(engine.handle), sleep=no_sleep)
    oc = OllamaClient(OLLAMA, transport=httpx.MockTransport(ollama.handle))
    media = MediaClient(transport=httpx.MockTransport(r2.handle), sleep=no_sleep)
    worker = Worker(settings, api, oc, media)
    yield Rig(engine, r2, ollama, worker, settings)
    api.close()
    oc.close()
    media.close()
