from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from conftest import FakeApi

from pandabase_tools import photos
from pandabase_tools.telemetry import Telemetry


@pytest.mark.parametrize(
    ("caption", "description", "job_type", "basis"),
    [
        ("receipt from trader joe's", None, "paper_receipt", "caption"),
        ("we're out of oat milk", None, "trash_cam", "caption"),
        ("finished the receipt paper", None, "paper_receipt", "default"),  # ambiguous → default
        (None, "A printed till slip with a subtotal and tax", "paper_receipt", "description"),
        (None, "An empty carton of oat milk on a counter", "trash_cam", "description"),
        ("", None, "paper_receipt", "default"),
    ],
)
def test_classify(caption: str | None, description: str | None, job_type: str, basis: str) -> None:
    got = photos.classify(caption, description)
    assert (got.job_type, got.basis) == (job_type, basis)


def test_submit_uploads_then_creates_job(tmp_path: Path) -> None:
    img = tmp_path / "IMG_0001.jpg"
    img.write_bytes(b"\xff\xd8synthetic")
    puts: list[httpx.Request] = []
    api = FakeApi(
        {
            "POST /api/media/upload-url": lambda b: {
                "url": "https://r2.test/media/k1.jpg?sig=1",
                "method": "PUT",
                "key": "media/k1.jpg",
                "headers": {"content-type": "image/jpeg"},
                "expires_at": "2026-10-20T20:00:00Z",
            },
            "POST /api/jobs": lambda b: {
                "job": {
                    "id": "J1",
                    "job_type": b["job_type"],
                    "status": "queued",
                    "attempts": 0,
                    "media_r2_key": b["media_r2_key"],
                    "cycle_id": None,
                    "error": None,
                    "discord_channel_id": b.get("discord_channel_id"),
                    "discord_message_id": b.get("discord_message_id"),
                    "notified_at": None,
                    "created_at": "2026-10-20T19:00:00Z",
                    "completed_at": None,
                }
            },
        }
    )
    client = api.client()
    client.put_media = lambda upload, data: puts.append(  # type: ignore[method-assign]
        httpx.Request("PUT", str(upload.url), content=data)
    )
    tel = Telemetry()
    out = photos.submit(
        client,
        tel,
        file=img,
        actor="1001",
        channel_id="10",
        message_id="555",
        job_type="paper_receipt",
        basis="caption",
    )
    assert out == {
        "job_id": "J1",
        "job_type": "paper_receipt",
        "basis": "caption",
        "media_r2_key": "media/k1.jpg",
    }
    assert puts[0].content == b"\xff\xd8synthetic"
    job_req = next(r for r in api.requests if r.url.path == "/api/jobs")
    assert job_req.headers["Idempotency-Key"] == "job:555:paper_receipt"
    assert tel.metrics("photo_classified") == [{"job_type": "paper_receipt", "basis": "caption"}]


def test_media_type_rejects_unknown(tmp_path: Path) -> None:
    assert photos.media_type(Path("a.HEIC")) == ("image/heic", "heic")
    with pytest.raises(ValueError):
        photos.media_type(Path("a.pdf"))
