"""API client: route table vs. the generated OpenAPI, idempotency, retries, errors."""

from __future__ import annotations

import json

import httpx
import pytest
from conftest import REPO, FakeApi

from pandabase_tools import contracts as c
from pandabase_tools.api import ROUTES, ApiError, match_route


def _ref(schema: dict[str, object] | None) -> str | None:
    ref = (schema or {}).get("$ref")
    return str(ref).rsplit("/", 1)[-1] if ref else None


def test_route_table_matches_every_agent_route_in_openapi() -> None:
    doc = json.loads((REPO / "contracts" / "openapi.json").read_text())
    expected: dict[str, tuple[str | None, str | None, list[str]]] = {}
    for path, ops in doc["paths"].items():
        for method, op in ops.items():
            if "agent" not in op.get("x-scopes", []):
                continue
            body = op.get("requestBody", {}).get("content", {}).get("application/json", {})
            resp = op["responses"]["200"]["content"]["application/json"]["schema"]
            query = sorted(p["name"] for p in op.get("parameters", []) if p["in"] == "query")
            expected[f"{method.upper()} {path}"] = (_ref(body.get("schema")), _ref(resp), query)
    assert set(ROUTES) == set(expected)
    for key, route in ROUTES.items():
        body, resp, query = expected[key]
        assert (route.body.__name__ if route.body else None) == body, key
        assert route.response.__name__ == resp, key
        fields = sorted(route.query.model_fields) if route.query else []
        assert fields == query, key
        has_actor = bool(route.body and "actor_discord_id" in route.body.model_fields)
        assert has_actor == (route.actor != "none"), key


def test_match_route_with_id() -> None:
    route, ident = match_route("post", "/api/jobs/01ABC/notified")
    assert route.path == "/api/jobs/{id}/notified" and ident == "01ABC"
    with pytest.raises(KeyError):
        match_route("POST", "/api/jobs/claim")  # worker scope: not ours


def test_every_post_sends_an_idempotency_key_and_bearer() -> None:
    api = FakeApi({"POST /api/telemetry": lambda _: {"accepted": 1}})
    client = api.client()
    client.telemetry([c.TelemetryEvent(metric_type="x", payload={})])
    client.call(
        "POST",
        "/api/telemetry",
        body={"events": [{"metric_type": "y", "payload": {}}]},
        idempotency_key="k1",
    )
    keys = [r.headers.get("Idempotency-Key") for r in api.requests]
    assert keys[0] and keys[0].startswith("pbt-") and keys[1] == "k1"
    assert all(r.headers["Authorization"] == "Bearer token" for r in api.requests)


def test_retries_5xx_and_network_errors_with_the_same_key() -> None:
    attempts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request.headers["Idempotency-Key"])
        if len(attempts) == 1:
            raise httpx.ConnectError("down")
        if len(attempts) == 2:
            return httpx.Response(503, json={"error": "busy"})
        return httpx.Response(200, json={"accepted": 1})

    from pandabase_tools.api import ApiClient

    sleeps: list[float] = []
    client = ApiClient(
        "https://x.test", "t", transport=httpx.MockTransport(handler), sleep=sleeps.append
    )
    assert client.telemetry([c.TelemetryEvent(metric_type="x", payload={})]) == 1
    assert len(set(attempts)) == 1 and len(attempts) == 3 and sleeps == [1.0, 2.0]


def test_4xx_is_not_retried_and_surfaces_error() -> None:
    api = FakeApi(
        {
            "POST /api/inventory/events": lambda _: httpx.Response(
                403, json={"error": "unknown actor"}
            )
        }
    )
    with pytest.raises(ApiError) as err:
        api.client().call(
            "POST",
            "/api/inventory/events",
            body={"actor_discord_id": "9", "events": [{"item_id": "I1", "kind": "consumed"}]},
        )
    assert err.value.status == 403 and err.value.error == "unknown actor"
    assert len(api.requests) == 1


def test_request_is_validated_before_sending() -> None:
    api = FakeApi({})
    with pytest.raises(Exception, match="kind"):
        api.client().call(
            "POST",
            "/api/grocery/cycle/C1/overrides",
            body={"actor_discord_id": "1", "kind": "nope"},
        )
    assert api.requests == []


def test_missing_token_is_refused() -> None:
    from pandabase_tools.api import ApiClient

    with pytest.raises(ValueError, match="AGENT_API_TOKEN"):
        ApiClient("https://x.test", "")
