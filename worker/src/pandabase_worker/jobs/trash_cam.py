"""Trash Cam (DESIGN §5): identify the finished product(s) in a photo, with confidence.

The State Engine resolves the most confident detection to an item and decides whether to apply
it (`trashCam.applyConfidence`); the worker only reports what it sees.
"""

from pydantic import BaseModel

from pandabase_worker.contracts import Detection, TrashCamResult
from pandabase_worker.jobs import JobFailure, Outcome
from pandabase_worker.jobs.context import JobContext

MAX_DETECTIONS = 5


class VlmDetection(BaseModel):
    name: str
    confidence: float
    bbox: list[float] | None = None


class VlmTrashCam(BaseModel):
    detections: list[VlmDetection]


def clean_bbox(bbox: list[float] | None) -> list[float] | None:
    """Keep a normalized `[x0, y0, x1, y1]` box; drop anything malformed."""
    if bbox is None or len(bbox) != 4 or not all(0 <= v <= 1 for v in bbox):
        return None
    x0, y0, x1, y1 = bbox
    return bbox if x0 < x1 and y0 < y1 else None


def to_result(raw: VlmTrashCam) -> TrashCamResult:
    detections = [
        Detection(
            name=d.name.strip(),
            confidence=min(max(d.confidence, 0.0), 1.0),
            bbox=clean_bbox(d.bbox),
        )
        for d in raw.detections
        if d.name.strip()
    ]
    detections.sort(key=lambda d: d.confidence, reverse=True)
    return TrashCamResult(detections=detections[:MAX_DETECTIONS])


def run(ctx: JobContext) -> Outcome:
    if not ctx.images:
        raise JobFailure("trash_cam job has no image")
    inf = ctx.ollama.generate(
        ctx.settings.vlm_model,
        ctx.prompt.system,
        ctx.prompt.render(),
        VlmTrashCam,
        images=ctx.images,
    )
    result = to_result(inf.value)
    top = result.detections[0].confidence if result.detections else None
    return Outcome(
        result=result.model_dump(mode="json", exclude_none=True),
        model=inf.model,
        prompt_version=ctx.prompt.version,
        raw_model_response={"responses": inf.raw},
        latency_ms=inf.latency_ms,
        repaired=inf.repaired,
        telemetry={"detections": len(result.detections), "top_confidence": top},
    )
