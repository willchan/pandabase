// Receipt ingest (DESIGN §4.5): dedupe → `applyReceipt` → persist its effects in one transaction
// → telemetry. Used by `POST /api/receipts/ingest`, text purchases, and paper-receipt jobs.
import {
  groceryCycle,
  inventoryEvent,
  item,
  preferenceEvent,
  product,
  receipt,
  receiptHold,
  receiptLine,
  reviewItem,
  type Db,
} from "@pandabase/db";
import { and, asc, eq, lte } from "drizzle-orm";
import { monotonicFactory } from "ulid";
import type { ReceiptIngestResponseT } from "../contracts/receipts";
import {
  applyReceipt,
  heldReceiptExpiry,
  holdsReceipt,
  receiptDedupeKey,
  type ReceiptEffects,
  type ReceiptInput,
} from "../domain/receipts";
import { badRequest } from "../http";
import type { Q } from "../repo/db";
import { refreshInventoryState } from "../repo/inventory";
import { receiptRepository } from "../repo/receipts";
import { emitTelemetry } from "../telemetry";
import { linkCostcoReceiptIn } from "./costco";
import { openNextCycleIn } from "./cycles";
import type { ServiceCtx } from "./types";

export const newId = monotonicFactory();

type ItemInsert = typeof item.$inferInsert;
type EventInsert = typeof inventoryEvent.$inferInsert;

export interface IngestInput extends ReceiptInput {
  jobId?: string | null;
}

/** Ingest a receipt in its own transaction. Re-ingesting the same receipt is a no-op. */
export async function ingestReceipt(
  db: Db,
  input: IngestInput,
  ctx: ServiceCtx,
): Promise<ReceiptIngestResponseT> {
  try {
    return await db.transaction((tx) => ingestReceiptIn(tx, input, ctx));
  } catch (err) {
    // A concurrent ingest of the same receipt won the unique dedupe key.
    if (String(err).includes("receipt.dedupe_key")) {
      const existing = await existingReceipt(db, dedupeKey(input, ctx));
      if (existing) return existing;
    }
    throw err;
  }
}

