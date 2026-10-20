# PandaBase — Design

> Living document. Describes **how** PandaBase works. Any PR that changes architecture, schema,
> API contracts, or algorithms updates this file in the same PR. Product intent lives in
> [PRD.md](PRD.md); build sequencing in [PLAN.md](PLAN.md).

## 1. Architecture

```
                         ┌──────────────────────── Vercel ────────────────────────┐
  Will / wife ──Google──▶│  /web  Next.js (App Router) — UI + API routes           │
   (phone)               │        Auth.js v5 (Google, allowlist)                   │
                         │        Drizzle ORM ──────────────▶ Turso (libSQL)       │
                         │        Vercel Cron: /api/cron/maintenance (daily)       │
                         └───────▲───────────────────▲────────────────────────────┘
                                 │ HTTPS (bearer)    │ HTTPS (bearer)
                                 │ AGENT token       │ WORKER token
  ┌──────────────── Mac Mini (M6, 32GB) — outbound connections only ──────────────┐
  │  OpenClaw (existing, native)          docker-compose                          │
  │   ├─ PandaBase skill pack  ◀─────┐     └─ worker (Python)                     │
  │   │   /agent/skills/*/SKILL.md   │          ├─ polls /api/jobs/claim          │
  │   ├─ /agent/tools/*.py           │          ├─ FFmpeg, image prep             │
  │   │   (CDP → Chromium profiles)  │          └─ Ollama client ──┐              │
  │   ├─ cron (Fri/Sat/daily/Sun)    │                             ▼              │
  │   └─ Discord channel ◀──────────────▶ Discord      Ollama (native, Metal)    │
  │  Chromium profiles: will, wife (logged in to Amazon)                          │
  │  /diagnostics (gitignored; weekly reports + JSONL)                            │
  └───────────────────────────────────────────────────────────────────────────────┘
                     Media: Cloudflare R2 (presigned PUT/GET; no media through Vercel)
```

**Ownership rule:** the State Engine (`/web` + `/db`) owns *all* business logic and is the only
component that touches the database. The worker and agent tools are clients of the HTTP API.

### 1.1 Components

| Component | Runs on | Responsibility |
|-----------|---------|----------------|
| `/web` | Vercel | UI, API, domain logic (velocity, estimation, matching, product choice, cycles), diagnostics rendering, daily maintenance cron |
| `/db` | (package) | Drizzle schema, migrations, seed (`@pandabase/db`) |
| `/worker` | Mac Mini, Docker | Claims media jobs, prepares images/frames, calls Ollama VLM, posts structured results. Stateless. |
| `/agent/skills` | Mac Mini, existing OpenClaw | Natural-language skills: conversation, scheduling, orchestration |
| `/agent/tools` | Mac Mini, invoked by OpenClaw | Deterministic Python: cart injection, receipt parsing, API client |
| Ollama | Mac Mini, native | Local VLM inference (Metal). Not in Docker: Docker on macOS has no GPU access. |
| R2 | Cloudflare | Media + keyframes |

### 1.2 Mac Mini resource budget

32GB shared by: OpenClaw's own model, Chromium (2 profiles, rarely concurrent), the VLM, and
evening Claude Code sessions. Therefore:

