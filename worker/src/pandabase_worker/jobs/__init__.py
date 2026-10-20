"""Job handlers: one module per job type, each turning a claimed job into an `Outcome`."""

from dataclasses import dataclass, field
from typing import Any


class JobFailure(Exception):
    """A job can't produce a result this attempt (bad input, unreadable media, …)."""


@dataclass
class Outcome:
    """What a handler produced; the loop posts it as `JobCompleteRequest`."""

    result: dict[str, Any]
    model: str
    prompt_version: str
    raw_model_response: Any
    latency_ms: int
    repaired: bool
    # Extra `vlm_inference` telemetry fields (e.g. totals_check).
    telemetry: dict[str, Any] = field(default_factory=dict)
