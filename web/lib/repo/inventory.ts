// Inventory reads (read-time estimates, §4.2) and `inventory_state` maintenance.
import { awayPeriod, inventoryEvent, inventoryState, item } from "@pandabase/db";
import { projectRows, toInventoryItem } from "@pandabase/db/rebuild-state";
import { and, asc, inArray, isNull, ne } from "drizzle-orm";
import type { Config } from "../config";
import {
  estimateItem,
  freshnessBatches,
  type Estimate,
  type InventoryItem,
  type InventoryState,
} from "../domain/inventory";
import type { AwayPeriod } from "../domain/time";
import type { Acquisition } from "../domain/velocity";
import type { Q } from "./db";

export type ItemRow = typeof item.$inferSelect;
export type EventRow = typeof inventoryEvent.$inferSelect;

export const awayPeriods = async (q: Q): Promise<AwayPeriod[]> =>
  q.select({ startsOn: awayPeriod.startsOn, endsOn: awayPeriod.endsOn }).from(awayPeriod);

export const toState = (s: typeof inventoryState.$inferSelect): InventoryState => ({
  location: s.location,
  anchorQty: s.anchorQty,
  anchorAt: s.anchorAt,
  anchorKind: s.anchorKind,
  statusOverride: s.statusOverride,
  frozenAt: s.frozenAt,
  lastVerifiedAt: s.lastVerifiedAt,
});

/** Re-project `inventory_state` for `itemIds` from their non-expired events. */
export async function refreshInventoryState(
  q: Q,
  itemIds: readonly string[],
  now: string,
  config: Config,
): Promise<void> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return;
  const items = await q.select().from(item).where(inArray(item.id, ids));
  const events = await q
    .select()
    .from(inventoryEvent)
    .where(and(inArray(inventoryEvent.itemId, ids), ne(inventoryEvent.trust, "expired")))
    .orderBy(asc(inventoryEvent.occurredAt), asc(inventoryEvent.id));
  const rows = projectRows(items, events, await awayPeriods(q), now, config);
  await q.delete(inventoryState).where(inArray(inventoryState.itemId, ids));
  if (rows.length > 0) await q.insert(inventoryState).values(rows);
}

export interface ItemEstimate {
  item: ItemRow;
  inv: InventoryItem;
  states: InventoryState[];
  estimate: Estimate & { byLocation: (Estimate & { location: string })[] };
  acquisitionsByLocation: Record<string, Acquisition[]>;
  /** Latest non-expired acquisition. */
  lastAcquired: { at: string; trust: "confirmed" | "provisional" } | null;
  /** Latest count across locations. */
  lastVerifiedAt: string | null;
}

/** Read-time estimates for active (unmerged) items, or just `itemIds`. */
export async function loadEstimates(
  q: Q,
  now: string,
  config: Config,
  itemIds?: readonly string[],
): Promise<Map<string, ItemEstimate>> {
  const scope = itemIds ? [...new Set(itemIds)] : null;
  if (scope && scope.length === 0) return new Map();
  const items = await q
    .select()
    .from(item)
    .where(scope ? inArray(item.id, scope) : isNull(item.mergedIntoItemId));
  const ids = items.map((i) => i.id);
  const states = ids.length
    ? await q.select().from(inventoryState).where(inArray(inventoryState.itemId, ids))
    : [];
  // Acquisitions and counts: the events that start a shelf-life clock (§4.2).
  const clockEvents = ids.length
    ? await q
        .select({
          itemId: inventoryEvent.itemId,
          kind: inventoryEvent.kind,
          location: inventoryEvent.location,
          quantity: inventoryEvent.quantity,
          toLocation: inventoryEvent.toLocation,
          statusOverride: inventoryEvent.statusOverride,
          occurredAt: inventoryEvent.occurredAt,
          trust: inventoryEvent.trust,
        })
        .from(inventoryEvent)
        .where(
          and(
            inArray(inventoryEvent.itemId, ids),
            inArray(inventoryEvent.kind, ["acquired", "observed"]),
            ne(inventoryEvent.trust, "expired"),
          ),
        )
        .orderBy(asc(inventoryEvent.occurredAt), asc(inventoryEvent.id))
    : [];
  const away = await awayPeriods(q);
  const out = new Map<string, ItemEstimate>();
  for (const i of items) {
    const inv = toInventoryItem(i);
    const mine = states.filter((s) => s.itemId === i.id).map(toState);
    const mineEvents = clockEvents.filter((e) => e.itemId === i.id);
    const byLoc = freshnessBatches(mineEvents);
    const last = mineEvents.filter((e) => e.kind === "acquired").at(-1);
    const verified = mine
      .map((s) => s.lastVerifiedAt)
      .filter((t): t is string => t !== null)
      .sort()
      .at(-1);
    out.set(i.id, {
      item: i,
      inv,
      states: mine,
      estimate: estimateItem(inv, mine, now, { away, config }, byLoc),
      acquisitionsByLocation: byLoc,
      lastAcquired: last
        ? { at: last.occurredAt, trust: last.trust === "confirmed" ? "confirmed" : "provisional" }
        : null,
      lastVerifiedAt: verified ?? null,
    });
  }
  return out;
}
