"""System test stack (docs/TESTING.md, tier A): every real component on one machine.

- State Engine: `next start` (a production build in `web/.next-system`) on a freshly migrated
  and seeded SQLite file, with real agent/worker/cron tokens and Auth.js (no dev bypass).
- Worker: `python -m pandabase_worker` against `FakeOllama` (M6's recorded responses) and a
  `FakeR2` that checks the State Engine's SigV4 presigned URLs.
- Agent: the `pandabase-tools` console script, run with the exact commands the skills name
  (`Skills.cmd`), plus `agent_shim.py` for `cart build` (synthetic Amazon behind the driver).
- Web UI: Playwright (Python) with an Auth.js session cookie minted from `AUTH_SECRET`.

Everything is relative to the seed's `now` (= the real clock at startup); the API has no clock
override.

**Remote mode** (tier A', `SYSTEM_REMOTE_URL` set; `make e2e-preview`): no `next start`. The
State Engine is a deployed preview: its database (reset and seeded by `make preview-reset`) is read
through `BridgeDb`, R2 is the real preview bucket (`RemoteR2`), tokens and `AUTH_SECRET` come from
the environment, and the worker and tools reach it through a local `HeaderProxy` that adds the
Vercel protection-bypass header. Only steps marked `preview` run; the objects the run stored in R2
are deleted at the end. `make e2e-system-remote-local` runs the same path against a local stack.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pytest
from fakes import FakeOllama, FakeR2, HeaderProxy
from remote import BridgeDb, RemoteR2

REPO = Path(__file__).resolve().parents[2]
WEB = REPO / "web"
WORKER = REPO / "worker"
SKILLS = REPO / "agent" / "skills"
HERE = Path(__file__).resolve().parent
DIST_DIR = ".next-system"
TZ = "America/Los_Angeles"
EMAILS = ("alex@example.com", "sam@example.com")
# Seeded members (db/src/seed-data.ts): Alex is the cart member.
ALEX = "100000000000000001"
SAM = "100000000000000002"
REMOTE_URL = os.environ.get("SYSTEM_REMOTE_URL", "").rstrip("/")
# What remote mode reads from the environment (the GitHub `preview` environment's secrets).
REMOTE_ENV = (
    "AGENT_API_TOKEN", "WORKER_API_TOKEN", "CRON_SECRET", "AUTH_SECRET", "TURSO_DATABASE_URL",
    "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
)  # fmt: skip
BYPASS_HEADER = "x-vercel-protection-bypass"


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "preview: part of tier A''s shortened week (remote mode)")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Remote mode runs only the shortened week; the rest is deselected, not skipped."""
    if not REMOTE_URL:
        return
    keep = [i for i in items if i.get_closest_marker("preview")]
    config.hook.pytest_deselected(items=[i for i in items if i not in keep])
    items[:] = keep


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
        return port


def wait_for[T](
    what: str, fn: Callable[[], T | None], timeout: float = 30, every: float = 0.2
) -> T:
    deadline = time.monotonic() + timeout
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            out = fn()
            if out:
                return out
        except Exception as err:  # retried until the deadline
            last = err
        time.sleep(every)
    raise AssertionError(f"timed out waiting for {what}" + (f": {last}" if last else ""))


# --- skills ---------------------------------------------------------------------------------


def skill_commands(name: str) -> list[str]:
    """Every `pandabase-tools …` command a SKILL.md names (same rule as M7's test_skills.py)."""
    body = (SKILLS / name / "SKILL.md").read_text().split("\n---\n", 1)[1]
    found = re.findall(r"`(pandabase-tools [^`]+)`", body)
    for block in re.findall(r"```sh\n(.*?)```", body, re.S):
        found += [
            ln.strip() for ln in block.splitlines() if ln.lstrip().startswith("pandabase-tools ")
        ]
    return list(dict.fromkeys(found))


