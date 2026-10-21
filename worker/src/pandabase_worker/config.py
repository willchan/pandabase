"""Worker settings from the environment (DESIGN §8) and fixed tunables (DESIGN §1.2, §5)."""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

# DESIGN §1.2: the Mac Mini's 32GB are shared, so the model unloads soon after a burst.
KEEP_ALIVE = "2m"
# Default VLM: Qwen3.5 9B (natively multimodal), q4_K_M ≈ 6.6GB. See PLAN M6 Notes.
DEFAULT_VLM_MODEL = "qwen3.5:9b"
# merge_suggest is short-text work; the 4B sibling (≈ 3.4GB) follows the same JSON prompts.
DEFAULT_TEXT_MODEL = "qwen3.5:4b"
# Context window per request: a receipt image + prompt + ~100 lines of JSON fits in 8K tokens,
# and a small window keeps the KV cache (and so resident memory) small.
NUM_CTX = 8192
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
