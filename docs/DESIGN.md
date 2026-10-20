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
- Default VLM is an ~8B Qwen-VL-class model (choose the current best in Ollama's catalog at build
  time; configurable via `OLLAMA_VLM_MODEL`).
- Only one Chromium profile is driven at a time (tools take a file lock).

## 2. Data model

All tables have `id` (text, ULID), `created_at`, `updated_at` (UTC ISO-8601 text) unless noted.
Quantities of items are in the item's **base unit** (e.g. eggs, not cartons). Money is integer
cents. Enums are text with CHECK constraints.

### 2.1 People & settings

**member** — `email` (unique), `display_name`, `discord_user_id` (unique), `chromium_profile`,
`amazon_sweep` (`daily`|`weekly`|`off`), `is_cart_account` (bool; exactly one true).

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
- `item_id`, `product_id` (nullable), `confidence_score` (0–1; 1.0 when human-confirmed)
- `trust`, `ignored` (bool — the ignore list for ASINs and store fee lines)

### 2.3 Inventory

**inventory_event** — append-only log; the source of truth.
- `item_id`, `location`, `kind` (`acquired`|`observed`|`consumed`|`discarded`|`presumed_discarded`|`moved`)
- `quantity` (base units; for `observed` it's the absolute amount; for `moved` the moved amount),
  `to_location` (for `moved`), `status_override` (`critical`|`consumed`|null)
- `occurred_at`, `source` (`digital_receipt`|`paper_receipt`|`manual`|`trash_cam`|`checkin`|`backfill`|`task`|`system`),
  `source_ref` (receipt/job/cycle id)
- `actor_member_id` (nullable), `actor_system` (`agent`|`worker`|`cron`|null)
- `trust` (`confirmed`|`provisional`|`expired`)

**inventory_state** — cached projection, pk (`item_id`, `location`).
- `anchor_qty`, `anchor_at`, `anchor_kind` (`acquired`|`observed`)
- `status_override`, `frozen_at`, `last_verified_at`

Rebuildable from events at any time (`pnpm db:rebuild-state`). Estimates are computed at read time
(§4.2) and never stored.

### 2.4 Receipts

**receipt** — `source` (`digital`|`paper`|`manual`), `vendor`, `account_member_id`,
`external_order_id` (nullable), `dedupe_key` (unique: `digital:{account}:{order_id}` /
`paper:{vendor}:{date}:{total}` / `manual:{idempotency key}`), `fulfillment`
(`delivery`|`pickup`|`in_store`|`unknown`), `ordered_at`, `acquired_at`, `subtotal_cents`,
`total_cents`, `totals_check` (`pass`|`fail`|`n/a`), `job_id`, `status` (`applied`|`pending_review`|`partial`).

**receipt_line** — `receipt_id`, `raw_text`, `asin`, `product_id`, `item_id`, `qty` (purchase
units), `unit_price_cents`, `line_total_cents`, `match_method`
(`asin`|`alias_exact`|`fuzzy`|`manual`|`none`), `match_score`, `trust`, `ignored`.

### 2.5 Jobs, review, labels

**audit_job** — `job_type` (`paper_receipt`|`trash_cam`|`merge_suggest`; `storage_audit` reserved
for v1.1), `status` (`queued`|`claimed`|`completed`|`failed`), `media_r2_key`,
`keyframe_r2_keys` (json), `expected_state_snapshot` (json, nullable), `input` (json),
`raw_model_response` (json), `result` (json), `model`, `prompt_version`, `attempts`,
`claimed_at`, `lease_expires_at`, `error`, `actor_member_id`, `cycle_id`,
`discord_channel_id`, `discord_message_id`, `notified_at`, `completed_at`.

**review_item** — one actionable unit in the Cleanup/This Week UI.
- `kind` (`receipt`|`new_product`|`merge_suggestion`|`unverified_item`|`failed_job`|`trash_cam`)
- `job_id`, `receipt_id`, `item_id`, `payload` (json: detected name, suggestions, delta)
- `urgency` (`this_week`|`cleanup`), `impact_score` (real; higher = affects this week's cart)
- `status` (`pending`|`confirmed`|`corrected`|`dismissed`|`expired`)
- `default_action` (json — what happens on expiry), `expires_at`
- `reviewed_by_member_id`, `reviewed_at`

**labeled_observation** — created only from human confirmation/correction.
`source_kind` (`receipt_line`|`trash_cam`|`checkin`), `job_id`, `keyframe_r2_key`, `bbox` (json),
`model_output` (json), `human_label` (json), `model`, `prompt_version`, `member_id`.

### 2.6 Grocery cycle & preferences

**grocery_cycle** — `week_label` (e.g. `2026-W43`), `discord_thread_id`, `status`
(`open`|`building`|`ready`|`closed`|`skipped`|`other_store`), `opened_at`, `nudge_sent_at`,
`built_at`, `closed_at`, `close_reason`, `cart_result` (json). At most one non-closed cycle.

**grocery_cycle_override** — `cycle_id`, `kind` (`add`|`skip`|`qty`|`product`), `item_id`
(nullable), `free_text` (nullable, one-off adds), `quantity`, `product_id`, `actor_member_id`.

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
(`datamodel-code-generator`) into `worker/pandabase_worker/contracts.py` and
`agent/tools/pandabase/contracts.py`. CI fails if generated files are stale.

### 3.1 Auth

- **Session** (Auth.js v5, Google, JWT sessions): `signIn` callback rejects emails not in
  `ALLOWED_EMAILS`. Session users have all scopes.
- **Bearer tokens:** `AGENT_API_TOKEN` (scope `agent`), `WORKER_API_TOKEN` (scope `worker`).
  Constant-time compare. One `withAuth(scopes, handler)` wrapper on every route.
- **Actor:** agent writes include `actor_discord_id`; unknown IDs → 403. System actions record
  `actor_system`.
- **Idempotency:** mutating machine routes honor `Idempotency-Key`; replay returns the stored response.
- **Dev:** `DEV_AUTH_BYPASS=1` works only when `NODE_ENV=development`.
- **Cron:** `/api/cron/maintenance` requires `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron).

### 3.2 Routes (v1)

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/grocery/cycle/current` | agent | Current non-closed cycle (or null) |
| `POST /api/grocery/cycle/open` | agent | Open a new cycle (idempotent per week); body: `discord_thread_id` |
| `POST /api/grocery/cycle/{id}/overrides` | agent | add/skip/qty/product; free-text adds allowed |
| `POST /api/grocery/cycle/{id}/status` | agent | `skipped` / `other_store` / `closed` with reason |
| `GET /api/grocery/checkin` | agent | Friday nudge lists: likely_needed, please_check, freezer, pending_review_count |
| `GET /api/predictions?cycle_id=` | agent | Cart plan: lines with item, qty, candidate products, `needs_price_check` |
| `POST /api/grocery/price-quotes` | agent | Agent-observed prices for candidates |
| `GET /api/grocery/cycle/{id}/cart` | agent | Final cart lines (product chosen, reason text) after quotes |
| `POST /api/grocery/cycle/{id}/cart-result` | agent | Per-line injection outcome (tier1/tier2/failed) |
| `GET /api/items/lookup?q=` | agent | "Do we have X?" — matches + estimate + confidence text |
| `POST /api/inventory/events` | agent | Observations, manual purchases, consumed, moved ("froze the chicken") |
| `GET /api/freezer/aging?limit=` | agent | Oldest freezer stock |
| `POST /api/away-periods` | agent | Create away period |
| `GET /api/receipts/cursor?account=` | agent | Last ingested `external_order_id`/date for a member's account |
| `POST /api/receipts/ingest` | agent | Digital/manual receipt JSON → resolve, apply, EMA |
| `POST /api/media/upload-url` | agent | R2 presigned PUT for a new media key |
| `POST /api/jobs` | agent | Create audit job |
| `GET /api/jobs/notifications` | agent | Completed/failed jobs not yet replied to in Discord |
| `POST /api/jobs/{id}/notified` | agent | Mark reply sent |
| `POST /api/jobs/claim` | worker | Lease next queued job (+ presigned GET URLs) |
| `POST /api/jobs/complete` | worker | Result or failure for a claimed job |
| `POST /api/telemetry` | agent, worker | Telemetry events (batched) |
| `GET /api/diagnostics/weekly?week=` | agent | Rendered Markdown + JSONL extracts |
| `GET /api/cron/maintenance` | cron | Expire review items, purge idempotency/telemetry, release stale leases |

UI mutations use server actions that call the same domain functions as the routes.

The outline's chore routes (`/api/tasks/*`) are deferred to v2 ([ROADMAP.md](ROADMAP.md)).

## 4. Algorithms

All tunables live in `web/lib/config.ts` (overridable via `setting`). Pure functions in
`web/lib/domain/`, fully unit-tested.

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

- Same-day merge: acquisitions of the same item on the same household-TZ date sum into one.
- Backfill replays receipts chronologically through the same function.
- Static items never use EMA.
- A one-off product (bought once in the 12-month backfill) creates a `static` item; a second
  purchase within 6 months promotes it to `velocity`.

### 4.2 Inventory estimate

Projection per (item, location) from the event log:

- `acquired` → `anchor_qty = estimate_at(t) + qty`, `anchor_at = t`
- `observed` → `anchor_qty = qty` (absolute), `anchor_at = t`, `last_verified_at = t`
- `consumed` → `anchor_qty = 0` and `status_override = consumed`;
  `status_override = critical` events set the override without changing quantity
- `moved` → subtract from source, add to destination; destination freezer stamps `frozen_at`
- the next `acquired` clears `status_override`

Read-time estimate for velocity items:

```
on_hand(t) = max(0, anchor_qty − days(anchor_at → t, minus away days) / ema)
runout(t)  = anchor_at + anchor_qty × ema (+ away days)
status     = override ?? (on_hand == 0 → out | runout ≤ today+3 → low | stocked)
```

Static items: `on_hand = anchor_qty` (no decay); `low` when `≤ reorder_threshold`.

**Shelf life:** if `shelf_life_days` is set, units acquired more than `shelf_life_days` ago are
dropped from the estimate and a `presumed_discarded` event is logged (trust `provisional`).

**Overbuy:** on acquisition of a velocity item, if the stock already on hand would have lasted
`on_hand_before × ema ≥ OVERBUY_DAYS_OF_STOCK` (default 14 days), log telemetry `overbuy`.
Static items: overbuy if `on_hand_before > reorder_threshold × 2`.

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
the next cycle (min 1); static → 1 purchase unit unless overridden.

### 4.4 Product choice

Candidates = products of the item with stance ≠ rejected and vendor in the cart vendor set.

1. One candidate → choose it.
2. Several → `needs_price_check = true`; the agent reads current prices (tier 2 browser) and posts
   `price_quotes`. Missing quotes fall back to `last_price_cents`.
3. `preferred` = stance preferred, else highest `preference_score`, else most `times_bought`.
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

New ASINs bought for an item are added as `acceptable`.

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
cart plan, + 3 if in please_check, + 1 otherwise; Cleanup sorts by it.

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

## 5. Media pipeline

1. User posts a photo in `#pandabase`. `discord-intake` classifies (`paper_receipt` | `trash_cam`)
   from text + image; asks once if ambiguous.
2. Agent → `POST /api/media/upload-url` → PUT bytes to R2 (`media/{yyyy}/{mm}/{ulid}.{ext}`).
3. Agent → `POST /api/jobs` with type, key, actor, Discord message/channel, current cycle.
4. Worker loop (every 10s): `POST /api/jobs/claim` → lease 5 min, `attempts += 1`.
   Download via presigned GET, normalize (EXIF rotate, resize to ≤ 2048px), save keyframe(s) to
   `keyframes/{job_id}/{n}.jpg` (R2), call Ollama with the versioned prompt from
   `worker/prompts/{job_type}.v{N}.md`, validate JSON against the contract, post
   `POST /api/jobs/complete`.
   Failures post `{status: failed, error}`; after 3 attempts the job is `failed` and a review item
   is created. Expired leases return to `queued`.
5. App applies results (§4.5 / Trash Cam → `consumed` event provisional if confidence ≥ 0.8 and
   item resolved; else a `trash_cam` review item).
6. Agent polls `GET /api/jobs/notifications` and replies in a thread under the original message.

**Paper receipt prompt contract:** transcribe only — `{store, date, lines:[{raw_text, qty,
unit_price, line_total}], subtotal, tax, total}`. The worker runs the totals check
(`|Σ line_total − subtotal| ≤ 2¢`) and reports it.

**Retention (R2 lifecycle rules):** `media/` videos 90 days (v1.1); photos and `keyframes/`
indefinitely.

## 6. Agent (OpenClaw skill pack)

Skills are folders with `SKILL.md` (YAML frontmatter + instructions). They call deterministic tools
via the shell; tools talk to the API with `AGENT_API_TOKEN`.

| Skill | Trigger | Does |
|---|---|---|
| `grocery-cycle` | cron: Fri 18:00, Sat 10:00, Mon 09:00; thread replies | Open cycles, record list edits/skips/away/other-store, Friday nudge (incl. freezer), Saturday build (price checks → `cart_injector.py` → tier-2 fallback → summary) |
| `discord-intake` | photo posted in `#pandabase` | Classify, upload, create job, reply when done (polls notifications) |
| `digital-receipt-scraper` | cron daily 21:00 (Will), Sun 21:00 (wife); `backfill` on request | `receipt_parser.py` per profile → `/api/receipts/ingest` |
| `item-lookup` | "do we have X?" anywhere | `/api/items/lookup` → short answer |
| `telemetry-aggregator` | cron Sun 23:00 | Fetch weekly diagnostics → write `/diagnostics` → 3-line summary |

Tools (`/agent/tools`, Python, uv):

- `pandabase/` — API client package (generated contracts, auth, idempotency keys, retries).
- `cart_injector.py` — attaches over **CDP** to the cart member's existing Chromium profile;
  tier 1: navigate to `https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=…&Quantity.1=…`
  (batched), click the single confirm control, verify; outputs JSON
  `{added:[], needs_agent:[], failed:[]}`. Never touches checkout. Whole Foods support via this URL
  is **unverified** — `make smoke` checks it; if unsupported, WF lines go to `needs_agent`.
- `receipt_parser.py` — attaches over CDP to a member's profile; walks order history newer than
  the cursor (or 12 months in backfill mode, throttled ~3s/page, resumable); for orders in a final
  state (Delivered / Picked up / in-store) extracts ASINs from `/dp/` and `/gp/product/` links and
  nearby qty/price text; emits receipt JSON. Zero ASINs on a page → returns page text with
  `needs_agent_extraction` for the skill to handle and logs telemetry.
- A per-profile file lock prevents concurrent drives.

Config: `agent/pandabase.config.example.json` — API base URL, channel IDs
(`cycle_channel`, `intake_channel`, `ops_channel` — all `#pandabase` in v1), members ↔ Discord IDs ↔
Chromium profiles + CDP ports, schedule. `agent/cron.example.json` documents the OpenClaw cron
entries. `make install-agent-skills` symlinks skills into the OpenClaw workspace.

Agent message style: short, Discord markdown, ✅ ⚠️ ❓ markers, one web link when needed, no
components/embeds.

## 7. Diagnostics

**Emitters** (`POST /api/telemetry`, batched): API middleware (route, status, latency), worker
(model, prompt_version, latency, totals_check, parse failures), tools (tier-1 per-line results,
selector errors, price-lookup failures), domain (ema_outlier_rejected, overbuy,
estimate_vs_observed, preference events, review expiries, clarifying questions asked by agent).

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

`/diagnostics` is gitignored. The Claude review playbook lives in [CLAUDE.md](../CLAUDE.md).

## 8. Environments & operations

| Env | DB | Auth | Notes |
|---|---|---|---|
| local | `file:./dev.db` (libSQL), seeded fake household | `DEV_AUTH_BYPASS` | `pnpm dev` |
| preview | Turso `pandabase-preview` | Google | Vercel previews |
| production | Turso `pandabase` | Google | Vercel; migrations run manually: `pnpm db:migrate:prod` |

Timestamps stored UTC; `HOUSEHOLD_TZ=America/Los_Angeles` defines "today" and schedules.

**Env vars** — web: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET`, `ALLOWED_EMAILS`, `AGENT_API_TOKEN`, `WORKER_API_TOKEN`, `CRON_SECRET`,
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `HOUSEHOLD_TZ`,
`DEV_AUTH_BYPASS`. Worker: `PANDABASE_API_URL`, `WORKER_API_TOKEN`, `OLLAMA_URL`
(`http://host.docker.internal:11434`), `OLLAMA_VLM_MODEL`, `POLL_INTERVAL_SECONDS`.
Agent tools: `PANDABASE_API_URL`, `AGENT_API_TOKEN`, `PANDABASE_CONFIG`.

## 9. Repository layout

```
/web            Next.js app (UI, API, domain logic)        pnpm workspace
/db             @pandabase/db: Drizzle schema, migrations, seed   pnpm workspace
/contracts      openapi.json (generated)
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
