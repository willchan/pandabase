"""State Engine API client (worker scope). Wire types are the generated contracts only."""

import time
import uuid
from types import TracebackType
from typing import Literal, Self

import httpx

from pandabase_worker.config import API_TIMEOUT_SECONDS, HTTP_ATTEMPTS
from pandabase_worker.contracts import (
    ClaimedJob,
    JobClaimRequest,
    JobClaimResponse,
    JobCompleteRequest,
    JobCompleteResponse,
    TelemetryEvent,
    TelemetryRequest,
    TelemetryResponse,
)
from pandabase_worker.http import Sleep, request_with_retries


class ApiError(Exception):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"API {status}: {body[:300]}")
        self.status = status
        self.body = body


class LeaseLost(ApiError):
    """409 on complete: the lease expired and the job moved on. Drop the job (DESIGN §5)."""


JobType = Literal["paper_receipt", "trash_cam", "merge_suggest"]


class ApiClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        transport: httpx.BaseTransport | None = None,
        sleep: Sleep = time.sleep,
    ) -> None:
        self._http = httpx.Client(
            base_url=base_url,
            headers={"authorization": f"Bearer {token}", "user-agent": "pandabase-worker"},
            timeout=API_TIMEOUT_SECONDS,
            transport=transport,
        )
        self._sleep = sleep

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self, t: type[BaseException] | None, e: BaseException | None, tb: TracebackType | None
    ) -> None:
        self.close()

    def claim(self, job_types: list[JobType] | None = None) -> ClaimedJob | None:
        """Lease the oldest queued job. Not retried: a claim is not idempotent (each one costs the
        job an attempt), and the poll loop asks again shortly anyway."""
        body = JobClaimRequest(job_types=job_types).model_dump(mode="json", exclude_none=True)
        res = self._post("/api/jobs/claim", body, None, attempts=1)
        return JobClaimResponse.model_validate_json(res.content).job

    def complete(self, req: JobCompleteRequest) -> JobCompleteResponse:
        """Finish the current attempt. The idempotency key is per attempt, so a retry after a lost
        response replays the stored result instead of applying it twice."""
        key = f"complete:{req.job_id}:{req.attempt}"
        res = self._post("/api/jobs/complete", req.model_dump(mode="json", exclude_none=True), key)
        return JobCompleteResponse.model_validate_json(res.content)

    def telemetry(self, events: list[TelemetryEvent]) -> int:
        body = TelemetryRequest(events=events).model_dump(mode="json", exclude_none=True)
        res = self._post("/api/telemetry", body, f"telemetry:{uuid.uuid4()}")
        return TelemetryResponse.model_validate_json(res.content).accepted

    def _post(
        self, path: str, body: object, idempotency_key: str | None, attempts: int = HTTP_ATTEMPTS
    ) -> httpx.Response:
        headers = {"idempotency-key": idempotency_key} if idempotency_key else {}
        res = request_with_retries(
            self._http,
            "POST",
            path,
            json=body,
            headers=headers,
            sleep=self._sleep,
            attempts=attempts,
        )
        if res.status_code == 409:
            raise LeaseLost(res.status_code, res.text)
        if res.status_code >= 400:
            raise ApiError(res.status_code, res.text)
        return res
