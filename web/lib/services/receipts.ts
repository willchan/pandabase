// Receipt ingest (DESIGN §4.5): dedupe → `applyReceipt` → persist its effects in one transaction
// → telemetry. Used by `POST /api/receipts/ingest`, text purchases, and paper-receipt jobs.
import {
  groceryCycle,
  inventoryEvent,
  item,
  product,
  receipt,
  receiptHold,
  receiptLine,
  reviewItem,
  type Db,
} from "@pandabase/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { monotonicFactory } from "ulid";
import type { ReceiptIngestResponseT } from "../contracts/receipts";
import { normalizeSku } from "../domain/matching";
import {
  applyReceipt,
  eventSource,
  lineBaseUnits,
  receiptDedupeKey,
  reconcileReceiptEvents,
  totalsCheck,
  type ReceiptEffects,
  type ReceiptInput,
} from "../domain/receipts";
import { badRequest } from "../http";
import type { Q } from "../repo/db";
import { toCandidate } from "../repo/catalog";
import { refreshInventoryState } from "../repo/inventory";
import { receiptRepository } from "../repo/receipts";
import { emitTelemetry } from "../telemetry";
import { linkCostcoReceiptIn } from "./costco";
import { rebuildItemsIn } from "./learning";
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
 * totals check fails is applied as read like any other (§10 #90): a later read of the order that
 * differs replaces it (`replaceReceiptIn`); the same content again is a duplicate.
 *
 * Legacy holds (§4.5 *Held receipts*, retired): an order still held from before #90 resolves its
 * `receipt_hold` row when it applies — re-read by a sweep, or released by the daily cron
 * (`release`, `releaseHolds`). Nothing creates a hold any more; the table goes in a contract PR.
 */
export async function ingestReceiptIn(
  q: Q,
  input: IngestInput,
  ctx: ServiceCtx,
  opts: { release?: boolean } = {},
): Promise<ReceiptIngestResponseT> {
  const key = dedupeKey(input, ctx);
  const [stored] = await q.select().from(receipt).where(eq(receipt.dedupeKey, key));
  if (stored) {
    // §4.5 / PLAN M11.2: a digital order read again with different content replaces the stored
    // one; anything else is a duplicate.
    const replaced =
      stored.source === "digital" ? await replaceReceiptIn(q, stored, input, ctx) : null;
    return replaced ?? (await existingReceipt(q, key))!;
  }
  const fx = await applyReceipt(input, receiptRepository(q), {
    config: ctx.config,
    newId: () => newId(),
    now: ctx.now,
  });
  const out = await persistReceiptEffects(q, input, fx, ctx);
  const [hold] = await q
    .select()
    .from(receiptHold)
    .where(and(eq(receiptHold.dedupeKey, key), eq(receiptHold.status, "held")));
  if (hold) await resolveHoldIn(q, hold, out.receipt_id, fx.receipt.totalsCheck, ctx, opts);
  return out;
}

/** A legacy hold's order applied: mark it resolved with the receipt it became (§4.5, retired). */
async function resolveHoldIn(
  q: Q,
  hold: typeof receiptHold.$inferSelect,
  receiptId: string,
  totalsCheck: string,
  ctx: ServiceCtx,
  opts: { release?: boolean },
): Promise<void> {
  const attempts = hold.attempts + (opts.release ? 0 : 1);
  await q
    .update(receiptHold)
    .set({
      // `expired`: applied as the hold stored it, not from a new read (the table's CHECK predates
      // the release).
      status: opts.release ? "expired" : "applied",
      attempts,
      resolvedAt: ctx.now,
      receiptId,
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
        receiptId,
        vendor: hold.vendor,
        outcome: opts.release
          ? "released"
          : totalsCheck === "pass"
            ? "totals_pass"
            : totalsCheck === "fail"
              ? "totals_fail"
              : "unchecked",
        attempts,
        heldDays: Math.round((Date.parse(ctx.now) - Date.parse(hold.createdAt)) / 864e5),
      },
    ],
    ctx.now,
  );
}

