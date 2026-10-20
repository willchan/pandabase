"""Photo intake (PRD §4.2 paper receipts, §4.3 Trash Cam): classify → upload → audit job.

Classification is deterministic and local: the caption first, then the local image description
OpenClaw's media understanding produced with the household's Ollama VLM (never a cloud model —
see M7 Notes), then a default. The default is a paper receipt — the worker's totals check and
the review queue catch a wrong guess — and the reply tells the human how to re-file it once,
without waiting. Every decision emits `photo_classified {job_type, basis}`.
"""

from __future__ import annotations

import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from . import contracts as c
from .api import ApiClient
from .telemetry import Telemetry

JobType = Literal["paper_receipt", "trash_cam"]
Basis = Literal["caption", "description", "default"]

RECEIPT_WORDS = re.compile(r"\b(?:receipts?|bought|purchased?|shopping|groceries)\b", re.I)
TRASH_WORDS = re.compile(
    r"\b(?:out of|ran out|finished|empty|used up|all gone|trash|threw (?:it )?out|tossed"
    r"|we'?re out|last one|need more)\b",
    re.I,
)
# What a VLM description of a receipt tends to say.
RECEIPT_DESCRIPTION = re.compile(r"\b(?:receipt|itemi[sz]ed|subtotal|total|till slip)\b", re.I)
EXTENSIONS = {"jpg", "jpeg", "png", "webp", "heic", "mp4", "mov"}


@dataclass(frozen=True)
class Classification:
    job_type: JobType
    basis: Basis


def classify(caption: str | None, description: str | None) -> Classification:
    """Caption keywords (only when unambiguous) → local description → default receipt."""
    if caption:
        receipt, trash = bool(RECEIPT_WORDS.search(caption)), bool(TRASH_WORDS.search(caption))
        if receipt != trash:
            return Classification("paper_receipt" if receipt else "trash_cam", "caption")
    if description:
        if RECEIPT_DESCRIPTION.search(description):
            return Classification("paper_receipt", "description")
        return Classification("trash_cam", "description")
    return Classification("paper_receipt", "default")


def media_type(path: Path) -> tuple[str, str]:
    ext = path.suffix.lower().lstrip(".")
    if ext not in EXTENSIONS:
        raise ValueError(f"unsupported media type: .{ext}")
    content_type = mimetypes.guess_type(path.name)[0] or (
        "image/heic" if ext == "heic" else "video/quicktime" if ext == "mov" else ""
    )
    if not content_type.startswith(("image/", "video/")):
        raise ValueError(f"unsupported media type: {content_type or ext}")
    return content_type, ext


def submit(
    api: ApiClient,
    tel: Telemetry,
    *,
    file: Path,
    actor: str,
    channel_id: str | None,
    message_id: str | None,
    job_type: JobType,
    basis: Basis | Literal["human"],
    cycle_id: str | None = None,
    media_r2_key: str | None = None,
) -> dict[str, object]:
    """Upload (unless re-filing an already uploaded key) and create the job."""
    if media_r2_key is None:
        content_type, ext = media_type(file)
        upload = api.upload_url(content_type, ext)
        api.put_media(upload, file.read_bytes())
        media_r2_key = upload.key
    body = c.JobCreateRequest(
        actor_discord_id=actor,
        job_type=job_type,
        media_r2_key=media_r2_key,
        discord_channel_id=channel_id,
        discord_message_id=message_id,
        cycle_id=cycle_id,
    )
    suffix = "" if basis != "human" else ":refile"
    key = f"job:{message_id}:{job_type}{suffix}" if message_id else None
    job = api.create_job(body, key=key).job
    if basis == "human":
        tel.emit("photo_reclassified", to_job_type=job_type, media_r2_key=media_r2_key)
    else:
        tel.emit("photo_classified", job_type=job_type, basis=basis)
    return {"job_id": job.id, "job_type": job_type, "basis": basis, "media_r2_key": media_r2_key}
