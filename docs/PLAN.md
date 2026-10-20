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
| M1 Skeleton & CI | done | #2 |
| M2 Schema & seed | done | #3 |
| M3 Domain logic | in review | |
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

**Notes:**

*Versions chosen (checked 2026-10-20):* Node **24.22.0** (Active LTS "Krypton"; `.nvmrc` = `24`,
`engines.node` = `>=24 <25`), pnpm **12.14.0** (pinned via `packageManager`), Next.js **16.4.2**
(App Router, Turbopack, scaffolded with `create-next-app@16.4.2`), React **19.3.0**, Tailwind
**4.3**, TypeScript **6.0.3**, ESLint **9.39**, typescript-eslint **8.71**, Prettier **3.9**,
Vitest **5.0**. Python **3.14** (3.14.6; 3.15 is still beta), uv **0.13.3** (pinned in CI),
ruff **0.17**, mypy **2.4** (strict), pytest **9.1**.

*Deviations / choices:*
- **TypeScript 6, not 7.** TS 7 (native/Go) is out but typescript-eslint's peer range is
  `<6.1.0` and Next's build type-check uses the JS compiler API; revisit when both support 7.
- **ESLint 9, not 10.** eslint-config-next 16.4.2 pulls `eslint-plugin-react`/`-import`/
  `-jsx-a11y`, which don't accept ESLint 10 yet.
- **typescript-eslint 8.71.2, not 8.72.0.** pnpm 12 enforces a minimum release age; 8.72.0 was
  under a day old and pnpm offered to add exclusions. Kept the guard and used the prior minor —
  don't add `minimumReleaseAgeExclude` entries casually.