/**
 * §10 #90: holds left from before ingest stopped holding are applied as read by the daily cron,
 * whatever their `expires_at`, each in its own transaction, oldest receipt first. A later read of
 * the order replaces it like any applied receipt. Removed with `receipt_hold` (contract PR).
 */
export async function releaseHolds(db: Db, ctx: ServiceCtx): Promise<number> {
  const due = await db
    .select({ id: receiptHold.id, input: receiptHold.input })
    .from(receiptHold)
    .where(eq(receiptHold.status, "held"))
    .orderBy(asc(receiptHold.acquiredAt), asc(receiptHold.id));
  for (const h of due) {
    await db.transaction((tx) =>
      ingestReceiptIn(tx, h.input as IngestInput, ctx, { release: true }),
    );
  }
  return due.length;
}

type ReceiptRow = typeof receipt.$inferSelect;
type LineRow = typeof receiptLine.$inferSelect;
type LineContent = Pick<
  LineRow,
  "rawText" | "asin" | "vendorSku" | "qty" | "unitPriceCents" | "lineTotalCents"
>;

/** What a re-read can change on a line: its text, ids, quantity and prices (not its answers). */
const lineKey = (l: LineContent): string =>
  JSON.stringify([
    l.rawText,
    l.asin ?? null,
    l.vendorSku ?? null,
    l.qty,
    l.unitPriceCents ?? null,
    l.lineTotalCents ?? null,
  ]);

/** An input line as ingest would store it (item numbers normalized on Costco lines, §4.8). */
const inputLineContent = (l: IngestInput["lines"][number]): LineContent => ({
  rawText: l.rawText,
  asin: l.asin ?? null,
  vendorSku: l.vendorSku && !l.asin ? normalizeSku(l.vendorSku) : (l.vendorSku ?? null),
  qty: l.qty,
  unitPriceCents: l.unitPriceCents ?? null,
  lineTotalCents: l.lineTotalCents ?? null,
});

const headerKey = (r: {
  fulfillment: string;
  orderedAt: string | null;
  acquiredAt: string;
  subtotalCents: number | null;
  totalCents: number | null;
}): string =>
  JSON.stringify([r.fulfillment, r.orderedAt, r.acquiredAt, r.subtotalCents, r.totalCents]);

const isPending = (l: Pick<LineRow, "itemId" | "ignored">) => l.itemId === null && !l.ignored;
const isProvisional = (l: Pick<LineRow, "itemId" | "ignored" | "trust" | "matchMethod">) =>
  l.itemId !== null && !l.ignored && l.trust === "unverified" && l.matchMethod === "fuzzy";

/**
 * PLAN M11.2 / DESIGN §4.5 *Re-read orders*: a digital order ingested again whose content (header
 * or lines) differs from the stored receipt replaces it in place — same receipt id and ingest
 * time. A line whose content is unchanged keeps its row, so its match and any review answer stay;
 * changed and new lines are resolved afresh (new items and products stamped with the receipt's
 * `created_at`, the import-reset convention); lines no longer on the order are deleted. The
 * receipt's `acquired` events are re-derived from its final lines (an unchanged event keeps its
 * row, the rest are deleted and re-inserted), its open receipt review is re-pointed, and every
 * item it touched, before or after, is rebuilt (§4.10). It doesn't close a cycle or link a Costco
 * trip again: that happened when the order was first read. Returns null — answer as a duplicate —
 * when nothing changed, or when the stored read added up and this one doesn't (a worse read).
 */
