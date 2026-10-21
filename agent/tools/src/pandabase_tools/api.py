"""State Engine API client (DESIGN §3): bearer auth, contract validation, idempotency, retries.

The generated `contracts` models are the only wire types: request bodies are validated before
they're sent and responses are parsed into the route's response model. Every POST carries an
`Idempotency-Key`; a retry after a network error or 5xx reuses the same key, so the server
replays instead of applying twice. `ROUTES` mirrors `web/lib/contracts/routes.ts` for the agent
scope (a test checks it against `contracts/openapi.json`).
"""

from __future__ import annotations

import re
import secrets
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ValidationError

from . import contracts as c

Method = Literal["GET", "POST"]


@dataclass(frozen=True)
class Route:
    method: Method
    path: str
    response: type[BaseModel]
    body: type[BaseModel] | None = None
    query: type[BaseModel] | None = None
    # Body carries `actor_discord_id`; the CLI's `--actor` fills it in.
    actor: Literal["required", "optional", "none"] = "none"


ROUTES: dict[str, Route] = {
    r.method + " " + r.path: r
    for r in (
        Route("GET", "/api/grocery/cycle/current", c.CycleCurrentResponse),
        Route("POST", "/api/grocery/cycle/open", c.CycleOpenResponse, c.CycleOpenRequest),
        Route(
            "POST",
            "/api/grocery/cycle/{id}/overrides",
            c.CycleOverrideResponse,
            c.CycleOverrideRequest,
            actor="required",
        ),
        Route(
            "POST",
            "/api/grocery/cycle/{id}/status",
            c.CycleStatusResponse,
            c.CycleStatusRequest,
            actor="optional",
        ),
        Route("GET", "/api/grocery/checkin", c.CheckinResponse),
        Route("GET", "/api/predictions", c.PredictionsResponse, query=c.PredictionsQuery),
        Route("POST", "/api/grocery/price-quotes", c.PriceQuotesResponse, c.PriceQuotesRequest),
        Route("GET", "/api/grocery/cycle/{id}/cart", c.CartResponse),
        Route(
            "POST", "/api/grocery/cycle/{id}/cart-result", c.CartResultResponse, c.CartResultRequest
        ),
        Route("GET", "/api/items/lookup", c.LookupResponse, query=c.LookupQuery),
        Route(
            "POST",
            "/api/inventory/events",
            c.InventoryEventsResponse,
            c.InventoryEventsRequest,
            actor="required",
        ),
        Route("GET", "/api/freezer/aging", c.FreezerAgingResponse, query=c.FreezerAgingQuery),
        Route(
            "POST", "/api/away-periods", c.AwayPeriodResponse, c.AwayPeriodRequest, actor="required"
        ),
        Route(
            "POST",
            "/api/products/{id}/reject",
            c.ProductRejectResponse,
            c.ProductRejectRequest,
            actor="required",
        ),
        Route("GET", "/api/receipts/cursor", c.ReceiptCursorResponse, query=c.ReceiptCursorQuery),
        Route(
            "POST",
            "/api/receipts/ingest",
            c.ReceiptIngestResponse,
            c.ReceiptIngestRequest,
            actor="required",
        ),
        Route(
            "POST",
            "/api/catalog/merge-suggestions/run",
            c.MergeSuggestRunResponse,
            c.MergeSuggestRunRequest,
            actor="optional",
        ),
        Route("POST", "/api/media/upload-url", c.UploadUrlResponse, c.UploadUrlRequest),
        Route("POST", "/api/jobs", c.JobResponse, c.JobCreateRequest, actor="required"),
        Route("GET", "/api/jobs/notifications", c.JobNotificationsResponse),
        Route("POST", "/api/jobs/{id}/notified", c.JobResponse, c.EmptyRequest),
        Route("POST", "/api/telemetry", c.TelemetryResponse, c.TelemetryRequest),
        Route("GET", "/api/diagnostics/weekly", c.DiagnosticsResponse, query=c.DiagnosticsQuery),
    )
}


def match_route(method: str, path: str) -> tuple[Route, str]:
    """Resolve a concrete path (`/api/jobs/01ABC/notified`) to its route and the `{id}` value."""
    for route in ROUTES.values():
        if route.method != method.upper():
            continue
        pattern = "^" + re.escape(route.path).replace(r"\{id\}", r"([^/]+)") + "$"
        m = re.match(pattern, path)
        if m:
            return route, (m.group(1) if m.groups() else "")
    raise KeyError(f"no agent route {method.upper()} {path}")


class ApiError(Exception):
    def __init__(self, status: int, error: str, details: Any = None) -> None:
        super().__init__(f"HTTP {status}: {error}")
        self.status = status
        self.error = error
        self.details = details

    def as_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"error": self.error, "status": self.status}
        if self.details is not None:
            out["details"] = self.details
        return out


def new_idempotency_key() -> str:
    return "pbt-" + secrets.token_hex(12)


def dump(model: BaseModel) -> dict[str, Any]:
    """Wire JSON: fields that were set (explicit nulls kept, unset optionals dropped)."""
    return model.model_dump(mode="json", exclude_unset=True)


RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})


class ApiClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        transport: httpx.BaseTransport | None = None,
        retries: int = 3,
        sleep: Callable[[float], None] = time.sleep,
        timeout: float = 30.0,
    ) -> None:
        if not token:
            raise ValueError("AGENT_API_TOKEN is not set")
        self.http = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}", "User-Agent": "pandabase-tools"},
            transport=transport,
            timeout=timeout,
        )
        self.retries = retries
        self.sleep = sleep

    def close(self) -> None:
        self.http.close()

    def call(
        self,
        method: str,
        path: str,
        *,
        body: BaseModel | Mapping[str, Any] | None = None,
        query: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> BaseModel:
        """Validate, send (with retries), and parse the response into the route's model."""
        route, _ = match_route(method, path)
        payload: dict[str, Any] | None = None
        if route.body is not None:
            model = body if isinstance(body, BaseModel) else route.body.model_validate(body or {})
            payload = dump(model)
        params: dict[str, str] | None = None
        if route.query is not None and query:
            q = route.query.model_validate(dict(query))
            params = {k: str(v) for k, v in dump(q).items()}
        headers: dict[str, str] = {}
        if route.method == "POST":
            headers["Idempotency-Key"] = idempotency_key or new_idempotency_key()
        data = self._send(route.method, path, payload, params, headers)
        return route.response.model_validate(data)

    def _send(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        params: dict[str, str] | None,
        headers: dict[str, str],
    ) -> Any:
        delay = 1.0
        for attempt in range(self.retries + 1):
            last = attempt == self.retries
            try:
                res = self.http.request(method, path, json=payload, params=params, headers=headers)
            except httpx.TransportError as err:
                if last:
                    raise ApiError(0, f"network error: {err}") from err
            else:
                if res.status_code in RETRY_STATUSES and not last:
                    pass
                elif res.status_code >= 400:
                    try:
                        err_body = res.json()
                    except ValueError:
                        err_body = {"error": res.text[:200]}
                    raise ApiError(
                        res.status_code, str(err_body.get("error")), err_body.get("details")
                    )
                else:
                    return res.json()
            self.sleep(delay)
            delay *= 2
        raise AssertionError("unreachable")

    # Typed helpers used by the composite commands ------------------------------------------------

    def cycle_status(
        self, cycle_id: str, status: str, *, reason: str | None = None, key: str | None = None
    ) -> c.CycleStatusResponse:
        body: dict[str, Any] = {"status": status}
        if reason:
            body["reason"] = reason
        res = self.call(
            "POST", f"/api/grocery/cycle/{cycle_id}/status", body=body, idempotency_key=key
        )
        assert isinstance(res, c.CycleStatusResponse)
        return res

    def predictions(self, cycle_id: str) -> c.PredictionsResponse:
        res = self.call("GET", "/api/predictions", query={"cycle_id": cycle_id})
        assert isinstance(res, c.PredictionsResponse)
        return res

    def price_quotes(self, body: c.PriceQuotesRequest, key: str | None = None) -> int:
        res = self.call("POST", "/api/grocery/price-quotes", body=body, idempotency_key=key)
        assert isinstance(res, c.PriceQuotesResponse)
        return res.accepted

    def cart(self, cycle_id: str) -> c.CartResponse:
        res = self.call("GET", f"/api/grocery/cycle/{cycle_id}/cart")
        assert isinstance(res, c.CartResponse)
        return res

    def cart_result(
        self, cycle_id: str, body: c.CartResultRequest, key: str | None = None
    ) -> c.CartResultResponse:
        res = self.call(
            "POST", f"/api/grocery/cycle/{cycle_id}/cart-result", body=body, idempotency_key=key
        )
        assert isinstance(res, c.CartResultResponse)
        return res

    def receipt_cursor(self, account: str) -> c.ReceiptCursorResponse:
        res = self.call("GET", "/api/receipts/cursor", query={"account": account})
        assert isinstance(res, c.ReceiptCursorResponse)
        return res

    def ingest_receipt(
        self, body: c.ReceiptIngestRequest, key: str | None = None
    ) -> c.ReceiptIngestResponse:
        res = self.call("POST", "/api/receipts/ingest", body=body, idempotency_key=key)
        assert isinstance(res, c.ReceiptIngestResponse)
        return res

    def upload_url(self, content_type: str, ext: str) -> c.UploadUrlResponse:
        res = self.call(
            "POST", "/api/media/upload-url", body={"content_type": content_type, "ext": ext}
        )
        assert isinstance(res, c.UploadUrlResponse)
        return res

    def put_media(self, upload: c.UploadUrlResponse, data: bytes) -> None:
        """PUT bytes to the presigned R2 URL (not the API; no bearer token)."""
        res = httpx.put(str(upload.url), content=data, headers=upload.headers, timeout=120)
        if res.status_code >= 300:
            raise ApiError(res.status_code, f"media upload failed: {res.text[:200]}")

    def create_job(self, body: c.JobCreateRequest, key: str | None = None) -> c.JobResponse:
        res = self.call("POST", "/api/jobs", body=body, idempotency_key=key)
        assert isinstance(res, c.JobResponse)
        return res

    def telemetry(self, events: list[c.TelemetryEvent]) -> int:
        res = self.call("POST", "/api/telemetry", body=c.TelemetryRequest(events=events))
        assert isinstance(res, c.TelemetryResponse)
        return res.accepted

    def diagnostics(self, week: str | None) -> c.DiagnosticsResponse:
        res = self.call("GET", "/api/diagnostics/weekly", query={"week": week} if week else None)
        assert isinstance(res, c.DiagnosticsResponse)
        return res


def validation_details(err: ValidationError) -> list[dict[str, Any]]:
    return [{"loc": list(e["loc"]), "msg": e["msg"]} for e in err.errors()]
