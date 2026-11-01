#!/usr/bin/env python3
"""Read-only production smoke after `vercel deploy --prod` (deploy.yml `smoke`, DESIGN §8).

    web_smoke.py --base-url https://… [--migrations status.json]

Tokens come from the environment: AGENT_API_TOKEN, WORKER_API_TOKEN, VERCEL_PROTECTION_BYPASS
(optional; production is normally unprotected). A check whose token isn't configured is reported
as skipped, not failed. `--migrations` is the JSON `pnpm db:migrations-status` printed.

Strictly read-only, enforced by `Client.request`: GET only, plus one POST that carries no
credentials and must be refused (401). Each check is retried (SMOKE_ATTEMPTS times, SMOKE_DELAY
seconds) while a fresh deployment propagates. Writes a Markdown table to $GITHUB_STEP_SUMMARY and
`failed=<names>` to $GITHUB_OUTPUT; exits 1 when any check failed. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Unauthenticated POSTs the smoke may send; each must be refused before the handler runs.
REFUSED_POSTS = frozenset({"/api/telemetry"})

Fetch = Callable[[str, str, dict[str, str], bytes | None], tuple[int, bytes]]


class NotReadOnly(Exception):
    """The smoke tried a request that could change production."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None  # a redirect is an answer (e.g. a route sent to /sign-in), not to be followed


def urllib_fetch(
    method: str, url: str, headers: dict[str, str], body: bytes | None
) -> tuple[int, bytes]:
    opener = urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with opener.open(req, timeout=20) as res:
            return int(res.status), res.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


@dataclass
class Client:
    base_url: str
    fetch: Fetch = urllib_fetch
    bypass: str = ""

    def request(self, method: str, path: str, token: str | None = None) -> tuple[int, bytes]:
        if method == "POST":
            if token is not None or path not in REFUSED_POSTS:
                raise NotReadOnly(f"POST {path} is not an allowed unauthenticated probe")
        elif method != "GET":
            raise NotReadOnly(f"{method} {path}: the smoke only sends GET")
        headers = {"accept": "application/json", "user-agent": "pandabase-web-smoke"}
        if token is not None:
            headers["authorization"] = f"Bearer {token}"
        if self.bypass:
            headers["x-vercel-protection-bypass"] = self.bypass
        body = None
        if method == "POST":
            headers["content-type"] = "application/json"
            body = b'{"events": []}'
        return self.fetch(method, self.base_url.rstrip("/") + path, headers, body)


@dataclass
class Result:
    name: str
    outcome: str  # pass | fail | skip | report
    detail: str


def _expect(client: Client, path: str, status: int, token: str | None = None) -> tuple[bool, str]:
    got, _ = client.request("GET", path, token)
    return got == status, f"GET {path} → {got} (want {status})"


