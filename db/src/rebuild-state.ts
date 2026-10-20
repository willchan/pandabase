// Rebuild `inventory_state` from `inventory_event` (DESIGN §2.3).
//
// M2 STUB: a naive projection — no decay, no shelf life, no away days. Quantities simply add and
// subtract. M3 replaces the fold with the real §4.2 projection from `web/lib/domain/`.
import { asc, ne } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { createDb, type Db } from "./client";
import { nowIso } from "./schema/common";
import { inventoryEvent, inventoryState } from "./schema/inventory";

type EventRow = typeof inventoryEvent.$inferSelect;
type StateRow = typeof inventoryState.$inferInsert;

/** Fold events (already sorted by `occurred_at`) into one state row per (item, location). */
export function projectNaive(events: readonly EventRow[], now: string): StateRow[] {
  const rows = new Map<string, StateRow>();
  const at = (itemId: string, location: EventRow["location"]): StateRow => {
    const key = `${itemId}\u0000${location}`;
    let row = rows.get(key);
    if (!row) {
      row = { itemId, location, createdAt: now, updatedAt: now };
      rows.set(key, row);
    }
    return row;
  };
  const anchor = (row: StateRow, qty: number, t: string, kind: "acquired" | "observed") => {
    row.anchorQty = Math.max(0, qty);
    row.anchorAt = t;
    row.anchorKind = kind;
  };

  for (const e of events) {
    const row = at(e.itemId, e.location);
    const qty = row.anchorQty ?? 0;
    switch (e.kind) {
      case "acquired":
        anchor(row, qty + e.quantity, e.occurredAt, "acquired");
        row.statusOverride = null;
        break;
      case "observed":
        anchor(row, e.quantity, e.occurredAt, "observed");
        row.lastVerifiedAt = e.occurredAt;
        break;
      case "consumed":
        anchor(row, 0, e.occurredAt, row.anchorKind ?? "observed");
        break;
      case "discarded":
      case "presumed_discarded":
        anchor(row, qty - e.quantity, e.occurredAt, row.anchorKind ?? "observed");
        break;
      case "moved": {
        anchor(row, qty - e.quantity, e.occurredAt, row.anchorKind ?? "observed");
        if (e.toLocation) {
          const dest = at(e.itemId, e.toLocation);
          anchor(dest, (dest.anchorQty ?? 0) + e.quantity, e.occurredAt, "acquired");
          if (e.toLocation === "freezer") dest.frozenAt = e.occurredAt;
        }
        break;
      }
    }
    if (e.statusOverride) row.statusOverride = e.statusOverride;
  }
  return [...rows.values()];
}

/** Replace `inventory_state` with a projection of all non-expired events. */
export async function rebuildInventoryState(db: Db, now: string = nowIso()): Promise<number> {
  const events = await db
    .select()
    .from(inventoryEvent)
    .where(ne(inventoryEvent.trust, "expired"))
    .orderBy(asc(inventoryEvent.occurredAt), asc(inventoryEvent.id));
  const rows = projectNaive(events, now);
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
