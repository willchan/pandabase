# PandaBase — Product Requirements

> Living document. Describes **what** PandaBase does and **why**. Any PR that changes user-visible
> behavior updates this file. Implementation detail lives in [DESIGN.md](DESIGN.md).

## 1. Problem

Running a household's groceries is a loop of small, forgettable decisions: what's running low,
what to add to this week's order, which brand is on sale, whether there's already milk at home.
We forget things, overbuy things, and spend attention on bookkeeping we'd rather not do.

PandaBase is a household operating system that keeps that state for us and acts on it. It is
split in two:

- **State Engine** — a web app + database that owns all household data and business logic.
- **Autonomous Agent** — our existing family OpenClaw agent, which talks to us in Discord, drives
  the browser for Amazon / Whole Foods, and calls the State Engine's API.

## 2. Users

One household, two members (Will and his wife), each with:

- a Google account (web UI sign-in, allowlisted),
- a Discord account (talks to the agent),
- a login in a shared Amazon Household (separate Amazon logins, each driven through its own
  Chromium profile by the agent).

Will does almost all of the grocery shopping. Whole Foods **pickup** is the most common
fulfillment, then in-store Whole Foods (linked via phone number), then delivery.

## 3. Design principles

1. **Nothing blocks on a human.** Every question has a default outcome and an expiry. If we're
   busy or lazy, the system still works — it just works better when we engage.
2. **Ask once, never nag.** Each question is asked once. Pending work collects quietly in the web
   UI's Cleanup tab; the Friday nudge may mention it in one optional line.
3. **Only human input becomes training signal.** System guesses are marked `provisional`;
   only `confirmed` data feeds learning and labels.
4. **Cart only, never checkout.** The agent fills carts. Humans check out.
5. **Observable learning.** Every learning component (velocity, matching, VLM, product choice,
   cart injection) emits diagnostics so a human-with-Claude can review and improve it later.
6. **Local-first media.** Photos are processed by local models on the Mac Mini. No cloud LLM
   calls for vision.

## 4. MVP scope (v1 — groceries)

### 4.1 Weekly grocery cycle (the core loop)

A Discord **thread per cycle** in `#pandabase`, acting as a running grocery list.

- **Opens** right after the previous cycle closes (its order was picked up/delivered and ingested,
  or someone says "done"), or **Monday 9am** at the latest.
- **Anytime:** either of us replies to add things — including one-off free text
  ("birthday candles, cake flour"), skip items ("skip bananas"), or set quantities.
- **Friday 6pm nudge** in the thread:
  - *Likely needed* — items predicted to run out within 3 days, or marked critical.
  - *Please check* — items the app is unsure about (near run-out, stale, or with an audit hint
    like "count the eggs"). We can answer with text or a photo.
  - *Freezer* — the 1–3 oldest freezer items.
  - Optional one-liner: "N review items waiting → link".
- **Saturday 10am cart build:** the agent fills Will's Whole Foods/Amazon cart and posts a summary:
  what was added (and why each product was chosen), what fell back to manual, what failed.
  Builds from predictions alone if nobody replied.
- **Away weeks:** "away until Nov 3" or "skip this week" → cycle skipped; away days don't distort
  consumption estimates.
- **Other-store weeks:** "shopping at Trader Joe's" → cycle closes without a cart; purchases arrive
  via paper-receipt photos or text ("bought milk, eggs").

### 4.2 Receipts → inventory

- **Digital (Amazon / Whole Foods):** daily sweep of Will's order history, weekly for his wife's.
  Delivery, pickup and phone-linked in-store purchases. An order is ingested once
  delivered/picked up. Re-ingesting is harmless.
- **Paper receipts:** photo in Discord → local VLM transcribes → app matches lines to items using
  store-specific aliases → one review item per receipt in the web UI. Exact known matches apply
  immediately; strong guesses apply provisionally; weak ones wait 14 days then expire.
- **Text purchases:** "bought milk, eggs" in Discord records a manual acquisition.
- **Backfill:** a one-time import of the last 12 months of Amazon orders seeds the catalog and
  consumption history so predictions are useful on day one.

### 4.3 Trash Cam

Photo of an empty/finished item in Discord → VLM identifies it → item marked consumed/critical →
it lands in the next cart. Agent replies with what it understood. The agent tells a receipt from a finished
item by the caption (or the local model's description); when it had to guess, its reply says so
and one word (`trash` / `receipt`) re-files the photo — nobody has to answer.

### 4.4 "Do we have X?"

Ask the agent anywhere in Discord (e.g. from the store aisle). It answers from the inventory
estimate with an honest confidence hint: "~2 milk (bought Oct 12, unverified) → probably fine."

### 4.5 Learning

- **Consumption velocity** per item, quantity-aware (12 vs 18 eggs), robust to trips, stock-ups,
  and purchases made elsewhere.
- **Product/brand preference:** an item ("Eggs") has several acceptable products. The cart picks
  the preferred one unless another is meaningfully cheaper per unit, explains the choice, and
  learns from our overrides and from what we actually bought.
- **Receipt aliases** get better with each confirmed receipt.
- **Overbuy awareness:** buying when the estimate says we have plenty is logged and surfaced.
- **Perishables** can have a shelf life so overbought milk doesn't suppress milk for a month.

### 4.6 Web UI (mobile-first)

| Page | Purpose |
|------|---------|
| **This Week** | Current cycle, planned cart with reasons, running list, overrides. (Urgent HITL.) |
| **Cleanup** | Tabs: receipts (photo beside the lines, one dropdown per line, one confirm), merges (suggested merges and new products), unverified items, jobs (failed jobs and unsure Trash Cam photos) — sorted by impact on this week's cart, with expiry shown. (Long-term HITL.) |
| **Pantry** | Estimated inventory by location; item detail with products, thresholds, EMA history, event log. |
| **Insights** | Visual view of the diagnostics metrics. |
| **Settings** | Away periods, members ↔ Discord IDs, cart account, default thresholds. |

Every page answers "what needs me?" first. Machine guesses are labelled *provisional* /
*unverified* and perishables show a use-by date, without prompting. "We're out", "running low" and
counts can be recorded from This Week's please-check list and from any item.

### 4.7 Diagnostics

Weekly Markdown report + raw JSONL extracts written to `/diagnostics` on the Mac Mini, covering
every learning component and UX friction. A documented Claude Code workflow ("review
diagnostics") turns these into proposed improvements.

## 5. Non-goals (v1)

- Checking out / paying. Ever, without a separate explicit decision.
- Video audits of fridge/freezer (v1.1).
- Chores & maintenance tasks (v2).
- Standalone freezer monitor with recipe suggestions (v2).
- Location-specific features for non-grocery supplies (bathroom/utility/garage) (v2). Supplies
  bought on Amazon (paper towels etc.) work in v1 as ordinary items.
- Multiple households, roles/permissions, cloud vision models, fine-tuning.

See [ROADMAP.md](ROADMAP.md).

## 6. Success metrics

Reported weekly in diagnostics; targets are aspirational for the first 3 months.

| Metric | Target |
|--------|--------|
| Cart lines we keep without edits | ≥ 80% |
| Paper-receipt lines auto-matched (exact alias) | ≥ 70% after 2 months |
| Tier-1 cart injection success | ≥ 90% |
| Estimate-vs-observed error (items flagged wrong) | trending down |
| Overbuy events per month | trending down |
| Weekly human effort | < 5 minutes typical |
