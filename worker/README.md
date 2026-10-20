# worker

Python media worker (uv). Claims jobs from the State Engine API, normalizes the photo (EXIF
rotate, ≤ 2048px JPEG), uploads it as the job's keyframe, asks the local Ollama model for JSON
matching the job's schema (one repair retry) and posts the result. Never touches the database;
never calls cloud vision/LLM APIs. One job at a time. See DESIGN §1.2 and §5.

| Job | Model (env) | Prompt |
|---|---|---|
| `paper_receipt` | `OLLAMA_VLM_MODEL` (`qwen3.5:9b`) | `prompts/paper_receipt.v1.md` (transcription only) |
| `trash_cam` | `OLLAMA_VLM_MODEL` | `prompts/trash_cam.v1.md` |
| `merge_suggest` | `OLLAMA_TEXT_MODEL` (`qwen3.5:4b`) | `prompts/merge_suggest.v1.md` |

Prompts are versioned: to change one, add `{job_type}.v{N+1}.md` (the highest version is used and
recorded as `prompt_version`).

```
uv sync
uv run ruff check && uv run ruff format --check && uv run mypy . && uv run pytest
PANDABASE_API_URL=http://localhost:3000 WORKER_API_TOKEN=… OLLAMA_URL=http://localhost:11434 \
  uv run python -m pandabase_worker
docker build -t pandabase-worker .
```

SIGTERM finishes the current job, then exits; a second signal exits immediately.
