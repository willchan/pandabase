// Grocery cycle reads and the contract shape of a cycle.
import { ACTIVE_CYCLE_STATUSES, groceryCycle } from "@pandabase/db";
import { desc, eq, inArray, isNotNull } from "drizzle-orm";
import { CartResult, type CartResultT, type CycleT } from "../contracts/cycle";
import type { CycleCart } from "../domain/receipts";
import { notFound } from "../http";
import type { Q } from "./db";

export type CycleRow = typeof groceryCycle.$inferSelect;

/** `cart_result` in the M4 shape, or null (older/foreign shapes are ignored). */
export const parseCartResult = (v: unknown): CartResultT | null => {
  const r = CartResult.safeParse(v);
  return r.success ? r.data : null;
};

export const toCycle = (c: CycleRow): CycleT => ({
  id: c.id,
  week_label: c.weekLabel,
  status: c.status,
  discord_thread_id: c.discordThreadId,
  opened_at: c.openedAt,
  nudge_sent_at: c.nudgeSentAt,
  built_at: c.builtAt,
  closed_at: c.closedAt,
  close_reason: c.closeReason,
  cart_result: parseCartResult(c.cartResult),
});

export async function getCycle(q: Q, id: string): Promise<CycleRow> {
  const [row] = await q.select().from(groceryCycle).where(eq(groceryCycle.id, id));
  if (!row) throw notFound(`cycle ${id}`);
  return row;
}

export async function activeCycle(q: Q): Promise<CycleRow | null> {
  const [row] = await q
    .select()
    .from(groceryCycle)
    .where(inArray(groceryCycle.status, [...ACTIVE_CYCLE_STATUSES]));
  return row ?? null;
}

/** The most recently built cycle as `applyReceipt` sees it (DESIGN §4.5). */
export async function lastBuiltCycle(q: Q): Promise<CycleCart | null> {
  const [row] = await q
    .select()
    .from(groceryCycle)
    .where(isNotNull(groceryCycle.builtAt))
    .orderBy(desc(groceryCycle.builtAt))
    .limit(1);
  if (!row) return null;
  const cart = parseCartResult(row.cartResult);
  return {
    cycleId: row.id,
    status: row.status,
    builtAt: row.builtAt,
    cartVendors: cart?.vendors ?? [],
    orderIds: cart?.order_ids ?? [],
    lines: (cart?.lines ?? [])
      .filter((l) => l.outcome !== "failed" && l.item_id !== null)
      .map((l) => ({ itemId: l.item_id!, productId: l.product_id })),
    pleaseCheckItemIds: cart?.please_check_item_ids ?? [],
  };
}
