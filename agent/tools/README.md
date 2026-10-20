# agent/tools

Deterministic Python tools invoked by the OpenClaw agent: cart injection, receipt parsing and the
State Engine API client. Never touches the database; never navigates to or submits checkout.
Built out in M7.

```
uv sync
uv run ruff check && uv run ruff format --check && uv run mypy . && uv run pytest
```
