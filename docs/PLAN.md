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
7. Drive the PR to green **and mergeable** following `.claude/skills/steward/SKILL.md`: check
   mergeability before CI on every wake and after each push; a conflicted PR gets no CI.
8. The PR that finishes a milestone also marks its status row `done` and moves the milestone's
   whole section, **Notes** included, from this file to the end of [PLAN-done.md](PLAN-done.md).
   For a milestone split into parts (M10.1–M10.4), the PR that lands the last part does the move.
   `make ops-check` (CI `ops`) fails while a `done`/`merged` milestone still has a section here.

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
| M4 API & contracts | done | #5 |
| M5 Web UI & auth | done | #10 |
| M6 Python worker | done | #8 |
| M7 Agent skill pack & tools | done | #9 |
| M8 Ops, compose, README | done | #11 |
| M9 Continuous deployment | done | #14 |
| M10 Costco | in progress (M10.1–M10.3 done; M10.4 not started) | #66, #67, #68, #71 |
| M11 Receipts as the source of truth | done (M11.3 run on production 2026-11-23) | #88 (M11.1), #89 (M11.2), M11.3 notes PR |

Finished milestones (M1–M9, *After M9*, M11) and their **Notes** are in
[PLAN-done.md](PLAN-done.md); a code comment's "PLAN M<N>" points there when M<N> is finished.
Read one there only when your task depends on it; never read that file in full. Milestones move
there once done (*Session protocol* step 8).

---

## M10 — Costco as a second store

**Goal:** Costco items are bought on monthly in-store trips from a list PandaBase keeps, the weekly
Whole Foods/Amazon cart leaves them out until a trip, and Costco receipts feed inventory (PRD §4.8).

**Read:** PRD §4.1, §4.2, §4.8. DESIGN §2.2, §2.4, §4.3, §4.4, §4.8, §6, §10 #52, #74.

Owner decisions (2026-11-15): list on demand, not a cadence or a cart; PandaBase suggests the
store and overrides stick; Will's Costco account on the `pandabase` profile; no Costco cart
(delivery orders are only imported); trips about monthly (35-day gap); Costco prices from receipts
only; one freezer question per trip; the owner saves the Costco pages for fixtures.

One PR each:

1. **M10.1 Docs + store choice** — PRD §4.8, DESIGN §4.8 / #74, `storeChoice.ts` + tests,
   `costco.*` config. No schema, no callers.
2. **M10.2 Trips and the weekly cart** — migration (`item.store_pin`, `costco_trip`); routes to plan /
   cancel a trip, read its list and pin a store (contracts regenerated); the cart plan runs
   `chooseStore` + `costcoTiming` (bridge lines say so); `store_choice` / `costco_trip` telemetry and
   a weekly-report section; `discord-intake` / `grocery-cycle` skill steps for "going to Costco
   Saturday", "back from Costco", "get X at Whole Foods"; This Week shows the next trip's list;
   tier-A step.
3. **M10.3 Costco receipts** — `vendor_alias.kind = item_number`, `product.vendor_sku`; parser and
   `receipts sweep --vendor costco` from synthetic fixtures built from the owner's saved pages
   (list page, one warehouse receipt, one online order; real HTML stays in `.scratch/`, never
   committed); instant-savings folding; Kirkland store brands; trip closes on its receipt; backfill
   of past Costco receipts; `make smoke` gets an opt-in Costco check.
4. **M10.4 Freezer question + `freezesBulk`** — one post-trip question with a default (no change)
   and an expiry; answers move stock and teach `freezesBulk`; diagnostics rows.

**Acceptance (each PR):** `make check`; M10.2–M10.4 also follow the verify skill (seeded shots of
This Week with a planned trip; the prod copy for the store split of the real catalog).

**Notes:**

