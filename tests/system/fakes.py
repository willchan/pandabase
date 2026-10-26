"""In-process fakes for the system test (docs/TESTING.md, tier A): Ollama and R2.

Both are plain `ThreadingHTTPServer`s on 127.0.0.1 with a random port. They record every request
so the test can assert the seams (what the worker sent Ollama, what the agent PUT to R2), and
they are strict where the real service is: R2 verifies the SigV4 query signature and expiry the
State Engine presigned, Ollama answers only the `/api/chat` shape the worker uses.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Self
from urllib.parse import parse_qsl, quote, urlsplit

REPO = Path(__file__).resolve().parents[2]
OLLAMA_FIXTURES = REPO / "worker" / "tests" / "fixtures" / "ollama"


class _Server:
    """A background HTTP server whose handler dispatches to `self.handle`."""

    def __init__(self) -> None:
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def _dispatch(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length) if length else b""
                status, headers, payload = owner.handle(self.command, self.path, self.headers, body)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(payload)

            do_GET = do_PUT = do_POST = do_HEAD = do_DELETE = _dispatch

            def log_message(self, format: str, *args: Any) -> None:
                return None

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host!s}:{port}"

    def start(self) -> Self:
        self.thread.start()
        return self

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def handle(
        self, method: str, path: str, headers: Any, body: bytes
    ) -> tuple[int, dict[str, str], bytes]:
        raise NotImplementedError


def _json(status: int, data: Any) -> tuple[int, dict[str, str], bytes]:
    return status, {"content-type": "application/json"}, json.dumps(data).encode()


# --- R2 -------------------------------------------------------------------------------------


@dataclass
class R2Object:
    body: bytes
    content_type: str | None


@dataclass
class R2Request:
    method: str
    key: str
    status: int
    error: str | None = None


def _rfc3986(s: str) -> str:
    return quote(s, safe="-_.~")


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


class FakeR2(_Server):
    """S3-compatible stub for presigned GET/PUT (SigV4 query auth, `UNSIGNED-PAYLOAD`)."""

    def __init__(self, bucket: str, access_key: str, secret: str) -> None:
        super().__init__()
        self.bucket = bucket
        self.access_key = access_key
        self.secret = secret
        self.objects: dict[str, R2Object] = {}
        self.requests: list[R2Request] = []
        self.lock = threading.Lock()

    def handle(
        self, method: str, path: str, headers: Any, body: bytes
    ) -> tuple[int, dict[str, str], bytes]:
        parts = urlsplit(path)
        prefix = f"/{self.bucket}/"
        key = parts.path[len(prefix) :] if parts.path.startswith(prefix) else ""
        error = self.verify(method, parts.path, parts.query, headers.get("host", ""))
        if not key:
            error = error or "no such bucket"
        status: int
        out: tuple[int, dict[str, str], bytes]
        with self.lock:
            if error:
                out = (403, {"content-type": "application/xml"}, f"<Error>{error}</Error>".encode())
            elif method == "PUT":
                self.objects[key] = R2Object(body, headers.get("content-type"))
                out = (200, {"etag": hashlib.md5(body).hexdigest()}, b"")
            elif method in ("GET", "HEAD"):
                obj = self.objects.get(key)
                if obj is None:
                    error = "NoSuchKey"
                    out = (404, {"content-type": "application/xml"}, b"<Error>NoSuchKey</Error>")
                else:
                    ctype = obj.content_type or "application/octet-stream"
                    out = (200, {"content-type": ctype}, obj.body)
            else:
                error = "method not allowed"
                out = (405, {}, b"")
            status = out[0]
            self.requests.append(R2Request(method, key, status, error))
        return out

    def verify(self, method: str, path: str, query: str, host: str) -> str | None:
        """Check a SigV4 presigned URL the way S3/R2 does (signature, credential, expiry)."""
        params = parse_qsl(query, keep_blank_values=True)
        q = dict(params)
        if q.get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256":
            return "missing or unsupported X-Amz-Algorithm"
        try:
            access_key, day, region, service, term = q["X-Amz-Credential"].split("/")
            signed_at = datetime.strptime(q["X-Amz-Date"], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
            expires = int(q["X-Amz-Expires"])
            signature = q["X-Amz-Signature"]
            signed_headers = q["X-Amz-SignedHeaders"]
        except KeyError, ValueError:
            return "malformed presigned query"
        if access_key != self.access_key or term != "aws4_request" or service != "s3":
            return "InvalidAccessKeyId"
        if not 1 <= expires <= 7 * 86_400:
            return "X-Amz-Expires out of range"
        if datetime.now(UTC) > signed_at + timedelta(seconds=expires):
            return "Request has expired"
        if signed_headers != "host":
            return f"unexpected signed headers {signed_headers}"
        canonical_query = "&".join(
            f"{_rfc3986(k)}={_rfc3986(v)}" for k, v in sorted(params) if k != "X-Amz-Signature"
        )
        canonical = "\n".join(
            [method, path, canonical_query, f"host:{host}\n", "host", "UNSIGNED-PAYLOAD"]
        )
        scope = f"{day}/{region}/{service}/aws4_request"
        to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                q["X-Amz-Date"],
                scope,
                hashlib.sha256(canonical.encode()).hexdigest(),
            ]
        )
        k = _hmac(("AWS4" + self.secret).encode(), day)
        for part in (region, service, "aws4_request"):
            k = _hmac(k, part)
        expected = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return "SignatureDoesNotMatch"
        return None


# --- Ollama ---------------------------------------------------------------------------------


def _fixture(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((OLLAMA_FIXTURES / name).read_text())
    return data


@dataclass
class FakeOllama(_Server):
    """Ollama `/api/tags` + non-streaming `/api/chat`, answering from M6's recorded fixtures.

    The job type is read from the request's `format` schema (`lines` → paper receipt,
    `detections` → Trash Cam, `suggestions` → merge suggestions). The paper receipt's date is
    moved to `receipt_date`, and merge suggestions are computed from the job's item list (the
    fixture's ids are made up), pairing items whose names share a word.
    """

    receipt_date: str = ""
    chats: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        super().__init__()

    def handle(
        self, method: str, path: str, headers: Any, body: bytes
    ) -> tuple[int, dict[str, str], bytes]:
        if method == "GET" and path == "/api/tags":
            return _json(200, _fixture("tags.json"))
        if method != "POST" or path != "/api/chat":
            return _json(404, {"error": f"no route {method} {path}"})
        req = json.loads(body)
        self.chats.append(req)
        props = set((req.get("format") or {}).get("properties", {}))
        if "lines" in props:
            res = _fixture("paper_receipt.ok.json")
            content = json.loads(res["message"]["content"])
            content["date"] = self.receipt_date or content["date"]
            res["message"]["content"] = json.dumps(content)
        elif "detections" in props:
            res = _fixture("trash_cam.ok.json")
        elif "suggestions" in props:
            res = _fixture("merge_suggest.ok.json")
            res["message"]["content"] = json.dumps({"suggestions": self.merges(req)})
        else:
            return _json(400, {"error": "unknown format schema"})
        res["model"] = req.get("model", res["model"])
        return _json(200, res)

    @staticmethod
    def merges(req: dict[str, Any]) -> list[dict[str, Any]]:
        """Pair items whose names share a word of ≥ 4 letters (the worker drops duplicates)."""
        users = [m for m in req.get("messages", []) if m.get("role") == "user"]
        found = re.search(r"(\[.*\])", str(users[0].get("content", "")) if users else "", re.S)
        if not found:
            return []
        items = json.loads(found.group(1))
        words = [
            (i["item_id"], {w for w in re.findall(r"[a-z]{4,}", i["name"].lower())}) for i in items
        ]
        out = []
        for n, (a, wa) in enumerate(words):
            for b, wb in words[n + 1 :]:
                if wa & wb:
                    out.append(
                        {"item_id": a, "merge_into_item_id": b, "confidence": 0.9, "reason": "same"}
                    )
        return out