def checks(
    client: Client, agent: str, worker: str, migrations: Path | None
) -> list[tuple[str, Callable[[], tuple[str, str]]]]:
    """(name, fn) pairs; fn → (outcome, detail). Outcomes other than `fail` are final."""

    def status_check(
        path: str, status: int, token: str | None = None
    ) -> Callable[[], tuple[str, str]]:
        def run() -> tuple[str, str]:
            ok, detail = _expect(client, path, status, token)
            return ("pass" if ok else "fail"), detail

        return run

    def needs(
        token: str, name: str, fn: Callable[[], tuple[str, str]]
    ) -> Callable[[], tuple[str, str]]:
        return fn if token else (lambda: ("skip", f"{name} not configured in `production`"))

    def refused_post() -> tuple[str, str]:
        got, _ = client.request("POST", "/api/telemetry")
        return (
            "pass" if got == 401 else "fail"
        ), f"POST /api/telemetry without a token → {got} (want 401)"

    def worker_health() -> tuple[str, str]:
        got, body = client.request("GET", "/api/health/worker", agent)
        if got != 200:
            return "fail", f"GET /api/health/worker → {got} (want 200)"
        try:
            beat = json.loads(body).get("heartbeat")
        except ValueError, AttributeError:
            return "fail", "GET /api/health/worker → 200 but not JSON"
        if not beat:
            return "report", "reachable; no worker heartbeat yet (expected until the Mac Mini runs)"
        return "pass", f"heartbeat at {beat.get('at')}, sha {str(beat.get('sha'))[:7]}"

    def migrations_match() -> tuple[str, str]:
        if migrations is None or not migrations.exists():
            return "fail", "no migration status (pnpm db:migrations-status didn't run)"
        try:
            st = json.loads(migrations.read_text().strip().splitlines()[-1])
        except ValueError, IndexError:
            return "fail", "migration status isn't JSON"
        detail = f"{st.get('applied')} applied / {st.get('expected')} in db/migrations"
        bad = {k: st.get(k) for k in ("pending", "changed", "unknown") if st.get(k)}
        if st.get("ok") is True:
            return "pass", detail
        return "fail", detail + (f"; {json.dumps(bad)}" if bad else "")

    cur = "/api/grocery/cycle/current"
    worker_on_agent = status_check(cur, 403, worker)
    return [
        ("sign-in page", status_check("/sign-in", 200)),
        ("API without a token", status_check(cur, 401)),
        ("health without a token", status_check("/api/health/worker", 401)),
        ("unauthenticated POST refused", refused_post),
        ("worker token on an agent route", needs(worker, "WORKER_API_TOKEN", worker_on_agent)),
        ("agent token", needs(agent, "AGENT_API_TOKEN", status_check(cur, 200, agent))),
        ("worker heartbeat", needs(agent, "AGENT_API_TOKEN", worker_health)),
        ("cron without its secret", status_check("/api/cron/maintenance", 401)),
        ("migrations match db/migrations", migrations_match),
    ]  # fmt: skip


def run(
    client: Client,
    agent: str = "",
    worker: str = "",
    migrations: Path | None = None,
    attempts: int = 6,
    delay: float = 10,
    sleep: Callable[[float], None] = time.sleep,
) -> list[Result]:
    results = []
    for name, fn in checks(client, agent, worker, migrations):
        outcome, detail = "fail", ""
        for attempt in range(attempts):
            try:
                outcome, detail = fn()
            except NotReadOnly:
                raise
            except Exception as err:  # network errors are retried like a wrong status
                outcome, detail = "fail", f"{type(err).__name__}: {err}"
            if outcome != "fail" or attempt == attempts - 1:
                break
            sleep(delay)
        results.append(Result(name, outcome, detail))
    return results


def summary(results: list[Result], base_url: str) -> str:
    icon = {"pass": "✅", "fail": "❌", "skip": "⏭️", "report": "📝"}
    rows = [f"| {icon[r.outcome]} | {r.name} | {r.detail} |" for r in results]
    return "\n".join(
        [f"### Production smoke: {base_url}", "", "| | Check | Result |", "|---|---|---|", *rows]
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--migrations", type=Path)
    args = ap.parse_args(argv)
    client = Client(args.base_url, bypass=os.environ.get("VERCEL_PROTECTION_BYPASS", ""))
    results = run(
        client,
        agent=os.environ.get("AGENT_API_TOKEN", ""),
        worker=os.environ.get("WORKER_API_TOKEN", ""),
        migrations=args.migrations,
        attempts=int(os.environ.get("SMOKE_ATTEMPTS", "6")),
        delay=float(os.environ.get("SMOKE_DELAY", "10")),
    )
    text = summary(results, args.base_url)
    print(text)
    failed = [r.name for r in results if r.outcome == "fail"]
    for r in results:
        if r.outcome == "skip":
            print(f"::notice title=smoke check skipped::{r.name}: {r.detail}")
        elif r.outcome == "report":
            print(f"::notice title=smoke::{r.name}: {r.detail}")
        elif r.outcome == "fail":
            print(f"::error title=smoke check failed::{r.name}: {r.detail}")
    if path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(path, "a") as f:
            f.write(text + "\n")
    if path := os.environ.get("GITHUB_OUTPUT"):
        with open(path, "a") as f:
            f.write(f"failed={', '.join(failed)}\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
