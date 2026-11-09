---
name: verify
description: How to see a PandaBase change working before calling it done — seeded phone screenshots for UI changes, the read-only prod copy for data/importer/prediction changes, and real-page-shaped fixtures for importer changes. Read before finishing any change to web pages, components, domain logic, importers, predictions or diagnostics.
---

# Verifying a PandaBase change

Tests passing isn't the bar: the 2026-11 import bug (every order tagged `wholefoods`, the
footer's "Amazon Business Card" imported as an item) passed every test because the fixtures were
cleaner than real pages. So look at the change the way the household will meet it. The tools are
in docs/TESTING.md *Verification loops*; this is when to use which.

**The repo is public.** Prod data, prod-copy screenshots and saved real pages never go in
commits, PRs, fixtures, CI logs or uploads. In chat: counts only. No Claude in Chrome (it is
Will's real browser and carts), no signed-in browsing of prod, and ask before any live Amazon
page load or anything that touches production.

## Pick the loop by what changed

| Change | Do |
|---|---|
| Anything | The fast checks it touches (`pnpm lint && pnpm typecheck && pnpm test`, the Python checks) |
| UI: a page, component, style, copy | + **Seeded shots** below |
| Data shape, importer, matching, predictions, cart plan, diagnostics | + **Prod copy** below (and seeded shots if a page shows it) |
| Importer / page parser (`agent/tools` receipt, cart or product parsing) | + **Real page shapes** below |

## Seeded shots (any UI change)

1. `pnpm --filter web shot / /pantry …` — every path your change shows, light and dark, into
   `web/.shots/`. It starts its own seeded server; `--base-url http://localhost:3000` reuses the
   `dev-seeded` one from `.claude/launch.json`.
2. It exits 1 on any console error, page error, failed request or HTTP ≥ 400 — fix those, don't
   wave them through (a hydration warning is an error).
3. **Open every PNG and look**: layout at 390 px, both themes, empty and long states, the bottom
   nav not covering content, text that fits. Iterate until it looks right, then re-shoot.
4. Put the final seeded shots in the PR. They are synthetic, so they may be pushed — but not onto
   `main`: commit them to a `shots/<topic>` branch made from an empty tree and link them in the PR
   body by raw URL (as #41 and #45 did):
   ```
   cp web/.shots/*.png "$TMPDIR" && git switch --orphan shots/<topic> && mv "$TMPDIR"/*.png .
   git add *.png && git commit -m "Screenshots for #N" && git push -u origin shots/<topic>
   git switch -   # back to your branch; link https://raw.githubusercontent.com/<owner>/<repo>/shots/<topic>/<file>.png
   ```
   Never `--prod-copy` shots. If pushing screenshots needs Will's OK in this session, ask once.

## Prod copy (data, importer, prediction, diagnostics changes)

1. `make prod-copy` — fresh read-only copy into `.scratch/prod-copy.db`, prints row counts. Needs
   the read-only token (`~/.config/pandabase/prod-ro.env`, or cloud environment secrets); if it
   is missing, say so and carry on with the seeded loop — never use the read-write token.
2. Run what your change affects against the copy, never against prod:
   - `pnpm --filter web data-quality` — the weekly report's data-quality checks, counts only.
   - Repairs and backfills: their dry-run (`--apply` omitted) with
     `TURSO_DATABASE_URL=file:.scratch/prod-copy.db`.
   - Screens: `dev-prod-copy` in `.claude/launch.json` or `pnpm --filter web shot --prod-copy …`.
     Look locally; these shots never leave the machine.
3. Compare before/after on the copy (run on `main`, then on your branch) and report **counts
   only**: rows changed, flags raised, lines matched. In the PR, write the counts, not names.
4. A regression the copy reveals gets a **synthetic** test shaped like it (CLAUDE.md: bug fixes
   start with a regression test).

## Real page shapes (importer and parser changes)

Fixtures drift from Amazon's live pages; check the parser against one real page of each kind it
reads (order list, order details for delivery / pickup / in-store, product, cart — whichever your
change touches). Only on the Mac Mini, with the member's own Chromium (not Claude in Chrome),
read-only — and **ask Will first**, naming the pages.

1. With his OK, open each page once through the tools' CDP driver (it blocks checkout routes) and
   save the HTML to the gitignored `.scratch/live-pages/`:
   ```python
   # from agent/tools: uv run python -I - <<'EOF'
   from pathlib import Path
   from pandabase_tools.browser import CdpDriver
   out = Path("../../.scratch/live-pages"); out.mkdir(parents=True, exist_ok=True)
   with CdpDriver("http://127.0.0.1:<member cdp port>") as d:   # profile.cdp_url
       snap = d.open("<order details URL>")
   (out / "order_details.html").write_text(snap.html)
   EOF
   ```
2. Run the parser on each saved page (`parse_order_list`, `parse_order_details`, …) and compare
   with what the page shows. Report counts only (lines found, store, status), never names, ids or
   prices.
3. Write or update **synthetic** fixtures in `agent/tools/tests/fixtures/amazon/` shaped like the
   real page — the same chrome (header, footer, no `<main>`, carousels), landmarks and wording, with
   invented order ids, `B0SYNTH…` ASINs, products and prices — add a row to its README, and a test
   that fails on the old parser.
4. **Delete the saved copies** (`rm -rf .scratch/live-pages`) before you commit, and say you did.

## Before you call it done

- Name in the PR which loops ran, and what each found (counts for the prod copy).
- If a loop couldn't run (no token, not on the Mac, Will hasn't OK'd a live page), say which and
  why rather than skipping it silently.