async function replaceReceiptIn(
  q: Q,
  r: ReceiptRow,
  input: IngestInput,
  ctx: ServiceCtx,
): Promise<ReceiptIngestResponseT | null> {
  const { now } = ctx;
  const oldLines = await q
    .select()
    .from(receiptLine)
    .where(eq(receiptLine.receiptId, r.id))
    .orderBy(asc(receiptLine.id));
  const newTotals = totalsCheck(input);
  const same =
    headerKey(r) ===
      headerKey({
        fulfillment: input.fulfillment,
        orderedAt: input.orderedAt,
        acquiredAt: input.acquiredAt,
        subtotalCents: input.subtotalCents,
        totalCents: input.totalCents ?? null,
      }) &&
    oldLines.length === input.lines.length &&
    oldLines.every((l, i) => lineKey(l) === lineKey(inputLineContent(input.lines[i]!)));
  if (same) return null;
  if (r.totalsCheck === "pass" && newTotals === "fail") {
    await emitTelemetry(
      q,
      "state_engine",
      [{ metric: "receipt_replaced", outcome: "kept_passing", receiptId: r.id, vendor: r.vendor }],
      now,
    );
    return null;
  }

  const fx = await applyReceipt(input, receiptRepository(q), {
    config: ctx.config,
    newId: () => newId(),
    now,
  });
  // Unchanged lines keep their rows (first match by content, in order).
  const pool = new Map<string, LineRow[]>();
  for (const l of oldLines) {
    const k = lineKey(l);
    pool.set(k, [...(pool.get(k) ?? []), l]);
  }
  const finals: { kept: LineRow | null; fresh: (typeof fx.lines)[number] | null; id: string }[] =
    fx.lines.map((l) => {
      const kept = pool.get(lineKey(inputLineContent(l)))?.shift() ?? null;
      return { kept, fresh: kept ? null : l, id: kept?.id ?? newId() };
    });
  const removed = [...pool.values()].flat();
  const fresh = finals.filter((f) => f.fresh);

  // Only the new items and products a fresh line uses (a kept line keeps what it had).
  const usedItems = new Set(fresh.map((f) => f.fresh!.itemId));
  const usedProducts = new Set(fresh.map((f) => f.fresh!.productId));
  const newItems = fx.newItems.filter((i) => usedItems.has(i.id));
  const newProducts = fx.newProducts.filter((p) => usedProducts.has(p.id));
  const born = { createdAt: r.createdAt, updatedAt: now };
  if (newItems.length > 0) {
    await q.insert(item).values(
      newItems.map((i): ItemInsert => ({
        ...born,
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
  if (newProducts.length > 0) {
    await q.insert(product).values(newProducts.map((p) => ({ ...born, ...p })));
  }
  if (removed.length > 0) {
    await q.delete(receiptLine).where(
      inArray(
        receiptLine.id,
        removed.map((l) => l.id),
      ),
    );
  }
  if (fresh.length > 0) {
    await q.insert(receiptLine).values(
      fresh.map(({ fresh: l, id }) => ({
        createdAt: now,
        updatedAt: now,
        id,
        receiptId: r.id,
        rawText: l!.rawText,
        asin: l!.asin,
        vendorSku: l!.vendorSku ?? null,
        productId: l!.productId,
        itemId: l!.itemId,
        qty: l!.qty,
        unitPriceCents: l!.unitPriceCents,
        lineTotalCents: l!.lineTotalCents,
        matchMethod: l!.matchMethod,
        matchScore: l!.matchScore,
        trust: l!.trust,
        ignored: l!.ignored,
      })),
    );
  }
  for (const rn of fx.renames) {
    if (!usedItems.has(rn.itemId)) continue;
    await q
      .update(item)
      .set({ canonicalName: rn.to, updatedAt: now })
      .where(eq(item.id, rn.itemId));
    await q
      .update(product)
      .set({ title: rn.title, updatedAt: now })
      .where(eq(product.id, rn.productId));
  }

  // The final lines, as stored now.
  const final = finals.map(({ kept, fresh: l, id }) =>
    kept
      ? kept
      : ({
          id,
          rawText: l!.rawText,
          itemId: l!.itemId,
          productId: l!.productId,
          qty: l!.qty,
          trust: l!.trust,
          ignored: l!.ignored,
          matchMethod: l!.matchMethod,
          matchScore: l!.matchScore,
        } as Pick<
          LineRow,
          | "id"
          | "rawText"
          | "itemId"
          | "productId"
          | "qty"
          | "trust"
          | "ignored"
          | "matchMethod"
          | "matchScore"
        >),
  );
  const applied = final.filter((l) => l.itemId !== null && !l.ignored);
  const status: ReceiptRow["status"] = final.some(isPending)
    ? applied.length > 0
      ? "partial"
      : "pending_review"
    : "applied";
  await q
    .update(receipt)
    .set({
      fulfillment: input.fulfillment,
      orderedAt: input.orderedAt,
      acquiredAt: input.acquiredAt,
      subtotalCents: input.subtotalCents,
      totalCents: input.totalCents,
      totalsCheck: newTotals,
      status,
      updatedAt: now,
    })
    .where(eq(receipt.id, r.id));

  // `acquired` events from the final lines (base units as `applyReceipt` counts them).
  const finalItems = [...new Set(applied.map((l) => l.itemId!))];
  const [itemRows, productRows, events] = await Promise.all([
    finalItems.length
      ? q
          .select({ id: item.id, defaultLocation: item.defaultLocation })
          .from(item)
          .where(inArray(item.id, finalItems))
      : Promise.resolve([]),
    finalItems.length
      ? q.select().from(product).where(inArray(product.itemId, finalItems))
      : Promise.resolve([]),
    q
      .select()
      .from(inventoryEvent)
      .where(
        and(
          eq(inventoryEvent.sourceRef, r.id),
          eq(inventoryEvent.kind, "acquired"),
          ne(inventoryEvent.trust, "expired"),
        ),
      ),
  ]);
  const location = new Map(itemRows.map((i) => [i.id, i.defaultLocation]));
  const productsOf = (itemId: string) =>
    productRows.filter((p) => p.itemId === itemId).map(toCandidate);
  const moved = r.acquiredAt !== input.acquiredAt;
  const plan = reconcileReceiptEvents(
    final.map((l) => ({
      itemId: l.itemId,
      qty: l.qty,
      trust: l.trust,
      ignored: l.ignored,
      baseQty: l.itemId ? lineBaseUnits(l, productsOf(l.itemId), r.vendor) : 0,
    })),
    moved
      ? []
      : events.map((e) => ({
          id: e.id,
          itemId: e.itemId,
          quantity: e.quantity ?? 0,
          trust: e.trust === "confirmed" ? "confirmed" : "provisional",
        })),
  );
  const drop = moved ? events.map((e) => e.id) : plan.expire;
  if (drop.length > 0) await q.delete(inventoryEvent).where(inArray(inventoryEvent.id, drop));
  for (const t of plan.trust) {
    await q
      .update(inventoryEvent)
      .set({ trust: t.trust, updatedAt: now })
      .where(eq(inventoryEvent.id, t.eventId));
  }
  if (plan.insert.length > 0) {
    await q.insert(inventoryEvent).values(
      plan.insert.map((e): EventInsert => ({
        createdAt: now,
        updatedAt: now,
        id: newId(),
        itemId: e.itemId,
        location: (location.get(e.itemId) ?? "pantry") as EventInsert["location"],
        kind: "acquired",
        quantity: e.quantity,
        occurredAt: input.acquiredAt,
        source: eventSource(input.source),
        sourceRef: r.id,
        actorMemberId: ctx.actor.memberId,
        actorSystem: ctx.actor.system,
        trust: e.trust,
      })),
    );
  }

  // Reviews: the open receipt review lists the final open lines; new items get theirs.
  const open = await q
    .select()
    .from(reviewItem)
    .where(and(eq(reviewItem.receiptId, r.id), eq(reviewItem.status, "pending")));
  const payload = {
    vendor: input.vendor,
    pending_line_ids: final.filter(isPending).map((l) => l.id),
    provisional_line_ids: final.filter(isProvisional).map((l) => l.id),
  };
  const hasOpenLines = payload.pending_line_ids.length + payload.provisional_line_ids.length > 0;
  const openReceiptReview = open.find((x) => x.kind === "receipt");
  const reviewIds: string[] = [];
  if (openReceiptReview) {
    if (hasOpenLines) {
      reviewIds.push(openReceiptReview.id);
      await q
        .update(reviewItem)
        .set({ payload, updatedAt: now })
        .where(eq(reviewItem.id, openReceiptReview.id));
    } else {
      await q.delete(reviewItem).where(eq(reviewItem.id, openReceiptReview.id));
    }
  }
  for (const rv of fx.reviews) {
    const isReceiptReview = rv.kind === "receipt";
    if (isReceiptReview ? openReceiptReview || !hasOpenLines : !usedItems.has(rv.itemId!)) continue;
    const id = newId();
    reviewIds.push(id);
    await q.insert(reviewItem).values({
      createdAt: now,
      updatedAt: now,
      id,
      kind: rv.kind,
      jobId: r.jobId,
      receiptId: r.id,
      itemId: rv.itemId,
      payload: isReceiptReview ? payload : rv.payload,
      urgency: rv.urgency,
      impactScore: rv.impactScore,
      status: rv.status,
      defaultAction: rv.defaultAction,
      expiresAt: rv.expiresAt,
    });
  }

  // Every item the order touched, before or after, is rebuilt from its receipts (§4.10).
  const touched = new Set<string>(finalItems);
  for (const l of oldLines) if (l.itemId) touched.add(l.itemId);
  for (const e of events) touched.add(e.itemId);
  const rebuilt = await rebuildItemsIn(q, touched, ctx, { scope: "replace", receiptId: r.id });
  await refreshInventoryState(q, [...touched], now, ctx.config);
  await emitTelemetry(
    q,
    "state_engine",
    [
      {
        metric: "receipt_replaced",
        outcome: "replaced",
        receiptId: r.id,
        vendor: r.vendor,
        linesKept: finals.length - fresh.length,
        linesNew: fresh.length,
        linesRemoved: removed.length,
        newItems: newItems.length,
        totalsBefore: r.totalsCheck,
        totalsAfter: newTotals,
        itemsRebuilt: touched.size,
        itemsChanged: rebuilt.plan.changes.length,
      },
    ],
    now,
  );

  return {
    receipt_id: r.id,
    duplicate: false,
    replaced: true,
    status,
    totals_check: newTotals,
    lines: final.map((l) => ({
      id: l.id,
      raw_text: l.rawText,
      item_id: l.itemId,
      product_id: l.productId,
      match_method: l.matchMethod,
      match_score: l.matchScore,
      trust: l.trust,
      pending: isPending(l),
      ignored: l.ignored,
    })),
    new_item_ids: newItems.map((i) => i.id),
    review_ids: reviewIds,
    closed_cycle_id: null,
    costco_trip_id: null,
  };
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
 * lines, `acquired` events (`source_ref` = receipt id), reviews, the cycle patch, the touched
 * items' learning — rebuilt from their receipts, not patched (§4.10) — the `inventory_state`
 * projection, and the domain telemetry.
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

  for (const r of fx.renames) {
    await q.update(item).set({ canonicalName: r.to, updatedAt: now }).where(eq(item.id, r.itemId));
    await q
      .update(product)
      .set({ title: r.title, updatedAt: now })
      .where(eq(product.id, r.productId));
  }
  // Product stats, stances, the EMA, tracking promotion and the switch threshold aren't patched
  // from `fx`: the touched items are rebuilt from their receipts below (§4.10, PLAN M11.2).

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

  const touched = fx.inventoryEvents.map((e) => e.itemId);
  await rebuildItemsIn(q, touched, ctx, { scope: "ingest", patched: fx, receiptId });
  await refreshInventoryState(q, touched, now, ctx.config);
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
