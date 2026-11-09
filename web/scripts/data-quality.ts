// `pnpm --filter web data-quality` (docs/TESTING.md "Verification loops"): run the weekly
// report's data-quality checks (DESIGN §7) over every week with receipts in a LOCAL database —
// normally the prod copy (`make prod-copy`) — and print counts only, safe to paste into chat.
// `--names` also prints the flagged item names: for your own terminal, never for a PR or chat.
// Refuses anything but a `file:` database. Read-only.
import { createDb, receipt } from "@pandabase/db";
import { asc } from "drizzle-orm";
import path from "node:path";
import { parseArgs } from "node:util";
import { lastCompleteWeek, renderWeekly } from "../lib/diagnostics/weekly";
import { storeSplit } from "../lib/domain/dataQuality";
import { isoWeekLabel, localDate } from "../lib/domain/time";
import { loadConfig } from "../lib/repo/settings";
import { prodCopyRefusal } from "./dev-server";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const { values } = parseArgs({ options: { names: { type: "boolean", default: false } } });
const url = process.env.TURSO_DATABASE_URL || `file:${path.join(REPO, ".scratch", "prod-copy.db")}`;
const refusal = prodCopyRefusal(url);
if (refusal) {
  console.error(`data-quality refused: ${refusal}`);
  process.exit(1);
}

const db = createDb({ url, authToken: "" });
try {
  const { config } = await loadConfig(db);
  const tz = config.householdTz;
  const now = new Date().toISOString();
  const receipts = await db
    .select({
      createdAt: receipt.createdAt,
      acquiredAt: receipt.acquiredAt,
      vendor: receipt.vendor,
    })
    .from(receipt)
    .orderBy(asc(receipt.createdAt));
  const weeks = [...new Set(receipts.map((r) => isoWeekLabel(localDate(r.createdAt, tz))))];
  const current = lastCompleteWeek(now, tz);
  if (!weeks.includes(current)) weeks.push(current);

  type Dq = Record<string, unknown>;
  const rowsOf = async (week: string): Promise<Dq[]> => {
    const r = await renderWeekly(db, week, { now, config });
    const jsonl = r.extracts.find((e) => e.name === "data_quality.jsonl")!.jsonl.trim();
    return jsonl ? jsonl.split("\n").map((l) => JSON.parse(l) as Dq) : [];
  };

  console.log("Store split by week the receipts were imported (the report's view):");
  let catalog: Dq[] = [];
  for (const week of weeks) {
    const rows = await rowsOf(week);
    catalog = rows; // catalog/plan checks are "as of now": identical every week
    const split = rows.find((r) => r.check === "store_split")!;
    const by = Object.entries(split.by_store as Record<string, number>)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    console.log(
      `  ${week}  ${String(split.lines).padStart(5)} lines  ${by || "-"}  top ${Math.round(Number(split.top_share) * 100)}%${split.flagged ? "  FLAGGED" : ""}`,
    );
  }

  // The same check by purchase week: how often a real shopping week is (nearly) one store.
  const byPurchase = new Map<string, string[]>();
  for (const r of receipts) {
    const w = isoWeekLabel(localDate(r.acquiredAt, tz));
    byPurchase.set(w, [...(byPurchase.get(w) ?? []), r.vendor]);
  }
  const purchaseWeeks = [...byPurchase.values()].map((v) => storeSplit(v, config));
  const share95 = purchaseWeeks.filter((s) => s.topShare >= config.dataQuality.storeSplitShare);
  console.log(
    `\nBy purchase week (receipts, not lines): ${purchaseWeeks.length} weeks, ${share95.length} with ≥ ${Math.round(config.dataQuality.storeSplitShare * 100)}% from one store.`,
  );

  const adLike = catalog.filter((r) => r.check === "ad_like_name");
  const stale = catalog.filter((r) => r.check === "stale_runout_planned");
  const phrases = new Map<string, number>();
  for (const r of adLike) phrases.set(String(r.phrase), (phrases.get(String(r.phrase)) ?? 0) + 1);
  const reasons = new Map<string, number>();
  for (const r of stale) {
    const k = String(r.reason ?? "override");
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  console.log(
    `\nAd-like item names (catalog, now): ${adLike.length}` +
      (adLike.length
        ? ` — ${[...phrases].map(([p, c]) => `"${p}" ${c}`).join(", ")}; in the cart plan: ${adLike.filter((r) => r.planned).length}`
        : ""),
  );
  console.log(
    `Planned items that ran out > ${config.lapsedAfterDays} days ago (now): ${stale.length}` +
      (stale.length ? ` — by reason: ${[...reasons].map(([k, c]) => `${k} ${c}`).join(", ")}` : ""),
  );
  if (values.names) {
    console.log("\n(--names: local only, don't paste)");
    for (const r of adLike) console.log(`  ad-like: ${String(r.item)}`);
    for (const r of stale) console.log(`  stale: ${String(r.item)} (${String(r.days_ago)} d)`);
  }
} finally {
  db.$client.close();
}
