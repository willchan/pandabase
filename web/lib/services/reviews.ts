// Review resolution (DESIGN §4.5, §4.6) behind the Cleanup page's server actions: answering a
// receipt review, confirming merges and auto-created items, Trash Cam answers and dismissals.
// Only these human answers write `labeled_observation`s.
import {
  auditJob,
  groceryCycleOverride,
  inventoryEvent,
  item,
  labeledObservation,
  product,
  receipt,
  receiptLine,
  reviewItem,
  vendorAlias,
  type Db,
} from "@pandabase/db";
import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { projectRows } from "@pandabase/db/rebuild-state";
import { normalizeReceiptText } from "../domain/matching";
import { planMerge } from "../domain/merge";
import {
  eventSource,
  lineBaseUnits,
  reconcileReceiptEvents,
  resolveReceiptReview,
  type LineDecision,
} from "../domain/receipts";
import { isOneTimeBuy, mayCreateLabel, type ReviewKind } from "../domain/review";
import { daysBetween } from "../domain/time";
import { badRequest, conflict, notFound } from "../http";
import { getItem, toCandidate } from "../repo/catalog";
import { asRecord, batchThen, batchTransaction, type Q, type Stmt } from "../repo/db";
import {
  inventoryStateReads,
  inventoryStateWrites,
  refreshInventoryState,
} from "../repo/inventory";
import { emitTelemetry, telemetryWrites } from "../telemetry";
import { newId } from "./receipts";
import type { ServiceCtx } from "./types";

type ReviewRow = typeof reviewItem.$inferSelect;
type LineRow = typeof receiptLine.$inferSelect;
type Outcome = "confirmed" | "corrected" | "dismissed";

async function pendingReview(q: Q, id: string, kinds: readonly ReviewKind[]): Promise<ReviewRow> {
  const [r] = await q.select().from(reviewItem).where(eq(reviewItem.id, id));
  if (!r) throw notFound(`review ${id}`);
  if (!kinds.includes(r.kind)) throw badRequest(`review ${id} is a ${r.kind} review`);
  if (r.status !== "pending") throw conflict(`review ${id} is already ${r.status}`);
  return r;
}

/** Close a review as answered by the acting member and log `review_resolved`. */
async function closeReview(
  q: Q,
  r: ReviewRow,
  status: Outcome,
  ctx: ServiceCtx,
  extra: Record<string, unknown> = {},
): Promise<void> {
  for (const w of closeReviewWrites(q, r, status, ctx, extra)) await w;
}

/** `closeReview`'s statements, unsent, for services that batch. */
function closeReviewWrites(
  q: Q,
  r: ReviewRow,
  status: Outcome,
  ctx: ServiceCtx,
  extra: Record<string, unknown> = {},
) {
  return [
    q
      .update(reviewItem)
      .set({
        status,
        reviewedByMemberId: ctx.actor.memberId,
        reviewedAt: ctx.now,
        updatedAt: ctx.now,
      })
      .where(eq(reviewItem.id, r.id)),
    ...telemetryWrites(
      q,
      "state_engine",
      [
        {
          metric: "review_resolved",
          reviewId: r.id,
          kind: r.kind,
          outcome: status,
          impactScore: r.impactScore,
          ageHours: Math.round(daysBetween(r.createdAt, ctx.now) * 24 * 10) / 10,
          ...extra,
        },
      ],
      ctx.now,
    ),
  ];
}

// --- reads --------------------------------------------------------------------------------------

export interface ReviewSummary {
  id: string;
  kind: ReviewKind;
  urgency: "this_week" | "cleanup";
  impactScore: number;
  createdAt: string;
  expiresAt: string | null;
  itemId: string | null;
  itemName: string | null;
  receiptId: string | null;
  jobId: string | null;
  payload: Record<string, unknown>;
  receipt: { vendor: string; source: string; acquiredAt: string; lines: number } | null;
  /** Merge suggestions: the item to fold into. */
  mergeInto: { id: string; name: string } | null;
  job: { type: string; error: string | null; attempts: number } | null;
  /** A new product bought once, off this week's cart: Cleanup leaves it out (§4.6). */
  oneTimeBuy: boolean;
}