def _slot(placeholder: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", placeholder.lower()).strip("_")


def skill_argv(
    skill: str,
    contains: str,
    *,
    json_body: Any = None,
    drop: tuple[str, ...] = (),
    flags: dict[str, str] | None = None,
    **slots: str,
) -> list[str]:
    """The one command in `skill` containing `contains`, placeholders filled from `slots`.

    `<sender id>` is filled by `sender_id=`, `<C>` by `c=`. `json_body` replaces the template's
    `--json` value (otherwise the template's own JSON must parse once filled), `flags` replaces
    other flags' values (e.g. `--outcomes`), and `drop` removes optional flags (with their value)
    the skill says to omit when empty. A skill that renames a
    route, flag or placeholder breaks the lookup — which is the point.
    """
    matches = [c for c in skill_commands(skill) if contains in c]
    assert len(matches) == 1, f"{skill}: {len(matches)} commands contain {contains!r}: {matches}"
    template = matches[0]
    values: list[str] = []

    def sub(m: re.Match[str]) -> str:
        key = _slot(m.group(1))
        values.append(slots.get(key, f"\0{key}"))  # unfilled: only allowed on a dropped flag
        return f"@@{len(values) - 1}@@"

    marked = re.sub(r"<([^>]+)>", sub, template)
    argv = [
        re.sub(r"@@(\d+)@@", lambda m: values[int(m.group(1))], a) for a in shlex.split(marked)
    ][1:]
    for flag in drop:
        i = argv.index(flag)
        del argv[i : i + 2]
    for flag, value in (flags or {}).items():
        argv[argv.index(flag) + 1] = value
    missing = [a[1:] for a in argv if "\0" in a]
    assert not missing, f"{skill}: fill {missing} in {template}"
    if "--json" in argv:
        i = argv.index("--json") + 1
        if json_body is None:
            json.loads(argv[i])  # the skill's own template must be valid JSON once filled
        else:
            argv[i] = json.dumps(json_body)
    else:
        assert json_body is None, f"{template} takes no --json"
    return argv


# --- stack ----------------------------------------------------------------------------------


class LocalDb:
    """The local stack's SQLite file, read-only."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def rows(self, sql: str, *params: Any) -> list[dict[str, Any]]:
        con = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, timeout=10)
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(sql, params).fetchall()]
        finally:
            con.close()

    def close(self) -> None:
        return None


@dataclass
class Stack:
    """`base_url` is what the API clients use; `web_url` is what the browser opens (the same
    locally; in remote mode the proxy and the preview, see the module docstring)."""

    base_url: str
    db: LocalDb | BridgeDb
    tmp: Path
    config_path: Path
    tokens: dict[str, str]
    auth_secret: str
    r2: FakeR2 | RemoteR2
    ollama: FakeOllama
    web_url: str = ""
    bypass: str = ""
    procs: dict[str, subprocess.Popen[bytes]] = field(default_factory=dict)
    logs: dict[str, Path] = field(default_factory=dict)
    amazon_log: Path = Path()
    seq: int = 0

    @property
    def remote(self) -> bool:
        return isinstance(self.r2, RemoteR2)

    # Agent CLI -------------------------------------------------------------------------------

    def _env(self) -> dict[str, str]:
        return {
            **os.environ,
            "PANDABASE_CONFIG": str(self.config_path),
            "AGENT_API_TOKEN": self.tokens["agent"],
            "FAKE_AMAZON_LOG": str(self.amazon_log),
        }

    def tools(self, argv: list[str], *, shim: bool = False, expect: int | None = 0) -> Any:
        """Run `pandabase-tools` (or the shim) → parsed JSON (or text); asserts the exit code."""
        exe = (
            [sys.executable, str(HERE / "agent_shim.py")]
            if shim
            else [str(Path(sys.executable).parent / "pandabase-tools")]
        )
        p = subprocess.run(
            [*exe, *argv], capture_output=True, text=True, env=self._env(), timeout=120
        )
        if expect is not None:
            assert p.returncode == expect, (
                f"pandabase-tools {shlex.join(argv)} → {p.returncode}\n{p.stdout}\n{p.stderr}"
            )
        out = p.stdout.strip()
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return out

    def skill(self, skill: str, contains: str, **kw: Any) -> Any:
        """Run a skill's command (see `skill_argv`); `shim=`/`expect=` go to `tools`."""
        run_kw = {k: kw.pop(k) for k in ("shim", "expect") if k in kw}
        return self.tools(skill_argv(skill, contains, **kw), **run_kw)

    def message_id(self) -> str:
        """A fresh synthetic Discord message id."""
        self.seq += 1
        return str(500000000000000000 + self.seq)

    # HTTP and DB -----------------------------------------------------------------------------

    def http(
        self, method: str, path: str, *, token: str | None = None, **kw: Any
    ) -> httpx.Response:
        headers = dict(kw.pop("headers", {}))
        if token is not None:
            headers["authorization"] = f"Bearer {token}"
        return httpx.request(method, self.base_url + path, headers=headers, timeout=60, **kw)

    def rows(self, sql: str, *params: Any) -> list[dict[str, Any]]:
        return self.db.rows(sql, *params)

    def one(self, sql: str, *params: Any) -> dict[str, Any]:
        rows = self.rows(sql, *params)
        assert len(rows) == 1, f"{len(rows)} rows for {sql} {params}"
        return rows[0]

    def telemetry(self, metric: str, since: str = "") -> list[dict[str, Any]]:
        rows = self.rows(
            "select source, payload, created_at from system_telemetry"
            " where metric_type = ? and created_at >= ? order by created_at",
            metric,
            since,
        )
        return [{**r, "payload": json.loads(r["payload"] or "null")} for r in rows]

    def today(self) -> str:
        return datetime.now(ZoneInfo(TZ)).date().isoformat()

    def session_cookie(self, email: str) -> dict[str, str]:
        """An Auth.js v5 session cookie (JWE) for `email`, as Google sign-in would set.

        Over https (a deployed preview) Auth.js uses `__Secure-` cookies, and the cookie name is
        also the JWE salt.
        """
        name = ("__Secure-" if self.web_url.startswith("https:") else "") + "authjs.session-token"
        script = (
            "import { encode } from 'next-auth/jwt';"
            "const [email, secret, salt] = process.argv.slice(1);"
            "process.stdout.write(await encode({ salt, secret,"
            " token: { email, name: email.split('@')[0], sub: email } }));"
        )
        p = subprocess.run(
            ["node", "--input-type=module", "-e", script, email, self.auth_secret, name],
            cwd=WEB,
            capture_output=True,
            text=True,
            check=True,
        )
        return {"name": name, "value": p.stdout, "url": self.web_url}

    def bypass_browser(self, ctx: Any) -> None:
        """Remote mode: send Vercel's bypass header (and ask for its cookie) on every request the
        browser makes to the preview — only there, never to R2."""
        if not self.bypass:
            return
        extra = {BYPASS_HEADER: self.bypass, "x-vercel-set-bypass-cookie": "true"}
        origin = self.web_url + "/"
        ctx.route(
            lambda url: url.startswith(origin),
            lambda route: route.continue_(headers={**route.request.headers, **extra}),
        )

    def log_tail(self, name: str, lines: int = 60) -> str:
        path = self.logs.get(name)
        if not path or not path.exists():
            return ""
        return "\n".join(path.read_text(errors="replace").splitlines()[-lines:])


def _run(cmd: list[str], cwd: Path, env: dict[str, str], log: Path) -> None:
    with log.open("a") as f:
        code = subprocess.run(cmd, cwd=cwd, env=env, stdout=f, stderr=subprocess.STDOUT).returncode
    if code != 0:
        tail = "\n".join(log.read_text(errors="replace").splitlines()[-40:])
        raise AssertionError(f"{shlex.join(cmd)} → exit {code}\n{tail}")


def _start(stack: Stack, name: str, cmd: list[str], cwd: Path, env: dict[str, str]) -> None:
    log = stack.tmp / f"{name}.log"
    stack.logs[name] = log
    # Its own process group, so stopping `pnpm exec next start` also stops next-server.
    stack.procs[name] = subprocess.Popen(
        cmd, cwd=cwd, env=env, stdout=log.open("w"), stderr=subprocess.STDOUT,
        start_new_session=True,
    )  # fmt: skip


def agent_config(base_url: str, web_url: str, tmp: Path) -> Path:
    cfg = json.loads((REPO / "agent" / "pandabase.config.example.json").read_text())
    cfg.update(
        api_base_url=base_url,
        web_url=web_url,
        household_tz=TZ,
        state_dir=str(tmp / "state"),
        diagnostics_dir=str(tmp / "diagnostics"),
    )
    cfg["cart"]["page_delay_seconds"] = 0
    cfg["members"] = [
        {"name": "alex", "discord_id": ALEX, "profile": "alex", "cart_member": True,
         "receipt_sweep": "daily"},
        {"name": "sam", "discord_id": SAM, "profile": "sam", "cart_member": False,
         "receipt_sweep": "weekly"},
    ]  # fmt: skip
    profiles = {
        "profiles": {
            m: {"cdp_url": f"http://127.0.0.1:{9 + n}", "user_data_dir": str(tmp / m),
                "openclaw_browser_profile": f"pandabase-{m}"}
            for n, m in enumerate(("alex", "sam"))
        }
    }  # fmt: skip
    config_path = tmp / "pandabase.config.json"
    (tmp / "profiles.json").write_text(json.dumps(profiles))
    config_path.write_text(json.dumps(cfg))
    return config_path


def web_env(
    base_url: str, db_path: Path, tokens: dict[str, str], auth_secret: str, r2: FakeR2
) -> dict[str, str]:
    """The local State Engine's environment (also `remote_local.py`'s)."""
    return {
        **os.environ,
        "NODE_ENV": "production",
        "NEXT_DIST_DIR": DIST_DIR,
        "NEXT_TELEMETRY_DISABLED": "1",
        "TURSO_DATABASE_URL": f"file:{db_path}",
        "AGENT_API_TOKEN": tokens["agent"],
        "WORKER_API_TOKEN": tokens["worker"],
        "CRON_SECRET": tokens["cron"],
        "AUTH_SECRET": auth_secret,
        "AUTH_TRUST_HOST": "true",
        "AUTH_URL": base_url,
        "ALLOWED_EMAILS": ",".join(EMAILS),
        # Must be ignored outside NODE_ENV=development (asserted in the test).
        "DEV_AUTH_BYPASS": "1",
        "R2_ACCOUNT_ID": "system",
        "R2_ACCESS_KEY_ID": r2.access_key,
        "R2_SECRET_ACCESS_KEY": r2.secret,
        "R2_BUCKET": r2.bucket,
        "R2_ENDPOINT": r2.url,
        "HOUSEHOLD_TZ": TZ,
    }


def build_web(env: dict[str, str], log: Path) -> None:
    if os.environ.get("SYSTEM_BUILD", "1") != "0" or not (WEB / DIST_DIR / "BUILD_ID").exists():
        _run(["pnpm", "exec", "next", "build"], WEB, env, log)


def start_worker(s: Stack) -> None:
    worker_env = {
        **os.environ,
        "PANDABASE_API_URL": s.base_url,
        "WORKER_API_TOKEN": s.tokens["worker"],
        "OLLAMA_URL": s.ollama.url,
        "POLL_INTERVAL_SECONDS": "0.3",
        "HOUSEHOLD_TZ": TZ,
        "PANDABASE_BUILD_SHA": "systemtest",
    }
    worker_python = WORKER / ".venv" / "bin" / "python"
    _start(s, "worker", [str(worker_python), "-m", "pandabase_worker"], WORKER, worker_env)


def remote_stack(tmp: Path) -> tuple[Stack, HeaderProxy]:
    """Tier A': a deployed State Engine (see the module docstring)."""
    missing = [k for k in REMOTE_ENV if not os.environ.get(k)]
    if missing:
        raise pytest.UsageError(f"remote mode needs {', '.join(missing)}")
    env = os.environ
    bypass = env.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")
    proxy = HeaderProxy(REMOTE_URL, {BYPASS_HEADER: bypass} if bypass else {}).start()
    tokens = {"agent": env["AGENT_API_TOKEN"], "worker": env["WORKER_API_TOKEN"],
              "cron": env["CRON_SECRET"]}  # fmt: skip
    db = BridgeDb(env["TURSO_DATABASE_URL"], env.get("TURSO_AUTH_TOKEN", ""))
    config = agent_config(proxy.url, REMOTE_URL, tmp)
    s = Stack(proxy.url, db, tmp, config, tokens, env["AUTH_SECRET"], RemoteR2.from_env(),
              FakeOllama().start(), web_url=REMOTE_URL, bypass=bypass)  # fmt: skip
    return s, proxy


def cleanup_r2(s: Stack, since: str) -> list[str]:
    """Delete what this run stored in the (shared, synthetic) preview bucket: the photos it
    uploaded and the worker's keyframes, as recorded on the jobs created since `since`."""
    keys: list[str] = []
    for job in s.rows(
        "select media_r2_key, keyframe_r2_keys from audit_job where created_at >= ?", since
    ):
        keys += [job["media_r2_key"] or "", *json.loads(job["keyframe_r2_keys"] or "[]")]
    keys = [k for k in dict.fromkeys(keys) if k.startswith(("media/", "keyframes/"))]
    assert isinstance(s.r2, RemoteR2)
    for key in keys:
        s.r2.delete(key)
    left = [k for k in keys if s.r2.content_type(k) is not None]
    assert not left, f"R2 objects not deleted: {left}"
    print(f"--- deleted {len(keys)} R2 object(s) this run created ---")
    return keys


@pytest.fixture(scope="session")
def stack(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Stack]:
    tmp = tmp_path_factory.mktemp("system")
    if REMOTE_URL:
        yield from _remote(tmp)
    else:
        yield from _local(tmp)


def _remote(tmp: Path) -> Iterator[Stack]:
    s, proxy = remote_stack(tmp)
    s.amazon_log = tmp / "amazon.jsonl"
    s.ollama.receipt_date = s.today()
    started = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    try:
        wait_for("the preview", lambda: s.http("GET", "/sign-in").status_code == 200, timeout=60)
        start_worker(s)
        yield s
    finally:
        try:
            cleanup_r2(s, started)
        finally:
            _stop(s)
            s.db.close()
            proxy.stop()
            if isinstance(s.r2, RemoteR2):
                s.r2.close()


def _stop(s: Stack) -> None:
    for name, proc in s.procs.items():
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
        print(f"--- {name} log (tail) ---\n{s.log_tail(name)}")
    s.ollama.stop()
    keep = os.environ.get("SYSTEM_KEEP")
    if keep:
        shutil.copytree(s.tmp, keep, dirs_exist_ok=True)


def _local(tmp: Path) -> Iterator[Stack]:
    db_path = tmp / "system.db"
    tokens = {k: secrets.token_hex(16) for k in ("agent", "worker", "cron")}
    auth_secret = secrets.token_hex(32)
    r2 = FakeR2("pandabase-system", "SYSTEMTESTKEY", secrets.token_hex(16)).start()
    ollama = FakeOllama().start()
    port = int(os.environ.get("SYSTEM_PORT") or free_port())
    base_url = f"http://127.0.0.1:{port}"
    config_path = agent_config(base_url, base_url, tmp)
    s = Stack(base_url, LocalDb(db_path), tmp, config_path, tokens, auth_secret, r2, ollama,
              web_url=base_url)  # fmt: skip
    s.amazon_log = tmp / "amazon.jsonl"
    ollama.receipt_date = s.today()
    env = web_env(base_url, db_path, tokens, auth_secret, r2)
    try:
        setup = tmp / "setup.log"
        s.logs["setup"] = setup
        build_web(env, setup)
        _run(
            ["pnpm", "exec", "tsx", "e2e/seed-db.ts"],
            WEB,
            {**env, "E2E_DB": str(db_path)},
            setup,
        )
        _start(s, "web", ["pnpm", "exec", "next", "start", "-p", str(port), "-H", "127.0.0.1"],
               WEB, env)  # fmt: skip
        wait_for("next start", lambda: s.http("GET", "/sign-in").status_code == 200, timeout=60)
        start_worker(s)
        yield s
    finally:
        _stop(s)
        r2.stop()