- *Costco pages (2026-11-15):* the owner saved the Online and Warehouse tabs, one warehouse receipt
  and one online order. Synthetic copies with the same structure are in
  `agent/tools/tests/fixtures/costco/` (README lists what the pages showed; the real HTML stays out
  of the repo). M10.3 builds its parser and sweep against them; DESIGN §4.8 *Costco receipts* has
  the resulting rules (barcode key, next-morning sweep, warehouse prices for store choice).
- *M10.1:* the store functions are pure and uncalled, so they emit no telemetry yet; M10.2 adds
  `store_choice` when the cart plan calls them (CLAUDE.md *Diagnostics*). `costco.vendor` is a
  config string so the receipt importer and the products it creates agree on `costco`.
- *M10.2:* as planned, plus:
  - **Trip default outcome:** the daily cron cancels a planned trip
    `costco.tripExpireAfterDays` (7) past its date with no receipt (`close_reason` `expired`), so
    the weekly cart stops waiting; "back from Costco" closes it `done` with no receipt until M10.3
    (TODO in `services/costco.ts` and `cycle_replies.costco_closed`). Dates are today to
    `costco.tripMaxAheadDays` (60) ahead. DESIGN §10 #75.
  - **Routes:** planning while a trip is planned *moves* it (one route, `moved_from` in the
    response), so there is no separate move route. `GET/POST /api/costco/trip`,
    `POST /api/costco/trip/{id}/status`, `POST /api/items/{id}/store-pin`. Agent commands:
    `pandabase-tools costco plan --when <day> | done | cancel` print the Discord reply.
  - **`item.store_pin` has no CHECK** (a CHECK would make drizzle-kit rebuild `item`); Zod is the
    only writer. `costco_trip` has its enum / closed_at / one-planned constraints.
  - **A human override on a waiting Costco item** (add / qty / product) puts it back in the week's
    cart as a bridge. Tier A found this: step 3's "3 eggs" kept eggs in the cart, so step 10b uses
    frozen blueberries for the `wait` case.
  - **Extra telemetry:** `costco_trip_planned` and `store_override` besides `store_choice` /
    `costco_trip`; the weekly report gets §6 *Store choice (Costco)* (later sections renumber to
    7–10) and a `store_choice` extract.
  - **Seed:** six synthetic Costco products (eggs, spinach, rice, olive oil, blueberries, toilet
    paper) covering `cheaper`, `spoils_first` and `not_cheaper_enough`, appended last so the rest
    of the seed keeps its ids.
  - **Text purchases stay as they are (owner, 2026-11-15):** "got 2 milk at Costco" records the
    purchase but creates no Costco product or price (`applyReceipt` only creates products for ASIN
    lines; pinned by a test in `app/api/costco/costco.test.ts`). Costco ties every order to an
    account, so every Costco purchase reaches PandaBase as a website receipt (M10.3), which creates
    the product and its price.
  - **Out items with a trip days away go to the weekly cart only (owner, 2026-11-15; follow-up
    PR):** M10.2 shipped them both bridged and on the trip list ("needed now"), a possible double
    buy. `costcoListLine` now leaves a critical / consumed item off a trip within `lowWithinDays`
    (DESIGN §4.8); the weekly cart buys the usual week's worth, and once restocked it is listed by
    runout again.
  - **Prod copy (counts only, 2026-11-15):** 471 items, 0 Costco products (amazon 120, wholefoods
    351), so all 471 are `regular` / `no_costco_product`; 48 plan lines, 0 waiting, an empty trip
    list. Nothing changes for the household until M10.3 imports Costco receipts.
