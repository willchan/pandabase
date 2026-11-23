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
- a Discord account (talks to the `pandabase` agent in the shared channels; a DM reaches
  whichever agent the gateway routes that member to, and any agent with the PandaBase skill sees
  the same data),
- a login in a shared Amazon Household (separate Amazon logins). PandaBase drives one of them:
  Will's (the cart account), in its own browser profile named `pandabase`. Members' personal
  browser profiles belong to their own agents, outside PandaBase.

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
  or someone says "done"), or **Monday 9am** at the latest. The app opens it itself, so a mid-week
  delivery never costs the household that week's Friday check-in and Saturday cart. Skipping a week
  (or shopping elsewhere) before its Saturday cart leaves the next list to Monday.
- **Anytime:** either of us replies to add things — including one-off free text
  ("birthday candles, cake flour"), skip items ("skip bananas"), or set quantities.
- **Friday 6pm nudge** in `#pandabase`, linking the week's thread (replies go in the thread):
  - *Likely needed* — items predicted to run out within 3 days, or marked critical.
  - *Please check* — items the app is unsure about (near run-out, stale, or with an audit hint
    like "count the eggs"). We can answer with text or a photo.
  - *Freezer* — the 1–3 oldest freezer items.
  - Optional one-liner: "N review items waiting → link".
