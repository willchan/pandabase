"""Client telemetry (DESIGN §7): buffered, flushed once per command via `POST /api/telemetry`.

Metric names the weekly report reads: `selector_error {selector, error, page}`,
`price_lookup_failed {asin, product_id, error}`, `cart_tier1_line {asin, item_id, product_id,
vendor, outcome, error}`, `clarifying_question {question}`, `photo_classified {job_type, basis}`,
`photo_reclassified {from_job_type, to_job_type}`, `receipt_sweep {member, mode, …counts}`.
A telemetry failure never fails the command.
"""

from __future__ import annotations

import sys
from datetime import UTC, datetime
from typing import Any, Protocol

from . import contracts as c


class Sink(Protocol):
    def telemetry(self, events: list[c.TelemetryEvent]) -> int: ...


class Telemetry:
    def __init__(self) -> None:
        self.events: list[c.TelemetryEvent] = []

    def emit(self, metric: str, **payload: Any) -> None:
        self.events.append(
            c.TelemetryEvent(
                metric_type=metric,
                occurred_at=datetime.now(UTC),
                payload={k: v for k, v in payload.items() if v is not None},
            )
        )

    def metrics(self, name: str) -> list[dict[str, Any]]:
        return [e.payload for e in self.events if e.metric_type == name]

    def flush(self, sink: Sink | None) -> int:
        if not self.events or sink is None:
            return 0
        sent = 0
        try:
            for i in range(0, len(self.events), 500):
                sent += sink.telemetry(self.events[i : i + 500])
        except Exception as err:
            print(f"telemetry flush failed: {err}", file=sys.stderr)
        self.events = []
        return sent
