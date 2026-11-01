"""`make e2e-system-remote-local`: tier A''s remote code path against a local stack.

The sandbox and CI can't reach the real preview, so this runs exactly what the preview workflow
runs — `make preview-reset` (the guarded reset + seed), then `make e2e-preview` (remote mode) —
against a local `next start` behind a `BypassGate` that, like Vercel's Deployment Protection,
refuses anything without the bypass header. R2 is `FakeR2`, reached through `RemoteR2` (the
endpoint override); the database is a `file:` URL, read through the same `BridgeDb`. Afterwards it
checks the run cleaned up every object it stored and that the gate refused nothing.
"""

from __future__ import annotations

import os
import secrets
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

from conftest import (
    REPO,
    WEB,
    LocalDb,
    Stack,
    _run,
    _start,
    _stop,
    build_web,
    free_port,
    wait_for,
    web_env,
)
from fakes import BypassGate, FakeOllama, FakeR2


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="remote-local-"))
    db_path = tmp / "preview.db"
    tokens = {k: secrets.token_hex(16) for k in ("agent", "worker", "cron")}
    auth_secret, bypass = secrets.token_hex(32), secrets.token_hex(16)
    r2 = FakeR2("pandabase-media-preview", "PREVIEWKEY", secrets.token_hex(16)).start()
    port = free_port()
    gate = BypassGate(f"http://127.0.0.1:{port}", bypass).start()
    env = web_env(gate.url, db_path, tokens, auth_secret, r2)
    # Only for `_start`/`_stop`/logs; the State Engine here stands in for the deployed preview.
    s = Stack(gate.url, LocalDb(db_path), tmp, tmp / "unused.json", tokens, auth_secret, r2,
              FakeOllama())  # fmt: skip
    remote_env = {
        **os.environ,
        "SYSTEM_REMOTE_URL": gate.url,
        "VERCEL_AUTOMATION_BYPASS_SECRET": bypass,
        "AGENT_API_TOKEN": tokens["agent"],
        "WORKER_API_TOKEN": tokens["worker"],
        "CRON_SECRET": tokens["cron"],
        "AUTH_SECRET": auth_secret,
        "TURSO_DATABASE_URL": f"file:{db_path}",
        "TURSO_AUTH_TOKEN": "",
        "R2_ACCOUNT_ID": "system",
        "R2_ACCESS_KEY_ID": r2.access_key,
        "R2_SECRET_ACCESS_KEY": r2.secret,
        "R2_BUCKET": r2.bucket,
        "R2_ENDPOINT": r2.url,
    }
    remote_env.pop("SYSTEM_KEEP", None)
    try:
        setup = tmp / "setup.log"
        s.logs["setup"] = setup
        build_web(env, setup)
        _run(["make", "-s", "preview-reset"], REPO, remote_env, setup)
        # WAL, so the test's reads (BridgeDb) never make the app's writes fail with SQLITE_BUSY —
        # a local-file artifact: Turso serializes for us.
        with sqlite3.connect(db_path) as con:
            con.execute("PRAGMA journal_mode=WAL")
        _start(s, "web", ["pnpm", "exec", "next", "start", "-p", str(port), "-H", "127.0.0.1"],
               WEB, env)  # fmt: skip
        wait_for("next start", lambda: s.http("GET", "/sign-in", headers={
            "x-vercel-protection-bypass": bypass}).status_code == 200, timeout=60)  # fmt: skip
        gate.refused.clear()
        code = subprocess.run(["make", "-s", "e2e-preview"], cwd=REPO, env=remote_env).returncode
        if code != 0:
            return code
        left = [k for k in r2.objects if k.startswith(("media/", "keyframes/"))]
        deleted = {r.key for r in r2.requests if r.method == "DELETE" and r.status == 204}
        assert not left, f"the run left R2 objects behind: {left}"
        assert deleted, "the run deleted nothing from R2"
        assert not gate.refused, (
            f"requests reached the 'preview' without the bypass: {gate.refused}"
        )
        print(f"remote mode OK: {gate.requests} requests through the gate, {len(deleted)} R2 "
              "object(s) cleaned up")  # fmt: skip
        return 0
    finally:
        _stop(s)
        gate.stop()
        r2.stop()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
