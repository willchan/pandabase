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
                      ├─▶ M6 (worker)       ─┼─▶ M8 (ops & docs) ─▶ M9 (continuous deployment)
                      └─▶ M7 (agent pack)   ─┘
```

M5, M6, M7 can run as **parallel sessions** once M4 is merged; they share only the generated
contracts.

## Status

| Milestone | Status | PR |
|---|---|---|
| M1 Skeleton & CI | done | #2 |
| M2 Schema & seed | done | #3 |
| M3 Domain logic | done | #4 |
| M4 API & contracts | in review | #5 |
| M5 Web UI & auth | todo | |
| M6 Python worker | in review | #8 |
| M7 Agent skill pack & tools | in review | |
| M8 Ops, compose, README | todo | |
| M9 Continuous deployment | todo | |

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

**Notes:**

*Shipped as one PR* (no M4a/M4b split). All 25 routes of DESIGN §3.2 plus
`POST /api/products/{id}/reject` and Auth.js's `/api/auth/[...nextauth]`.

*Versions added:* web: `zod` 4.6.7 (`z.toJSONSchema` — no OpenAPI library needed), `aws4fetch`
1.0.20 (SigV4 query presigning for R2), `next-auth` 5.0.0-beta.32, `drizzle-orm`/`@libsql/client`
(same versions as `/db`), `ulid`, `@pandabase/db` (workspace). Root: `tsx`. Python: `pydantic`
≥ 2.14 (runtime, both projects); `datamodel-code-generator` 0.86.0 pinned in `worker`'s dev group
(the generator runs from `worker/.venv` for both outputs). Lockfiles stay at uv revision 5 — lock
with uv ≥ 0.13 (an older uv rewrites them as revision 3).

*Deviations / choices (DESIGN §2.6, §3, §4.3, §5, §7, §9, §10 #27–29 updated):*
- Generated Python lives at `worker/src/pandabase_worker/contracts.py` and
  `agent/tools/src/pandabase_tools/contracts.py` (the `src/` layout from M1; the plan's paths
  predate it). Wire format is snake_case. `pnpm contracts:gen` = `scripts/gen-contracts.ts`:
  Zod registry + route table → `contracts/openapi.json` (sorted keys; `anyOf [X, null]` flattened
  to `type: [X, "null"]` and date `pattern`s dropped so Pydantic gets plain `str | None` / `date`)
  → `datamodel-codegen` → `ruff`. CI job `contracts` runs it and fails on `git diff`.
- Touched M2's `db/src/env.ts`/`client.ts`: `new URL("…", import.meta.url)` became
  `packagePath("…")` — Turbopack tried to bundle `db/migrations` as an asset when `/web` imports
  `@pandabase/db`. `web/next.config.ts` transpiles `@pandabase/db` and keeps libSQL external.
  The web app's default DB URL is `../db/dev.db` from its cwd (`web/lib/context.ts`).
- API routes call Next's `connection()` first (`AppContext.requestBoundary`): with
  `cacheComponents`, Next otherwise executes GET handlers at build time (it did — and wrote
  telemetry).
- Cycle status route takes `nudged | building | ready | skipped | other_store | closed` (all
  §4.7 events), not just the three terminal ones; `reason` replaces the default close reason.
  `cart-result` also advances an open/building cycle to `ready` (one call after the build).
- `POST /api/inventory/events` kinds: `observed`, `critical` (null-quantity observed +
  override), `consumed`, `discarded`, `moved`, `acquired` (text purchase → one manual receipt per
  vendor through `applyReceipt`, dedupe key `manual:{Idempotency-Key or ULID}:{vendor}`;
  `quantity` = purchase units). Domain addition: `ReceiptLineInput.itemId/productId` → match
  method `manual`, confirmed.
- New domain modules (pure, tested, no `@/` imports): `jobs.ts` (leases, retries, `vendorSlug`,
  `paperReceiptInput`, `resolveTrashCam`), `lookup.ts` (`searchItems`, `lookupAnswer`), and
  `predictions.ts` gained `pleaseCheckReason`/`pleaseCheckList`. New config knobs: `cartVendors`,
  `checkin.*`, `lookup.*`, `jobs.*`, `trashCam.applyConfidence`, `retention.*`,
  `diagnostics.slowRouteMs` (arrays like `cartVendors` can't be overridden by a `setting` row).
- Review expiry: every §4.6 default is "leave as is", so the cron only marks reviews `expired`
  and logs `review_expired`; it reads the default from the review kind, not the stored
  `default_action` (the seed stores `keep` / `keep_unverified`, which differ from the domain's
  names — harmless, but M5 shouldn't rely on the stored value's spelling for seeded rows).
- Telemetry `source`s: `state_engine`, `api`, `cron`, `agent`, `worker`, `session` (DESIGN §7
  lists every metric name and the client payload fields the report reads).
- Not built (no route needs them yet; for M5): receipt-review resolution
  (`resolveReceiptReview` → persist), merge confirmation (`NEW_PRODUCT_STANCE` product on the
  target item), "we're out"/critical from the UI (use `recordInventoryEvents`).
- Shelf-life quirk (a fresh count read as expired) fixed in [#7](https://github.com/willchan/pandabase/pull/7): a count restarts the window.

*For M5 (web UI):*
- Server actions call the services, never the routes: `web/lib/services/*`
  (`cycles.ts`: `currentCycle`, `openCycle`, `addOverride`, `setCycleStatus`, `predictions`,
  `cart`, `checkin`, `recordPriceQuotes`, `recordCartResult`; `inventory.ts`:
  `recordInventoryEvents`, `lookupItems`, `freezerAging`, `createAwayPeriod`, `rejectProductById`;
  `receipts.ts`: `ingestReceipt`/`ingestReceiptIn`, `persistReceiptEffects`; `jobs.ts`;
  `maintenance.ts`). Each takes `ServiceCtx {now, config, actor}`: `now` = `appContext().now()`,
  `config` from `loadConfig(db)` (`web/lib/repo/settings.ts`), `actor = {memberId, system: null}`.
  `appContext().db` is the database. Return values are contract-shaped (snake_case).
- Auth.js: `web/auth.ts` exports `auth`, `signIn`, `signOut`, `handlers` (Google provider, JWT,
  allowlist `signIn` callback); add the sign-in page and middleware. API routes resolve sessions
  through `web/lib/auth/session.ts` (`setSessionResolver` in tests).
- Reads for pages: `loadEstimates` (`web/lib/repo/inventory.ts`), `planFor`
  (`web/lib/services/cycles.ts`), `renderWeekly` (`web/lib/diagnostics/weekly.ts`) for Insights.
- Contracts: `import { … } from "@/lib/contracts"` (Zod schemas + types).

*For M6 (worker):* models in `pandabase_worker.contracts` (`JobClaimRequest/Response`,
`ClaimedJob`, `JobCompleteRequest/Response`, `PaperReceiptResult`, `TrashCamResult`,
`MergeSuggestResult`, `TelemetryRequest`). Auth: `Authorization: Bearer $WORKER_API_TOKEN`.
`POST /api/jobs/claim` `{}` (optional `job_types`) → `{job: ClaimedJob | null}`; upload keyframes
to the presigned `keyframe_uploads[n].url` (PUT) and list their keys in `complete`. Echo
`attempt`; a 409 means the lease was lost — drop the job. Post `result` as the job type's
contract (money in cents) or `{status: "failed", error}`; an invalid result counts as a failed
attempt. Send `Idempotency-Key` on `complete` (retries are safe). Emit `vlm_inference {model,
prompt_version, latency_ms, totals_check, parse_failure}` (and `vlm_parse_failure`) via
`POST /api/telemetry`.

*For M7 (agent pack):* models in `pandabase_tools.contracts`; `Authorization: Bearer
$AGENT_API_TOKEN`; every write that a human asked for carries `actor_discord_id` (403 if unknown —
register members' Discord ids in Settings). Send `Idempotency-Key` on every POST (replays are
returned verbatim for 24h). Cycle flow: `POST …/cycle/open` (idempotent; call it whenever there's
no active cycle) → overrides → Fri `status: nudged` with `GET /api/grocery/checkin` → Sat
`status: building` (may come back `skipped` when away) → `GET /api/predictions` → price quotes for
`needs_price_check_item_ids` → `GET …/cart` → inject → `POST …/cart-result` (cycle → `ready`;
include `order_ids` if seen) → the order's digital receipt closes it (or `status: closed`).
"Do we have X?": `GET /api/items/lookup?q=` → post `matches[0].text`. Text purchases: inventory
events `kind: acquired`. "Never buy X": `POST /api/products/{id}/reject`. Receipt sweep:
`GET /api/receipts/cursor?account={discord id}` → `POST /api/receipts/ingest` (`source: digital`,
`account`, `external_order_id`). Media: `POST /api/media/upload-url` → PUT bytes with the returned
`headers` → `POST /api/jobs` → poll `GET /api/jobs/notifications` → reply → `POST
/api/jobs/{id}/notified`. Weekly: `GET /api/diagnostics/weekly` → write `markdown` to
`/diagnostics/{week}.md` and each extract to `/diagnostics/{week}/{name}`. Emit
`selector_error`, `price_lookup_failed`, `cart_tier1_line`, `clarifying_question {question}` via
`POST /api/telemetry`.

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

**Notes:**

*Models (checked 2026-10-20; ollama.com itself was unreachable from the build session, so the
catalog was read through search results of its library/tag pages):* default
`OLLAMA_VLM_MODEL` = **`qwen3.5:9b`** — Qwen3.5 9B is natively multimodal (text + image, 256K
context); its `latest` tag is `q4_K_M`, 6.6GB on disk, roughly 7–8GB resident with the worker's
`num_ctx` 8192, so it fits the ~8GB budget beside OpenClaw's model and Chromium on the 32GB M6.
Alternatives considered: `qwen3-vl:8b` (6.1GB; the previous Qwen VL generation — a fine fallback),
`gemma4:e4b` (6.6–9.5GB; good general multimodal, rated below Qwen on document OCR), `glm-ocr`
(2.2GB, document-only — no use for Trash Cam), `qwen3.8:27b` / `nemotron-3.5-bolt` (18GB / 25GB —
too big). Receipts are dense small print, so OCR quality decides. `merge_suggest` uses
**`qwen3.5:4b`** (`OLLAMA_TEXT_MODEL`, 3.4GB): the task is short-text judgement over item
names, a 4B instruct model handles it with schema-constrained JSON, and staying in the same
family means the same prompt style and `think: false` behave the same. (Reusing the 9B VLM
would also work — set `OLLAMA_TEXT_MODEL=qwen3.5:9b` to keep one model resident.)

*Versions added:* `httpx` 0.28.1, `pillow` 13.0, `pillow-heif` 1.8.1 (iPhone HEIC uploads).
Locked with uv 0.13.3 (revision 5). Image installs uv 0.13.3 from PyPI in a build stage (no
`ghcr.io/astral-sh/uv` copy), runtime = `python:3.14-slim` + ffmpeg, uid 10001.

*Deviations / choices (DESIGN §1.2, §5, §7, §8, §10 #32 updated):*
- Layout: `src/pandabase_worker/{main,api,http,ollama,media,prompts,telemetry,config}.py`,
  `jobs/{paper_receipt,trash_cam,merge_suggest,context}.py`; run with
  `python -m pandabase_worker`. `http.py` holds the shared retry helper (network/429/5xx, 4
  tries, 1s→2s→4s); `config.py` holds tunables (keep_alive, num_ctx, max px, timeouts).
- Ollama: `/api/chat`, `format` = the job's output JSON schema, `stream: false`,
  `think: false` (dropped and resent if a model rejects it), temperature 0, `keep_alive: "2m"`.
  One repair turn on invalid output. The model's raw replies go in `raw_model_response`
  (`{responses: [...]}`).
- **merge_suggest input** was unspecified: chose `{items: [{item_id, name, aliases?}]}` (2–150
  items) in the job's `input`; the worker can't read the catalog (no worker-scope route).
  Follow-up: promote it to a Zod contract (`MergeSuggestInput`) when something creates these
  jobs (nothing does yet — M5/M8 or a cron).
- Paper receipt: negative lines (discounts) count in the totals check but are not posted;
  unreadable date → today in `HOUSEHOLD_TZ`; unreadable store → `UNKNOWN`. Flagged in telemetry.
- Health gate: before each claim the worker checks `GET /api/tags` and claims only job types
  whose model is pulled (a claim costs an attempt; an Ollama outage would otherwise fail every
  queued job). Reported once per state change as `worker_ollama_unavailable`.
- `claim` is not retried (not idempotent; the next poll retries). `complete` is, with
  `Idempotency-Key: complete:{job_id}:{attempt}`. 409 → drop (`worker_lease_lost`).
- Telemetry beyond DESIGN §7's list: `worker_heartbeat` (added for M9's health check, which
  names a heartbeat but didn't define it), `worker_job_failed`, `worker_lease_lost`,
  `worker_complete_error`, `worker_ollama_unavailable`, plus extra `vlm_inference` fields. They
  reach the weekly `vlm` extract only where the report already reads them (`vlm_inference`
  fields); a "worker health" row in the report is a follow-up (web/lib/diagnostics is M4's).
- Tests: in-memory fake State Engine (leases, attempts, 409, idempotent replay), fake R2 and
  Ollama via `httpx.MockTransport`; Ollama fixtures in `tests/fixtures/ollama/` are synthetic
  responses in Ollama's wire shape (no live model was reachable); the receipt image is rendered
  with Pillow at test time. An autouse fixture fails any real socket connect.
- Local `docker build` in the build session could not reach Docker Hub (429) or
  `deb.debian.org` (network policy), so the image was verified locally without the ffmpeg layer
  (non-root, imports, prompts, SIGTERM → exit 0 in < 1s); the CI job `worker-image` builds the
  real Dockerfile.

*For M8 (ops):*
- Env: `PANDABASE_API_URL`, `WORKER_API_TOKEN`, `OLLAMA_URL` (`http://host.docker.internal:11434`),
  `OLLAMA_VLM_MODEL` (`qwen3.5:9b`), `OLLAMA_TEXT_MODEL` (`qwen3.5:4b`), `POLL_INTERVAL_SECONDS`
  (10), `HOUSEHOLD_TZ`. `PROMPTS_DIR` is set by the image.
- Compose service hints: `build: ./worker`, `restart: unless-stopped`, `env_file: .env`,
  `extra_hosts: ["host.docker.internal:host-gateway"]` (needed on Linux; Docker Desktop has it),
  `stop_grace_period: 5m` (SIGTERM waits for the in-flight job; the lease is 5 min), no ports,
  no volumes, `read_only: true` + `tmpfs: /tmp` is fine (the worker writes nothing to disk).
  Ollama runs natively: `ollama pull qwen3.5:9b qwen3.5:4b`; `OLLAMA_NUM_PARALLEL=1` and
  `OLLAMA_MAX_LOADED_MODELS=1` on the host keep memory bounded.
- `worker_heartbeat {version, vlm_model, text_model, ollama_ok}` is emitted at startup and every
  10 min (`HEARTBEAT_SECONDS`) — the liveness signal M9's deploy health check reads.
- `make smoke` VLM checks: (1) `curl $OLLAMA_URL/api/tags` lists both models; (2) a
  `/api/chat` with `format` + `keep_alive: "2m"` + a small synthetic receipt image returns JSON
  that validates as the paper-receipt schema (`pandabase_worker.jobs.paper_receipt.VlmReceipt`)
  in < 60s; (3) end to end: upload a synthetic receipt, `POST /api/jobs`, wait for
  `GET /api/jobs/notifications` to show it completed with `model`/`prompt_version` set;
  (4) `docker compose stop worker` exits 0 within the grace period.

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

**Notes:**

*OpenClaw findings* (docs at `github.com/openclaw/openclaw/tree/main/docs`, read 2026-10-20 at
commit `d1b8bcc`; npm `openclaw` 2026.10.5. `docs.openclaw.ai` itself was unreachable from the
build sandbox, so the repo's `docs/` tree — the site's source — was used):
- **Skill format** ([tools/skills.md](https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md),
  [tools/creating-skills.md](https://github.com/openclaw/openclaw/blob/main/docs/tools/creating-skills.md)):
  AgentSkills spec. Frontmatter needs `name` + `description`; optional `homepage`,
  `user-invocable` (default true → slash command), `disable-model-invocation`,
  `command-dispatch: tool`. Gating lives in `metadata.openclaw` (JSON5): `requires.bins`,
  `requires.anyBins`, `requires.env`, `requires.config`, `os`, `primaryEnv`, `emoji`, `install`.
  The skill's name comes from frontmatter `name`; skills are snapshotted at session start.
  Per-skill env/secrets: `skills.entries.<name>.env` (injected for the run, host only).
- **Skill locations** (precedence): `<workspace>/skills` > `<workspace>/.agents/skills` >
  `~/.agents/skills` > `~/.openclaw/skills` > bundled > `skills.load.extraDirs`. Workspace roots
  **reject symlinks resolving outside the root** unless `skills.load.allowSymlinkTargets`
  trusts them → DESIGN §6 now installs via `skills.load.extraDirs` (not symlinks).
- **Shell tools**: skills don't declare tools; the agent runs commands with the `exec` tool.
  Default host exec is `mode=full` (no approvals); with `tools.exec.mode: "allowlist"`, chaining,
  pipes and **redirections are rejected** unless every segment is allowlisted
  ([tools/exec.md](https://github.com/openclaw/openclaw/blob/main/docs/tools/exec.md)) → the CLI
  takes JSON via `--json`/`--input FILE` and writes its own files; allowlist only `pandabase-tools`.
- **Cron** ([automation/cron-jobs](https://github.com/openclaw/openclaw/tree/main/docs/automation/cron-jobs)):
  `openclaw automations` (alias `openclaw cron`) `add --cron "0 18 * * 5" --tz
  America/Los_Angeles --session isolated --message "…"`; `--announce --channel discord --to
  channel:<id>` or `--no-deliver`; `--tools exec,…` caps tools. Jobs live in OpenClaw's SQLite
  state — edit via CLI, not JSON (so `cron.example.json` is documentation/input, not a file
  OpenClaw reads). **Command payloads** (`--command`) run a shell command with no model turn and
  announce stdout; printing `NO_REPLY` posts nothing → used for job-result replies. `$skill-name`
  in a message references a skill explicitly.
- **Discord** ([channels/discord/*](https://github.com/openclaw/openclaw/tree/main/docs/channels/discord)):
  threads route as their own sessions inheriting the parent channel's config; `message` tool
  actions `send`, `reply`, `react` (emoji; `""` clears), `thread-create` (`--thread-name`,
  `--message`), `read`; reply tags `[[reply_to:<id>]]`. Adding any guild `channels` entry makes the
  map an **allowlist** — keep a `"*"` entry. Needed config: `#pandabase` with `requireMention:
  false` and `requireMentionInBotThreads: false` (cycle threads are bot-created), other channels
  `requireMention: true` (so "do we have X?" works when mentioned).
- **Inbound images** ([nodes/media-understanding.md](https://github.com/openclaw/openclaw/blob/main/docs/nodes/media-understanding.md)):
  a vision-capable reply model gets photos **natively** unless an image-capable entry in
  `tools.media.models[]` describes them first; `tools.media.image.enabled: false` does *not*
  stop native delivery. → configure `tools.media.models: [{provider: "ollama", model:
  "<OLLAMA_VLM_MODEL>", capabilities: ["image"]}]` (with the model under
  `models.providers.ollama.models[]`, `input: ["text","image"]`) so photos are described locally;
  the skill passes that description to `photo submit` and never inspects pixels. Residual risk
  (documented by OpenClaw): an image whose local description fails may still be delivered
  natively — M8 should consider a text-only model for the agent or scoping media understanding
  to `#pandabase`.
- **Browser** ([tools/browser/*](https://github.com/openclaw/openclaw/tree/main/docs/tools/browser)):
  profiles are `openclaw`-managed, `existing-session` (Chrome DevTools MCP auto-connect, needs a
  human to approve the attach prompt — unsuitable unattended), or remote CDP (`cdpUrl`, with
  `attachOnly: true` for a loopback browser it must not launch). → each member's Chromium runs
  with `--remote-debugging-port`; our tools attach with Playwright `connect_over_cdp`, and the
  agent's tier-2 profile `pandabase-<member>` is `{cdpUrl: "http://127.0.0.1:<port>",
  attachOnly: true}` on the same browser. OpenClaw has no URL denylist for the browser tool
  (only an SSRF policy), so "never checkout" in tier 2 is a skill rule; our own tools enforce it
  in code.

*Deviations / choices (DESIGN §6, §7, §10 #33–37 added; PRD §4.3 one sentence):*
- One CLI, `pandabase-tools` (console script), with subcommands instead of separate
  `cart_injector.py`/`receipt_parser.py` entry points; those are modules of `pandabase_tools`.
  Generic `api get|post <path>` covers every agent route (route table tested against
  `contracts/openapi.json`); `--actor` required on human-attributed routes, `--key` for
  idempotency (skills use `discord:<message id>`).
- Dependencies: `playwright` ≥ 1.63 (sync API, `connect_over_cdp`; no browser download needed —
  we attach), `httpx` 0.28. HTML parsing is stdlib `html.parser` (`dom.py`).
- Cart build is resumable via `state_dir/cart-<cycle>.json` (a `building` cycle → 409 on a
  second `building`, and re-adding would double quantities). `needs_agent` lines are finished by
  the agent and reported with `cart finish` (one `cart-result` call; unreported lines = failed).
- Price checks happen inside `cart build` (product page per candidate, ≤ 20, 1.5 s apart).
- Receipts: collect-then-process, oldest first; 14-day overlap instead of a strict cursor;
  in-flight orders retried next sweep; local `done` set only saves page loads.
- Photo classification and the `photo_classified`/`photo_reclassified` metrics are new
  (heuristic → diagnostics rule): rows added to the weekly report's UX section
  (`web/lib/diagnostics/weekly.ts` + snapshot, an M4-owned file — called out in the PR).
- Job-result replies: `pandabase-tools jobs replies` as a 5-minute command automation (no model
  call), replying to the photo with `[[reply_to:<id>]]` (several at once: one message with jump
  links). Marks jobs notified before printing, so a failed Discord delivery loses that reply
  (the result is still in the web UI).
- Example member names are `will` and `partner`; Discord ids in the examples are placeholders.
- `GET /api/freezer/aging` isn't used by a skill (the check-in already includes the oldest
  freezer items); it stays available via `api get`.
- Tested: guard (checkout/payment/slot/sign-in/other-host URLs refused, CDP route aborts),
  URL building/batching, classification incl. unavailable/not-offered, layout-changed and
  unverified fallbacks, checkout redirect and signed-out handling, price extraction, cart-result
  mapping, build resume, order list/detail parsing (delivery, WF pickup, WF in-store with
  `/gp/product/`), final-state filtering, cursor window, backfill resume, zero-ASIN fallback,
  idempotency keys and retries, lock, CLI, skill frontmatter and every command a skill names.

*For M8:*
- **Install**: `cd agent/tools && uv sync`; put `agent/tools/.venv/bin` on the OpenClaw
  gateway's `PATH` (so `requires.bins: ["pandabase-tools"]` passes); copy the example configs to
  `agent/pandabase.config.json` + `agent/profiles.json` (gitignore them); set `AGENT_API_TOKEN`
  and `PANDABASE_CONFIG` in the gateway's environment (or `skills.entries.<name>.env` for each
  of the five skills). `make install-agent-skills` = add the repo's absolute `agent/skills` path
  to `skills.load.extraDirs` in `~/.openclaw/openclaw.json`, then `openclaw skills check`
  (restart the gateway or start a new session to pick them up). Exec: either default `full`, or
  `tools.exec.mode: "allowlist"` with `pandabase-tools` allowlisted.
- **Cron**: for each `cron.example.json` job, `openclaw automations add --name <name> --cron
  "<cron>" --tz America/Los_Angeles --session isolated --message "<message>" --no-deliver`;
  for the `command` job: `--command "pandabase-tools jobs replies" --command-env
  PANDABASE_CONFIG=… --command-env AGENT_API_TOKEN=… --announce --channel discord --to
  channel:<intake_channel>`. Requires `operator.admin`. Idempotent re-registration: list first
  and `edit` existing names.
- **Discord**: guild config with `#pandabase` `{requireMention: false,
  requireMentionInBotThreads: false, users: [both members]}` and `"*": {requireMention: true}`;
  bot needs Create Public Threads, Send Messages in Threads, Add Reactions, Read Message History.
- **Media**: `tools.media.models` image entry on local Ollama (see findings); verify with
  `openclaw infer image describe --file <sample> --model ollama/<model>`.
- **Chromium per profile**: one Chromium per member, each its own user-data dir (Chrome ≥ 136
  ignores `--remote-debugging-port` on the default data dir), started at login by a LaunchAgent:
  `Chromium --user-data-dir="$HOME/Library/Application Support/PandaBase/chromium-<member>"
  --remote-debugging-port=<9222|9223> --remote-debugging-address=127.0.0.1 --no-first-run`.
  Sign in to Amazon once by hand in each (the tools never sign in). OpenClaw browser profiles:
  `browser.profiles.pandabase-<member> = {cdpUrl: "http://127.0.0.1:<port>", attachOnly: true}`.
  Keep the port bound to loopback (CDP = full control of a signed-in browser).
- **`make smoke`** checks: `pandabase-tools cdp check --member <m>` for each profile (attach +
  open the cart page); `pandabase-tools cart url <ASIN>:1` for one Amazon ASIN and one Whole
  Foods ASIN, opened in the cart member's profile and confirmed by hand or by a tiny script
  using `pandabase_tools.cart_injector.inject` on a one-line cart — if the WF item lands in the
  Whole Foods cart, set `cart.wholefoods_tier1: true`; then remove the test items. Also `api get
  /api/grocery/cycle/current` (agent token round trip) and `jobs replies` (prints `NO_REPLY`).
- **Backfill** (`make backfill`): `pandabase-tools receipts sweep --member <m> --backfill`
  repeated until `complete` (it resumes); or ask the agent "backfill receipts for <m>".

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
(`pnpm db:migrate:prod`, members in Settings, `make backfill`), `make smoke`, diagnostics workflow,
and a manual update procedure for the Mac Mini (`git pull`, `uv sync`, `docker compose up -d --build`)
that M9 automates. Expose that procedure as `make update` so M9 can wrap it.

**Acceptance:**
```
docker compose config
docker compose build
make -n smoke backfill install-agent-skills
```
Plus a fresh-eyes review: someone following README from zero has no missing step (list any manual
steps that can't be scripted).

**Notes:** —

---

## M9 — Continuous deployment

**Goal:** merging to `main` deploys everything safely — web (migrate, then deploy) and the Mac Mini
(pull-based, health-checked, auto-rollback) — with no inbound ports on the home network.

**Read:** DESIGN §1, §8 (incl. *Continuous deployment*), §10 #30–31. M8 Notes. `docker-compose.yml`,
`Makefile`, `.github/workflows/ci.yml`.

**Owns:**
- `.github/workflows/deploy.yml` — on `workflow_run` of CI success on `main`: job `migrate`
  (`pnpm db:migrate:prod`, GitHub environment `production` holding `TURSO_*`) → job `deploy-web`
  (`vercel deploy --prod` via `VERCEL_TOKEN`/`VERCEL_ORG_ID`/`VERCEL_PROJECT_ID`) → job
  `publish-worker` (build + push `ghcr.io/willchan/pandabase-worker:{sha,main}`). Concurrency group
  so deploys never overlap. Emits a `deploy` telemetry event per component via the API.
- Preview path: on PRs, migrate `pandabase-preview` before Vercel's preview build (or document why
  Vercel's preview integration suffices). Vercel production auto-deploy disabled (`vercel.json`
  `git.deploymentEnabled.main = false`).
- `scripts/deploy/mac-update.sh` + `make update` (replacing M8's manual one) +
  `ops/launchd/com.pandabase.update.plist` (every 15 min):
  newer `main` sha with green CI (check via GitHub API with a read-only token, or the GHCR tag's
  existence) → skip inside quiet windows (Fri 17:30–19:00, Sat 09:30–12:00 household TZ) → record
  current sha/image → `git pull --ff-only` → `uv sync` (tools) → `docker compose pull && up -d` →
  health check (worker heartbeat telemetry seen within 2 min + agent-token API round trip) → on
  failure roll back to recorded sha/image and post once to `#pandabase` (via a tiny Discord webhook
  or the agent) → emit `deploy` telemetry either way. Lockfile so runs never overlap.
- `docker-compose.yml`: worker uses the GHCR image by tag (`PANDABASE_WORKER_TAG`, default `main`),
  local build still possible via an override file.
- `web/lib/diagnostics`: a *Deploys* section (component, sha, outcome, rollbacks) in the weekly report.
- `CLAUDE.md` rule (already added): backward-compatible migrations. Add a CI check if cheap (e.g.
  flag `DROP COLUMN`/`DROP TABLE`/`RENAME` in new migrations unless the PR carries a
  `contract-migration` label or marker comment).
- README: deploy secrets setup (GitHub environment, Vercel token, GHCR auth on the Mac Mini,
  launchd install), how to pause auto-update, how to roll back by hand.

**Acceptance:**
```
actionlint .github/workflows/*.yml
shellcheck scripts/deploy/*.sh
bats scripts/deploy/tests        # or pytest: quiet-window logic, no-op when up to date,
                                 # rollback on failed health check (docker/git stubbed)
plutil -lint ops/launchd/*.plist # if available; else xmllint --noout
pnpm --filter web test -- lib/diagnostics
```
Plus a dry run documented in the PR: `make update DRY_RUN=1` output against a stubbed newer sha.

**Out of scope:** blue/green or canary deploys; deploying OpenClaw itself.

**Notes:** —
