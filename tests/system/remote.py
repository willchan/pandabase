"""Tier A' remote mode (docs/TESTING.md): the real services the harness talks to directly.

- `RemoteR2`: an S3 client for the preview bucket, signing SigV4 *query* URLs like the State
  Engine's presigner (`web/lib/r2.ts`), so the same code also runs against `FakeR2` (which
  verifies them). Used to check what the run stored and to delete it afterwards.
- `BridgeDb`: SQL against the State Engine's database through `@libsql/client` in a long-lived
  Node process (`sql_bridge.mjs`), so `file:` (local self-test) and `libsql://` (Turso preview)
  take the same path. Reads only: the steps assert on rows, never write them.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

HERE = Path(__file__).resolve().parent
DB_PACKAGE = HERE.parents[1] / "db"


def _enc(s: str) -> str:
    return quote(s, safe="-_.~")


def presign(
    method: str,
    endpoint: str,
    bucket: str,
    key: str,
    access_key: str,
    secret: str,
    expires: int = 300,
    now: datetime | None = None,
) -> str:
    """A SigV4 query-signed URL (`UNSIGNED-PAYLOAD`, signed header `host`, region `auto`)."""
    when = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    day = when[:8]
    scope = f"{day}/auto/s3/aws4_request"
    base = endpoint.rstrip("/")
    host = httpx.URL(base).netloc.decode()
    path = f"/{bucket}/" + "/".join(_enc(p) for p in key.split("/"))
    params = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key}/{scope}",
        "X-Amz-Date": when,
        "X-Amz-Expires": str(expires),
        "X-Amz-SignedHeaders": "host",
    }
    query = "&".join(f"{_enc(k)}={_enc(v)}" for k, v in sorted(params.items()))
    canonical = "\n".join([method, path, query, f"host:{host}\n", "host", "UNSIGNED-PAYLOAD"])
    to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", when, scope, hashlib.sha256(canonical.encode()).hexdigest()]
    )
    k = hmac.new(("AWS4" + secret).encode(), day.encode(), hashlib.sha256).digest()
    for part in ("auto", "s3", "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    return f"{base}{path}?{query}&X-Amz-Signature={sig}"


class RemoteR2:
    """The bucket the State Engine presigns for, reached with the same `R2_*` values."""

    def __init__(
        self, account_id: str, access_key: str, secret: str, bucket: str, endpoint: str = ""
    ) -> None:
        self.url = (endpoint or f"https://{account_id}.r2.cloudflarestorage.com").rstrip("/")
        self.bucket = bucket
        self.access_key = access_key
        self.secret = secret
        self.http = httpx.Client(timeout=30)

    @classmethod
    def from_env(cls, env: dict[str, str] | os._Environ[str] = os.environ) -> RemoteR2:
        return cls(
            env["R2_ACCOUNT_ID"],
            env["R2_ACCESS_KEY_ID"],
            env["R2_SECRET_ACCESS_KEY"],
            env["R2_BUCKET"],
            env.get("R2_ENDPOINT", ""),
        )

    def _signed(self, method: str, key: str) -> str:
        return presign(method, self.url, self.bucket, key, self.access_key, self.secret)

    def content_type(self, key: str) -> str | None:
        """Like `FakeR2.content_type`: the object's content type, or None when it's absent."""
        res = self.http.head(self._signed("HEAD", key))
        if res.status_code == 404:
            return None
        res.raise_for_status()
        return str(res.headers.get("content-type", ""))

    def delete(self, key: str) -> None:
        res = self.http.delete(self._signed("DELETE", key))
        if res.status_code not in (200, 204, 404):
            res.raise_for_status()

    def close(self) -> None:
        self.http.close()


class BridgeDb:
    """`rows(sql, *params)` over `@libsql/client` (see module docstring)."""

    def __init__(self, url: str, auth_token: str = "") -> None:
        env = {**os.environ, "BRIDGE_DATABASE_URL": url, "BRIDGE_AUTH_TOKEN": auth_token}
        self.proc = subprocess.Popen(
            ["node", "--input-type=module", "-e", (HERE / "sql_bridge.mjs").read_text()],
            cwd=DB_PACKAGE,  # resolves @libsql/client from db/node_modules
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        self.lock = threading.Lock()

    def rows(self, sql: str, *params: Any) -> list[dict[str, Any]]:
        assert self.proc.stdin and self.proc.stdout
        with self.lock:
            self.proc.stdin.write(json.dumps({"sql": sql, "args": list(params)}) + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError(f"sql bridge exited ({self.proc.poll()})")
        out = json.loads(line)
        if "error" in out:
            raise RuntimeError(f"{out['error']} — {sql}")
        rows: list[dict[str, Any]] = out["rows"]
        return rows

    def close(self) -> None:
        if self.proc.stdin:
            self.proc.stdin.close()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
