# worker

Python media worker (uv). Claims jobs from the State Engine API, prepares images/frames, calls a
local Ollama VLM and posts structured results. Never touches the database; never calls cloud
vision/LLM APIs. Prompts are versioned files in `prompts/`. Built out in M6.

```
uv sync
uv run ruff check && uv run ruff format --check && uv run mypy . && uv run pytest
```
