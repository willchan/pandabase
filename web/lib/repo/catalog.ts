// Catalog reads shared by services.
import { item, product } from "@pandabase/db";
import { asc, eq, inArray, isNull } from "drizzle-orm";
import type { CanonicalItem } from "../domain/matching";
import type { ProductCandidate } from "../domain/productChoice";
import { notFound } from "../http";
import type { Q } from "./db";

export type ProductRow = typeof product.$inferSelect;

export async function getItem(q: Q, id: string) {
  const [row] = await q.select().from(item).where(eq(item.id, id));
  if (!row) throw notFound(`item ${id}`);
  return row;
}

export async function getProduct(q: Q, id: string) {
  const [row] = await q.select().from(product).where(eq(product.id, id));
  if (!row) throw notFound(`product ${id}`);
  return row;
}

export const canonicalItems = async (q: Q): Promise<CanonicalItem[]> =>
  q
    .select({ id: item.id, canonicalName: item.canonicalName })
    .from(item)
    .where(isNull(item.mergedIntoItemId))
    .orderBy(asc(item.id));

/** Products of `itemIds`, grouped by item. */
export async function productsByItem(
  q: Q,
  itemIds: readonly string[],
): Promise<Map<string, ProductRow[]>> {
  const out = new Map<string, ProductRow[]>();
  if (itemIds.length === 0) return out;
  const rows = await q
    .select()
    .from(product)
    .where(inArray(product.itemId, [...new Set(itemIds)]))
    .orderBy(asc(product.id));
  for (const p of rows) {
    let list = out.get(p.itemId);
    if (!list) out.set(p.itemId, (list = []));
    list.push(p);
  }
  return out;
}

export const toCandidate = (p: ProductRow): ProductCandidate => ({
  id: p.id,
  vendor: p.vendor,
  title: p.title,
  unitQuantity: p.unitQuantity,
  stance: p.stance,
  preferenceScore: p.preferenceScore,
  timesBought: p.timesBought,
  consecutiveBuys: p.consecutiveBuys,
  lastPriceCents: p.lastPriceCents,
});