- *M10.3:* as planned (DESIGN §4.8 *Costco receipts*, §10 #76–#80), plus:
  - **`vendor_alias` rebuilt.** Widening `kind`'s CHECK makes drizzle-kit rebuild the table; the
    owner agreed (2026-11-15), so migration `0003_costco_receipts` is a marked contract migration
    (every column copied, nothing references `vendor_alias`). Upgrade-tested on a seeded DB and the
    prod copy. `receipt_line.match_method` stays `asin` for item-number matches (no second rebuild).
    New columns: `product.vendor_sku` (unique per vendor), `product.last_price_fulfillment`,
    `receipt_line.vendor_sku`. Contracts: `ReceiptLineIn.vendor_sku`, `ReceiptIngestRequest.tax_cents`,
    `ReceiptIngestResponse.costco_trip_id`.
  - **Online lines skip the text match** (DESIGN §10 #77): token-set scoring would match any
    one-word item a long title contains. Warehouse text still uses it; a fuzzy match gets a Costco
    product only after the receipt review answer (an `item_number` alias).
  - **Scheduling is local**: `costco done` writes the next two dates to `receipts-costco.json`;
    the daily 09:10 command job (`--due`) loads nothing otherwise. "Back from Costco" with no trip
    planned still schedules the sweep. `receipts.costco.orders_url` (Mac config, never committed)
    names the orders page, since its URL carries the account id.
  - **Seed:** the six synthetic Costco products have item numbers (eggs `9000101` and toilet
    paper `9000201` match the fixtures) and `in_store` prices. Tier A step 11c runs the `--due`
    sweep against the fixtures through the agent shim.
  - **Not done here:** `make smoke`'s opt-in Costco check (it would load costco.com: the first live
    run is the owner's, below); savings per trip in `costco_trip` telemetry (`bought` is there);
    re-deriving a renamed product's pack size (past events are already in base units); bot-check
    detection is a guess ("Access Denied" and similar) until a live page shows Costco's.
  - **Prod copy (counts only, 2026-11-16):** migration applied cleanly (471 products, 0 aliases,
    471 items unchanged); main vs branch give the identical cart plan (50 lines) and W43–W46 weekly
    reports apart from the new Costco line, and identical data-quality output. Replaying the
    synthetic warehouse receipt on a throwaway copy: 5/5 lines applied, totals pass, 0 fuzzy
    matches (real item names share few tokens with warehouse abbreviations), 5 new unverified
    items — so the first real backfill leans on merge suggestions and online titles.
  - **M10.2 gaps:** both settled by #69 (owner, 2026-11-15) and left alone here: out items with
    a trip days away go to the weekly cart only, and text purchases create no Costco product —
    this importer is where Costco products and prices come from.
  - **First live run (owner, on the Mac):** sign in on the `pandabase` profile and set
    `orders_url` (SETUP-MAC *Costco*), one `receipts sweep --vendor costco`, then `--backfill`;
    save one warehouse receipt with a discount line if one turns up, for a new synthetic fixture.
  - **First live sweep (2026-11-15) read nothing:** 1 page, 1 click, 0 orders and 0 receipts
    while the Online tab showed delivered orders. The SPA renders each tab's frame
    (`myOrderHistory`, the tabs) before its cards, and the sweep read the frame alone; and the live
    cards run inline texts together ("Delivered on 11/10/2026Order …"), so `\b` after a date never
    matched and a delivered order would have looked pending. Fixed: the driver waits (≤ 8 s, then a
    network settle) for a card on the orders page and after the tab click, and the date patterns
    use digit-only boundaries. Regression tests: real Chromium with late-rendered cards, and the
    inline texts. Also `pandabase-tools api get '/path?k=v'` now takes the query from the path
    (CLAUDE.md's form for `/api/diagnostics/weekly?week=…` failed with "no agent route").
  - **Second live sweep (2026-11-16) timed out** clicking the Warehouse tab: with the display
    asleep, the headed Chrome in the agent account's background session stopped painting, so the
    click never saw a "stable" element. PandaBase's Chrome now runs headless (headed Chrome's user
    agent, a desktop screen size), and `HEADED=1 make install-chromium` gives a window for signing
    in (DESIGN §10 #81).
  - **Costco's silent session refresh** stopped sweeps with `refused_host` while Costco was still
    signed in: an expired token redirects `/myaccount/` → `/LogonForm` → `signin.costco.com`, whose
    page posts back to `/OAuthLogonCmd`, and the route aborted that post. Observed in full on
    2026-11-16 (redirects aren't routed; only the post is). The driver now lets that one post
    through during an account-page `open` and waits for `/myaccount/` (DESIGN §4.8). Regression
    tests: real Chromium on a fake costco.com with no 3xx responses (Playwright doesn't route a
    redirect's target, so a fake 302 would reach the real site) and a no-network check.
  - **First importing sweep (2026-11-16):** 6 receipts (4 warehouse, 2 online), 2 failed totals
    checks and 1 unread line. The unread line was a warehouse instant saving (`<coupon> / <item>
    <amount>-`), so that item stayed at full price; it now comes off the item it names. The online
    one was a one-item order: with no second item to bound it, the item's block grew to the whole
    page, so its price was the summary's first amount and its total the item's fee ("CA BEP FEE");
    and its "Discount on Order" broke subtotal + tax = total. Fixed: the block stops at the order
    summary, the fee is added to its item's line, and tax isn't sent with an order discount
    (DESIGN §10 #82). Ingest dedupes on the receipt id, so the six receipts already written keep
    the old lines until they are reset and swept again: `db:reset-imports --vendor costco`
    (Bootstrap input `vendor`) resets Costco's import alone, keeping Amazon's. It also stopped a
    reset from failing on a Costco trip that links to a deleted receipt (the trip keeps its status
    and loses only the link). On production it refuses: some Costco lines matched items an Amazon / Whole
    Foods import created, and Costco's ingest also moved those items' buy streaks and product
    stances, which deleting its lines can't undo. A full reset (every store) is unblocked but
    re-imports every Amazon and Whole Foods order too.
  - **Held receipts (2026-11-17, DESIGN §4.5 *Held receipts*, §10 #83):** so a misread can't reach
    shared items again, a digital receipt whose totals check fails is now stored as a
    `receipt_hold` (migration `0004_receipt_holds`) and not applied; a re-ingest of the order that
    adds up applies it, and the daily cron applies an unfixed hold as read after
    `receipts.heldExpireDays` (14). Ingest answers `status: "held"` (+ `held_until`); both sweeps
    keep held orders out of `done` (Amazon re-reads them past its list window) and re-send them
    under a key with the body's hash, so a corrected read isn't answered from the 24 h idempotency
    store. `db:reset-imports` deletes holds. Telemetry `receipt_held` / `receipt_hold_released`,
    `receipt_sweep.held`; weekly report §3 counts them. Does not fix the six receipts already
    applied: those still need a reset.
  - **Costco only (2026-11-17, the day #78 shipped):** the prod copy showed 33 of 35 checked Whole
    Foods orders failing the totals check (~6% either way) and 11 of 163 Amazon
    ones, so #78 would have held nearly every Whole Foods order, the weekly cart's included. Holds
    now apply only to `receipts.holdVendors` (`costco`). The `--vendor costco` reset of the six
    applied receipts is still blocked on production (14 other-store lines name Costco-created
    items; 4 Costco lines matched items an earlier import created); only the all-stores reset is
    unblocked.
  - **Whole Foods item grid (2026-11-22):** the failures weren't the store's: two saved live
    orders add up to their subtotal to the cent. The parser misread the grid's Quantity | Weight |
    Total cells — a weighed item's per-lb price as its price, a bare "2" as 1 (multi-unit buys
    undercounted in inventory), out-of-stock and refunded units as bought. It now reads the grid by
    its ids (DESIGN §6 *Whole Foods item grid*; synthetic fixture
    `order_details_live_pickup_grid.html`). Orders already imported keep their old lines until
    they're re-imported (the all-stores reset, still the owner's call). Next: importers declare
    whether their totals are exact (replacing `holdVendors`), so a new store needs no list edit.

---

