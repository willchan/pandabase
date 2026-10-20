"""Client telemetry (DESIGN §7): buffered events posted to `POST /api/telemetry`.

A telemetry failure is logged and never fails a job.
"""

import logging
from datetime import UTC, datetime
from typing import Any, Protocol

from pandabase_worker.contracts import TelemetryEvent

log = logging.getLogger(__name__)

# The State Engine accepts at most this many events per request.
MAX_BATCH = 500


class TelemetrySink(Protocol):
    def telemetry(self, events: list[TelemetryEvent]) -> int: ...


class Telemetry:
    def __init__(self, sink: TelemetrySink) -> None:
        self._sink = sink
        self._events: list[TelemetryEvent] = []

    def emit(self, metric: str, **payload: Any) -> None:
        self._events.append(
            TelemetryEvent(metric_type=metric, occurred_at=datetime.now(UTC), payload=payload)
        )

    def flush(self) -> None:
        events, self._events = self._events, []
        for i in range(0, len(events), MAX_BATCH):
            try:
                self._sink.telemetry(events[i : i + MAX_BATCH])
            except Exception as err:
                log.warning("telemetry dropped (%d events): %s", len(events[i:]), err)
                return
