# CLAUDE.md

PandaBase is a household operating system for groceries: a Next.js + Turso **State Engine** on
Vercel, a Python **worker** and an existing **OpenClaw agent** on a Mac Mini, talking through an
authenticated HTTP API.

## Start here

| Doc | Read when |
|---|---|
| [docs/PRD.md](docs/PRD.md) | You need to know *what* the product does and *why* |
| [docs/DESIGN.md](docs/DESIGN.md) | You're changing architecture, schema, API, algorithms, or agent behavior |
| [docs/PLAN.md](docs/PLAN.md) | You're executing a build milestone — follow its *Session protocol* |
| [docs/ROADMAP.md](docs/ROADMAP.md) | You're tempted to build chores, video audits, or freezer features — they're deferred |

Read only the sections your task needs.

## Rules

- **Driving a PR?** Follow `.claude/skills/steward/SKILL.md`: check mergeability before CI on every
  wake and after each push — GitHub runs no PR CI while a PR conflicts with `main`.
- **The docs are living.** Any PR that changes user-visible behavior updates `docs/PRD.md`; any PR
  that changes architecture, schema, API contracts, algorithms or agent behavior updates
  `docs/DESIGN.md` (including §10 *Key decisions* when a decision changes). Deviations from a
  milestone go in that milestone's **Notes** in `docs/PLAN.md`.
- **The State Engine owns business logic and the database.** The worker and agent tools never touch
  the DB; they call the API. Domain rules live in `web/lib/domain/` as pure, tested functions.
- **Contracts are generated.** Zod in `web/lib/contracts/` → `contracts/openapi.json` → Python
  models. Never hand-edit generated files; run `pnpm contracts:gen`.
- **Tunables live in `web/lib/config.ts`.** No magic numbers in domain code.
- **Migrations are backward-compatible (expand → contract).** `main` deploys automatically and
  migrations run *before* the new code ships, so the previous release must keep working against the
  new schema. Add columns/tables freely; drop or rename only in a later PR, after no deployed code
  uses them.
- **Nothing blocks on a human.** New review flows need a default outcome and an expiry.
  Only human-confirmed data becomes `labeled_observation`s.
- **Cart only, never checkout.** No code path may navigate to or submit checkout.
- **No cloud vision/LLM calls from the worker.** Local Ollama only.
- **Diagnostics:** any new learning component or heuristic emits telemetry and gets a section (or
  rows) in the weekly diagnostics report.
- **Privacy:** never commit `/diagnostics`, `.env*`, real receipts, or real order HTML. Test fixtures
  must be synthetic or scrubbed.
- **Bug fixes start with a regression test.** Write a test that reproduces the bug and fails before
  the fix, then make it pass. Name or comment it so the bug is recognisable (what input, what was
  wrong).
- **Prompts are versioned files** in `worker/prompts/`; changing a prompt means a new version file,
  and jobs record `prompt_version`.

## Commands

> Keep this list accurate as milestones land. Node 24 (`.nvmrc`), pnpm 12, Python 3.14 + uv.

