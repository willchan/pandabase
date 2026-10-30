"""web_smoke.py with HTTP stubbed: which checks pass, retry, skip, and that it never writes."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import web_smoke as ws

AGENT, WORKER = "agent-token", "worker-token"
CUR = "/api/grocery/cycle/current"


class FakeProd:
    """Answers like a healthy production; `overrides[(method, path, token)]` changes one answer."""

    def __init__(self, heartbeat: Any = None) -> None:
        self.calls: list[tuple[str, str, dict[str, str], bytes | None]] = []
        self.overrides: dict[tuple[str, str, str | None], list[int]] = {}
        self.heartbeat = heartbeat

    def __call__(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None
    ) -> tuple[int, bytes]:
        self.calls.append((method, url, headers, body))
        path = url.removeprefix("https://prod.example")
        auth = headers.get("authorization", "")
        token = auth.removeprefix("Bearer ") if auth else None
        queued = self.overrides.get((method, path, token))
        if queued:
            return queued.pop(0), b"{}"
        if path == "/sign-in":
            return 200, b"<html>"
        if token is None:
            return 401, b'{"error": "unauthorized"}'
        if path == CUR:
            return (200, b'{"cycle": null}') if token == AGENT else (403, b"{}")
        if path == "/api/health/worker" and token == AGENT:
            return 200, json.dumps({"heartbeat": self.heartbeat}).encode()
        return 404, b"{}"


def migrations(tmp_path: Path, name: str = "m.json", **kw: Any) -> Path:
    p = tmp_path / name
    st = {"ok": True, "expected": 2, "applied": 2, "pending": [], "changed": [], "unknown": []}
    p.write_text("$ pnpm …\n" + json.dumps({**st, **kw}))
    return p


def run(prod: FakeProd, tmp_path: Path, **kw: Any) -> dict[str, ws.Result]:
    client = ws.Client("https://prod.example", fetch=prod)
    args: dict[str, Any] = {"agent": AGENT, "worker": WORKER, "migrations": migrations(tmp_path)}
    args.update(kw)
    results = ws.run(client, delay=0, sleep=lambda _: None, **args)
    return {r.name: r for r in results}


def test_healthy_production_passes_and_a_missing_heartbeat_is_only_reported(
    tmp_path: Path,
) -> None:
    res = run(FakeProd(), tmp_path)
    assert {n for n, r in res.items() if r.outcome != "pass"} == {"worker heartbeat"}
    assert res["worker heartbeat"].outcome == "report"
    beat = {"at": "2026-10-30T00:00:00Z", "sha": "abcdef1234"}
    assert run(FakeProd(beat), tmp_path)["worker heartbeat"].outcome == "pass"


def test_only_gets_plus_one_unauthenticated_post(tmp_path: Path) -> None:
    prod = FakeProd()
    run(prod, tmp_path)
    posts = [c for c in prod.calls if c[0] != "GET"]
    assert [(m, u) for m, u, *_ in posts] == [("POST", "https://prod.example/api/telemetry")]
    assert "authorization" not in posts[0][2]


@pytest.mark.parametrize(
    ("method", "path", "token"),
    [
        ("POST", "/api/telemetry", AGENT),  # a credentialed POST could write
        ("POST", "/api/grocery/cycle/open", None),
        ("PUT", CUR, None),
        ("DELETE", CUR, AGENT),
    ],
)
def test_the_client_refuses_anything_that_could_write(
    method: str, path: str, token: str | None
) -> None:
    prod = FakeProd()
    with pytest.raises(ws.NotReadOnly):
        ws.Client("https://prod.example", fetch=prod).request(method, path, token)
    assert prod.calls == []


def test_each_wrong_answer_fails_its_check(tmp_path: Path) -> None:
    prod = FakeProd()
    keep = [200] * 10
    prod.overrides = {
        ("GET", CUR, None): list(keep),  # auth gate open
        ("GET", CUR, WORKER): list(keep),  # scopes not enforced
        ("GET", "/api/cron/maintenance", None): list(keep),
        ("POST", "/api/telemetry", None): [202] * 10,
    }
    res = run(prod, tmp_path, migrations=migrations(tmp_path, "bad.json", ok=False, pending=[3]))
    failed = {n for n, r in res.items() if r.outcome == "fail"}
    assert failed == {
        "API without a token",
        "worker token on an agent route",
        "cron without its secret",
        "unauthenticated POST refused",
        "migrations match db/migrations",
    }
    assert '"pending": [3]' in res["migrations match db/migrations"].detail


def test_retries_while_the_deployment_propagates(tmp_path: Path) -> None:
    prod = FakeProd()
    prod.overrides = {("GET", "/sign-in", None): [404, 502]}
    slept: list[float] = []
    client = ws.Client("https://prod.example", fetch=prod)
    results = ws.run(client, AGENT, WORKER, migrations(tmp_path), attempts=3, delay=5,
                     sleep=slept.append)  # fmt: skip
    assert results[0].outcome == "pass" and slept == [5, 5]


def test_network_errors_are_retried_then_fail(tmp_path: Path) -> None:
    def down(*_: Any) -> tuple[int, bytes]:
        raise OSError("connection refused")

    results = ws.run(ws.Client("https://prod.example", fetch=down), AGENT, WORKER,
                     migrations(tmp_path), attempts=2, delay=0, sleep=lambda _: None)  # fmt: skip
    assert {r.outcome for r in results if r.name != "migrations match db/migrations"} == {"fail"}
    assert "connection refused" in results[0].detail


def test_missing_tokens_skip_their_checks_instead_of_failing(tmp_path: Path) -> None:
    res = run(FakeProd(), tmp_path, agent="", worker="")
    skipped = {n for n, r in res.items() if r.outcome == "skip"}
    assert skipped == {"agent token", "worker heartbeat", "worker token on an agent route"}
    assert not [r for r in res.values() if r.outcome == "fail"]


def test_missing_migration_status_fails(tmp_path: Path) -> None:
    res = run(FakeProd(), tmp_path, migrations=tmp_path / "absent.json")
    assert res["migrations match db/migrations"].outcome == "fail"


def test_main_writes_summary_and_failed_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    prod = FakeProd()
    prod.overrides = {("GET", "/api/cron/maintenance", None): [200] * 10}
    out, summ = tmp_path / "out", tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summ))
    monkeypatch.setenv("AGENT_API_TOKEN", AGENT)
    monkeypatch.setenv("WORKER_API_TOKEN", WORKER)
    monkeypatch.setenv("SMOKE_ATTEMPTS", "1")
    real = ws.Client
    monkeypatch.setattr(ws, "Client", lambda base, bypass="": real(base, prod, bypass))
    code = ws.main(
        ["--base-url", "https://prod.example", "--migrations", str(migrations(tmp_path))]
    )
    assert code == 1
    assert out.read_text() == "failed=cron without its secret\n"
    assert "❌ | cron without its secret" in summ.read_text()
    printed = capsys.readouterr().out
    assert AGENT not in printed and WORKER not in printed
