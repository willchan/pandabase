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
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { normalizeReceiptText } from "../domain/matching";
import { planMerge } from "../domain/merge";
import {
  eventSource,
  lineBaseUnits,
  reconcileReceiptEvents,
  resolveReceiptReview,
  type LineDecision,
} from "../domain/receipts";
import { mayCreateLabel, type ReviewKind } from "../domain/review";
import { daysBetween } from "../domain/time";
import { badRequest, conflict, notFound } from "../http";
import { getItem, productsByItem, toCandidate } from "../repo/catalog";
import { asRecord, type Q } from "../repo/db";
import { refreshInventoryState } from "../repo/inventory";
import { emitTelemetry } from "../telemetry";
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
  await q
    .update(reviewItem)
    .set({
      status,
      reviewedByMemberId: ctx.actor.memberId,
      reviewedAt: ctx.now,
      updatedAt: ctx.now,
    })
    .where(eq(reviewItem.id, r.id));
  await emitTelemetry(
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
  );
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
}

/**
 * Pending reviews for Cleanup / This Week, highest impact first (§4.6), then soonest expiry.
 * Receipt reviews count their open lines (pending + provisional) from `receipt_line`.
 */
export async function pendingReviews(q: Q): Promise<ReviewSummary[]> {
  const rows = await q
    .select()
    .from(reviewItem)
    .where(eq(reviewItem.status, "pending"))
    .orderBy(desc(reviewItem.impactScore), asc(reviewItem.createdAt), asc(reviewItem.id));
  const names = new Map(
    (await q.select({ id: item.id, name: item.canonicalName }).from(item)).map((i) => [
      i.id,
      i.name,
    ]),
  );
  const out: ReviewSummary[] = [];
  for (const r of rows) {
    const payload = asRecord(r.payload);
    let rec: ReviewSummary["receipt"] = null;
    if (r.receiptId && r.kind === "receipt") {
      const [x] = await q.select().from(receipt).where(eq(receipt.id, r.receiptId));
      const lines = (await receiptLines(q, r.receiptId)).filter(isOpenLine);
      if (x) rec = { vendor: x.vendor, source: x.source, acquiredAt: x.acquiredAt, lines: lines.length };
    }
    let job: ReviewSummary["job"] = null;
    if (r.jobId && r.kind === "failed_job") {
      const [j] = await q.select().from(auditJob).where(eq(auditJob.id, r.jobId));
      if (j) job = { type: j.jobType, error: j.error, attempts: j.attempts };
    }
    const intoId = typeof payload.merge_into_item_id === "string" ? payload.merge_into_item_id : null;
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
    });
  }
  return out.sort(
    (a, b) =>
      b.impactScore - a.impactScore ||
      (a.expiresAt ?? "9999").localeCompare(b.expiresAt ?? "9999") ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

const receiptLines = (q: Q, receiptId: string) =>
  q
    .select()
    .from(receiptLine)
    .where(eq(receiptLine.receiptId, receiptId))
    .orderBy(asc(receiptLine.id));

/** A line the receipt review asks about: unmatched (pending) or matched provisionally. */
const isOpenLine = (l: LineRow) => !l.ignored && (l.itemId === null || l.trust !== "confirmed");

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
  const [job] = rec.jobId
    ? await q.select().from(auditJob).where(eq(auditJob.id, rec.jobId))
    : [];
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
  return db.transaction(async (tx) => {
    const r = await pendingReview(tx, reviewId, ["receipt"]);
    if (!r.receiptId) throw badRequest(`review ${reviewId} has no receipt`);
    const [rec] = await tx.select().from(receipt).where(eq(receipt.id, r.receiptId));
    if (!rec) throw notFound(`receipt ${r.receiptId}`);
    const lines = await receiptLines(tx, rec.id);
    const open = new Map(lines.filter(isOpenLine).map((l) => [l.id, l]));

    const decided: { line: LineRow; decision: LineDecision }[] = [];
    for (const a of answers) {
      const line = open.get(a.lineId);
      if (!line) throw badRequest(`line ${a.lineId} is not open on this receipt`);
      if (a.answer === "item") await getItem(tx, a.itemId);
      const decision: LineDecision =
        a.answer === "ignore"
          ? { kind: "ignore" }
          : a.answer === "keep" || a.itemId === line.itemId
            ? { kind: "confirm" }
            : { kind: "correct", itemId: a.itemId, productId: null };
      if (decision.kind === "confirm" && line.itemId === null) continue; // nothing to keep
      decided.push({ line, decision });
    }

    const aliases = await tx.select().from(vendorAlias).where(eq(vendorAlias.vendor, rec.vendor));
    const res = resolveReceiptReview({
      vendor: rec.vendor,
      existingAliases: aliases,
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

    for (const u of res.lineUpdates) {
      await tx
        .update(receiptLine)
        .set({
          itemId: u.itemId,
          productId: u.productId,
          trust: u.trust,
          ignored: u.ignored,
          ...(u.matchMethod ? { matchMethod: u.matchMethod } : {}),
          updatedAt: ctx.now,
        })
        .where(eq(receiptLine.id, u.lineId));
    }
    for (const a of res.aliases) {
      const { trust, ...alias } = a;
      await tx
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
        });
    }

    // Make the receipt's `acquired` events match its final lines.
    const final = await receiptLines(tx, rec.id);
    const products = await productsByItem(
      tx,
      final.flatMap((l) => (l.itemId ? [l.itemId] : [])),
    );
    const events = await tx
      .select()
      .from(inventoryEvent)
      .where(
        and(
          eq(inventoryEvent.sourceRef, rec.id),
          eq(inventoryEvent.kind, "acquired"),
          ne(inventoryEvent.trust, "expired"),
        ),
      )
      .orderBy(asc(inventoryEvent.id));
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
    for (const t of plan.trust) {
      await tx
        .update(inventoryEvent)
        .set({ trust: t.trust, updatedAt: ctx.now })
        .where(eq(inventoryEvent.id, t.eventId));
    }
    if (plan.expire.length > 0) {
      await tx
        .update(inventoryEvent)
        .set({ trust: "expired", updatedAt: ctx.now })
        .where(inArray(inventoryEvent.id, plan.expire));
    }
    for (const e of plan.insert) {
      const it = await getItem(tx, e.itemId);
      await tx.insert(inventoryEvent).values({
        id: newId(),
        createdAt: ctx.now,
        updatedAt: ctx.now,
        itemId: e.itemId,
        location: it.defaultLocation,
        kind: "acquired",
        quantity: e.quantity,
        occurredAt: rec.acquiredAt,
        source: eventSource(rec.source),
        sourceRef: rec.id,
        actorMemberId: ctx.actor.memberId,
        actorSystem: ctx.actor.system,
        trust: e.trust,
      });
    }

    const corrected = decided.some((d) => d.decision.kind !== "confirm");
    const status = corrected ? "corrected" : "confirmed";
    if (mayCreateLabel(status, ctx.actor.memberId) && res.labels.length > 0) {
      const [job] = rec.jobId
        ? await tx.select().from(auditJob).where(eq(auditJob.id, rec.jobId))
        : [];
      await tx.insert(labeledObservation).values(
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
      );
    }

    const stillPending = final.some((l) => l.itemId === null && !l.ignored);
    const applied = final.some((l) => l.itemId !== null && !l.ignored);
    const receiptStatus = !stillPending ? "applied" : applied ? "partial" : "pending_review";
    await tx
      .update(receipt)
      .set({ status: receiptStatus, updatedAt: ctx.now })
      .where(eq(receipt.id, rec.id));

    const touched = [
      ...events.map((e) => e.itemId),
      ...plan.insert.map((e) => e.itemId),
    ];
    await refreshInventoryState(tx, touched, ctx.now, ctx.config);
    const count = (k: LineDecision["kind"]) => decided.filter((d) => d.decision.kind === k).length;
    await closeReview(tx, r, status, ctx, {
      vendor: rec.vendor,
      confirmedLines: count("confirm"),
      correctedLines: count("correct"),
      ignoredLines: count("ignore"),
    });
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
  input: { reviewId: string | null; itemId: string; intoItemId: string; unitQuantity: number | null },
  ctx: ServiceCtx,
): Promise<{ itemId: string; intoItemId: string }> {
  return db.transaction(async (tx) => {
    const r = input.reviewId
      ? await pendingReview(tx, input.reviewId, ["merge_suggestion", "new_product", "unverified_item"])
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
