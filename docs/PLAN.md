# PandaBase — Build Plan

> Living document. Each milestone is executed by **one fresh Claude Code session** producing
> **one PR**. Sessions read only what their milestone lists — keep context small.
> When a milestone deviates from this plan or from DESIGN.md, record it in the milestone's
> **Notes** and update DESIGN.md in the same PR.

## Session protocol

1. Read `CLAUDE.md`, this file's *Session protocol* and **your milestone only**, then the DESIGN/PRD
   sections the milestone lists.
2. Branch from latest `main`: `claude/m<N>-<slug>`.
3. Build to the acceptance criteria. Run every acceptance command locally; all must pass.
4. Update the status table below (→ `in review`) and the milestone's **Notes** with deviations,
   follow-ups, and anything the next milestones need to know.
5. Open a PR titled `M<N>: <title>`; body lists acceptance commands and their results.
6. Don't edit files owned by another milestone except where your milestone says so; if you must,
   call it out in the PR.

## Dependency graph

```
M1 ─▶ M2 ─▶ M3 ─▶ M4 ─┬─▶ M5 (web UI)       ─┐
                      ├─▶ M6 (worker)       ─┼─▶ M8 (ops & docs)
                      └─▶ M7 (agent pack)   ─┘
```

M5, M6, M7 can run as **parallel sessions** once M4 is merged; they share only the generated
contracts.

## Status

| Milestone | Status | PR |
|---|---|---|
| M1 Skeleton & CI | todo | |
| M2 Schema & seed | todo | |
| M3 Domain logic | todo | |
| M4 API & contracts | todo | |
| M5 Web UI & auth | todo | |
| M6 Python worker | todo | |
| M7 Agent skill pack & tools | todo | |
| M8 Ops, compose, README | todo | |

---

## M1 — Monorepo skeleton & CI

**Goal:** an empty-but-green monorepo every later milestone builds on.

**Read:** DESIGN §1, §8, §9.

**Owns:** root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, ESLint/Prettier config,
`.gitignore` (incl. `/diagnostics`, `.env*`, `*.db`), `.nvmrc`, `/web` (bare Next.js app: latest
stable major, App Router, TS strict, Tailwind, one placeholder page), `/db` (empty package),
`/worker` and `/agent/tools` uv projects (ruff, mypy, pytest, one trivial test each),
`.github/workflows/ci.yml`, `Makefile` (stub targets), `.env.example`.

**CI:** two parallel jobs.
- `web`: pnpm install (frozen lockfile) → lint → typecheck → vitest → `next build`.
- `python`: matrix over `worker`, `agent/tools`: `uv sync` → `ruff check` → `ruff format --check`
  → `mypy` → `pytest`.

**Acceptance:**
```
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm --filter web build
(cd worker && uv run ruff check && uv run mypy . && uv run pytest)
(cd agent/tools && uv run ruff check && uv run mypy . && uv run pytest)
```

**Out of scope:** any schema, routes, auth, Docker.

**Notes:** —

---

## M2 — Database schema, migrations, seed

**Goal:** the full v1 schema in Drizzle with migrations and a realistic seed.

**Read:** DESIGN §2, §8. PRD §2.

**Owns:** `/db/**` (`@pandabase/db`): `schema/*.ts` (one file per §2.x group), `client.ts`
(libSQL client from env; `file:./dev.db` default), `migrations/`, `seed.ts`, `rebuild-state.ts`
stub. Root scripts: `db:generate`, `db:migrate`, `db:migrate:prod`, `db:seed`, `db:reset`.

**Seed:** 2 members, ~40 items across categories/locations (mix velocity/static; some with
`shelf_life_days`, `audit_hint`), multiple products for ~8 items (brand switching), ~6 months of
synthetic digital + paper receipts with realistic intervals, 1 away period, 1 open cycle,
a few pending review items. Deterministic (seeded RNG).

**Acceptance:**
```
pnpm db:reset && pnpm db:seed        # against file:./dev.db
pnpm --filter @pandabase/db test     # schema smoke tests: constraints, uniques, enum CHECKs
pnpm drizzle-kit check
```

**Out of scope:** domain logic (seed writes events directly; `inventory_state` can be filled by a
naive projection to be replaced in M3).

**Notes:** —

---

## M3 — Domain logic

**Goal:** all business rules as pure, table-driven-tested functions.

**Read:** DESIGN §4 (all), §2. PRD §3, §4.5.

