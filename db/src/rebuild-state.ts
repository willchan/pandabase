// Rebuild `inventory_state` from `inventory_event` (DESIGN §2.3) with the §4.2 projection from
// `web/lib/domain/inventory.ts` — the one implementation of the fold. Imported by relative path:
// `@pandabase/db` can't depend on `web` (web depends on db from M4 on), and the domain module is
// pure TS with relative imports only.
import { asc, ne } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, type Config } from "../../web/lib/config";
import {
  projectInventory,
  type InventoryEvent,
  type InventoryItem,
} from "../../web/lib/domain/inventory";
import type { AwayPeriod } from "../../web/lib/domain/time";
import { createDb, type Db } from "./client";
import { nowIso } from "./schema/common";
import { item } from "./schema/catalog";
import { inventoryEvent, inventoryState } from "./schema/inventory";
import { awayPeriod } from "./schema/people";

type EventRow = typeof inventoryEvent.$inferSelect;
type ItemRow = Pick<
  typeof item.$inferSelect,
  | "id"
  | "trackingType"
  | "currentEmaDays"
  | "defaultLocation"
  | "reorderThreshold"
  | "shelfLifeDays"
>;
type StateRow = typeof inventoryState.$inferInsert;

export const toInventoryItem = (i: ItemRow): InventoryItem => ({
  trackingType: i.trackingType,
  emaDays: i.currentEmaDays,
  defaultLocation: i.defaultLocation,
  reorderThreshold: i.reorderThreshold,
  shelfLifeDays: i.shelfLifeDays,
});

/** Project every item's events into `inventory_state` rows (pure; `now` stamps the rows). */
export function projectRows(
  items: readonly ItemRow[],
  events: readonly EventRow[],
  away: readonly AwayPeriod[],
  now: string,
  config: Config = DEFAULT_CONFIG,
): StateRow[] {
  const byItem = new Map<string, InventoryEvent[]>();
  for (const e of events) {
    let list = byItem.get(e.itemId);
    if (!list) byItem.set(e.itemId, (list = []));
    list.push(e);
  }
  const rows: StateRow[] = [];
  for (const i of items) {
    const evs = byItem.get(i.id);
    if (!evs) continue;
    const { states } = projectInventory(toInventoryItem(i), evs, { away, config });
    for (const s of states) {
      rows.push({
        ...s,
        itemId: i.id,
        location: s.location as StateRow["location"],
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return rows;
}

/**
 * Replace `inventory_state` with a projection of all non-expired events. `tz` defaults to
 * `HOUSEHOLD_TZ`, then the config default.
 */
export async function rebuildInventoryState(
  db: Db,
  now: string = nowIso(),
  opts: { tz?: string } = {},
): Promise<number> {
  const config: Config = {
    ...DEFAULT_CONFIG,
    householdTz: opts.tz ?? process.env.HOUSEHOLD_TZ ?? DEFAULT_CONFIG.householdTz,
  };
  const items = await db.select().from(item);
  const away = await db.select().from(awayPeriod);
  const events = await db
    .select()
    .from(inventoryEvent)
    .where(ne(inventoryEvent.trust, "expired"))
    .orderBy(asc(inventoryEvent.occurredAt), asc(inventoryEvent.id));
  const rows = projectRows(items, events, away, now, config);
  await db.transaction(async (tx) => {
    await tx.delete(inventoryState);
    for (let i = 0; i < rows.length; i += 200) {
      await tx.insert(inventoryState).values(rows.slice(i, i + 200));
    }
  });
  return rows.length;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const db = createDb();
  const n = await rebuildInventoryState(db);
  console.log(`inventory_state rebuilt: ${n} rows`);
  db.$client.close();
}
