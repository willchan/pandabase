// `pnpm db:rename-items [--apply]`: re-derive the names of auto-created items that were named
// before `deriveItemName` learned to drop a leading store brand (DESIGN §4.5; 2026-11-09: "365 By
// Whole Foods Market, Organic Peeled Garlic" made an item called "365 By Whole Foods Market").
// Touches only unverified, unmerged items whose current name is exactly what the old rule made
// from one of their product titles — a name a person gave or confirmed is never changed.
// Without --apply it only counts. Prints counts only (Actions logs are public).
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { and, asc, eq, isNull } from "drizzle-orm";
import { DEFAULT_CONFIG } from "../../web/lib/config";
import { deriveItemName } from "../../web/lib/domain/matching";
import { createDb, type Db } from "./client";
import { databaseUrlFromEnv } from "./env";
import { nowIso } from "./schema/common";
import { item, product } from "./schema/index";

export interface RenamePlan {
  /** Unverified, unmerged items looked at. */
  checked: number;
  renames: { itemId: string; from: string; to: string }[];
}

export async function planItemRenames(
  db: Db,
  storeBrands: readonly string[] = DEFAULT_CONFIG.itemNames.storeBrands,
): Promise<RenamePlan> {
  const items = await db
    .select({ id: item.id, name: item.canonicalName })
    .from(item)
    .where(and(eq(item.trust, "unverified"), isNull(item.mergedIntoItemId)))
    .orderBy(asc(item.id));
  const products = await db
    .select({ itemId: product.itemId, title: product.title })
    .from(product)
    .orderBy(asc(product.createdAt), asc(product.id));
  const titles = new Map<string, string[]>();
  for (const p of products) titles.set(p.itemId, [...(titles.get(p.itemId) ?? []), p.title]);
  const renames: RenamePlan["renames"] = [];
  for (const i of items) {
    for (const title of titles.get(i.id) ?? []) {
      if (deriveItemName(title) !== i.name) continue;
      const to = deriveItemName(title, storeBrands);
      if (to !== i.name) renames.push({ itemId: i.id, from: i.name, to });
      break;
    }
  }
  return { checked: items.length, renames };
}

export async function applyItemRenames(db: Db, now: string = nowIso()): Promise<RenamePlan> {
  return db.transaction(async (tx) => {
    const plan = await planItemRenames(tx as unknown as Db);
    for (const r of plan.renames) {
      await tx
        .update(item)
        .set({ canonicalName: r.to, updatedAt: now })
        .where(and(eq(item.id, r.itemId), eq(item.canonicalName, r.from)));
    }
    return plan;
  });
}

export function formatRenamePlan(plan: RenamePlan, applied: boolean): string {
  return [
    `Item names — ${applied ? "APPLIED" : "dry run"}`,
    `  unverified items checked  ${plan.checked}`,
    `  ${applied ? "renamed" : "would rename"}${" ".repeat(applied ? 10 : 5)}${plan.renames.length}`,
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
  const db = createDb({ url: databaseUrlFromEnv() });
  try {
    const plan = values.apply ? await applyItemRenames(db) : await planItemRenames(db);
    const text = formatRenamePlan(plan, values.apply);
    console.log(text);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, `\n\`\`\`\n${text}\n\`\`\`\n`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    db.$client.close();
  }
}
