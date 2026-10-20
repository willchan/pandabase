// Item detail (Pantry → item) and the item settings a household edits there (DESIGN §2.2).
import { inventoryEvent, item, member, type Db } from "@pandabase/db";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { replayVelocity } from "../domain/velocity";
import { badRequest, notFound } from "../http";
import { getItem, productsByItem, type ProductRow } from "../repo/catalog";
import type { Q } from "../repo/db";
import {
  awayPeriods,
  loadEstimates,
  refreshInventoryState,
  type ItemEstimate,
} from "../repo/inventory";
import { emitTelemetry } from "../telemetry";
import type { ServiceCtx } from "./types";

type ReadCtx = Pick<ServiceCtx, "now" | "config">;

export interface EmaPoint {
  at: string;
  /** EMA after this purchase (days one base unit lasts); null before there are two purchases. */
  emaDays: number | null;
  /** Days per unit this interval measured (null for the first purchase). */
  observedDays: number | null;
  outcome: string;
}

export interface ItemDetail {
  estimate: ItemEstimate;
  products: ProductRow[];
  events: (typeof inventoryEvent.$inferSelect & { actorName: string | null })[];
  /** EMA replayed over the item's purchases (§4.1) — the curve the stored EMA came from. */
  emaHistory: EmaPoint[];
}

export async function itemDetail(
  q: Q,
  itemId: string,
  ctx: ReadCtx,
  opts: { eventLimit?: number } = {},
): Promise<ItemDetail> {
  const it = await getItem(q, itemId);
  const estimate = (await loadEstimates(q, ctx.now, ctx.config, [it.id])).get(it.id);
  if (!estimate) throw notFound(`item ${itemId}`);
  const products = (await productsByItem(q, [it.id])).get(it.id) ?? [];
  const names = new Map(
    (await q.select({ id: member.id, name: member.displayName }).from(member)).map((m) => [
      m.id,
      m.name,
    ]),
  );
  const events = await q
    .select()
    .from(inventoryEvent)
    .where(eq(inventoryEvent.itemId, it.id))
    .orderBy(desc(inventoryEvent.occurredAt), desc(inventoryEvent.id))
    .limit(opts.eventLimit ?? 40);
  const acquisitions = await q
    .select({ at: inventoryEvent.occurredAt, qty: inventoryEvent.quantity })
    .from(inventoryEvent)
    .where(
      and(
        eq(inventoryEvent.itemId, it.id),
        eq(inventoryEvent.kind, "acquired"),
        ne(inventoryEvent.trust, "expired"),
      ),
    )
    .orderBy(asc(inventoryEvent.occurredAt));
  const replay = replayVelocity(
    {
      emaDays: null,
      defaultEmaDays: it.defaultEmaDays,
      outlierStreak: 0,
      outlierDirection: null,
    },
    acquisitions.map((a) => ({ at: a.at, qty: a.qty ?? 0 })),
    { away: await awayPeriods(q), config: ctx.config },
  );
  const merged = acquisitions.length === replay.steps.length ? acquisitions : null;
  return {
    estimate,
    products,
    events: events.map((e) => ({
      ...e,
      actorName: e.actorMemberId ? (names.get(e.actorMemberId) ?? null) : null,
    })),
    emaHistory: replay.steps.map((s, i) => ({
      at: merged?.[i]?.at ?? "",
      emaDays: s.state.emaDays,
      observedDays: s.observedDays,
      outcome: s.outcome,
    })),
  };
}

export interface ItemSettingsPatch {
  auditHint?: string | null;
  shelfLifeDays?: number | null;
  reorderThreshold?: number | null;
}

/** Edit an item's audit hint, shelf life and reorder threshold; re-projects its inventory. */
export async function updateItemSettings(
  db: Db,
  itemId: string,
  patch: ItemSettingsPatch,
  ctx: ServiceCtx,
): Promise<void> {
  const set: ItemSettingsPatch = {};
  if (patch.auditHint !== undefined) {
    const hint = patch.auditHint?.trim() || null;
    if (hint && hint.length > 200) throw badRequest("audit hint is too long");
    set.auditHint = hint;
  }
  if (patch.shelfLifeDays !== undefined) {
    const d = patch.shelfLifeDays;
    if (d !== null && !(Number.isInteger(d) && d > 0 && d <= 3650)) {
      throw badRequest("shelf life must be a whole number of days (1–3650)");
    }
    set.shelfLifeDays = d;
  }
  if (patch.reorderThreshold !== undefined) {
    const t = patch.reorderThreshold;
    if (t !== null && !(Number.isFinite(t) && t >= 0)) {
      throw badRequest("reorder threshold must be 0 or more");
    }
    set.reorderThreshold = t;
  }
  const fields = Object.keys(set);
  if (fields.length === 0) return;
  await db.transaction(async (tx) => {
    const it = await getItem(tx, itemId);
    if (it.mergedIntoItemId) throw badRequest(`item ${it.id} was merged`);
    await tx
      .update(item)
      .set({ ...set, updatedAt: ctx.now })
      .where(eq(item.id, it.id));
    await refreshInventoryState(tx, [it.id], ctx.now, ctx.config);
    await emitTelemetry(
      tx,
      "state_engine",
      [{ metric: "item_settings_changed", itemId: it.id, fields }],
      ctx.now,
    );
  });
}
