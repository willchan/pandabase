"""Worker settings from the environment (DESIGN §8) and fixed tunables (DESIGN §1.2, §5)."""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

# DESIGN §1.2: one resident model on the Mac Mini. The worker uses the model OpenClaw's agents
# already keep loaded (Qwen3.8 27B: vision, ≈ 18GB), so a job never swaps it out.
DEFAULT_VLM_MODEL = "qwen3.8:27b"
DEFAULT_TEXT_MODEL = "qwen3.8:27b"
# Context window per request. Must equal OpenClaw's for the shared model: Ollama reloads a model
# whose `num_ctx` changes. A receipt image + prompt + ~100 lines of JSON needs well under 8K.
NUM_CTX = 32768
# Must equal OpenClaw's `keep_alive` for the shared model: Ollama keeps the last request's value, so
# a shorter one would cut the reply model's residency. Sent explicitly because the Ollama app
# (0.40.14) doesn't pass the host's `OLLAMA_KEEP_ALIVE` to its server: without it a request gets 5m.
KEEP_ALIVE = "30m"
# Output cap per job type (Ollama `num_predict`; DESIGN §5). With none, an answer stuck in a
# repetition loop runs until the context fills — ~4 min on the 4B model, the whole timeout. A
# 40-item merge_suggest answer needs well under 1K tokens. Receipts and trash-cam have no cap yet:
# a long receipt's JSON can need most of the context. Thinking tokens count against the cap too
# (Qwen3.8 at think "low" spent all 2048 on a 40-item batch), so requests keep `think: false`.
MAX_OUTPUT_TOKENS: Mapping[str, int] = {"merge_suggest": 2048}
# DESIGN §5: images are normalized to ≤ 2048px on the long side before keyframe upload / VLM.
MAX_IMAGE_PX = 2048
JPEG_QUALITY = 90
# HTTP retries for transient failures (network, 429, 5xx): attempts and first backoff.
HTTP_ATTEMPTS = 4
HTTP_BACKOFF_SECONDS = 1.0
# Per-request timeouts: API/R2 calls are quick; a cold VLM load + inference is not.
API_TIMEOUT_SECONDS = 30.0
OLLAMA_TIMEOUT_SECONDS = 240.0
# Liveness: `worker_heartbeat` at startup and this often (deploy health checks look for it).
HEARTBEAT_SECONDS = 600

PROMPTS_DIR = Path(__file__).resolve().parents[2] / "prompts"


@dataclass(frozen=True)
class Settings:
    api_url: str
    api_token: str
    ollama_url: str = "http://host.docker.internal:11434"
    vlm_model: str = DEFAULT_VLM_MODEL
    text_model: str = DEFAULT_TEXT_MODEL
    poll_interval_seconds: float = 10.0
    household_tz: str = "America/Los_Angeles"
    prompts_dir: Path = PROMPTS_DIR
    # Git sha the image was built from (Dockerfile `GIT_SHA`); the deploy health check matches it.
    build_sha: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        e = os.environ if env is None else env
        missing = [k for k in ("PANDABASE_API_URL", "WORKER_API_TOKEN") if not e.get(k)]
        if missing:
            raise ValueError(f"missing env: {', '.join(missing)}")
        return cls(
            api_url=e["PANDABASE_API_URL"].rstrip("/"),
            api_token=e["WORKER_API_TOKEN"],
            ollama_url=(e.get("OLLAMA_URL") or cls.ollama_url).rstrip("/"),
            vlm_model=e.get("OLLAMA_VLM_MODEL") or DEFAULT_VLM_MODEL,
            text_model=e.get("OLLAMA_TEXT_MODEL") or DEFAULT_TEXT_MODEL,
            poll_interval_seconds=float(e.get("POLL_INTERVAL_SECONDS") or 10),
            household_tz=e.get("HOUSEHOLD_TZ") or cls.household_tz,
            prompts_dir=Path(e["PROMPTS_DIR"]) if e.get("PROMPTS_DIR") else PROMPTS_DIR,
            build_sha=e.get("PANDABASE_BUILD_SHA") or None,
        )