**Owns:** `web/lib/config.ts`, `web/lib/domain/**`, `web/lib/domain/**/*.test.ts`.
Modules: `velocity.ts`, `inventory.ts` (projection + estimate + shelf life + overbuy),
`predictions.ts`, `productChoice.ts` (+ learning), `matching.ts` (normalize, fuzzy, alias rules),
`receipts.ts` (`applyReceipt` orchestration over a repository interface), `review.ts` (expiry,
impact), `cycle.ts` (state machine), `time.ts` (household TZ, away-day arithmetic).
Replace M2's naive projection in `db/rebuild-state.ts` with `inventory.ts`.

Design for testability: pure functions take plain data; DB access goes through small repository
interfaces implemented in M4.

**Acceptance:**
```
pnpm --filter web test -- lib/domain      # ≥ 95% line coverage on lib/domain
pnpm typecheck
```
Tests must include, at minimum: every row of DESIGN §4.1–4.6 tables, cold start (with/without
seed), away subtraction, 3-outlier-streak acceptance, same-day merge, 12 vs 18 pack normalization,
shelf-life discard, overbuy, switch-threshold learning bounds, implicit swap, expiry defaults,
every cycle transition.

**Out of scope:** HTTP, UI, DB writes.

**Notes:** —

---

## M4 — API routes & contracts

**Goal:** every v1 route from DESIGN §3.2, authenticated, idempotent, tested; contracts generated.

**Read:** DESIGN §3, §5 (steps 2–6), §7 (emitters), §2. Skim §4 for function names.

**Owns:** `web/app/api/**`, `web/lib/contracts/**`, `web/lib/auth/**` (token + session check,
`withAuth`, actor resolution — Auth.js config itself is minimal here and completed in M5),
`web/lib/repo/**` (Drizzle repositories), `web/lib/r2.ts`, `web/lib/telemetry.ts`,
`web/lib/diagnostics/**` (weekly Markdown + JSONL renderer), `web/vercel.json` (cron),
`/contracts/openapi.json`, `scripts/gen-contracts.*`, generated
`worker/pandabase_worker/contracts.py` and `agent/tools/pandabase/contracts.py`.
CI: add contract-drift check (`pnpm contracts:gen && git diff --exit-code`).

**Acceptance:**
```
pnpm --filter web test -- app/api lib/repo lib/diagnostics   # integration tests on in-memory libSQL
pnpm contracts:gen && git diff --exit-code
pnpm --filter web build
```
Integration tests must cover: scope enforcement per route (agent/worker/session/none), unknown
`actor_discord_id` → 403, idempotent replay, receipt ingest end-to-end (digital + paper) incl.
dedupe, job create → claim → lease expiry → re-claim → complete → notifications, cycle lifecycle
incl. skip/other-store/away, predictions with overrides + price quotes, cron maintenance, weekly
diagnostics rendering snapshot.

**Out of scope:** UI pages, Python code beyond generated contracts.

**Notes:** —

---

## M5 — Web UI & Google auth  *(parallel with M6, M7)*

**Goal:** the mobile-first UI from PRD §4.6, behind Google sign-in.

**Read:** PRD §3, §4.6. DESIGN §3.1, §4.4 (reason strings), §4.6.

**Owns:** `web/app/(app)/**` pages, `web/app/(auth)/**`, `web/components/**`, `web/auth.ts`
(Auth.js v5: Google provider, `ALLOWED_EMAILS` allowlist, JWT sessions, `DEV_AUTH_BYPASS` in dev
only), `web/middleware.ts`, server actions in `web/app/(app)/**/actions.ts` calling domain/repo
functions (no duplicated logic). shadcn/ui components, light/dark.

Pages: This Week, Cleanup (tabs: receipts, merges, unverified, failed jobs; receipt review = photo
beside lines with per-line match dropdown and one confirm), Pantry + item detail (EMA history chart,
products/stance/threshold, event log, editable `audit_hint`/`shelf_life_days`/`reorder_threshold`),
Insights, Settings (away periods, members, cart account, thresholds).

**Acceptance:**
```
pnpm --filter web test            # component/action tests incl. allowlist rejection
pnpm --filter web build
pnpm --filter web test:e2e        # Playwright, DEV_AUTH_BYPASS, seeded db: sign-in gate,
                                  # This Week override, confirm a receipt review, add away period
```
Lighthouse mobile accessibility ≥ 90 on This Week (documented in PR, not CI-gated).

**Out of scope:** API changes (if needed, add minimally and note in PR).

**Notes:** —