- **Saturday 10am cart build:** Will's Whole Foods/Amazon cart is filled and a summary posted in
  `#pandabase`: what was added (and which items landed in the other store's cart), what is left
  to find, what failed, with cart links. At 10:30 the agent searches for what's left and posts
  what it added by search. The nudge and the build run without the language model, so they can't
  be skipped or made up.
  Builds from predictions alone if nobody replied. Something we ran out of more than two months
  ago and never bought again is left out (we stopped buying it); adding it to the list brings it
  back. Something we get on Amazon **Subscribe & Save** is left out too — the subscription brings
  it — and named in the summary ("🔁 Left out, coming by Subscribe & Save"); asking for it on the
  list ("add soap") still buys it that week. If most of the lines it tried (and at least
  two) fail because the product page wasn't what the tools expect, it also posts one ⚠️ to the
  ops channel: Amazon's layout probably changed.
- **Friday afternoon add-button check:** before the build, one Amazon and one Whole Foods product
  page are opened (nothing clicked) to confirm the add button is still found; a ⚠️ goes to the ops
  channel only when it isn't, or when the cart browser is signed out.
- **Away weeks:** "away until Nov 3" or "skip this week" → cycle skipped; away days don't distort
  consumption estimates.
- **Paused weeks:** for stretches that aren't normal but we're still home (a new baby, guests,
  shopping somewhere PandaBase can't see) — "pause carts until March 1" in Discord, or Settings →
  Pause carts. No weekly cart and no Friday check-in; Saturday says carts are paused. Purchases
  still count toward what's on hand, but how fast things get used isn't learned from those weeks,
  so normal-life estimates are intact when it ends. "Resume carts" (Discord, This Week or
  Settings) ends it early.
- **Other-store weeks:** "shopping at Trader Joe's" → cycle closes without a cart; purchases arrive
  via paper-receipt photos or text ("bought milk, eggs").

### 4.2 Receipts → inventory

- **Digital (Amazon / Whole Foods):** daily sweep of Will's order history (the `pandabase`
  profile). His wife's orders aren't swept: PandaBase has no browser profile for her account.
  Delivery, pickup and phone-linked in-store purchases. An order is ingested once
  delivered/picked up (or, for an old order whose page no longer says, a week after it was
  placed); orders returned in full are skipped. Re-ingesting is harmless, and an order read
  again with different content (a fixed reader) **replaces** what was read before: its lines,
  stock and what PandaBase learned from it are corrected, and answers already given on unchanged
  lines are kept. One store's whole import can also be reset and read again without touching the
  others (items other stores bought stay, relearned without it). If Amazon shows a bot
  check, the import stops and asks in the ops channel for someone to clear it. Each sweep also
  reads the Subscribe & Save page (no clicks) to learn what Amazon already delivers on a schedule,
  and stays silent about it. It only updates the list when it read all of it; if it can't for three
  weeks, those items are bought normally again rather than silently missed.
- **Paper receipts:** photo in Discord → local VLM transcribes → app matches lines to items using
  store-specific aliases → one review item per receipt in the web UI. Exact known matches apply
  immediately; strong guesses apply provisionally; weak ones wait 14 days then expire.
- **Text purchases:** "bought milk, eggs" in Discord records a manual acquisition.
- **Backfill:** a one-time import of the last 12 months of Amazon orders seeds the catalog and
  consumption history so predictions are useful on day one. Each new product starts as an unverified item
  named after the product (not a store brand like "365 by Whole Foods Market");
  when the backfill finishes (and weekly after that, once enough new items pile up) the local model
  suggests which are items we already have ("these 3 look like *Eggs*") in Cleanup → Merges. It
  only suggests items whose names have something in common (a guess like "floss" for "cutting
  board oil" is dropped), unless it is very sure two names mean the same thing. A
  suggestion nobody answers expires after 30 days and changes nothing.
  If an import goes wrong, it can be reset and re-run; the reset refuses if anyone has already
  answered a review or entered counts for the imported items, so nothing a person did is lost.

### 4.3 Trash Cam

Photo of an empty/finished item in Discord → VLM identifies it → item marked consumed/critical →
it lands in the next cart. Agent replies with what it understood. The agent tells a receipt from a finished
item by the caption (or the local model's description); when it had to guess, its reply says so
and one word (`trash` / `receipt`) re-files the photo — nobody has to answer.
If the app can't be reached, replies wait quietly and post once it's back; only an outage of an
hour or more gets one ⚠️ line in `#pandabase` (and a ✅ when it's over).

### 4.4 "Do we have X?"

Ask the agent in `#pandabase` or one of its threads (e.g. from the store aisle); PandaBase doesn't
answer elsewhere in Discord. It answers from the inventory
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
| **This Week** | Current cycle, planned cart with reasons, running list, overrides, the Costco trip and its list. (Urgent HITL.) |
| **Cleanup** | Tabs: receipts (photo beside the lines, one dropdown per line, one confirm), merges (suggested merges and new products), unverified items, jobs (failed jobs and unsure Trash Cam photos) — sorted by impact on this week's cart (re-checked daily, so a review about something in this week's cart moves up to This Week), with expiry shown; 20 per tab, then "Show more". New products bought only once are left out (counted in a note): they stay as their own item, and come back if bought again or added to a cart. (Long-term HITL.) |
| **Pantry** | Estimated inventory by location; item detail with products, thresholds, EMA history, event log. |
| **Insights** | Visual view of the diagnostics metrics. |
| **Settings** | Cart pauses, away periods, members ↔ Discord IDs, cart account, default thresholds. A person on the allowlist becomes a member the first time they sign in. |

Every page answers "what needs me?" first. Machine guesses are labelled *provisional* /
*unverified* and perishables show a use-by date, without prompting. "We're out", "running low" and
counts can be recorded from This Week's please-check list and from any item.

### 4.7 Diagnostics

Weekly Markdown report + raw JSONL extracts written to `/diagnostics` on the Mac Mini, covering
every learning component and UX friction. A documented Claude Code workflow ("review
diagnostics") turns these into proposed improvements.

### 4.8 Costco

Costco is bought **in store, about once a month**, plus the odd delivery order. Bulk is cheaper only
if we use it up, so PandaBase decides per item where it comes from and keeps a list for the next run.

- **Which store:** an item becomes a Costco candidate once we've bought it there (prices come from
  Costco receipts; nothing is looked up on costco.com). It goes to Costco when Costco's pack is
  meaningfully cheaper per unit (15% by default) and one pack gets used up before it spoils (or
  it's a freezer item, or we freeze part of it). Each item shows why ("Costco: 43% cheaper per egg
  than Vital Farms"; "Costco's pack lasts ~40 days but keeps 21").
- **Overrides stick:** "get eggs at Whole Foods" / "get eggs at Costco" pins that item to that
  store. When the pin goes against a price-based choice, the household's Costco threshold moves a
  little too (away from Costco → it needs a bigger saving next time).
- **Costco list on demand:** "going to Costco Saturday" (or a planned date) posts the list for that
  trip: Costco items that would run out before the trip after it (~35 days later), with pack counts
  that cover until then (perishables nobody freezes: no more than keeps). No cart is filled for
  Costco, delivery included. Saying another day moves the trip; "back from Costco" closes it, and
  a trip nobody closes is dropped a week after its date. This Week shows the trip and its list and
  can plan, move or cancel one; each item's page shows where it comes from and can pin it.
- **The weekly cart leaves Costco items out** when a trip is planned on or before they run out.
  Otherwise (no trip planned, the trip is later, or the item is critical/out) the week's
  Whole Foods/Amazon cart buys the usual amount and says it's bridging to Costco. Something
  we're out of with a trip only days away is bought in the weekly cart, not on the trip. The Saturday
  summary names both, and anyone adding the item to the week's list puts it back in the cart.
- **Receipts (M10.3):** Will's Costco account is read on the `pandabase` browser profile:
  warehouse receipts and costco.com 2-Day Delivery orders (Same-Day/Instacart isn't used). "Back
  from Costco" closes the trip and the receipt is imported by itself the next morning (receipts
  appear on costco.com within a day; one retry the day after), plus a weekly fallback; nobody types
  in what they bought. A warehouse receipt dated on or a few days after a trip is that trip's
  receipt (and closes it if nobody said "back from Costco"). Costco item numbers are remembered
  like ASINs: a new item number becomes a new (unverified) item, and an item first named from the
  receipt's abbreviation ("KS ORG EGGS") gets its full name when an online order brings it. Store
  choice uses warehouse prices (delivered prices run higher); the weekly diagnostics show the
  delivery premium per item bought both ways. A receipt line PandaBase can't read (e.g. a
  discount) is reported, never guessed. A receipt whose lines don't add up to its total (a misread
  page) is **held**: nothing is stocked from it, the ops channel says so once, the next sweeps read
  it again, and it goes in once it adds up — or, if nobody fixes the reader within two weeks, as it
  was read. The weekly diagnostics count held receipts. The sweep only reads pages: it can't reach a
  Costco cart.
- **After a trip (M10.4, not yet):** one Discord question about bulk perishables ("froze any of the chicken /
  bread?"). A reply moves that amount to the freezer; no reply changes nothing and the question
  expires.

## 5. Non-goals (v1)

- Checking out / paying. Ever, without a separate explicit decision. No Costco cart either.
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
