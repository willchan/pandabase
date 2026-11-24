# PandaBase — Commands

The full command reference. `CLAUDE.md` lists only the everyday ones; look here (grep for the
tool or make target) before guessing a command. Keep this list accurate as milestones land.
Node 24 (`.nvmrc`), pnpm 12, Python 3.14 + uv.

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
                             # upsert a member by email (sign-in also creates them; TURSO_* for prod)
                             # no terminal: Actions → Bootstrap (bootstrap.yml; docs/SETUP-CLOUD.md)
pnpm db:reset-imports [--vendor V] [--apply]   # undo the digital receipt import, or one store's
                             # (counts only without --apply; refuses on human data; DESIGN §4.5).
                             # No terminal: Bootstrap reset-imports (input vendor)
pnpm db:rename-items [--apply]    # re-name auto-created items named after a store brand (counts only
                             # without --apply; DESIGN §4.5). No terminal: Bootstrap rename-items
pnpm db:generate             # after editing db/src/schema/*: new migration in db/migrations (commit it)
pnpm db:migrate              # apply migrations; db:migrate:prod for Turso (needs TURSO_AUTH_TOKEN)
pnpm db:rebuild-state        # recompute inventory_state from inventory_event (§4.2 projection)
pnpm db:rebuild-learning [--items ID,…] [--apply]   # recompute product stats, stances, EMA, tracking
                             # promotion, switch thresholds from receipts (counts per column + causes
                             # without --apply; DESIGN §4.10). No terminal: Bootstrap rebuild-learning
pnpm drizzle-kit check       # migration consistency (any drizzle-kit command works this way)
pnpm --filter @pandabase/db test   # schema smoke + seed tests (in-memory libSQL)
pnpm --filter web test -- lib/domain   # domain tests + coverage (≥ 95% lines on lib/domain enforced)
pnpm --filter web test -- app/api lib/repo lib/diagnostics   # API integration tests (in-memory libSQL)
pnpm --filter web test:e2e   # Playwright: next dev + DEV_AUTH_BYPASS on a fresh db/e2e.db (phone viewport)
pnpm --filter web test -- app components lib/services lib/auth   # server actions, components, services
pnpm --filter web dev:seeded   # next dev on a throwaway seeded db (dev sign-in as alex@example.com)
pnpm --filter web shot / /pantry   # phone screenshots, light + dark → web/.shots; nonzero on console/request errors
make prod-copy               # prod → .scratch/prod-copy.db, READ-ONLY token, counts only (docs/TESTING.md)
pnpm --filter web dev:prod-copy   # next dev on the prod copy as a real member (refuses non-file: DBs)
pnpm --filter web data-quality   # weekly data-quality checks on the prod copy: counts only
                             # prod data / prod-copy shots never go in commits, PRs, fixtures or CI logs
make prod-copy-clean         # delete the copy when you're done with it (verify skill)
pnpm contracts:gen           # Zod → contracts/openapi.json → worker/agent Pydantic models (commit them)
make contracts-check         # regenerate + fail if the generated contracts differ from git
docker build -t pandabase-worker worker   # worker image (CI job worker-image)
(cd worker && uv run python -m pandabase_worker)   # run the worker (env: PANDABASE_API_URL, WORKER_API_TOKEN, OLLAMA_URL)
(cd agent/tools && uv run pandabase-tools --help)   # agent CLI used by the skills (JSON on stdout)
(cd agent/tools && uv run pytest tests/test_skills.py)   # skill frontmatter + every command a skill names parses
make e2e-system              # tier A system test: next start + worker + fake Ollama/R2 + tools + Playwright (~1 min)
                             # SYSTEM_BUILD=0 reuses web/.next-system; SYSTEM_KEEP=<dir> keeps db + logs
make system-lint             # ruff + strict mypy for tests/system (part of make check)
make preview-reset           # migrate + empty + seed TURSO_DATABASE_URL (remote only the preview DB:
                             # PANDABASE_ALLOW_REMOTE_SEED=preview and a `preview` db name)
make e2e-preview             # tier A′: @preview steps against SYSTEM_REMOTE_URL (env: preview tokens,
                             # AUTH_SECRET, TURSO_*, R2_*, VERCEL_AUTOMATION_BYPASS_SECRET; preview-e2e.yml,
                             # on Vercel's repository_dispatch → `Preview E2E` commit status)
make e2e-system-remote-local # the same remote code path against a local stack + bypass gate (~1 min)
(cd web && vercel schedules invoke maintenance)   # run daily maintenance now on production (linked
                             # web/; idempotent). No terminal: Actions → Run maintenance (maintenance.yml).
                             # History: vercel schedules executions list maintenance (DESIGN §8)
pnpm db:migrations-status    # read-only: applied migrations vs db/migrations (deploy.yml smoke)
(cd worker && uv run python ../scripts/deploy/web_smoke.py --base-url URL [--migrations F])   # read-only prod smoke (Python 3.14)
make eval-agent              # tier B: real OpenClaw + skills on local Ollama (EVAL_MODEL); skips if unavailable
make check                   # everything CI runs
make ops-check               # shellcheck, actionlint, compose/plists, deploy bats tests, migration check, smoke ruff/mypy,
                             # finished milestones out of docs/PLAN.md (python3 scripts/docs/check_plan_done.py)
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
make install-update-timer    # launchd: make update every 15 min (GHCR image is public: no login)
make install-agent-tools     # agent/tools venv, pandabase-tools on PATH, configs from examples
make install-agent-skills    # skills.load.extraDirs += agent/skills; ~/.config/pandabase/agent.env
make install-agent-cron      # OpenClaw automations (list, then edit or add)
make install-agent-workspace # the pandabase agent's AGENTS.md + IDENTITY.md (replaced), USER.md (seeded)
make mac-rollout             # by hand: green main + the agent installers (make update runs them itself when needed)
make install-chromium        # per-member Chrome LaunchAgents (CHROMIUM_BIN; loopback-only CDP)
make install-ollama-env      # OLLAMA_NUM_PARALLEL=1, OLLAMA_MAX_LOADED_MODELS=1, OLLAMA_NO_CLOUD=1 at login
                             # (not on a shared host: the host owns them; the Mac uses its own)
make backfill [MEMBER=m]     # 12-month receipt backfill, resumable
make smoke                   # live checks; SMOKE_CART=1 / SMOKE_E2E=1 opt-ins, SMOKE_ONLY="api vlm"
                             # a full run restarts the worker and runs one VLM call on the shared
                             # model; SMOKE_ONLY="env api cdp" for a quick check
```