/**
 * Pending reviews for Cleanup / This Week, highest impact first (§4.6), then soonest expiry.
 * Receipt reviews count their open lines (pending + provisional) from `receipt_line`.
 */
export async function pendingReviews(q: Q): Promise<ReviewSummary[]> {
  // A constant number of queries however many reviews are pending (a real household had ~490).
  const pending = eq(reviewItem.status, "pending");
  const ofKind = (kind: ReviewKind, col: typeof reviewItem.receiptId | typeof reviewItem.jobId) =>
    q
      .select({ id: col })
      .from(reviewItem)
      .where(and(pending, eq(reviewItem.kind, kind)));
  const [rows, itemRows, receiptRows, lineRows, jobRows] = await Promise.all([
    q
      .select()
      .from(reviewItem)
      .where(pending)
      .orderBy(desc(reviewItem.impactScore), asc(reviewItem.createdAt), asc(reviewItem.id)),
    q.select({ id: item.id, name: item.canonicalName, trackingType: item.trackingType }).from(item),
    q
      .select()
      .from(receipt)
      .where(inArray(receipt.id, ofKind("receipt", reviewItem.receiptId))),
    q
      .select({
        receiptId: receiptLine.receiptId,
        itemId: receiptLine.itemId,
        trust: receiptLine.trust,
        ignored: receiptLine.ignored,
      })
      .from(receiptLine)
      .where(inArray(receiptLine.receiptId, ofKind("receipt", reviewItem.receiptId))),
    q
      .select()
      .from(auditJob)
      .where(inArray(auditJob.id, ofKind("failed_job", reviewItem.jobId))),
  ]);
  const names = new Map(itemRows.map((i) => [i.id, i.name]));
  const tracking = new Map(itemRows.map((i) => [i.id, i.trackingType]));
  const receipts = new Map(receiptRows.map((x) => [x.id, x]));
  const jobs = new Map(jobRows.map((j) => [j.id, j]));
  const openLines = new Map<string, number>();
  for (const l of lineRows)
    if (isOpenLine(l)) openLines.set(l.receiptId, (openLines.get(l.receiptId) ?? 0) + 1);
  const out: ReviewSummary[] = [];
  for (const r of rows) {
    const payload = asRecord(r.payload);
    const x = r.receiptId && r.kind === "receipt" ? receipts.get(r.receiptId) : undefined;
    const rec: ReviewSummary["receipt"] = x
      ? {
          vendor: x.vendor,
          source: x.source,
          acquiredAt: x.acquiredAt,
          lines: openLines.get(x.id) ?? 0,
        }
      : null;
    const j = r.jobId && r.kind === "failed_job" ? jobs.get(r.jobId) : undefined;
    const job: ReviewSummary["job"] = j
      ? { type: j.jobType, error: j.error, attempts: j.attempts }
      : null;
    const intoId =
      typeof payload.merge_into_item_id === "string" ? payload.merge_into_item_id : null;
    out.push({
      id: r.id,
      kind: r.kind,
      urgency: r.urgency,
      impactScore: r.impactScore,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      itemId: r.itemId,
      itemName: r.itemId ? (names.get(r.itemId) ?? null) : null,
      receiptId: r.receiptId,
      jobId: r.jobId,
      payload,
      receipt: rec,
      mergeInto: intoId ? { id: intoId, name: names.get(intoId) ?? intoId } : null,
      job,
      oneTimeBuy: isOneTimeBuy(r, r.itemId ? (tracking.get(r.itemId) ?? null) : null),
    });
  }
  return out.sort(
    (a, b) =>
      b.impactScore - a.impactScore ||
      (a.expiresAt ?? "9999").localeCompare(b.expiresAt ?? "9999") ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

/** Pending reviews Cleanup lists (the nav badge): all but one-time buys (`isOneTimeBuy`, §4.6). */
export async function cleanupCount(q: Q): Promise<number> {
  const [row] = await q
    .select({ n: sql<number>`count(*)` })
    .from(reviewItem)
    .leftJoin(item, eq(item.id, reviewItem.itemId))
    .where(
      and(
        eq(reviewItem.status, "pending"),
        sql`not (${reviewItem.kind} = 'new_product' and ${reviewItem.urgency} = 'cleanup' and coalesce(${item.trackingType}, '') = 'static')`,
      ),
    );
  return Number(row?.n ?? 0);
}

const receiptLines = (q: Q, receiptId: string) =>
  q
    .select()
    .from(receiptLine)
    .where(eq(receiptLine.receiptId, receiptId))
    .orderBy(asc(receiptLine.id));

/** A line the receipt review asks about: unmatched (pending) or matched provisionally. */
const isOpenLine = (l: Pick<LineRow, "ignored" | "itemId" | "trust">) =>
  !l.ignored && (l.itemId === null || l.trust !== "confirmed");

export type LineState = "pending" | "provisional" | "confirmed" | "ignored";
export const lineState = (l: LineRow): LineState =>
  l.ignored
    ? "ignored"
    : l.itemId === null
      ? "pending"
      : l.trust === "confirmed"
        ? "confirmed"
        : "provisional";

export interface ReceiptReviewDetail {
  review: ReviewRow;
  receipt: typeof receipt.$inferSelect;
  /** R2 key of the receipt photo (paper receipts). */
  mediaKey: string | null;
  lines: (LineRow & { state: LineState; itemName: string | null })[];
}

export async function receiptReviewDetail(q: Q, reviewId: string): Promise<ReceiptReviewDetail> {
  const [r] = await q.select().from(reviewItem).where(eq(reviewItem.id, reviewId));
  if (!r || r.kind !== "receipt" || !r.receiptId) throw notFound(`receipt review ${reviewId}`);
  const [rec] = await q.select().from(receipt).where(eq(receipt.id, r.receiptId));
  if (!rec) throw notFound(`receipt ${r.receiptId}`);
  const [job] = rec.jobId ? await q.select().from(auditJob).where(eq(auditJob.id, rec.jobId)) : [];
  const names = new Map(
    (await q.select({ id: item.id, name: item.canonicalName }).from(item)).map((i) => [
      i.id,
      i.name,
    ]),
  );
  return {
    review: r,
    receipt: rec,
    mediaKey: job?.mediaR2Key ?? null,
    lines: (await receiptLines(q, rec.id)).map((l) => ({
      ...l,
      state: lineState(l),
      itemName: l.itemId ? (names.get(l.itemId) ?? null) : null,
    })),
  };
}

// --- receipt review -----------------------------------------------------------------------------

/** One answer per open line: keep the match, pick an item, or ignore the line. */
export type LineAnswer =
  | { lineId: string; answer: "keep" }
  | { lineId: string; answer: "ignore" }
  | { lineId: string; answer: "item"; itemId: string };

/**
 * Answer a receipt review in one go (§4.5): kept matches become confirmed, corrected lines reverse
 * their provisional event and apply the chosen item, ignored lines become ignored aliases; every
 * answer strengthens the store's alias (paper) and becomes a `labeled_observation`. Open lines
 * left unanswered stay as they are (pending lines then never apply, like an expiry).
 */
export async function answerReceiptReview(
  db: Db,
  reviewId: string,
  answers: readonly LineAnswer[],
  ctx: ServiceCtx,
): Promise<{ status: "confirmed" | "corrected"; receiptStatus: string }> {
  // A constant number of round trips however long the receipt (DESIGN §8 *Database round
  // trips*): read the review, then everything else in one batch; decide in memory; send every
  // write plus the reads the inventory projection needs in one batch, then the projection.
  return batchTransaction(db, async (tx) => {
    const r = await pendingReview(tx, reviewId, ["receipt"]);
    const receiptId = r.receiptId;
    if (!receiptId) throw badRequest(`review ${reviewId} has no receipt`);
    // Every item this answer can touch: the lines' current items and the answered ones.
    const lineItemIds = tx
      .select({ id: receiptLine.itemId })
      .from(receiptLine)
      .where(eq(receiptLine.receiptId, receiptId));
    const answeredIds = [
      ...new Set(answers.flatMap((a) => (a.answer === "item" ? [a.itemId] : []))),
    ];
    const itemScope = or(inArray(item.id, answeredIds), inArray(item.id, lineItemIds));
    const ofReceipt = tx
      .select({ v: receipt.vendor })
      .from(receipt)
      .where(eq(receipt.id, receiptId));
    const [[rec], lines, aliases, items, productRows, events, jobs] = await tx.batch([
      tx.select().from(receipt).where(eq(receipt.id, receiptId)),
      receiptLines(tx, receiptId),
      tx.select().from(vendorAlias).where(eq(vendorAlias.vendor, ofReceipt)),
      tx.select().from(item).where(itemScope),
      tx
        .select()
        .from(product)
        .where(or(inArray(product.itemId, answeredIds), inArray(product.itemId, lineItemIds)))
        .orderBy(asc(product.id)),
      tx
        .select()
        .from(inventoryEvent)
        .where(
          and(
            eq(inventoryEvent.sourceRef, receiptId),
            eq(inventoryEvent.kind, "acquired"),
            ne(inventoryEvent.trust, "expired"),
          ),
        )
        .orderBy(asc(inventoryEvent.id)),
      tx
        .select()
        .from(auditJob)
        .where(
          eq(
            auditJob.id,
            tx.select({ j: receipt.jobId }).from(receipt).where(eq(receipt.id, receiptId)),
          ),
        ),
    ]);
    if (!rec) throw notFound(`receipt ${receiptId}`);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const itemOf = (id: string) => {
      const it = itemById.get(id);
      if (!it) throw notFound(`item ${id}`);
      return it;
    };
    const open = new Map(lines.filter(isOpenLine).map((l) => [l.id, l]));

    const decided: { line: LineRow; decision: LineDecision }[] = [];
    for (const a of answers) {
      const line = open.get(a.lineId);
      if (!line) throw badRequest(`line ${a.lineId} is not open on this receipt`);
      if (a.answer === "item") itemOf(a.itemId);
      const decision: LineDecision =
        a.answer === "ignore"
          ? { kind: "ignore" }
          : a.answer === "keep" || a.itemId === line.itemId
            ? { kind: "confirm" }
            : { kind: "correct", itemId: a.itemId, productId: null };
      if (decision.kind === "confirm" && line.itemId === null) continue; // nothing to keep
      decided.push({ line, decision });
    }

    const res = resolveReceiptReview({
      vendor: rec.vendor,
      existingAliases: aliases.filter((a) => a.vendor === rec.vendor),
      lines: decided.map(({ line, decision }) => ({
        lineId: line.id,
        normalized: rec.source === "paper" ? normalizeReceiptText(line.rawText) : null,
        itemId: line.itemId,
        productId: line.productId,
        matchScore: line.matchScore,
        eventId: null, // events are reconciled from the final lines below
        decision,
      })),
    });

    const writes: Stmt[] = [];
    // The receipt's lines as they will be once the updates below are written.
    const final = lines.map((l) => ({ ...l }));
    const finalById = new Map(final.map((l) => [l.id, l]));
    for (const u of res.lineUpdates) {
      const set = {
        itemId: u.itemId,
        productId: u.productId,
        trust: u.trust,
        ignored: u.ignored,
        ...(u.matchMethod ? { matchMethod: u.matchMethod } : {}),
        updatedAt: ctx.now,
      };
      writes.push(tx.update(receiptLine).set(set).where(eq(receiptLine.id, u.lineId)));
      const l = finalById.get(u.lineId);
      if (l) Object.assign(l, set);
    }
    for (const a of res.aliases) {
      const { trust, ...alias } = a;
      writes.push(
        tx
          .insert(vendorAlias)
          .values({ id: newId(), createdAt: ctx.now, updatedAt: ctx.now, ...alias, trust })
          .onConflictDoUpdate({
            target: [vendorAlias.vendor, vendorAlias.kind, vendorAlias.vendorString],
            set: {
              itemId: alias.itemId,
              productId: alias.productId,
              confidenceScore: alias.confidenceScore,
              ignored: alias.ignored,
              trust,
              updatedAt: ctx.now,
            },
          }),
      );
    }

    // Make the receipt's `acquired` events match its final lines.
    const products = new Map<string, (typeof productRows)[number][]>();
    for (const p of productRows) {
      let list = products.get(p.itemId);
      if (!list) products.set(p.itemId, (list = []));
      list.push(p);
    }
    const plan = reconcileReceiptEvents(
      final.map((l) => ({
        itemId: l.itemId,
        qty: l.qty,
        trust: l.trust,
        ignored: l.ignored,
        baseQty: l.itemId
          ? lineBaseUnits(l, (products.get(l.itemId) ?? []).map(toCandidate), rec.vendor)
          : 0,
      })),
      events.map((e) => ({
        id: e.id,
        itemId: e.itemId,
        quantity: e.quantity ?? 0,
        trust: e.trust === "confirmed" ? "confirmed" : "provisional",
      })),
    );
    for (const trust of ["confirmed", "provisional"] as const) {
      const ids = plan.trust.filter((t) => t.trust === trust).map((t) => t.eventId);
      if (ids.length > 0) {
        writes.push(
          tx
            .update(inventoryEvent)
            .set({ trust, updatedAt: ctx.now })
            .where(inArray(inventoryEvent.id, ids)),
        );
      }
    }
    if (plan.expire.length > 0) {
      writes.push(
        tx
          .update(inventoryEvent)
          .set({ trust: "expired", updatedAt: ctx.now })
          .where(inArray(inventoryEvent.id, plan.expire)),
      );
    }
    if (plan.insert.length > 0) {
      writes.push(
        tx.insert(inventoryEvent).values(
          plan.insert.map((e) => ({
            id: newId(),
            createdAt: ctx.now,
            updatedAt: ctx.now,
            itemId: e.itemId,
            location: itemOf(e.itemId).defaultLocation,
            kind: "acquired" as const,
            quantity: e.quantity,
            occurredAt: rec.acquiredAt,
            source: eventSource(rec.source),
            sourceRef: rec.id,
            actorMemberId: ctx.actor.memberId,
            actorSystem: ctx.actor.system,
            trust: e.trust,
          })),
        ),
      );
    }

    const corrected = decided.some((d) => d.decision.kind !== "confirm");
    const status = corrected ? "corrected" : "confirmed";
    if (mayCreateLabel(status, ctx.actor.memberId) && res.labels.length > 0) {
      const job = rec.jobId ? jobs[0] : undefined;
      writes.push(
        tx.insert(labeledObservation).values(
          res.labels.map((l) => ({
            id: newId(),
            createdAt: ctx.now,
            updatedAt: ctx.now,
            sourceKind: "receipt_line" as const,
            jobId: rec.jobId,
            modelOutput: {
              ...l.modelOutput,
              line_id: l.lineId,
              raw_text: lines.find((x) => x.id === l.lineId)?.rawText ?? null,
            },
            humanLabel: l.humanLabel,
            model: job?.model ?? null,
            promptVersion: job?.promptVersion ?? null,
            memberId: ctx.actor.memberId!,
          })),
        ),
      );
    }

    const stillPending = final.some((l) => l.itemId === null && !l.ignored);
    const applied = final.some((l) => l.itemId !== null && !l.ignored);
    const receiptStatus = !stillPending ? "applied" : applied ? "partial" : "pending_review";
    writes.push(
      tx
        .update(receipt)
        .set({ status: receiptStatus, updatedAt: ctx.now })
        .where(eq(receipt.id, rec.id)),
    );
    const count = (k: LineDecision["kind"]) => decided.filter((d) => d.decision.kind === k).length;
    writes.push(
      ...closeReviewWrites(tx, r, status, ctx, {
        vendor: rec.vendor,
        confirmedLines: count("confirm"),
        correctedLines: count("correct"),
        ignoredLines: count("ignore"),
      }),
    );

    // Re-project `inventory_state` for the touched items from the events as written.
    const touched = [
      ...new Set([...events.map((e) => e.itemId), ...plan.insert.map((e) => e.itemId)]),
    ];
    if (touched.length === 0) {
      await batchThen(tx, writes, []);
    } else {
      const [stateItems, stateEvents, away] = await batchThen(
        tx,
        writes,
        inventoryStateReads(tx, touched),
      );
      const rows = projectRows(stateItems, stateEvents, away, ctx.now, ctx.config);
      await batchThen(tx, inventoryStateWrites(tx, touched, rows), []);
    }
    return { status, receiptStatus };
  });
}

// --- items: merges and auto-created items -------------------------------------------------------

/**
 * Fold `itemId` into `intoItemId` (a merge suggestion, or a new product that is really an existing
 * item): products move over as acceptable, and the item's events, aliases, receipt lines and
 * current-cycle overrides follow. `unitQuantity` (target base units per pack) corrects the pack
 * size of a single-product item and rescales its history. The item's other open reviews close.
 */
export async function mergeItems(
  db: Db,
  input: {
    reviewId: string | null;
    itemId: string;
    intoItemId: string;
    unitQuantity: number | null;
  },
  ctx: ServiceCtx,
): Promise<{ itemId: string; intoItemId: string }> {
  return db.transaction(async (tx) => {
    const r = input.reviewId
      ? await pendingReview(tx, input.reviewId, [
          "merge_suggestion",
          "new_product",
          "unverified_item",
        ])
      : null;
    if (r && r.itemId !== input.itemId) throw badRequest(`review ${r.id} is about another item`);
    const source = await getItem(tx, input.itemId);
    const target = await getItem(tx, input.intoItemId);
    const sourceProducts = await tx
      .select()
      .from(product)
      .where(eq(product.itemId, source.id))
      .orderBy(asc(product.id));
    const plan = planMerge({ source, target, sourceProducts, unitQuantity: input.unitQuantity });
    if (!plan.ok) throw badRequest(plan.error);

    for (const { id, ...patch } of plan.productPatches) {
      await tx
        .update(product)
        .set({ ...patch, itemId: target.id, updatedAt: ctx.now })
        .where(eq(product.id, id));
    }
    await tx
      .update(inventoryEvent)
      .set({
        itemId: target.id,
        ...(plan.eventScale !== 1
          ? { quantity: sql`${inventoryEvent.quantity} * ${plan.eventScale}` }
          : {}),
        updatedAt: ctx.now,
      })
      .where(eq(inventoryEvent.itemId, source.id));
    for (const table of [vendorAlias, receiptLine, groceryCycleOverride] as const) {
      await tx
        .update(table)
        .set({ itemId: target.id, updatedAt: ctx.now })
        .where(eq(table.itemId, source.id));
    }
    await tx
      .update(item)
      .set({ mergedIntoItemId: target.id, updatedAt: ctx.now })
      .where(eq(item.id, source.id));

    const suggested =
      r?.kind === "merge_suggestion" ? asRecord(r.payload).merge_into_item_id : undefined;
    if (r) await closeReview(tx, r, suggested === target.id ? "confirmed" : "corrected", ctx);
    // The item's other open questions are answered by the merge.
    const others = await tx
      .select()
      .from(reviewItem)
      .where(and(eq(reviewItem.itemId, source.id), eq(reviewItem.status, "pending")));
    for (const o of others) await closeReview(tx, o, "confirmed", ctx, { via: "merge" });
    // Suggestions to fold another item into the source now mean its target (or are answered).
    const incoming = await tx
      .select()
      .from(reviewItem)
      .where(and(eq(reviewItem.kind, "merge_suggestion"), eq(reviewItem.status, "pending")));
    for (const o of incoming) {
      const payload = asRecord(o.payload);
      if (payload.merge_into_item_id !== source.id) continue;
      if (o.itemId === target.id) {
        await closeReview(tx, o, "confirmed", ctx, { via: "merge" });
        continue;
      }
      await tx
        .update(reviewItem)
        .set({ payload: { ...payload, merge_into_item_id: target.id }, updatedAt: ctx.now })
        .where(eq(reviewItem.id, o.id));
    }

    await refreshInventoryState(tx, [source.id, target.id], ctx.now, ctx.config);
    await emitTelemetry(
      tx,
      "state_engine",
      [
        {
          metric: "item_merged",
          itemId: source.id,
          intoItemId: target.id,
          reviewKind: r?.kind ?? null,
          eventScale: plan.eventScale,
          products: sourceProducts.length,
        },
      ],
      ctx.now,
    );
    return { itemId: source.id, intoItemId: target.id };
  });
}

/**
 * "Yes, this is a real item" for an auto-created item (new_product / unverified_item): the item
 * becomes confirmed, optionally renamed, and its open new-item questions close.
 */
export async function confirmItem(
  db: Db,
  input: { reviewId: string; name: string | null },
  ctx: ServiceCtx,
): Promise<{ itemId: string }> {
  return db.transaction(async (tx) => {
    const r = await pendingReview(tx, input.reviewId, ["new_product", "unverified_item"]);
    if (!r.itemId) throw badRequest(`review ${r.id} has no item`);
    const it = await getItem(tx, r.itemId);
    const name = input.name?.trim() || it.canonicalName;
    if (name.length > 120) throw badRequest("name is too long");
    await tx
      .update(item)
      .set({ trust: "confirmed", canonicalName: name, updatedAt: ctx.now })
      .where(eq(item.id, it.id));
    const status = name === it.canonicalName ? "confirmed" : "corrected";
    await closeReview(tx, r, status, ctx);
    const others = await tx
      .select()
      .from(reviewItem)
      .where(
        and(
          eq(reviewItem.itemId, it.id),
          eq(reviewItem.status, "pending"),
          inArray(reviewItem.kind, ["new_product", "unverified_item"]),
        ),
      );
    for (const o of others) await closeReview(tx, o, status, ctx);
    return { itemId: it.id };
  });
}

// --- Trash Cam and dismissals -------------------------------------------------------------------

/**
 * A human named what the Trash Cam saw: the item is marked consumed ("we're out") and the answer
 * becomes a Trash Cam label.
 */
export async function answerTrashCam(
  db: Db,
  input: { reviewId: string; itemId: string },
  ctx: ServiceCtx,
): Promise<{ eventId: string }> {
  return db.transaction(async (tx) => {
    const r = await pendingReview(tx, input.reviewId, ["trash_cam"]);
    const it = await getItem(tx, input.itemId);
    if (it.mergedIntoItemId) throw badRequest(`item ${it.id} was merged`);
    const [job] = r.jobId ? await tx.select().from(auditJob).where(eq(auditJob.id, r.jobId)) : [];
    const eventId = newId();
    await tx.insert(inventoryEvent).values({
      id: eventId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      itemId: it.id,
      location: it.defaultLocation,
      kind: "consumed",
      quantity: 0,
      statusOverride: "consumed",
      occurredAt: job?.createdAt ?? ctx.now,
      source: "trash_cam",
      sourceRef: r.jobId,
      actorMemberId: ctx.actor.memberId,
      actorSystem: ctx.actor.system,
      trust: "confirmed",
    });
    const status = r.itemId === it.id ? "confirmed" : "corrected";
    if (mayCreateLabel(status, ctx.actor.memberId)) {
      await tx.insert(labeledObservation).values({
        id: newId(),
        createdAt: ctx.now,
        updatedAt: ctx.now,
        sourceKind: "trash_cam",
        jobId: r.jobId,
        keyframeR2Key: job?.keyframeR2Keys?.[0] ?? null,
        modelOutput: asRecord(r.payload),
        humanLabel: { item_id: it.id },
        model: job?.model ?? null,
        promptVersion: job?.promptVersion ?? null,
        memberId: ctx.actor.memberId!,
      });
    }
    await refreshInventoryState(tx, [it.id], ctx.now, ctx.config);
    await closeReview(tx, r, status, ctx);
    return { eventId };
  });
}

/**
 * "Not now / not the same": close a review with its §4.6 default applied now (every default leaves
 * things as they are — pending lines stay unapplied, auto-created items stay, nothing merges).
 */
export async function dismissReview(db: Db, reviewId: string, ctx: ServiceCtx): Promise<void> {
  await db.transaction(async (tx) => {
    const r = await pendingReview(tx, reviewId, [
      "receipt",
      "new_product",
      "merge_suggestion",
      "unverified_item",
      "failed_job",
      "trash_cam",
    ]);
    await closeReview(tx, r, "dismissed", ctx);
  });
}
