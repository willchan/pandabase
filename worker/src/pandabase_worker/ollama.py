"""Local Ollama client: structured JSON output, schema validation, one repair retry.

Local only (CLAUDE.md): this is the worker's sole model client, and it talks to `OLLAMA_URL`.
"""

import base64
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
from pydantic import BaseModel, ValidationError

from pandabase_worker.config import KEEP_ALIVE, NUM_CTX, OLLAMA_TIMEOUT_SECONDS

REPAIR_PROMPT = (
    "Your previous reply could not be used: {error}\n"
    "Reply again with only the corrected JSON object matching the schema. No prose."
)


class OllamaError(Exception):
    """Ollama unreachable or returned an error."""


class ParseFailure(Exception):
    """The model's output was not valid JSON for the schema, even after the repair retry."""

    def __init__(self, model: str, error: str, raw: list[str], latency_ms: int) -> None:
        super().__init__(error)
        self.model = model
        self.error = error
        self.raw = raw
        self.latency_ms = latency_ms


@dataclass
class Inference[T: BaseModel]:
    value: T
    model: str
    latency_ms: int
    repaired: bool
    raw: list[str] = field(default_factory=list)


class OllamaClient:
    def __init__(
        self,
        base_url: str,
        *,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._http = httpx.Client(
            base_url=base_url, timeout=OLLAMA_TIMEOUT_SECONDS, transport=transport
        )
        self._clock = clock

    def close(self) -> None:
        self._http.close()

    def available_models(self) -> set[str] | None:
        """Names of locally pulled models, or None if Ollama is unreachable."""
        try:
            res = self._http.get("/api/tags", timeout=5.0)
            res.raise_for_status()
        except httpx.HTTPError:
            return None
        names: set[str] = set()
        for m in res.json().get("models", []):
            names.update(n for n in (m.get("name"), m.get("model")) if n)
        return names

    def generate[T: BaseModel](
        self,
        model: str,
        system: str,
        user: str,
        schema: type[T],
        images: list[bytes] | None = None,
    ) -> Inference[T]:
        """Ask `model` for JSON matching `schema`; on invalid output, repair once, then raise
        `ParseFailure`. Temperature 0, `keep_alive` 2m, thinking off."""
        user_msg: dict[str, Any] = {"role": "user", "content": user}
        if images:
            user_msg["images"] = [base64.b64encode(i).decode() for i in images]
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}, user_msg]
        raw: list[str] = []
        start = self._clock()
        error = ""
        for attempt in range(2):
            content = self._chat(model, messages, schema.model_json_schema())
            raw.append(content)
            try:
                value = schema.model_validate_json(_strip_fences(content))
            except ValidationError as err:
                error = _describe(err)
            else:
                return Inference(value, model, self._elapsed(start), attempt > 0, raw)
            messages += [
                {"role": "assistant", "content": content},
                {"role": "user", "content": REPAIR_PROMPT.format(error=error)},
            ]
        raise ParseFailure(model, error, raw, self._elapsed(start))

    def _chat(self, model: str, messages: list[dict[str, Any]], schema: dict[str, Any]) -> str:
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "format": schema,
            "stream": False,
            "think": False,
            "keep_alive": KEEP_ALIVE,
            "options": {"temperature": 0, "num_ctx": NUM_CTX},
        }
        res = self._post_chat(body)
        if res.status_code == 400 and "thinking" in res.text:
            # A model without a thinking mode (e.g. if OLLAMA_VLM_MODEL is swapped) may reject
            # the `think` flag; there is nothing to turn off, so resend without it.
            del body["think"]
            res = self._post_chat(body)
        if res.status_code >= 400:
            raise OllamaError(f"ollama {res.status_code}: {res.text[:300]}")
        content = res.json().get("message", {}).get("content")
        return content if isinstance(content, str) else ""

    def _post_chat(self, body: dict[str, Any]) -> httpx.Response:
        try:
            return self._http.post("/api/chat", json=body)
        except httpx.HTTPError as err:
            raise OllamaError(f"ollama unreachable: {err}") from err

    def _elapsed(self, start: float) -> int:
        return round((self._clock() - start) * 1000)


def _strip_fences(text: str) -> str:
    """Models sometimes wrap JSON in ``` fences despite `format`."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else ""
        t = t.rsplit("```", 1)[0]
    return t.strip()


def _describe(err: ValidationError) -> str:
    issues = err.errors(include_url=False)[:5]
    if issues and issues[0]["type"] == "json_invalid":
        return "not valid JSON"
    return "; ".join(
        f"{'.'.join(str(p) for p in i['loc']) or '(root)'}: {i['msg']}" for i in issues
    )