- Placeholder page uses system fonts (dropped the template's `next/font/google`) so `next build`
  needs no network.
- `next-env.d.ts` is gitignored (Next 16 regenerates it); `web` `typecheck` runs
  `next typegen && tsc --noEmit` so typed-route globals (`LayoutProps`, `PageProps`) exist before
  a build.
- `pnpm lint` = ESLint in every package + `prettier --check .`. Prettier ignores `*.md` (docs are
  hand-wrapped) and the Python trees (ruff formats those).
- `allowBuilds` in `pnpm-workspace.yaml` denies install scripts for `sharp`/`unrs-resolver`
  (prebuilt binaries suffice). A new dep needing a build script must be added there.

*For M2+:*
- ESLint: root `eslint.config.mjs` (JS + typescript-eslint recommended + prettier) applies to
  `/db` and any future TS package; `/web` has its own config (next core-web-vitals + typescript +
  prettier). Shared compiler options live in `tsconfig.base.json` (strict,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax` — use `import type`).
- `@pandabase/db` is an empty TS-source package (`exports: ./src/index.ts`, no build step); add
  `lint`/`typecheck`/`test` scripts and they're picked up by `pnpm -r`.
- Vitest in `/web` matches `**/*.test.ts` and resolves the `@/` alias; colocate tests.
- Python projects use a `src/` layout with the `uv_build` backend: packages `pandabase_worker` and
  `pandabase_tools`, dev deps in the `dev` dependency group, `requires-python >=3.14`. CI runs
  `uv sync --locked`, so commit `uv.lock` changes.
- `Makefile` has working `install`/`lint`/`typecheck`/`test`/`py-check`/`check` targets;
  `db-reset`, `db-seed`, `contracts` and `smoke` are stubs that exit 1 — replace them in M2/M4/M8.
- `.env.example` lists every env var from DESIGN §8 with placeholder values.

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

**Notes:**

*Versions chosen (checked 2026-10-20):* drizzle-orm **0.45.4**, drizzle-kit **0.31.11** (latest
stable; 1.0 is still `rc`), `@libsql/client` **0.18.0**, `ulid` **3.0.2**, `tsx` **4.23.15** (runs
the scripts), Vitest **5.0** (same as `/web`). All past pnpm's minimum-release-age; no exclusions
added. `esbuild` (via drizzle-kit/tsx) is denied its install script in `allowBuilds` — it ships its
binary as an optional dependency.

*Deviations / choices (DESIGN §2 updated to match):*
- Default local DB is **`db/dev.db` resolved absolutely** (not a cwd-relative `file:./dev.db`), so
  root scripts, `/db` scripts and later `/web` all hit the same file. `TURSO_DATABASE_URL` overrides;
  `.env.example` now leaves it blank (M1-owned file, small edit).
- Scripts don't load `.env` files; export `TURSO_*` in the shell when targeting Turso.
  `db:seed` and `db:reset` refuse non-`file:` URLs (`seed --force` overrides); `db:migrate:prod`
  refuses `file:` URLs and needs `TURSO_AUTH_TOKEN`.
- `pnpm drizzle-kit <cmd>` is a root script forwarding to `/db`'s drizzle-kit (config in
  `db/drizzle.config.ts`, dialect `turso`).
- Ambiguities resolved: "at most one non-closed cycle" → at most one **active** (`open|building|
  ready`) since `skipped`/`other_store` are terminal in §4.7, plus `week_label` unique; "exactly one
  cart account" → partial unique enforces at most one; `review_item.expires_at` nullable only for
  `unverified_item` (§4.6 "never expires"), `default_action` required; `vendor_alias.item_id`
  nullable only when `ignored`; `inventory_event.to_location` set iff `moved`; `inventory_state`
  anchor columns nullable; catalog/receipt-line trust = `confirmed|unverified`;
  `storage_audit` already allowed in the `job_type` CHECK.
- CHECK and partial-index expressions use **unqualified** column names (`col()` helper in
  `schema/common.ts`): Drizzle's default `"table"."col"` would break when drizzle-kit rebuilds a
  SQLite table under a temp name in a future migration.
- Added indexes beyond §2 for obvious access paths (events by item/location/time, jobs by status,
  reviews by status/expiry, telemetry by time and metric).
- CI (web job) now also runs `pnpm drizzle-kit check`, fails if `pnpm db:generate` produces an
  uncommitted migration (schema drift), and runs `pnpm db:reset && pnpm db:seed`. `make db-check`
  does the same locally (part of `make check`; needs a clean `db/migrations`).

*For M3+:*
- Entry points (`@pandabase/db`, TS source, no build): `createDb({ url?, authToken? })` → Drizzle
  `Db` (with `db.$client` = libSQL client), `migrateDb(db)`, `createTestDb()` → fresh migrated
  **in-memory** DB per call (transactions work; close with `db.$client.close()`), all tables and
  enum value arrays (e.g. `INVENTORY_EVENT_KINDS`, `LOCATIONS`, `ACTIVE_CYCLE_STATUSES`), `nowIso()`.
  Subpaths `@pandabase/db/seed` (`seed(db, { seed?, now? })`, `buildSeed`) and
  `@pandabase/db/rebuild-state` (`rebuildInventoryState(db, now?)`, `projectNaive`). No
  repository layer — M3/M4 query with Drizzle directly.
- Imports inside `/db` are extensionless (bundler resolution); `/web` will need `@pandabase/db` as a
  workspace dependency (and likely `transpilePackages` in `next.config.ts`).
- **M3 replaces** `projectNaive` (no decay/shelf life/away days) with the §4.2 projection —
  ideally keep `rebuildInventoryState`'s signature and have it call the domain function.
  Open question for M3: which event `kind` carries `status_override = critical` (the seed writes
  none; it uses `consumed` + `status_override = consumed`).
- Seed (`db/src/seed.ts`, catalog in `seed-data.ts`): fixed "now" `2026-10-20T16:00Z` and RNG seed
  so the DB contents are reproducible; 2 members (`@example.com`), 42 items (incl. one
  unverified "Kombucha" auto-created from the newest paper receipt), 9 items with brand switches
  (+ `preference_event`s, one rejected product), 26 weekly cycles (one `skipped` for the away
  period, one `other_store`) + 1 open cycle with overrides and price quotes, ~40 receipts (Whole
  Foods pickup/in-store paper/delivery + Amazon), 5 pending reviews (receipt, new_product,
  unverified_item, failed_job, trash_cam) and 2 corrected ones with `labeled_observation`s.
  `current_ema_days` is seeded from the simulation's truth (not derived) — M3's rebuild may
  recompute it. Because "now" is fixed, read-time estimates drift as real time passes; pass
  `now` to `seed()` if a test needs it relative to today.


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

**Notes:**

*Versions:* added `@vitest/coverage-v8` **5.0.5** (matches Vitest) to `/web`. Coverage is always on
in `web/vitest.config.mts` over `lib/domain/**` + `lib/config.ts`, with a 95% line threshold on
`lib/domain/**` (currently 100% lines, ~98% branches).

*Resolved M2's open question — the critical flag:* an `observed` event with
`status_override = 'critical'` and a **null quantity** sets the override without moving the
anchor; the next `acquired` clears it. Migration `0001_critical_override_event` makes
`inventory_event.quantity` nullable with a CHECK that allows null only for that shape (`IS
'critical'`, since a plain `=` lets NULL through a CHECK). Schema tests cover both directions.

*Deviations / choices (DESIGN §2.3, §4, §7, §10 updated to match):*
- A **fresh count** (`observed` with a quantity) also replaces an earlier override — otherwise
  "we're out" followed by a check-in of 4 eggs would keep eggs in the cart until the next purchase.
- `discarded`/`presumed_discarded` (not in §4.2's list) subtract from the decayed estimate.
  `consumed` anchors at 0 with kind `observed`.
- **Frozen reserve:** freezer stock of an item that doesn't live in the freezer neither decays nor
  expires, so splitting chicken between fridge and freezer doesn't double its consumption rate.
- **Shelf life is FIFO:** `expired = on_hand − units acquired at that location within the window`.
- Incremental EMA (one receipt at a time) skips the step for a second acquisition on the same
  household day and for late receipts dated before the latest acquisition (`placeAcquisition`).
  The previous acquisition comes from `inventory_event` history — no new item columns.
- One-off promotion to `velocity` excludes static items that have a `reorder_threshold`.
- EMA/overbuy learn from provisional acquisitions too; product stats and preference learning only
  from confirmed lines with a known product (DESIGN §10 #26). PRD §3.3 "only confirmed data feeds
  learning" is read as applying to labels and preferences; the EMA has its outlier guard.
- `applyReceipt` returns **effects** instead of writing (DESIGN §10 #25).
- §4.6 impact "+1 otherwise" read as *1 if neither* (so 10 / 3 / 13 / 1).
- §4.7: explicit `built` event for building → ready; skip / other_store accepted from any active
  state; repeated nudge is a no-op.
- Product's `unit_quantity_trust` for auto-created products is `unverified` (catalog trust has no
  `provisional`).
- `rebuildInventoryState(db, now?, { tz? })` keeps its signature (new optional third arg; `seed()`
  passes its `tz`). It imports the domain module by relative path (`../../web/lib/domain/…`):
  `@pandabase/db` can't depend on `web`, which will depend on it from M4. So **domain modules must
  stay free of `@/` imports and DOM/Next APIs** — `/db`'s `tsc` type-checks them too.
- Seed EMAs: replaying the seed's acquisitions through `replayVelocity` (cold start, no seed EMA)
  gives values within ±25% of the stored `current_ema_days` for all 32 velocity items (derived
  runs ~0–20% higher: the simulation buys ahead of need). The seed's semantics are unchanged —
  it still stores the simulation truth; nothing recomputes it.
- `projectNaive` is gone; `projectRows(items, events, away, now, config?)` replaced it.

*For M4:*
- Entry points (all pure, `web/lib/domain/*`; config in `web/lib/config.ts`):
  - `config.ts`: `DEFAULT_CONFIG`, `Config`, `withSettings(settingRows)` → `{ config, rejected }`
    (log `rejected` keys).
  - `time.ts`: `localDate`, `zonedToUtc`, `isoWeekLabel`, `awayDaysBetween`, `addEffectiveDays`, …
  - `velocity.ts`: `updateVelocity`, `replayVelocity` (backfill), `placeAcquisition`,
    `mergeSameDay`, `shouldPromoteToVelocity`, `trackingTypeForBackfill`.
  - `inventory.ts`: `projectInventory` (+ `estimateVsObserved` diagnostics), `estimateItem` /
    `estimateLocation`, `shelfLifeDiscards` (cron), `checkOverbuy`.
  - `predictions.ts`: `planCart({ items, overrides, vendors, quotes, now, config })`,
    `restockReason`, `cartQuantity`.
  - `productChoice.ts`: `chooseProduct`, `learnFromOverride` (explicit overrides),
    `rejectProduct`, `recordPurchase`, `switchEvent`.
  - `matching.ts`: `normalizeReceiptText`, `tokenSetRatio`, `matchPaperLine`,
    `matchDigitalLine`, `parseUnitQuantity`, `deriveItemName`, `confirmedAlias`.
  - `receipts.ts`: `applyReceipt(input, repo, { config, newId, now })` → `ReceiptEffects`;
    `resolveReceiptReview`; `receiptDedupeKey`; `totalsCheck`.
  - `review.ts`: `newReview`, `dueExpiries` (cron), `impactScore`, `mayCreateLabel`,
    `trustAfterReview`.
  - `cycle.ts`: `transition(cycle, event, now, { away, config })`, `cycleSchedule`,
    `isNudgeDue`, `isBuildDue`, `weekLabelToOpen`, `isOpenOverdue`, `receiptClosesCycle`.
- **Repository M4 must implement:** `ReceiptRepository` (`receipts.ts`): `aliases(vendor)`,
  `canonicalItems()` (unmerged items), `productsByAsin(vendor, asins)`, `item(id)` (maps
  `current_ema_days`→`emaDays`, `ema_outlier_*`→`outlier*`), `products(itemId)`,
  `inventory(itemId)`, `acquisitions(itemId)` (non-expired `acquired` events), `awayPeriods()`,
  `lastBuiltCycle()` (cart lines, vendors, order ids from `cart_result`, please-check ids — the
  `cart_result` shape is M4's to define). Then persist `ReceiptEffects` in one transaction: set
  `source_ref` = receipt id on events, apply `itemPatches` (`emaDays`→`current_ema_days`, …) and
  `productPatches`, insert reviews / preference events, apply `cycle.patch`.
- **Telemetry hooks:** every `ReceiptEffects.telemetry` entry is a `{ metric, …payload }` ready
  for `system_telemetry` (`ema_updated`, `ema_outlier_rejected`, `ema_outlier_accepted`,
  `ema_skipped`, `promoted_to_velocity`, `overbuy`, `receipt_line_match`, `preference_event`).
  Also emit: `projectInventory(...).estimateVsObserved` as `estimate_vs_observed` when an
  observation is recorded; `shelfLifeDiscards` results (they become `presumed_discarded` events);
  `dueExpiries` results as review expiries; `PreferenceEvent`s from `learnFromOverride` /
  `rejectProduct` / `switchEvent`; `withSettings(...).rejected`.
- Not covered by M3 (route-level orchestration for M4): writing the critical flag / "we're out"
  events from the agent, merge suggestions, and turning a confirmed `new_product` merge into an
  `acceptable` product on the target item (`NEW_PRODUCT_STANCE`).


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
