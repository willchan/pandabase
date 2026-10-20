// Drizzle implementation of the domain's `ReceiptRepository` (DESIGN §4.5, PLAN M3 "For M4").
import { inventoryEvent, inventoryState, product, vendorAlias } from "@pandabase/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { ReceiptRepository } from "../domain/receipts";
import { canonicalItems, getItem } from "./catalog";
import { lastBuiltCycle } from "./cycles";
import type { Q } from "./db";
import { awayPeriods, toState } from "./inventory";

export function receiptRepository(q: Q): ReceiptRepository {
  return {
    aliases: async (vendor) =>
      q
        .select({
          vendor: vendorAlias.vendor,
          kind: vendorAlias.kind,
          vendorString: vendorAlias.vendorString,
          itemId: vendorAlias.itemId,
          productId: vendorAlias.productId,
          confidenceScore: vendorAlias.confidenceScore,
          ignored: vendorAlias.ignored,
        })
        .from(vendorAlias)
        .where(eq(vendorAlias.vendor, vendor))
        .orderBy(asc(vendorAlias.id)),
    canonicalItems: () => canonicalItems(q),
    productsByAsin: async (vendor, asins) => {
      const keys = [...new Set(asins.flatMap((a) => [a, a.trim().toUpperCase()]))];
      return q
        .select({
          id: product.id,
          itemId: product.itemId,
          vendor: product.vendor,
          asin: product.asin,
        })
        .from(product)
        .where(and(eq(product.vendor, vendor), inArray(product.asin, keys)));
    },
    item: async (id) => {
      const i = await getItem(q, id);
      return {
        id: i.id,
        canonicalName: i.canonicalName,
        trackingType: i.trackingType,
        emaDays: i.currentEmaDays,
        defaultEmaDays: i.defaultEmaDays,
        outlierStreak: i.emaOutlierStreak,
        outlierDirection: i.emaOutlierDirection,
        defaultLocation: i.defaultLocation,
        reorderThreshold: i.reorderThreshold,
        shelfLifeDays: i.shelfLifeDays,
        switchThreshold: i.switchThreshold,
      };
    },
    products: async (itemId) =>
      (
        await q.select().from(product).where(eq(product.itemId, itemId)).orderBy(asc(product.id))
      ).map((p) => ({
        id: p.id,
        itemId: p.itemId,
        vendor: p.vendor,
        asin: p.asin,
        title: p.title,
        unitQuantity: p.unitQuantity,
        stance: p.stance,
        preferenceScore: p.preferenceScore,
        timesBought: p.timesBought,
        consecutiveBuys: p.consecutiveBuys,
        lastPriceCents: p.lastPriceCents,
      })),
    inventory: async (itemId) =>
      (await q.select().from(inventoryState).where(eq(inventoryState.itemId, itemId))).map(toState),
    acquisitions: async (itemId) =>
      (
        await q
          .select({ at: inventoryEvent.occurredAt, qty: inventoryEvent.quantity })
          .from(inventoryEvent)
          .where(
            and(
              eq(inventoryEvent.itemId, itemId),
              eq(inventoryEvent.kind, "acquired"),
              ne(inventoryEvent.trust, "expired"),
            ),
          )
          .orderBy(asc(inventoryEvent.occurredAt))
      ).map((a) => ({ at: a.at, qty: a.qty ?? 0 })),
    awayPeriods: () => awayPeriods(q),
    lastBuiltCycle: () => lastBuiltCycle(q),
  };
}
