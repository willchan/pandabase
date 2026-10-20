# agent/tools

`pandabase-tools`: the deterministic CLI the OpenClaw skills in `/agent/skills` run (DESIGN §6).
JSON on stdout; exit codes 0 ok · 1 error · 2 usage · 3 profile locked · 4 refused URL. Never
touches the database (it calls the State Engine API), never launches a browser or signs in (it
attaches over CDP to a member's running Chromium), and never navigates to checkout (`guard.py`).

```
uv sync
uv run ruff check && uv run ruff format --check && uv run mypy . && uv run pytest
PANDABASE_CONFIG=../pandabase.config.json AGENT_API_TOKEN=… uv run pandabase-tools config show
```

| Command | What |
|---|---|
| `api get\|post <path> [-q k=v] [--json …\|--input FILE] [--actor ID] [--key K]` | any agent route, contract-validated |
| `cart build [--cycle-id C]` / `cart finish --cycle-id C --outcomes '{…}'` / `cart url ASIN[:QTY]…` | Saturday build (price checks + tier 1), post result after tier 2, print an add URL |
| `receipts sweep --member M [--backfill]` / `receipts ingest --member M --input FILE` | order-history sweep; ingest an agent-extracted receipt |
| `photo submit --file F --actor ID …` / `photo classify` | classify + upload + audit job |
| `jobs replies` | reply text for finished photo jobs, or `NO_REPLY` (OpenClaw command automation) |
| `diagnostics write [--week W]` | weekly report → `/diagnostics` |
| `telemetry emit METRIC --payload '{…}'` | client telemetry (e.g. `clarifying_question`) |
| `lock acquire\|release\|status --member M` | per-profile lease for tier-2 browsing |
| `cdp check --member M` / `config show` | smoke checks |

Tests use synthetic HTML in `tests/fixtures/amazon/` (no real order data) and a fixture-backed
fake browser; `tests/test_skills.py` parses every command the skills name.