---

## M6 — Python worker  *(parallel with M5, M7)*

**Goal:** the job worker from DESIGN §5.

**Read:** DESIGN §1.2, §5, §7 (worker emitters). Generated `contracts.py`.

**Owns:** `/worker/**`: `pandabase_worker/` (`main.py` loop, `api.py` client with retries +
idempotency, `jobs/paper_receipt.py`, `jobs/trash_cam.py`, `jobs/merge_suggest.py`, `media.py`
(download, EXIF, resize, keyframe upload via presigned URL), `ollama.py` (client, `keep_alive`,
JSON-mode, schema validation, one repair retry), `telemetry.py`), `prompts/*.v1.md`,
`Dockerfile` (python slim + ffmpeg, non-root, uv), `tests/` with recorded Ollama fixtures and
sample images.

Choose the default `OLLAMA_VLM_MODEL` by checking Ollama's current catalog; record the choice and
reason in Notes and DESIGN §1.2.

**Acceptance:**
```
cd worker && uv run ruff check && uv run mypy . && uv run pytest
docker build -t pandabase-worker worker
```
Tests cover: claim/lease/complete loop, failure + retry reporting, totals check (pass/fail/≤2¢),
malformed VLM JSON → repair → failure, concurrency = 1, graceful shutdown on SIGTERM.

**Out of scope:** video/FFmpeg frame extraction (v1.1) beyond installing ffmpeg in the image.

**Notes:** —

---

## M7 — Agent skill pack & Playwright tools  *(parallel with M5, M6)*

**Goal:** OpenClaw skills and deterministic tools from DESIGN §6.

**Read:** DESIGN §3.2, §4.7, §6. PRD §4.1–4.4. Generated `contracts.py`. Check OpenClaw's current
skill format/docs before writing `SKILL.md` frontmatter; record findings in Notes.

**Owns:** `/agent/skills/{grocery-cycle,discord-intake,digital-receipt-scraper,item-lookup,telemetry-aggregator}/SKILL.md`,
`/agent/tools/**` (`pandabase/` client package, `cart_injector.py`, `receipt_parser.py`,
profile lock, CLI entry points emitting JSON), `agent/pandabase.config.example.json`,
`agent/cron.example.json`, `agent/profiles.example.json`, `agent/tools/tests/` with saved HTML
fixtures (order list, order details for delivery/pickup/in-store, add-to-cart confirm page,
a "layout changed" page).

**Acceptance:**
```
cd agent/tools && uv run ruff check && uv run mypy . && uv run pytest
```
Tests cover: add-to-cart URL building/batching, result classification (added/needs_agent/failed),
ASIN extraction from fixtures incl. pickup + in-store, final-state filtering, cursor/backfill
resume, zero-ASIN fallback output, never navigating to checkout URLs (asserted).
Each SKILL.md: lists exact tool commands and API calls, channel scoping, message templates, and
the "ask once / never nag" rules.

**Out of scope:** live Amazon/Discord (covered by `make smoke` in M8).

**Notes:** —

---

## M8 — Ops, compose, docs

**Goal:** the Mac Mini appliance and the docs needed to set everything up.

**Read:** DESIGN §1, §6 (config), §7, §8. All milestone Notes.

**Owns:** `docker-compose.yml` (worker service; `openclaw` service behind `--profile agent`;
`/diagnostics` volume; `host.docker.internal`), `Makefile` (`secrets`, `install-agent-skills`,
`smoke`, `backfill`, `up`, `logs`), `scripts/smoke/*` (live checks: API round trip with agent
token, Ollama VLM on a sample receipt, add-to-cart URL incl. Whole Foods item, CDP attach to each
profile), `README.md`, final `CLAUDE.md` touch-ups.

**README:** overview + link to PRD/DESIGN; setup checklist: Turso (prod + preview DBs, tokens),
R2 (bucket, API token, lifecycle rules), Google OAuth client, Vercel project + env vars + cron,
`make secrets`, Mac Mini (Docker Desktop, native Ollama + model pull, memory budget table, Chromium
profiles with remote debugging, OpenClaw skill install, cron entries, Discord channel), first run
(`pnpm db:migrate:prod`, members in Settings, `make backfill`), `make smoke`, diagnostics workflow.

**Acceptance:**
```
docker compose config
docker compose build
make -n smoke backfill install-agent-skills
```
Plus a fresh-eyes review: someone following README from zero has no missing step (list any manual
steps that can't be scripted).

**Notes:** —