- Worker concurrency = **1**, always.
- VLM requests use `keep_alive: "2m"` so the model unloads soon after a burst.
- Default VLM is **`qwen3.5:9b`** (Qwen3.5 9B, natively multimodal; `q4_K_M` ≈ 6.6GB on disk,
  ~7–8GB resident with the worker's 8K context), chosen from Ollama's catalog in Oct 2026 over
  `qwen3-vl:8b` (older generation, similar size) and `gemma4:e4b` (stronger general chat, weaker
  document OCR); configurable via `OLLAMA_VLM_MODEL`. Requests turn thinking off (`think: false`).
- `merge_suggest` (text only) uses **`qwen3.5:4b`** (≈ 3.4GB, `OLLAMA_TEXT_MODEL`).
- Requests use `num_ctx` 8192 to keep the KV cache small. The worker only claims job types whose
  model is pulled (`GET /api/tags`), since every claim costs the job an attempt.
- Only one Chromium profile is driven at a time (tools take a file lock).

## 2. Data model

All tables have `id` (text, ULID), `created_at`, `updated_at` (UTC ISO-8601 text) unless noted.
Quantities of items are in the item's **base unit** (e.g. eggs, not cartons). Money is integer
cents. Enums are text with CHECK constraints.

Conventions (schema in `db/src/schema/`, one file per subsection below):
- ULIDs are generated app-side. Timestamps are `YYYY-MM-DDTHH:MM:SS.sssZ` (what
  `Date.toISOString()` emits); the column also has an SQL default in the same format, and Drizzle
  bumps `updated_at` on update. Dates without time (`away_period`) are household-TZ `YYYY-MM-DD`.
- Booleans are integer 0/1 with a CHECK; JSON columns are text with `CHECK (json_valid(...))`.
- Exceptions to the `id`/`created_at`/`updated_at` trio: `setting` and `inventory_state` (natural
  primary keys), `system_telemetry` (append-only: no `updated_at`), `idempotency_key` (natural
  key, `created_at` only).
- "Trust" for catalog and receipt rows (`item`, `product.unit_quantity_trust`, `vendor_alias`,
  `receipt_line`) is `confirmed`|`unverified`; inventory events use their own set (§2.3).

### 2.1 People & settings

**member** — `email` (unique), `display_name`, `discord_user_id` (unique), `chromium_profile`,
`amazon_sweep` (`daily`|`weekly`|`off`), `is_cart_account` (bool; exactly one true — the schema
enforces *at most one* with a partial unique index; the app keeps one set).

**setting** — `key` (pk), `value` (json). Household-tunable defaults (thresholds, windows) that the
UI can edit. Code defaults live in `web/lib/config.ts`; a row overrides.

**away_period** — `starts_on`, `ends_on` (dates, household TZ), `note`, `created_by_member_id`.

### 2.2 Catalog

**item** — the *need* ("Eggs").
- `canonical_name`, `category`, `default_location`
  (`fridge`|`freezer`|`pantry`|`bathroom`|`utility`|`garden`|`garage`)
- `tracking_type` (`velocity`|`static`), `base_unit` (e.g. `egg`, `count`, `oz`)
- `current_ema_days` (real, nullable — **days one base unit lasts**), `default_ema_days` (seed)
- `ema_outlier_streak` (int), `ema_outlier_direction` (`high`|`low`|null)
- `reorder_threshold` (real, static items), `shelf_life_days` (int, nullable), `audit_hint` (text)
- `switch_threshold` (real, default 0.15) — see §4.4
- `trust` (`confirmed`|`unverified`), `merged_into_item_id` (nullable)

**product** — a concrete purchasable thing for an item.
- `item_id`, `vendor` (`amazon`|`wholefoods`|store slug), `asin` (nullable), `title`
- `unit_quantity` (real, base units per purchase unit), `unit_quantity_trust`
- `stance` (`preferred`|`acceptable`|`rejected`), `preference_score` (real)
- `times_bought`, `consecutive_buys`, `last_bought_at`, `last_price_cents`, `last_price_at`
- unique (`vendor`, `asin`) where asin not null

**vendor_alias** — maps external strings to products/items.
- `vendor`, `kind` (`receipt_text`|`asin`), `vendor_string` (normalized), unique (vendor, kind, vendor_string)
- `item_id` (nullable only when `ignored`), `product_id` (nullable), `confidence_score` (0–1; 1.0
  when human-confirmed)
- `trust`, `ignored` (bool — the ignore list for ASINs and store fee lines)

### 2.3 Inventory

**inventory_event** — append-only log; the source of truth.
- `item_id`, `location`, `kind` (`acquired`|`observed`|`consumed`|`discarded`|`presumed_discarded`|`moved`)
- `quantity` (base units; for `observed` it's the absolute amount; for `moved` the moved amount),
  `to_location` (set iff `kind = moved`), `status_override` (`critical`|`consumed`|null);
  `quantity ≥ 0`. `quantity` is null only for the **critical flag**: an `observed` event with
  `status_override = critical` that sets the override without moving the anchor (CHECK-enforced).
  "We're out" is a `consumed` event with `status_override = consumed`.
- `occurred_at`, `source` (`digital_receipt`|`paper_receipt`|`manual`|`trash_cam`|`checkin`|`backfill`|`task`|`system`),
  `source_ref` (receipt/job/cycle id)
- `actor_member_id` (nullable), `actor_system` (`agent`|`worker`|`cron`|null)
- `trust` (`confirmed`|`provisional`|`expired`)

**inventory_state** — cached projection, pk (`item_id`, `location`).
- `anchor_qty`, `anchor_at`, `anchor_kind` (`acquired`|`observed`) — nullable (a row may carry
  only an override)
- `status_override`, `frozen_at`, `last_verified_at`

Rebuildable from events at any time (`pnpm db:rebuild-state`; ignores `expired` events. M2 ships a
naive fold; since M3 it calls `projectInventory` from `web/lib/domain/inventory.ts`). Estimates are computed at read time
(§4.2) and never stored.

### 2.4 Receipts

**receipt** — `source` (`digital`|`paper`|`manual`), `vendor`, `account_member_id` (nullable),
`external_order_id` (nullable), `dedupe_key` (unique: `digital:{account}:{order_id}` /
`paper:{vendor}:{date}:{total}` / `manual:{idempotency key}`), `fulfillment`
(`delivery`|`pickup`|`in_store`|`unknown`), `ordered_at`, `acquired_at`, `subtotal_cents`,
`total_cents`, `totals_check` (`pass`|`fail`|`n/a`), `job_id`, `status` (`applied`|`pending_review`|`partial`).
`acquired_at` is required (it feeds the paper dedupe key and the EMA); `ordered_at` is nullable.

**receipt_line** — `receipt_id`, `raw_text`, `asin`, `product_id`, `item_id`, `qty` (purchase
units), `unit_price_cents`, `line_total_cents`, `match_method`
(`asin`|`alias_exact`|`fuzzy`|`manual`|`none`), `match_score`, `trust`, `ignored`.

### 2.5 Jobs, review, labels

**audit_job** — `job_type` (`paper_receipt`|`trash_cam`|`merge_suggest`; `storage_audit` reserved
for v1.1 and already allowed by the CHECK), `status` (`queued`|`claimed`|`completed`|`failed`), `media_r2_key`,
`keyframe_r2_keys` (json), `expected_state_snapshot` (json, nullable), `input` (json),
`raw_model_response` (json), `result` (json), `model`, `prompt_version`, `attempts`,
`claimed_at`, `lease_expires_at`, `error`, `actor_member_id`, `cycle_id`,
`discord_channel_id`, `discord_message_id`, `notified_at`, `completed_at`.

**review_item** — one actionable unit in the Cleanup/This Week UI.
- `kind` (`receipt`|`new_product`|`merge_suggestion`|`unverified_item`|`failed_job`|`trash_cam`)
- `job_id`, `receipt_id`, `item_id`, `payload` (json: detected name, suggestions, delta)
- `urgency` (`this_week`|`cleanup`), `impact_score` (real; higher = affects this week's cart)
- `status` (`pending`|`confirmed`|`corrected`|`dismissed`|`expired`)
- `default_action` (json — what happens on expiry; required), `expires_at` (required except for
  `unverified_item`, which never expires — §4.6)
- `reviewed_by_member_id`, `reviewed_at`

**labeled_observation** — created only from human confirmation/correction.
`source_kind` (`receipt_line`|`trash_cam`|`checkin`), `job_id`, `keyframe_r2_key`, `bbox` (json),
`model_output` (json), `human_label` (json), `model`, `prompt_version`, `member_id`.

### 2.6 Grocery cycle & preferences

**grocery_cycle** — `week_label` (e.g. `2026-W43`), `discord_thread_id`, `status`
(`open`|`building`|`ready`|`closed`|`skipped`|`other_store`), `opened_at`, `nudge_sent_at`,
`built_at`, `closed_at`, `close_reason`, `cart_result` (json: `{vendors, order_ids, lines:
[{item_id, product_id, asin, free_text, quantity, outcome: tier1|tier2|failed, error}],
please_check_item_ids, recorded_at}` — contract `CartResult`). `week_label` is unique (opening is
idempotent per week). At most one *active* cycle (`open`|`building`|`ready`; `closed`, `skipped`
and `other_store` are terminal per §4.7), enforced by a partial unique index.

**grocery_cycle_override** — `cycle_id`, `kind` (`add`|`skip`|`qty`|`product`), `item_id`
(nullable), `free_text` (nullable, one-off adds), `quantity`, `product_id`, `actor_member_id`.
Needs `item_id`, or `kind = add` with `free_text`.

**price_quote** — `cycle_id`, `product_id`, `price_cents`, `observed_at`, `source` (`agent`).

**preference_event** — `item_id`, `kind`
(`switch`|`override_to_preferred`|`override_to_cheaper`|`implicit_swap`|`reject`|`auto_promote`),
`from_product_id`, `to_product_id`, `threshold_before`, `threshold_after`, `cycle_id`.

### 2.7 Platform

**system_telemetry** — `source`, `metric_type`, `payload` (json), `created_at`. Retained 180 days.

**idempotency_key** — pk (`key`, `scope`), `response_status`, `response_body` (json), `created_at`.
Retained 24h.

## 3. API

All routes under `/web/app/api`. Payloads defined once as **Zod schemas** in `web/lib/contracts/`.
`pnpm contracts:gen` emits `contracts/openapi.json`; Python models are generated from it
(`datamodel-code-generator`, Pydantic v2) into `worker/src/pandabase_worker/contracts.py` and
`agent/tools/src/pandabase_tools/contracts.py`. CI fails if generated files are stale.

- **Wire format:** snake_case JSON; money in integer cents; timestamps ISO-8601 instants (any
  offset accepted, stored and returned as `toISOString()` UTC); household dates `YYYY-MM-DD`;
  quantities in base units unless a field says purchase units.
- **Route table:** `web/lib/contracts/routes.ts` lists every route (method, path, scopes,
  idempotent, body/query/response schemas). Handlers are built from it (`handle(def, fn)` in
  `web/lib/route.ts`: `withAuth` → Zod-validate query/body → service call → JSON), and the
  OpenAPI document is generated from it, so routes and contracts can't drift.
- **Errors:** `{error, details?}` with 400 (invalid JSON / contract; `details` = issue paths), 401
  (no/invalid credentials), 403 (wrong scope, email not allowed, unknown `actor_discord_id`), 404,
  409 (invalid cycle transition, inactive cycle, stale job attempt), 500.
- **Layers:** route handlers stay thin; orchestration lives in `web/lib/services/*` (shared with
  M5's server actions), reads/writes in `web/lib/repo/*` (Drizzle), rules in `web/lib/domain/*`.
  Each mutating service commits in one transaction and emits its telemetry inside it.
- API routes are never prerendered: `withAuth` awaits Next's `connection()` first, so nothing
  runs (or writes) at build time.

### 3.1 Auth

- **Session** (Auth.js v5, Google, JWT sessions; config in `web/auth.ts`): `signIn` callback
  rejects emails not in `ALLOWED_EMAILS`. Session users have every scope except `cron`; an API
  request with a session is re-checked against the allowlist and acts as the member with that email.
- **Bearer tokens:** `AGENT_API_TOKEN` (scope `agent`), `WORKER_API_TOKEN` (scope `worker`),
  `CRON_SECRET` (scope `cron`). Constant-time compare (SHA-256 then `timingSafeEqual`); an unset
  secret never matches. A bearer header wins over a session. One `withAuth(scopes, handler)`
  wrapper on every route (`web/lib/auth/withAuth.ts`).
- **Actor:** agent writes include `actor_discord_id`; unknown IDs → 403, missing on routes that
  attribute to a human (overrides, inventory events, receipts ingest, jobs, away periods, product
  reject) → 400. Events record `actor_member_id` and `actor_system` (`agent` for the agent acting
  for a member, `worker`, `cron`); session writes record only the member.
- **Idempotency:** mutating routes (every POST except `/api/jobs/claim`, which hands out leases)
  honor `Idempotency-Key` (≤ 200 chars). The key is scoped to `{principal scope}:{METHOD path}`;
  responses with status < 500 are stored and replayed verbatim with `Idempotent-Replayed: true`
  for 24h. Manual receipts and text purchases also use the key as their dedupe key.
- **Dev:** `DEV_AUTH_BYPASS=1` works only when `NODE_ENV=development` (acts as the first member by
  email).
- **Cron:** `/api/cron/maintenance` requires `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron,
  `web/vercel.json`, daily 11:17 UTC).
- **Latency middleware:** every request logs `api_request {route, method, status, latencyMs,
  scope}` (source `api`); a telemetry failure never fails the request.

### 3.2 Routes (v1)

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/grocery/cycle/current` | agent | Current non-closed cycle (or null) |
| `POST /api/grocery/cycle/open` | agent | Open a new cycle (idempotent: returns the active cycle, filling in its thread if the cron opened it); body: `discord_thread_id` |
| `POST /api/grocery/cycle/{id}/overrides` | agent | add/skip/qty/product; free-text adds allowed; a `product` override that differs from the plan's choice teaches the switch threshold (§4.4) |
| `POST /api/grocery/cycle/{id}/status` | agent | §4.7 transitions: `nudged` / `building` (→ `skipped` if away) / `ready` / `skipped` / `other_store` / `closed`, optional reason; invalid → 409 |
| `GET /api/grocery/checkin` | agent | Friday nudge lists: likely_needed, please_check, freezer, pending_review_count |
| `GET /api/predictions?cycle_id=` | agent | Cart plan: lines with item, qty, candidate products, `needs_price_check` |
| `POST /api/grocery/price-quotes` | agent | Agent-observed prices for candidates |
| `GET /api/grocery/cycle/{id}/cart` | agent | Final cart lines (product chosen, reason text) after quotes |
| `POST /api/grocery/cycle/{id}/cart-result` | agent | Per-line injection outcome (tier1/tier2/failed), vendors, order ids; an open/building cycle becomes `ready` |
| `GET /api/items/lookup?q=` | agent | "Do we have X?" — matches + estimate + confidence text |
| `POST /api/inventory/events` | agent | Counts (`observed`), `critical` flags, `consumed` ("we're out"), `discarded`, `moved` ("froze the chicken"), text purchases (`acquired` → a manual receipt through `applyReceipt`) |
| `GET /api/freezer/aging?limit=` | agent | Oldest freezer stock |
| `POST /api/away-periods` | agent | Create away period (re-projects `inventory_state`) |
| `POST /api/products/{id}/reject` | agent | "Never buy X": stance `rejected` + `reject` preference event |
| `GET /api/receipts/cursor?account=` | agent | Last ingested `external_order_id`/date for a member's account |
| `POST /api/receipts/ingest` | agent | Digital/manual receipt JSON → resolve, apply, EMA |
| `POST /api/media/upload-url` | agent | R2 presigned PUT for a new media key |
| `POST /api/jobs` | agent | Create audit job |
| `GET /api/jobs/notifications` | agent | Completed/failed jobs not yet replied to in Discord |
| `POST /api/jobs/{id}/notified` | agent | Mark reply sent |
| `POST /api/jobs/claim` | worker | Lease next queued job (+ presigned media GET and keyframe PUT URLs); `{job: null}` when empty |
| `POST /api/jobs/complete` | worker | Result or failure for the claimed attempt (`attempt` echoed; stale → 409) |
| `POST /api/telemetry` | agent, worker | Telemetry events (batched) |
| `GET /api/diagnostics/weekly?week=` | agent | Rendered Markdown + JSONL extracts |
| `GET /api/cron/maintenance` | cron | Expire review items, shelf-life discards, release stale leases, purge idempotency/telemetry, open an overdue cycle |

UI mutations use server actions that call the same domain functions as the routes.

The outline's chore routes (`/api/tasks/*`) are deferred to v2 ([ROADMAP.md](ROADMAP.md)).

## 4. Algorithms

All tunables live in `web/lib/config.ts` (`DEFAULT_CONFIG`; a `setting` row whose key is a dotted
path, e.g. `ema.alpha`, overrides it via `withSettings`, which rejects unknown keys and wrong
types). Pure functions in `web/lib/domain/` take plain data and a `Config`, and are table-tested
(≥ 95% line coverage). Learning steps return their telemetry payloads; callers (M4) emit them.

### 4.1 Velocity (EMA)

`current_ema_days` = days one base unit lasts. On each **acquisition event** (after same-day merge)
for a velocity item:

```
elapsed   = days(prev_acquired_at → this_acquired_at) − away_days_in_between
observed  = elapsed / prev_acquired_base_units
if ema is null:
    if default_ema_days: ema = default_ema_days   # seed, then continue to update
    elif first acquisition: record only; stop
    else: ema = observed; stop                     # second acquisition
if observed > 3.0 × ema or observed < 0.25 × ema:   # trip/off-system buy, or stock-up
    streak in same direction += 1
    if streak < 3: log telemetry 'ema_outlier_rejected'; stop
    # 3 in a row = real habit change → accept below
streak = 0
ema = 0.7 × ema + 0.3 × observed
```

- Same-day merge: acquisitions of the same item on the same household-TZ date sum into one (at =
  the earliest). Applied one receipt at a time (`placeAcquisition`), a second acquisition on the
  latest date skips the EMA step (that date's step already ran; the merge only changes the next
  step's `prev_acquired_base_units`, which is recomputed from the event history). A late receipt
  dated before the latest acquisition also skips the EMA (telemetry `ema_skipped`).
- `prev_acquired_*` come from the item's non-expired `acquired` events (no extra item columns).
- Thresholds are strict: `observed` exactly 3× or 0.25× the EMA is not an outlier. A streak in the
  other direction restarts at 1. Telemetry: `ema_updated`, `ema_outlier_rejected`,
  `ema_outlier_accepted` (the third-in-a-row habit change).
- Backfill replays receipts chronologically through the same function (`replayVelocity`).
- Static items never use EMA.
- A one-off product (bought once in the 12-month backfill) creates a `static` item; a second
  purchase within 6 months (`promoteToVelocityWithinDays` = 183) promotes it to `velocity` and
  starts its EMA. Static items with a `reorder_threshold` are static by design and never promoted.

### 4.2 Inventory estimate

Projection per (item, location) from the event log:

- `acquired` → `anchor_qty = estimate_at(t) + qty`, `anchor_at = t`
- `observed` → `anchor_qty = qty` (absolute), `anchor_at = t`, `last_verified_at = t`; a fresh
  count also replaces any earlier override (with its own, usually null)
- `observed` with null quantity + `status_override = critical` → sets the override only
- `consumed` → `anchor_qty = 0` (anchor kind `observed`) and `status_override = consumed`
- `discarded` / `presumed_discarded` → `anchor_qty = estimate_at(t) − qty` (floored at 0)
- `moved` → subtract from source, add to destination; destination freezer stamps `frozen_at`;
  emptying a location clears its `frozen_at`
- the next `acquired` clears `status_override`
- `expired` events are ignored; decay between events uses the item's *current* EMA.

**Frozen reserve:** stock in the freezer of an item whose `default_location` isn't the freezer
doesn't decay and has no shelf life — otherwise splitting stock across locations would double the
consumption rate. Items that live in the freezer decay there normally.

Read-time estimate for velocity items:

```
on_hand(t) = max(0, anchor_qty − days(anchor_at → t, minus away days) / ema)
runout(t)  = anchor_at + anchor_qty × ema (+ away days)
status     = override ?? (on_hand == 0 → out | runout ≤ today+3 → low | stocked)
```

`runout ≤ today+3` compares household-local dates (`lowWithinDays` = 3). A row with no anchor is
`unknown`. Velocity items without an EMA yet don't decay (no runout). Item-level estimates sum
locations; an override anywhere wins (`critical` over `consumed`); runout is when the combined
stock runs out.

Static items: `on_hand = anchor_qty` (no decay); `out` at 0, `low` when `≤ reorder_threshold`.

**Shelf life:** if `shelf_life_days` is set, units acquired more than `shelf_life_days` ago are
dropped from the estimate and a `presumed_discarded` event is logged (trust `provisional`; the
daily cron writes them via `shelfLifeDiscards`). FIFO: what's on hand is assumed to be the newest
units, so `expired = max(0, on_hand − units in batches started at that location within the window)`.
Each `acquired` event starts a batch; a count (`observed` with a quantity) replaces the location's
earlier batches with one batch of the counted units, fresh as of the count — a count replaces the
estimate, so it replaces the freshness clock too (`freshnessBatches`). A null-quantity `critical`
flag counts nothing and leaves the clocks alone. Counted units still age out `shelf_life_days`
after the count.

**Overbuy:** on acquisition of a velocity item, if the stock already on hand would have lasted
`on_hand_before × ema ≥ overbuyDaysOfStock` (default 14 days), log telemetry `overbuy`.
Static items: overbuy if `on_hand_before > reorder_threshold × 2`. No EMA / no threshold → no check.

**Estimate error:** every `observed` event logs `estimate_vs_observed {estimated, observed, item}`.
In v1 this does **not** modify the EMA; it's a diagnostic.

### 4.3 Restock flag (predictions)

An item is in the cart plan if:

```
(velocity and runout ≤ today + 3)  or  status_override == critical/consumed
or (static and on_hand ≤ reorder_threshold)
```

then apply cycle overrides (skip removes, qty replaces, add inserts including free text).
Quantity: velocity → enough purchase units of the chosen product to cover `ema`-based need until
the next cycle (min 1): `ceil((cartCoverDays / ema − on_hand) / unit_quantity)`, `cartCoverDays` =
7; static (or no EMA yet) → 1 purchase unit unless overridden. A line with no candidate product is
sized in base units. Overrides apply in order; a `product` override re-sizes the line for the new
pack unless a human set the quantity; `add` / `qty` on an unflagged item inserts it.

**Check-in lists** (`GET /api/grocery/checkin`, PRD §4.1): *likely needed* = plan lines with a
restock reason; *please check* = items not in the plan (nor skipped) whose runout is within
`lowWithinDays + checkin.pleaseCheckMarginDays` (4) days, or that have an `audit_hint` and no count
in `checkin.staleVerifiedDays` (21) — near-runout first, capped at `checkin.pleaseCheckMax` (6);
*freezer* = the `checkin.freezerOldest` (3) oldest freezer rows with stock (by `frozen_at`, else
anchor time). The please-check ids are stored in `cart_result` when the cart is built (review
impact, §4.6). **Lookup** (`GET /api/items/lookup`): canonical names by token-set score
≥ `lookup.minScore` (top `lookup.maxResults`), each with its estimate and a one-line answer —
high confidence after a count within `lookup.freshVerifiedDays`, medium after a confirmed
purchase or an older count, low otherwise (`web/lib/domain/lookup.ts`).

### 4.4 Product choice

Candidates = products of the item with stance ≠ rejected and vendor in the cart vendor set.

1. One candidate → choose it.
2. Several → `needs_price_check = true`; the agent reads current prices (tier 2 browser) and posts
   `price_quotes`. Missing quotes fall back to `last_price_cents`.
3. `preferred` = stance preferred, else highest `preference_score`, else most `times_bought`
   (ties by id). If the preferred or cheapest price is unknown, choose `preferred`.
4. Choose `cheapest_per_unit` instead of `preferred` iff
   `unit_price(preferred) − unit_price(cheapest) > switch_threshold × unit_price(preferred)`.
5. Emit a reason string ("28% cheaper per egg than your usual Vital Farms").

Learning (each writes a `preference_event`):

| Signal | Effect |
|---|---|
| Override toward pricier preferred | `switch_threshold += 0.05` (cap 0.6) |
| Override toward cheaper / different product | `switch_threshold −= 0.03` (floor 0.0); chosen `preference_score += 1` |
| Receipt shows a different product than the cart line (implicit swap) | as above, plus `implicit_swap` |
| "Never buy X" | stance `rejected` |
| Same product bought 3 consecutive times | stance `preferred` (previous preferred → acceptable) |

New ASINs bought for an item are added as `acceptable`. Thresholds stay on a 0.01 grid. An implicit
swap writes one `implicit_swap` event (not also `override_to_cheaper`). A `rejected` product is
never auto-promoted. Product stats and preference learning only use **confirmed** receipt lines
with a known product. A cart build that picks the cheaper product logs a `switch` event.

### 4.5 Receipt resolution

**Digital:** line ASIN → `vendor_alias(kind=asin)` / `product.asin` → item. Unknown ASIN →
auto-create `product` + `unverified` item (title-derived name, `unit_quantity` parsed from title,
else 1 with trust provisional) + a `new_product` review item (merge/ignore; default on expiry:
keep as is). Ignored ASINs are skipped.

**Paper:** normalize `raw_text` (upper-case, collapse whitespace, strip prices/codes), then:

| Match | Action | Trust |
|---|---|---|
| Exact `vendor_alias(vendor, receipt_text)` with confidence 1.0 | apply | confirmed |
| Fuzzy best ≥ 0.85 (token-set ratio vs this vendor's aliases, then all canonical names) | apply | provisional |
| Else | pending in receipt review item; expires 14 days → no effect | — |
| Ignored alias (bag fee, CRV, tax) | skip | — |

Confirming the receipt review item upgrades provisional lines to confirmed, writes/strengthens
aliases (confidence 1.0), and writes `labeled_observation`s. Correcting a provisional line
reverses its inventory event and applies the corrected one.

All receipts → one `applyReceipt()` path: inventory events, product stats, EMA, implicit-swap
detection against the last cycle's cart, overbuy check, cycle closure if it matches the cycle's
order.

Implementation notes (`web/lib/domain/receipts.ts`):
- `applyReceipt(input, repo, ctx)` reads through a `ReceiptRepository` and **returns effects**
  (rows to insert, patches, reviews, cycle patch, telemetry) without writing; M4 commits them in
  one transaction.
- Auto-created items: `static`, `unverified`, base unit `count`, location `pantry`, category
  `Uncategorized`. Catalog trust has no "provisional", so the product's `unit_quantity_trust` is
  `unverified` whether parsed or defaulted to 1.
- Base units = `qty × unit_quantity` of the line's product, else of the item's preferred product
  at that vendor (12- vs 18-packs normalize to eggs). Lines of one item on a receipt sum into one
  `acquired` event, `provisional` if any of them is.
- EMA and overbuy run on every non-expired acquisition, provisional included (§4.1's outlier guard
  is the safety net; a corrected line's event is reversed but the EMA step isn't).
- Ignored aliases match exactly only (a fuzzy "ignore" could silently drop an item). Fuzzy ties
  (token-set scores subsets as 1.0) break on the plain ratio of the whole strings.
- The receipt review item lists pending *and* provisional lines (impact from the cycle's cart /
  please-check lists). Receipt status: `partial` if some lines pending, `pending_review` if nothing
  applied.
- A receipt is the cycle's order if its vendor is a cart vendor and its order id is in
  `cart_result`'s order ids — or, when none were recorded, it's digital and acquired after the
  build. Only a `ready` cycle closes; implicit swaps are checked for any matching order.
- `resolveReceiptReview` turns a human's answers into effects: confirm → event confirmed + alias
  1.0; correct → event `expired` + corrected line applied; ignore → ignored alias; each answer is a
  `labeled_observation`.

### 4.6 Review expiry & trust

Run daily by `/api/cron/maintenance`:

| Review kind | Default on expiry | Window |
|---|---|---|
| receipt (pending lines) | drop pending lines | 14d |
| new_product | keep auto-created item/product | 30d |
| merge_suggestion | do nothing | 30d |
| unverified_item | stays unverified | never expires (low priority) |
| failed_job | dismiss | 14d |
| trash_cam (low confidence) | do nothing | 7d |

Only human actions create `labeled_observation`s. `impact_score` = 10 if the item is in the current
cart plan, + 3 if in please_check, 1 if neither; Cleanup sorts by it. Reviews scoring above 1 are
`this_week`, the rest `cleanup`. Expired reviews get status `expired` and their default applied.

### 4.7 Grocery cycle state machine

```
          open ──(Fri 6pm nudge)──▶ open ──(Sat 10am build)──▶ building ──▶ ready
           │                                                              │
           ├─ "skip"/away ──▶ skipped                                     ├─ order ingested (picked up/delivered) ──▶ closed
           └─ "other store" ──▶ other_store                               └─ "done" ──▶ closed
closed/skipped/other_store ──▶ agent opens next cycle immediately, or at Monday 9am at the latest.
```

Opening is idempotent per `week_label`. If an away period covers the build date, the build is a no-op
and the cycle becomes `skipped`.

Details (`web/lib/domain/cycle.ts`): `building ──(cart filled)──▶ ready` is an explicit `built`
event. "skip" and "other store" are accepted from any active state (a built cart can be abandoned —
nothing is checked out). A repeated nudge is a no-op. The cycle to open is the current ISO week's,
unless its build time has passed or its label is taken, then the next free week.

## 5. Media pipeline

1. User posts a photo in `#pandabase`. `discord-intake` classifies (`paper_receipt` | `trash_cam`)
   from text + image; asks once if ambiguous.
2. Agent → `POST /api/media/upload-url` → PUT bytes to R2 (`media/{yyyy}/{mm}/{ulid}.{ext}`).
3. Agent → `POST /api/jobs` with type, key, actor, Discord message/channel, current cycle.
4. Worker loop (every 10s): `POST /api/jobs/claim` → lease 5 min (`jobs.leaseMinutes`),
   `attempts += 1`; the response carries `attempt`, a presigned media GET and
   `jobs.maxKeyframes` presigned keyframe PUTs (`jobs.presignSeconds` = 900).
   Download via presigned GET, normalize (EXIF rotate, resize to ≤ 2048px), save keyframe(s) to
   `keyframes/{job_id}/{n}.jpg` (R2), call Ollama with the versioned prompt from
   `worker/prompts/{job_type}.v{N}.md`, validate JSON against the contract, post
   `POST /api/jobs/complete`.
   Failures post `{status: failed, error}` (an invalid result counts as a failure); after 3
   attempts (`jobs.maxAttempts`) the job is `failed` and a `failed_job` review item is created.
   Expired leases return to `queued` (on claim and in the daily cron) — except a lease that
   expires on the last attempt, which fails the job. `complete` must echo the current `attempt`:
   a late result from an expired lease is a 409.
5. App applies results in the same transaction as `complete` (`web/lib/services/jobs.ts`):
   paper receipt → `applyReceipt` (vendor = store name slug, e.g. `WHOLE FOODS MARKET` →
   `wholefoods`; acquired at local noon of the receipt date; deduped like any paper receipt);
   Trash Cam → the most confident detection, if ≥ `trashCam.applyConfidence` (0.8) and its name
   fuzzy-matches an item (paper-line rule), becomes a provisional `consumed` event at the job's
   creation time; else a `trash_cam` review item; merge-suggest → one `merge_suggestion` review per
   suggestion.
6. Agent polls `GET /api/jobs/notifications` (finished jobs with a Discord message and no
   `notified_at`, each with a one-line `summary`), replies in a thread under the original
   message, then `POST /api/jobs/{id}/notified`.

**Worker details** (`/worker`): prompts are `worker/prompts/{job_type}.v{N}.md` (system prompt,
a `---user---` line, the user message; highest N wins; `prompt_version` = `{job_type}.v{N}`).
Each model call asks Ollama for JSON matching the job's output schema (`format`), validates it,
and on invalid output sends one repair turn (the bad reply + the validation error); a second
invalid reply fails the attempt (`vlm_parse_failure`). The first keyframe is the normalized photo
(EXIF-rotated, ≤ 2048px, re-encoded JPEG, so EXIF/GPS is stripped), uploaded before inference and
listed in `complete` even on failure. `complete` sends `Idempotency-Key: complete:{job_id}:{attempt}`;
a 409 drops the result. SIGTERM finishes the current job, then exits (a second signal exits at
once; the lease then expires).
**merge_suggest input** (set by the job's creator; the worker never reads the catalog):
`{items: [{item_id, name, aliases?: [str]}]}`, 2–150 items. The worker keeps suggestions between
two distinct listed items, one per pair.

**Paper receipt prompt contract:** transcribe only — `{store, date, lines:[{raw_text, qty,
unit_price, line_total}], subtotal, tax, total}`. The worker converts money to cents, runs the
totals check (`|Σ line_total − subtotal| ≤ 2¢`) and posts contract `PaperReceiptResult`
(`{store, date, lines:[{raw_text, qty, unit_price_cents, line_total_cents}], subtotal_cents,
tax_cents, total_cents, totals_check}`). Lines with a negative amount (discounts, coupons) count
toward the totals check but are not posted (money fields are ≥ 0 and they aren't purchases). An
unreadable date falls back to today in `HOUSEHOLD_TZ`, an unreadable store to `UNKNOWN` (vendor
`unknown`); both are flagged in `vlm_inference`. The receipt row's `totals_check` is the app's own exact
check; the worker's is kept in `job_finished` telemetry. Trash Cam posts `TrashCamResult`
(`{detections:[{name, confidence, bbox?}]}`); merge-suggest posts `MergeSuggestResult`.

**Retention (R2 lifecycle rules):** `media/` videos 90 days (v1.1); photos and `keyframes/`
indefinitely.

## 6. Agent (OpenClaw skill pack)

Skills are folders with `SKILL.md` (OpenClaw / AgentSkills format: YAML frontmatter with `name`,
`description` and a `metadata.openclaw` JSON5 block gating on `requires.bins: ["pandabase-tools"]`
and `requires.env: ["AGENT_API_TOKEN", "PANDABASE_CONFIG"]`; markdown instructions). They call
one deterministic CLI, `pandabase-tools`, through OpenClaw's `exec` tool; the CLI talks to the API
with `AGENT_API_TOKEN`. Discord I/O (thread creation, replies, ✅ reactions) uses OpenClaw's
`message` tool (`thread-create`, `reply`, `react`, `read`).

| Skill | Trigger | Does |
|---|---|---|
| `grocery-cycle` | automations Fri 18:00, Sat 10:00, Mon 09:00; replies in the cycle thread | Open cycles (thread per cycle), record list edits/skips/away/other-store, Friday nudge (incl. freezer), Saturday build (`cart build` → tier-2 fallback in the agent's browser → `cart finish` → summary) |
| `discord-intake` | photo or inventory text in `#pandabase` | Photos: `photo submit` (classify, upload, create job); text purchases, "we're out", "froze X", "never buy X" → inventory events / product reject. Job results are posted by a **command automation** (`pandabase-tools jobs replies` every 5 min, no model call) |
| `digital-receipt-scraper` | automations daily 21:00 (cart member), Sun 21:00 (other member); backfill on request | `receipts sweep` per member profile → `/api/receipts/ingest`; agent extracts zero-ASIN pages |
| `item-lookup` | "do we have X?" anywhere the bot is addressed | `/api/items/lookup` → `matches[0].text` |
| `telemetry-aggregator` | automation Sun 23:00 | `diagnostics write` → `/diagnostics` → 3-line summary |

Tools (`/agent/tools`, Python, uv, package `pandabase_tools`, console script `pandabase-tools`;
JSON on stdout; exit 0 ok, 1 error, 2 usage, 3 profile locked, 4 refused URL):

- `api.py` — API client: generated contracts are the only wire types (bodies validated before
  sending, responses parsed), bearer auth, `Idempotency-Key` on every POST (reused across
  retries of 5xx/429/network errors), `actor_discord_id` filled from `--actor` and required on
  human-attributed routes. Its route table is checked against `contracts/openapi.json` in tests.
  `pandabase-tools api get|post <path>` exposes every agent route to the skills.
- `cart_injector.py` (`cart build`, `cart finish`) — attaches over **CDP** to the cart member's
  existing Chromium profile. Price checks for `needs_price_check` candidates (product page:
  JSON-LD offer → `itemprop=price` → the price block's screen-reader text). Tier 1: navigate to
  `https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=…&Quantity.1=…` (batched per vendor, ≤ 10),
  read which ASINs the confirm form offers (`ASIN.n` inputs; "unavailable" text excludes one),
  click the single confirm control (submit of the form whose action contains `/cart/add`; button
  name fallback) and verify ("added to cart" text, or a cart page without an add form).
  Outputs `{added, needs_agent, failed}`; a page with no add form and no "added" signal is
  "layout changed" → whole batch `needs_agent` + `selector_error`. Lines without an ASIN, free
  text, and vendors not enabled for tier 1 go straight to `needs_agent`; the skill adds them via
  OpenClaw's browser (tier 2), then `cart finish` posts `cart-result`. A build state file makes
  re-runs resume without adding a line twice. Whole Foods via the add URL is **unverified**:
  `cart.wholefoods_tier1` defaults to `false` (WF lines → `needs_agent`) until `make smoke`
  proves it.
- `receipt_parser.py` (`receipts sweep [--backfill]`) — attaches over CDP to a member's profile.
  Collect phase: walk order history newest-first (`orderID=` links; card = widest ancestor
  mentioning only that order) back to the cursor date minus a 14-day overlap (no cursor: 30
  days; backfill: 12 months, throttled 3 s/page, resumable per page). Process phase, **oldest
  first** (late receipts skip EMA updates): open each final-state order (Delivered / Picked up /
  in-store), extract lines from `/dp/` and `/gp/product/` links (block = widest ancestor
  mentioning only that ASIN; title, `Qty`/`N of`, `$` price; `<main>` only, recommendation
  sections skipped), date at household-local noon, and ingest with
  `external_order_id` dedupe. In-flight orders wait for the next sweep; cancelled ones are
  skipped. Zero ASINs on a final order → `needs_agent_extraction` with page text, and
  `selector_error`; the skill ingests its own extraction with `receipts ingest`.
- `photos.py` (`photo submit`) — classify (caption keywords when unambiguous → the local image
  description → default `paper_receipt`), presigned upload, `POST /api/jobs`;
  `--media-key --job-type` re-files a photo a human corrected.
- `guard.py` — every URL the tools open, and every page they land on, must be `https` on
  `www.amazon.com`/`amazon.com` and not match checkout/payment/slot/sign-in patterns; the CDP
  driver also installs it as a Playwright route that aborts such document requests. The tools
  never launch a browser, sign in, or store credentials (signed out → `not_signed_in`).
- `lock.py` — per-profile lease file in the state dir: commands hold it while driving a profile;
  the agent takes it (`lock acquire`/`release`) around tier-2 browsing.

Config: `agent/pandabase.config.example.json` — API base URL, web URL, household TZ, channel IDs
(`cycle_channel`, `intake_channel`, `ops_channel` — all `#pandabase` in v1), members ↔ Discord
IDs ↔ profile name (+ `cart_member`, `receipt_sweep`), tool tunables (`cart.*`, `receipts.*`),
state and diagnostics dirs. `agent/profiles.example.json` maps profiles to CDP URLs
(`http://127.0.0.1:<port>`), user-data dirs and the matching OpenClaw browser profile (an
`attachOnly` remote-CDP profile on the same port, for tier 2). `agent/cron.example.json`
documents the OpenClaw automations (`openclaw automations add --cron … --tz
America/Los_Angeles --session isolated --message "Use $<skill>: …"`; one command payload).
OpenClaw keeps automations in its own state DB, so M8 registers them with the CLI. Skills are
installed by pointing OpenClaw's `skills.load.extraDirs` at the repo's `agent/skills` (`make
install-agent-skills`): OpenClaw rejects workspace-skill symlinks that resolve outside the
workspace unless `skills.load.allowSymlinkTargets` trusts the target.
OpenClaw's media understanding must use the local Ollama VLM (`tools.media.models` with an
`ollama/…` image entry) so the agent's cloud model never needs the photo pixels (§10 #10).

Agent message style: short, Discord markdown, ✅ ⚠️ ❓ markers, one web link when needed, no
components/embeds.

## 7. Diagnostics

**Emitters** (`POST /api/telemetry`, batched): API middleware (route, status, latency), worker
(model, prompt_version, latency, totals_check, parse failures), tools (tier-1 per-line results,
selector errors, price-lookup failures), domain (ema_updated, ema_outlier_rejected,
ema_outlier_accepted, ema_skipped, promoted_to_velocity, overbuy, estimate_vs_observed,
receipt_line_match, preference events, shelf-life presumed discards, review expiries, clarifying
questions asked by agent). Domain functions return these payloads (`metric` + fields); the API
layer emits them.

`system_telemetry.source` is `state_engine` (services/domain), `api` (latency middleware), `cron`
(maintenance) or the posting client (`agent`, `worker`). State Engine metrics: `api_request`,
the `ReceiptEffects` metrics (with `receiptId`, `vendor`), `estimate_vs_observed {itemId, item,
location, estimated, observed, error}`, `preference_event`, `cart_line_result {cycleId, itemId,
productId, vendor, outcome, error}`, `cycle_opened`, `cycle_transition`, `job_created`,
`job_finished {jobType, outcome, attempts, model, promptVersion, …}`, `job_lease_expired`,
`review_expired {reviewId, kind, action}`, `presumed_discarded`, `maintenance_run`,
`settings_rejected {keys}`. The report reads these client metrics (payload fields it uses):
`vlm_inference {model, prompt_version, latency_ms, totals_check, parse_failure}`,
`vlm_parse_failure`, `selector_error {selector, error, page}`, `price_lookup_failed {asin,
product_id, error}`, `cart_tier1_line {asin, item_id, product_id, vendor, outcome, error}`,
`clarifying_question {question}`, `photo_classified {job_type, basis}` and `photo_reclassified
{to_job_type}` (UX section: photos by classification basis and human re-files). The agent
tools also emit `receipt_sweep {member, mode, pages, ingested, duplicates, pending, needs_agent,
errors, complete}` (stored for ad-hoc queries; no report section). The worker's `vlm_inference` /
`vlm_parse_failure` also carry `job_id`, `job_type`, `attempt`, `repaired` and per-type fields
(receipts `lines`, `discount_lines`, `date_fallback`, `store_missing`; Trash Cam `detections`,
`top_confidence`; merges `items`, `suggestions`, `dropped`), all copied into the `vlm` extract.
Worker health metrics (stored, not yet in the report): `worker_heartbeat {version, vlm_model,
text_model, ollama_ok}` (at startup and every 10 min; `ollama_ok` null until first checked),
`worker_ollama_unavailable {reason,
missing_models}`, `worker_job_failed {job_id, job_type, attempt, error}`, `worker_lease_lost`,
`worker_complete_error {error}`.

**Weekly report** — rendered by the app (`web/lib/diagnostics/`), written by the agent to
`/diagnostics/YYYY-Www.md` with extracts in `/diagnostics/YYYY-Www/*.jsonl`. Fixed sections, each
*metrics → notable examples → suggested investigation*:

1. Summary (top 3 findings)
2. Velocity (updates, outliers, estimate-vs-observed error by item, overbuys)
3. Receipt matching (auto/provisional/expired rates per store, worst aliases)
4. VLM (latency p50/p95, totals-check failures, human-correction rate per model × prompt version)
5. Product choice (switches, overrides, threshold drift)
6. Cart injection (tier-1 success, tier-2 fallbacks, failures with selector/error)
7. UX friction (expired items, clarifying questions, slow routes)
8. Data appendix (extract paths, keyframe R2 keys)

`GET /api/diagnostics/weekly?week=` (default: the last complete household-TZ ISO week) returns
`{week, markdown, extracts:[{name, jsonl}]}`; extracts are `velocity`, `receipt_lines`, `vlm`,
`product_choice`, `cart_injection`, `ux` (`.jsonl`), always present. The summary ranks findings
(cart failures and tier-1 rate below 90% first, then paper exact-alias rate below 70%, totals-check
failures and server errors, then overbuys, estimate error, pending lines, failed jobs, overrides,
then expired reviews and slow routes over `diagnostics.slowRouteMs`) and keeps the top 3.

`/diagnostics` is gitignored. The Claude review playbook lives in [CLAUDE.md](../CLAUDE.md).

## 8. Environments & operations

| Env | DB | Auth | Notes |
|---|---|---|---|
| local | `db/dev.db` (libSQL file; the default when `TURSO_DATABASE_URL` is unset), seeded fake household | `DEV_AUTH_BYPASS` | `pnpm db:reset && pnpm db:seed`, `pnpm dev` |
| preview | Turso `pandabase-preview` | Google | Vercel previews |
| production | Turso `pandabase` | Google | Vercel; deployed by `deploy.yml` after migrations (see *Continuous deployment*) |

Timestamps stored UTC; `HOUSEHOLD_TZ=America/Los_Angeles` defines "today" and schedules.

### Continuous deployment (M9)

- **Web:** GitHub Actions `deploy.yml`, after CI passes on `main`: migrate Turso production →
  `vercel deploy --prod`. Vercel's own production auto-deploy is off so code never ships before its
  migration. Previews stay on Vercel's Git integration against `pandabase-preview`.
- **Migrations are backward-compatible** (expand → contract): the previous release must run on the
  new schema, so a failed deploy after a successful migration leaves production working.
- **Mac Mini — pull, never push:** CI publishes the worker image to GHCR on green `main`. A `launchd`
  timer runs `make update` every 15 min: newer green sha → `git pull` (skills are symlinked, so they
  update too) → `uv sync` → `docker compose pull && up -d` → health check → automatic rollback to the
  previous sha/image on failure, with one `#pandabase` post. No inbound ports; no self-hosted runner.
- **Quiet windows:** no Mac Mini updates Fri 17:30–19:00 or Sat 09:30–12:00 (household TZ), around
  the nudge and cart build.
- Every deploy emits `deploy {component, sha, outcome}` telemetry; the weekly report has a *Deploys*
  section.

**Env vars** — web: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET`, `ALLOWED_EMAILS`, `AGENT_API_TOKEN`, `WORKER_API_TOKEN`, `CRON_SECRET`,
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `HOUSEHOLD_TZ`,
`DEV_AUTH_BYPASS`. Worker: `PANDABASE_API_URL`, `WORKER_API_TOKEN`, `OLLAMA_URL`
(`http://host.docker.internal:11434`), `OLLAMA_VLM_MODEL` (`qwen3.5:9b`), `OLLAMA_TEXT_MODEL`
(`qwen3.5:4b`), `POLL_INTERVAL_SECONDS` (10), `HOUSEHOLD_TZ`, `PROMPTS_DIR` (set by the image).
Agent tools: `PANDABASE_API_URL`, `AGENT_API_TOKEN`, `PANDABASE_CONFIG`.

## 9. Repository layout

```
/web            Next.js app (UI, API, domain logic)        pnpm workspace
/db             @pandabase/db: Drizzle schema, migrations, seed   pnpm workspace
/contracts      openapi.json (generated by scripts/gen-contracts.ts)
/scripts        repo-level scripts (contract generation)
/worker         Python worker (uv) + Dockerfile + prompts/
/agent/skills   OpenClaw SKILL.md folders
/agent/tools    Python tools (uv)
/diagnostics    gitignored; volume-mapped
/docs           PRD, DESIGN, ROADMAP, PLAN
docker-compose.yml, Makefile, CLAUDE.md, README.md, .github/workflows/ci.yml
```

## 10. Key decisions & rationale

| # | Decision | Why |
|---|---|---|
| 1 | One household, `member` table, Google allowlist | Two users; no tenancy complexity; need Discord↔Google identity mapping for attribution |
| 2 | Ship a skill pack for the existing OpenClaw, not a new deployment | Family agent already runs on the Mac Mini; OpenClaw skills are `SKILL.md`, not YAML workflows |
| 3 | Cart tier 1 = add-to-cart URL by ASIN; tier 2 = agent's LLM browser | Minimizes DOM coupling; agent self-heals when Amazon changes |
| 4 | Tools attach via CDP to existing logged-in profiles | No credential/2FA handling in PandaBase; shares the agent's session |
| 5 | Cart only, never checkout | Safety; humans keep control of spend |
| 6 | Ingest only Delivered/Picked-up orders; dedupe by order id | Substitutions are reflected; acquisition date is real; retries safe |
| 7 | EMA of days-per-base-unit with outlier guard, away subtraction, seeds | Quantity-aware, robust to trips/stock-ups, useful from day one |
| 8 | API-only DB access; Turso-backed job queue with leases, worker polls | Vercel can't reach the Mac Mini; durable, observable, crash-safe |
| 9 | Ollama native, worker in Docker | Docker on macOS has no Metal GPU access |
| 10 | Local models only, no cloud escalation | Owner preference; privacy |
| 11 | Keyframes kept forever, raw video 90d | Labels need frames, not video; video of the home is sensitive |
| 12 | Improvement = HITL labels + diagnostics + periodic Claude review | Simple; no reference-image prompting or fine-tuning infra until data says so |
| 13 | Running-list cycle thread; Fri nudge; Sat build | Gives time to add one-offs and to check uncertain items |
| 14 | Nothing blocks on a human; three trust levels; ask once | Busy household; only confirmed data trains |
| 15 | Item (need) vs Product (SKU) with per-item `switch_threshold` | Brand switching on sale; learn per-item price sensitivity |
| 16 | Inventory = event log + anchored estimate | Consumption is rarely observed; observations should override |
| 17 | 12-month backfill | Cold start would otherwise take weeks |
| 18 | Two scoped machine tokens + actor attribution + idempotency | Blast-radius control; LLM agents retry |
| 19 | One Discord channel, threads per cycle/upload; channel IDs per purpose in config | Simple now, splittable later |
| 20 | Latest stable Next.js, Auth.js v5, Drizzle + libSQL | Next 14 is past support; Drizzle has first-class Turso support |
| 21 | Zod → OpenAPI → Pydantic codegen, drift checked in CI | One contract source across TS and Python |
| 22 | Chores, video audits deferred | Groceries first as MVP |
| 23 | Daily Vercel Cron for maintenance | App stays healthy even if the Mac Mini is off |
| 24 | Invariants as DB constraints (enum/bool/JSON CHECKs, partial uniques); drizzle-kit migrations, schema drift checked in CI | A backstop under domain code; one active cycle / one cart account can't be violated by a buggy caller |
| 25 | Domain functions return effects; repositories only read | Business rules testable without a DB; M4 commits each operation in one transaction |
| 26 | EMA learns from provisional acquisitions; product preference only from confirmed lines | Paper receipts are mostly provisional and EMA has an outlier guard; a wrong product match would teach the wrong brand |
| 27 | One route table (`web/lib/contracts/routes.ts`) drives handlers and the OpenAPI document; orchestration in `web/lib/services` | Scopes, idempotency and contracts can't drift between code and docs; server actions (M5) reuse the same services |
| 28 | Snake_case wire format; Pydantic models generated from OpenAPI 3.1 with nullable unions flattened | Python clients read naturally; generated models stay plain (`str \| None`, no wrapper root models) |
| 29 | Text purchases become manual receipts | One `applyReceipt` path, so velocity, overbuy and product stats learn from "bought milk" too |
| 30 | CD: one workflow migrates Turso then deploys Vercel; migrations backward-compatible | Code never ships ahead of its schema; a half-failed deploy can't break production |
| 31 | Mac Mini updates are pulled by a `launchd` timer with health check, rollback and quiet windows | No inbound ports or self-hosted runner on a home machine; never disrupt the Friday nudge or Saturday build |
| 32 | Worker VLM `qwen3.5:9b` (Q4), text `qwen3.5:4b`, Ollama JSON-schema output + one repair turn | Best OCR-capable vision model that fits ~8GB next to OpenClaw's model; one family keeps prompts portable; schema-constrained output makes repair rare and bounded |
| 33 | One `pandabase-tools` CLI for every skill; generic `api get/post` plus composite browser commands | One binary to allowlist in OpenClaw's exec policy; skills can't drift from the contracts (tests parse every command a skill names) |
| 34 | Photo classification is deterministic (caption → local VLM description → default receipt), correctable by one reply | Agent's cloud model never sees photos; a wrong guess costs a review item, not a blocked human |
| 35 | Photo-job replies via an OpenClaw command automation, not an agent poll | No model call every few minutes; `NO_REPLY` keeps it silent |
| 36 | Receipt sweeps re-walk a 14-day overlap and ingest oldest-first | Dedupe makes overlap free; in-flight orders aren't skipped by the cursor; EMA skips out-of-order receipts |
| 37 | Whole Foods tier 1 off until smoke-verified | A silent mis-add to the Amazon cart is worse than an agent fallback |