```
pnpm install                 # JS deps (web, db)
pnpm dev                     # web on localhost:3000
pnpm lint && pnpm typecheck && pnpm test   # ESLint + Prettier check, tsc, vitest
pnpm format                  # Prettier --write
pnpm --filter web build      # next build
(cd worker && uv run ruff check && uv run ruff format --check && uv run mypy . && uv run pytest)
(cd agent/tools && uv run ruff check && uv run ruff format --check && uv run mypy . && uv run pytest)
pnpm db:reset && pnpm db:seed   # fresh db/dev.db (or TURSO_DATABASE_URL), migrated + seeded
pnpm db:add-member --email E --name N [--discord ID] [--profile P] [--sweep daily|weekly|off] [--cart]
                             # upsert a member by email (first-run bootstrap; TURSO_* for prod)
                             # no terminal: Actions → Bootstrap (bootstrap.yml; docs/SETUP-PHONE.md)
pnpm db:generate             # after editing db/src/schema/*: new migration in db/migrations (commit it)
pnpm db:migrate              # apply migrations; db:migrate:prod for Turso (needs TURSO_AUTH_TOKEN)
pnpm db:rebuild-state        # recompute inventory_state from inventory_event (§4.2 projection)
pnpm drizzle-kit check       # migration consistency (any drizzle-kit command works this way)
pnpm --filter @pandabase/db test   # schema smoke + seed tests (in-memory libSQL)
pnpm --filter web test -- lib/domain   # domain tests + coverage (≥ 95% lines on lib/domain enforced)
pnpm --filter web test -- app/api lib/repo lib/diagnostics   # API integration tests (in-memory libSQL)
pnpm --filter web test:e2e   # Playwright: next dev + DEV_AUTH_BYPASS on a fresh db/e2e.db (phone viewport)
pnpm --filter web test -- app components lib/services lib/auth   # server actions, components, services
pnpm contracts:gen           # Zod → contracts/openapi.json → worker/agent Pydantic models (commit them)
make contracts-check         # regenerate + fail if the generated contracts differ from git
docker build -t pandabase-worker worker   # worker image (CI job worker-image)
(cd worker && uv run python -m pandabase_worker)   # run the worker (env: PANDABASE_API_URL, WORKER_API_TOKEN, OLLAMA_URL)
(cd agent/tools && uv run pandabase-tools --help)   # agent CLI used by the skills (JSON on stdout)
(cd agent/tools && uv run pytest tests/test_skills.py)   # skill frontmatter + every command a skill names parses
make check                   # everything CI runs
make ops-check               # shellcheck, actionlint, compose/plists, deploy bats tests, migration check, smoke ruff/mypy
bats scripts/deploy/tests    # Mac Mini updater + migration check (git/docker/network stubbed)
scripts/deploy/check-migrations.sh --base origin/main   # new migrations must not DROP/RENAME (unless marked)
```

Mac Mini ops (README has the order; every script is idempotent and honours `DRY_RUN=1`):

```
make secrets                 # .env + .env.vercel: generate missing tokens (never prints values)
make vercel-env              # add those secrets to the linked Vercel project
make up / make logs / make down          # worker via docker compose (GHCR image; make up-local builds ./worker)
make update                  # CD: newest green main → pull → health check → auto-rollback (DRY_RUN=1 prints)
make update-status / update-pause / update-resume / rollback [TO=sha]
make install-update-timer    # launchd: make update every 15 min (needs docker login ghcr.io)
make install-agent-tools     # agent/tools venv, pandabase-tools on PATH, configs from examples
make install-agent-skills    # skills.load.extraDirs += agent/skills (backs up openclaw.json)
make install-agent-cron      # OpenClaw automations (list, then edit or add)
make install-chromium        # per-member Chromium LaunchAgents (loopback-only CDP)
make install-ollama-env      # OLLAMA_NUM_PARALLEL=1, OLLAMA_MAX_LOADED_MODELS=1 at login
make backfill [MEMBER=m]     # 12-month receipt backfill, resumable
make smoke                   # live checks; SMOKE_CART=1 / SMOKE_E2E=1 opt-ins, SMOKE_ONLY="api vlm"
```

## Playbook: "review diagnostics"

When asked to review diagnostics (normally run on the Mac Mini, where the gitignored repo-root
`diagnostics/` holds the agent's weekly output — "`/diagnostics`" below):

1. Read the last 4 weekly reports in `/diagnostics/*.md` (newest first). Note the *Summary* findings
   and any metric trending the wrong way vs PRD §6 targets.
2. For the top issues, open the matching JSONL extracts in `/diagnostics/YYYY-Www/` and look at
   concrete cases (and keyframes by R2 key if needed — ask before downloading many).
3. Rank issues by household impact: wrong/missing cart lines > wasted human effort > data quality >
   performance.
4. For each top issue, propose a change with evidence: prompt (new version file), threshold
   (`web/lib/config.ts`), matching/learning logic, model choice, or tool/selector fix. Estimate the
   effect using the extracts where possible (e.g. "replaying last 4 weeks of receipts with
   threshold 0.80 would auto-match 12 more lines, 1 wrong").
5. Present the ranked proposals and wait for approval. Implement approved ones as PRs that include
   before/after evidence and update DESIGN.md if behavior changes.
6. Check ROADMAP "Candidate improvements" — if the evidence now supports one, say so.
