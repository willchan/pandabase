---
name: digital-receipt-scraper
description: PandaBase digital receipts — sweep a household member's Amazon / Whole Foods order history (delivery, pickup, in-store) in their own Chromium profile and ingest finished orders; one-time 12-month backfill on request.
metadata:
  {
    "openclaw":
      {
        "emoji": "🧾",
        "requires": { "bins": ["pandabase-tools"], "env": ["AGENT_API_TOKEN", "PANDABASE_CONFIG"] },
      },
  }
---

# Digital receipt scraper

Triggers: the nightly automation for the cart member (21:00 daily), the weekly one for the other
member (Sunday 21:00), or a member asking to "backfill receipts" / "check my orders".

**Read-only on Amazon.** The tool only opens order-history and order-details pages in the
member's already-signed-in Chromium (over CDP). It never signs in, stores credentials, or goes
near checkout; neither do you. If Amazon is signed out, a human signs in on the Mac Mini.

## Sweep

```sh
pandabase-tools receipts sweep --member <member name>
```

It reads the member's cursor, walks orders newer than it (with a 2-week overlap — re-ingesting
is harmless), and ingests every order in a final state (Delivered / Picked up / in-store)
oldest first. Output: `{ingested, duplicates, pending, skipped, needs_agent_extraction, errors,
complete}`.

1. **`needs_agent_extraction`** (a details page whose layout had no product links): read
   `text` and build the receipt yourself — one line per purchased product with `raw_text` (the
   product name as printed), `qty`, and `unit_price_cents`/`line_total_cents` when shown (cents).
   Ignore recommendations, totals and shipping lines. Write this JSON to a file with the write
   tool:

   ```json
   {"vendor": "<vendor>", "external_order_id": "<order_id>", "fulfillment": "<fulfillment>",
    "acquired_at": "<acquired_at>", "ordered_at": "<ordered_at>", "total_cents": 907,
    "lines": [{"raw_text": "Synthetic Dish Soap, 24 fl oz", "qty": 1, "unit_price_cents": 399}]}
   ```

   ```sh
   pandabase-tools receipts ingest --member <member name> --input <file>
   ```

   If the text is unreadable, skip it — it'll be offered again on the next sweep.
2. **`ingested[].closed_cycle_id`** set → that order closed the grocery cycle. Post in the
   cycle's thread: "✅ Order picked up and in the pantry (N items). This week's list is closed."
   Then open the next cycle (`grocery-cycle` §1).
3. **`errors`** containing `not_signed_in` → post once to `channels.ops_channel`:
   "⚠️ Amazon is signed out in <member>'s browser on the Mac Mini — please sign in there. I'll
   pick up the receipts on the next run." Before posting, read the channel's recent messages
   (message tool `action: "read"`); if the same warning was posted in the last 7 days, stay
   silent. Other errors: stay silent (they're in telemetry and the weekly diagnostics).
4. Exit code 3 (`profile_locked`): the browser is busy (e.g. the cart build); run once more in
   15 minutes, then give up silently until the next scheduled sweep.

Otherwise the sweep is silent — no "nothing new" messages.

## Backfill (once, on request)

"Backfill receipts for <member>" → reply "🧾 Importing the last 12 months of <member>'s orders —
this takes a while; I'll post when it's done." Then repeat until `complete` is true or a run
makes no progress (nothing ingested and `errors` non-empty):

```sh
pandabase-tools receipts sweep --member <member name> --backfill
```

Each run pages through order history (throttled ~3 s/page) and resumes where the last one
stopped, so interruptions are fine. Handle `needs_agent_extraction` as above. When the loop ends
(and every extracted receipt is ingested), ask for merge suggestions once — the backfill created
one unverified item per product, and the worker proposes which of them are items we already have:

```sh
pandabase-tools api post /api/catalog/merge-suggestions/run --json '{}' --actor <member discord id> --key backfill-merges:<member discord id>:<YYYY-MM-DD>
```

It is idempotent (`skipped: "already_queued"` if a run is still waiting) and its suggestions land
in the web app's Cleanup → Merges tab; nobody has to answer them. Finish with one message:
"✅ Imported N orders from the last 12 months." (plus "⚠️ M couldn't be read" if any, and "Suggested
merges will appear in Cleanup → Merges." if the call returned `created: true`).