const dedupeKey = (input: ReceiptInput, ctx: ServiceCtx): string => {
  try {
    return receiptDedupeKey(input, ctx.config.householdTz);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
};

/**
 * Ingest within the caller's transaction (composable with other writes). A digital receipt whose
 * totals check fails is held instead (§4.5 Held receipts); `asIs` applies a held one regardless
 * (its expiry).
 */
export async function ingestReceiptIn(
  q: Q,
  input: IngestInput,
  ctx: ServiceCtx,
  opts: { asIs?: boolean } = {},
): Promise<ReceiptIngestResponseT> {
  const key = dedupeKey(input, ctx);
  const existing = await existingReceipt(q, key);
  if (existing) return existing;
  const [hold] = await q.select().from(receiptHold).where(eq(receiptHold.dedupeKey, key));
  if (!opts.asIs && holdsReceipt(input)) return holdReceiptIn(q, key, input, hold, ctx);
  const fx = await applyReceipt(input, receiptRepository(q), {
    config: ctx.config,
    newId: () => newId(),
    now: ctx.now,
  });
  const out = await persistReceiptEffects(q, input, fx, ctx);
  if (hold?.status === "held") {
    const attempts = hold.attempts + (opts.asIs ? 0 : 1);
    await q
      .update(receiptHold)
      .set({
        status: opts.asIs ? "expired" : "applied",
        attempts,
        resolvedAt: ctx.now,
        receiptId: out.receipt_id,
        updatedAt: ctx.now,
      })
      .where(eq(receiptHold.id, hold.id));
    await emitTelemetry(
      q,
      "state_engine",
      [
        {
          metric: "receipt_hold_released",
          holdId: hold.id,
          receiptId: out.receipt_id,
          vendor: hold.vendor,
          outcome: opts.asIs
            ? "expired"
            : fx.receipt.totalsCheck === "pass"
              ? "totals_pass"
              : "unchecked",
          attempts,
          heldDays: Math.round((Date.parse(ctx.now) - Date.parse(hold.createdAt)) / 864e5),
        },
      ],
      ctx.now,
    );
  }
  return out;
}

/**
 * §4.5 Held receipts: store (or replace) the order's input without applying anything. The expiry
 * is set when the order is first held; a re-ingest replaces the lines but doesn't extend it.
 */
async function holdReceiptIn(
  q: Q,
  key: string,
  input: IngestInput,
  prev: typeof receiptHold.$inferSelect | undefined,
  ctx: ServiceCtx,
): Promise<ReceiptIngestResponseT> {
  const { now } = ctx;
  const stored: IngestInput = { ...input };
  delete stored.jobId; // digital receipts come from no job
  const row = {
    source: input.source,
    vendor: input.vendor,
    accountMemberId: input.accountMemberId,
    externalOrderId: input.externalOrderId,
    acquiredAt: input.acquiredAt,
    input: stored,
    status: "held" as const,
    resolvedAt: null,
    receiptId: null,
    updatedAt: now,
  };
  let id: string, attempts: number, expiresAt: string;
  if (prev) {
    // A held order read again, or a resolved hold whose receipt was reset away (db:reset-imports).
    id = prev.id;
    attempts = prev.status === "held" ? prev.attempts + 1 : 1;
    expiresAt = prev.status === "held" ? prev.expiresAt : heldReceiptExpiry(now, ctx.config);
    await q
      .update(receiptHold)
      .set({ ...row, attempts, expiresAt })
      .where(eq(receiptHold.id, id));
  } else {
    id = newId();
    attempts = 1;
    expiresAt = heldReceiptExpiry(now, ctx.config);
    await q
      .insert(receiptHold)
      .values({ ...row, id, dedupeKey: key, attempts, expiresAt, createdAt: now });
  }
  await emitTelemetry(
    q,
    "state_engine",
    [
      {
        metric: "receipt_held",
        holdId: id,
        vendor: input.vendor,
        fulfillment: input.fulfillment,
        attempt: attempts,
        lines: input.lines.length,
        replaced: prev?.status === "held" && JSON.stringify(prev.input) !== JSON.stringify(stored),
        heldUntil: expiresAt,
      },
    ],
    now,
  );
  return {
    receipt_id: id,
    duplicate: false,
    status: "held",
    totals_check: "fail",
    lines: [],
    new_item_ids: [],
    review_ids: [],
    closed_cycle_id: null,
    costco_trip_id: null,
    held_until: expiresAt,
  };
}

/**
 * §4.5 default outcome: holds nobody fixed by `expires_at` are applied as read (daily cron), each
 * in its own transaction, oldest receipt first (a late receipt skips the EMA step, §4.1).
 */
export async function applyExpiredHolds(db: Db, ctx: ServiceCtx): Promise<number> {
  const due = await db
    .select({ id: receiptHold.id, input: receiptHold.input })
    .from(receiptHold)
    .where(and(eq(receiptHold.status, "held"), lte(receiptHold.expiresAt, ctx.now)))
    .orderBy(asc(receiptHold.acquiredAt), asc(receiptHold.id));
  for (const h of due) {
    await db.transaction((tx) => ingestReceiptIn(tx, h.input as IngestInput, ctx, { asIs: true }));
  }
  return due.length;
}

async function existingReceipt(q: Q, key: string): Promise<ReceiptIngestResponseT | null> {
  const [r] = await q.select().from(receipt).where(eq(receipt.dedupeKey, key));
  if (!r) return null;
  const lines = await q
    .select()
    .from(receiptLine)
    .where(eq(receiptLine.receiptId, r.id))
    .orderBy(asc(receiptLine.id));
  const reviews = await q
    .select({ id: reviewItem.id })
    .from(reviewItem)
    .where(eq(reviewItem.receiptId, r.id))
    .orderBy(asc(reviewItem.id));
  return {
    receipt_id: r.id,
    duplicate: true,
    status: r.status,
    totals_check: r.totalsCheck,
    lines: lines.map((l) => ({
      id: l.id,
      raw_text: l.rawText,
      item_id: l.itemId,
      product_id: l.productId,
      match_method: l.matchMethod,
      match_score: l.matchScore,
      trust: l.trust,
      pending: l.itemId === null && !l.ignored,
      ignored: l.ignored,
    })),
    new_item_ids: [],
    review_ids: reviews.map((x) => x.id),
    closed_cycle_id: null,
    costco_trip_id: null,
  };
}

/**
 * Commit `applyReceipt`'s effects (PLAN M3 "For M4"): new items/products, the receipt and its
 * lines, `acquired` events (`source_ref` = receipt id), item/product patches, preference events,
 * reviews, the cycle patch, the `inventory_state` projection, and the domain telemetry.
 */
export async function persistReceiptEffects(
  q: Q,
  input: IngestInput,
  fx: ReceiptEffects,
  ctx: ServiceCtx,
): Promise<ReceiptIngestResponseT> {
  const { now } = ctx;
  const stamp = { createdAt: now, updatedAt: now };

  if (fx.newItems.length > 0) {
    await q.insert(item).values(
      fx.newItems.map((i): ItemInsert => ({
        ...stamp,
        id: i.id,
        canonicalName: i.canonicalName,
        category: i.category,
        defaultLocation: i.defaultLocation as ItemInsert["defaultLocation"],
        trackingType: i.trackingType,
        baseUnit: i.baseUnit,
        trust: i.trust,
        switchThreshold: ctx.config.product.defaultSwitchThreshold,
      })),
    );
  }
  if (fx.newProducts.length > 0) {
    await q.insert(product).values(fx.newProducts.map((p) => ({ ...stamp, ...p })));
  }

  const receiptId = newId();
  await q.insert(receipt).values({
    ...stamp,
    id: receiptId,
    source: input.source,
    vendor: input.vendor,
    accountMemberId: input.accountMemberId,
    externalOrderId: input.externalOrderId,
    dedupeKey: fx.receipt.dedupeKey,
    fulfillment: input.fulfillment,
    orderedAt: input.orderedAt,
    acquiredAt: input.acquiredAt,
    subtotalCents: input.subtotalCents,
    totalCents: input.totalCents,
    totalsCheck: fx.receipt.totalsCheck,
    jobId: input.jobId ?? null,
    status: fx.receipt.status,
  });

  const lineIds = fx.lines.map(() => newId());
  if (fx.lines.length > 0) {
    await q.insert(receiptLine).values(
      fx.lines.map((l, i) => ({
        ...stamp,
        id: lineIds[i]!,
        receiptId,
        rawText: l.rawText,
        asin: l.asin,
        vendorSku: l.vendorSku ?? null,
        productId: l.productId,
        itemId: l.itemId,
        qty: l.qty,
        unitPriceCents: l.unitPriceCents,
        lineTotalCents: l.lineTotalCents,
        matchMethod: l.matchMethod,
        matchScore: l.matchScore,
        trust: l.trust,
        ignored: l.ignored,
      })),
    );
  }

  if (fx.inventoryEvents.length > 0) {
    await q.insert(inventoryEvent).values(
      fx.inventoryEvents.map((e): EventInsert => ({
        ...stamp,
        id: newId(),
        itemId: e.itemId,
        location: e.location as EventInsert["location"],
        kind: e.kind,
        quantity: e.quantity,
        occurredAt: e.occurredAt,
        source: e.source,
        sourceRef: receiptId,
        actorMemberId: ctx.actor.memberId,
        actorSystem: ctx.actor.system,
        trust: e.trust,
      })),
    );
  }

  for (const { id, patch } of fx.itemPatches) {
    await q
      .update(item)
      .set({
        updatedAt: now,
        ...("emaDays" in patch ? { currentEmaDays: patch.emaDays } : {}),
        ...("outlierStreak" in patch ? { emaOutlierStreak: patch.outlierStreak } : {}),
        ...("outlierDirection" in patch ? { emaOutlierDirection: patch.outlierDirection } : {}),
        ...(patch.trackingType ? { trackingType: patch.trackingType } : {}),
        ...(patch.switchThreshold !== undefined ? { switchThreshold: patch.switchThreshold } : {}),
      })
      .where(eq(item.id, id));
  }
  for (const r of fx.renames) {
    await q.update(item).set({ canonicalName: r.to, updatedAt: now }).where(eq(item.id, r.itemId));
    await q
      .update(product)
      .set({ title: r.title, updatedAt: now })
      .where(eq(product.id, r.productId));
  }
  for (const { id, ...patch } of fx.productPatches) {
    await q
      .update(product)
      .set({ ...patch, updatedAt: now })
      .where(eq(product.id, id));
  }
  if (fx.preferenceEvents.length > 0) {
    await q
      .insert(preferenceEvent)
      .values(fx.preferenceEvents.map((e) => ({ ...stamp, id: newId(), ...e })));
  }

  const reviewIds: string[] = [];
  for (const r of fx.reviews) {
    const id = newId();
    reviewIds.push(id);
    const payload =
      r.kind === "receipt"
        ? {
            vendor: input.vendor,
            pending_line_ids: (r.payload.pendingLines as number[]).map((i) => lineIds[i]!),
            provisional_line_ids: (r.payload.provisionalLines as number[]).map((i) => lineIds[i]!),
          }
        : r.payload;
    await q.insert(reviewItem).values({
      ...stamp,
      id,
      kind: r.kind,
      jobId: input.jobId ?? null,
      receiptId,
      itemId: r.itemId,
      payload,
      urgency: r.urgency,
      impactScore: r.impactScore,
      status: r.status,
      defaultAction: r.defaultAction,
      expiresAt: r.expiresAt,
    });
  }

  if (fx.cycle) {
    await q
      .update(groceryCycle)
      .set({ ...fx.cycle.patch, updatedAt: now })
      .where(eq(groceryCycle.id, fx.cycle.cycleId));
    // §4.7: a mid-week order must not cost the household that week's cycle.
    await openNextCycleIn(q, ctx);
  }

  // §4.8 / M10.3: a Costco warehouse receipt closes (or completes) its trip.
  const costcoTripId =
    input.vendor === ctx.config.costco.vendor && input.fulfillment === "in_store"
      ? await linkCostcoReceiptIn(
          q,
          {
            receiptId,
            acquiredAt: input.acquiredAt,
            lines: fx.lines.length,
            bought: new Set(
              fx.lines.filter((l) => l.itemId && !l.ignored && !l.pending).map((l) => l.itemId),
            ).size,
          },
          ctx,
        )
      : null;

  await refreshInventoryState(
    q,
    fx.inventoryEvents.map((e) => e.itemId),
    now,
    ctx.config,
  );
  await emitTelemetry(q, "state_engine", fx.telemetry, now, { receiptId, vendor: input.vendor });

  return {
    receipt_id: receiptId,
    duplicate: false,
    status: fx.receipt.status,
    totals_check: fx.receipt.totalsCheck,
    lines: fx.lines.map((l, i) => ({
      id: lineIds[i]!,
      raw_text: l.rawText,
      item_id: l.itemId,
      product_id: l.productId,
      match_method: l.matchMethod,
      match_score: l.matchScore,
      trust: l.trust,
      pending: l.pending,
      ignored: l.ignored,
    })),
    new_item_ids: fx.newItems.map((i) => i.id),
    review_ids: reviewIds,
    closed_cycle_id: fx.cycle?.cycleId ?? null,
    costco_trip_id: costcoTripId,
  };
}
