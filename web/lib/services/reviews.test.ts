// Review resolution services against the seeded database (in-memory libSQL).
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
  systemTelemetry,
  vendorAlias,
} from "@pandabase/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@/lib/config";
import { loadEstimates } from "@/lib/repo/inventory";
import { ALEX, setup, type Harness } from "@/test/harness";
import { ingestReceipt } from "./receipts";
import {
  answerReceiptReview,
  answerTrashCam,
  confirmItem,
  dismissReview,
  mergeItems,
  pendingReviews,
  receiptReviewDetail,
} from "./reviews";
import type { ServiceCtx } from "./types";

let h: Harness;
let ctx: ServiceCtx;

beforeEach(async () => {
  h = await setup();
  ctx = {
    now: h.now(),
    config: DEFAULT_CONFIG,
    actor: { memberId: await h.memberId(ALEX), system: null },
  };
});
afterEach(() => h.close());

const reviewOf = async (kind: string) => {
  const rows = await h.db
    .select()
    .from(reviewItem)
    .where(and(eq(reviewItem.status, "pending")));
  return rows.find((r) => r.kind === kind)!;
};
const telemetry = async (metric: string) =>
  h.db.select().from(systemTelemetry).where(eq(systemTelemetry.metricType, metric));

describe("pendingReviews", () => {
  it("lists pending reviews by impact, with receipt line counts, jobs and items", async () => {
    const list = await pendingReviews(h.db);
    expect(list.map((r) => r.kind)).toEqual([
      "receipt",
      "trash_cam",
      "failed_job",
      "new_product",
      "unverified_item",
    ]);
    expect(list[0]).toMatchObject({
      impactScore: 10,
      urgency: "this_week",
      receipt: { vendor: "wholefoods", source: "paper", lines: 1 },
    });
    expect(list.find((r) => r.kind === "failed_job")!.job).toMatchObject({
      type: "paper_receipt",
      error: expect.stringMatching(/blurry/),
    });
    expect(list.find((r) => r.kind === "unverified_item")).toMatchObject({
      itemName: "Kombucha",
      expiresAt: null,
    });
  });
});

describe("answerReceiptReview", () => {
  it("keeping the provisional match confirms line, event and alias, and writes a label", async () => {
    const r = await reviewOf("receipt");
    const detail = await receiptReviewDetail(h.db, r.id);
    expect(detail.mediaKey).toBe("seed/paper-receipts/7.jpg");
    const open = detail.lines.filter((l) => l.state === "provisional" || l.state === "pending");
    expect(open.map((l) => l.rawText)).toEqual(["BRGHTBRW GNGR KMBCHA 16"]);
    const line = open[0]!;

    const res = await answerReceiptReview(h.db, r.id, [{ lineId: line.id, answer: "keep" }], ctx);
    expect(res).toEqual({ status: "confirmed", receiptStatus: "applied" });

    const [l] = await h.db.select().from(receiptLine).where(eq(receiptLine.id, line.id));
    expect(l).toMatchObject({ trust: "confirmed", itemId: line.itemId });
    const events = await h.db
      .select()
      .from(inventoryEvent)
      .where(
        and(eq(inventoryEvent.sourceRef, detail.receipt.id), eq(inventoryEvent.itemId, line.itemId!)),
      );
    expect(events.map((e) => e.trust)).toEqual(["confirmed"]);
    const [alias] = await h.db
      .select()
      .from(vendorAlias)
      .where(eq(vendorAlias.vendorString, "BRGHTBRW GNGR KMBCHA 16"));
    expect(alias).toMatchObject({ itemId: line.itemId, confidenceScore: 1, trust: "confirmed" });
    const labels = await h.db
      .select()
      .from(labeledObservation)
      .where(eq(labeledObservation.jobId, detail.receipt.jobId!));
    expect(labels).toHaveLength(1);
    expect(labels[0]!.humanLabel).toEqual({ itemId: line.itemId, productId: line.productId });
    const [after] = await h.db.select().from(reviewItem).where(eq(reviewItem.id, r.id));
    expect(after).toMatchObject({ status: "confirmed", reviewedByMemberId: ctx.actor.memberId });
    expect((await telemetry("review_resolved"))[0]!.payload).toMatchObject({
      kind: "receipt",
      outcome: "confirmed",
      confirmedLines: 1,
    });
    await expect(
      answerReceiptReview(h.db, r.id, [{ lineId: line.id, answer: "keep" }], ctx),
    ).rejects.toThrow(/already confirmed/);
  });

  it("correcting a line reverses its event and applies the chosen item", async () => {
    const r = await reviewOf("receipt");
    const detail = await receiptReviewDetail(h.db, r.id);
    const line = detail.lines.find((l) => l.state === "provisional")!;
    const ginger = await h.itemId("Toilet Paper");
    const before = (await loadEstimates(h.db, ctx.now, ctx.config, [ginger])).get(ginger)!;

    const res = await answerReceiptReview(
      h.db,
      r.id,
      [{ lineId: line.id, answer: "item", itemId: ginger }],
      ctx,
    );
    expect(res.status).toBe("corrected");
    const events = await h.db
      .select()
      .from(inventoryEvent)
      .where(eq(inventoryEvent.sourceRef, detail.receipt.id));
    expect(events.filter((e) => e.itemId === line.itemId && e.trust !== "expired")).toEqual([]);
    expect(events.find((e) => e.itemId === ginger)).toMatchObject({
      trust: "confirmed",
      kind: "acquired",
    });
    const [l] = await h.db.select().from(receiptLine).where(eq(receiptLine.id, line.id));
    expect(l).toMatchObject({ itemId: ginger, matchMethod: "manual", trust: "confirmed" });
    const after = (await loadEstimates(h.db, ctx.now, ctx.config, [ginger])).get(ginger)!;
    expect(after.estimate.onHand).toBeGreaterThan(before.estimate.onHand);
  });

  it("ignoring a line drops its units and learns an ignored alias", async () => {
    const r = await reviewOf("receipt");
    const detail = await receiptReviewDetail(h.db, r.id);
    const line = detail.lines.find((l) => l.state === "provisional")!;
    await answerReceiptReview(h.db, r.id, [{ lineId: line.id, answer: "ignore" }], ctx);
    const [alias] = await h.db
      .select()
      .from(vendorAlias)
      .where(eq(vendorAlias.vendorString, "BRGHTBRW GNGR KMBCHA 16"));
    expect(alias).toMatchObject({ ignored: true, itemId: null });
    const [l] = await h.db.select().from(receiptLine).where(eq(receiptLine.id, line.id));
    expect(l).toMatchObject({ ignored: true, itemId: null });
  });

  it("resolves pending lines of a fresh paper receipt; unanswered ones stay pending", async () => {
    const res = await ingestReceipt(
      h.db,
      {
        source: "paper",
        vendor: "wholefoods",
        accountMemberId: null,
        externalOrderId: null,
        fulfillment: "in_store",
        orderedAt: null,
        acquiredAt: h.now(),
        subtotalCents: null,
        totalCents: 999,
        lines: [
          { rawText: "ZZQ MYSTERY THING", asin: null, qty: 1, unitPriceCents: 1, lineTotalCents: 1 },
          { rawText: "QQX OTHER THING", asin: null, qty: 2, unitPriceCents: 1, lineTotalCents: 2 },
        ],
      },
      { ...ctx, actor: { memberId: null, system: "worker" } },
    );
    expect(res.status).toBe("pending_review");
    const [review] = await h.db
      .select()
      .from(reviewItem)
      .where(and(eq(reviewItem.receiptId, res.receipt_id), eq(reviewItem.kind, "receipt")));
    const eggs = await h.itemId("Eggs");
    const out = await answerReceiptReview(
      h.db,
      review!.id,
      [
        { lineId: res.lines[0]!.id, answer: "item", itemId: eggs },
        { lineId: res.lines[1]!.id, answer: "keep" }, // nothing to keep: stays pending
      ],
      ctx,
    );
    expect(out.receiptStatus).toBe("partial");
    const [ev] = await h.db
      .select()
      .from(inventoryEvent)
      .where(and(eq(inventoryEvent.sourceRef, res.receipt_id), eq(inventoryEvent.itemId, eggs)));
    // 1 × the preferred Whole Foods egg carton (12).
    expect(ev).toMatchObject({ quantity: 12, trust: "confirmed", source: "paper_receipt" });
    const [rec] = await h.db.select().from(receipt).where(eq(receipt.id, res.receipt_id));
    expect(rec!.status).toBe("partial");
  });

  it("rejects lines that aren't open on the receipt and unknown items", async () => {
    const r = await reviewOf("receipt");
    const detail = await receiptReviewDetail(h.db, r.id);
    const confirmed = detail.lines.find((l) => l.state === "confirmed")!;
    await expect(
      answerReceiptReview(h.db, r.id, [{ lineId: confirmed.id, answer: "ignore" }], ctx),
    ).rejects.toThrow(/not open/);
    const open = detail.lines.find((l) => l.state === "provisional")!;
    await expect(
      answerReceiptReview(h.db, r.id, [{ lineId: open.id, answer: "item", itemId: "nope" }], ctx),
    ).rejects.toThrow(/not found/);
    const other = await reviewOf("trash_cam");
    await expect(answerReceiptReview(h.db, other.id, [], ctx)).rejects.toThrow(/trash_cam/);
    await expect(receiptReviewDetail(h.db, other.id)).rejects.toThrow(/not found/);
  });
});

describe("mergeItems", () => {
  it("folds an auto-created item into an existing one and closes its reviews", async () => {
    const r = await reviewOf("new_product");
    const kombucha = r.itemId!;
    const target = await h.itemId("Oat Milk");
    const [p] = await h.db.select().from(product).where(eq(product.itemId, kombucha));

    await mergeItems(
      h.db,
      { reviewId: r.id, itemId: kombucha, intoItemId: target, unitQuantity: null },
      ctx,
    );
    const [src] = await h.db.select().from(item).where(eq(item.id, kombucha));
    expect(src!.mergedIntoItemId).toBe(target);
    const [moved] = await h.db.select().from(product).where(eq(product.id, p!.id));
    expect(moved).toMatchObject({ itemId: target, stance: "acceptable" });
    expect(
      await h.db.select().from(inventoryEvent).where(eq(inventoryEvent.itemId, kombucha)),
    ).toHaveLength(0);
    const statuses = await h.db
      .select({ kind: reviewItem.kind, status: reviewItem.status })
      .from(reviewItem)
      .where(eq(reviewItem.itemId, kombucha));
    expect(statuses).toEqual(
      expect.arrayContaining([
        { kind: "new_product", status: "corrected" },
        { kind: "unverified_item", status: "confirmed" },
      ]),
    );
    expect((await telemetry("item_merged"))[0]!.payload).toMatchObject({
      itemId: kombucha,
      intoItemId: target,
      reviewKind: "new_product",
    });
    await expect(
      mergeItems(h.db, { reviewId: null, itemId: kombucha, intoItemId: target, unitQuantity: null }, ctx),
    ).rejects.toThrow(/already merged/);
  });

  it("a merge suggestion with a pack size rescales history and moves overrides", async () => {
    const kombucha = await h.itemId("Kombucha");
    const target = await h.itemId("Eggs");
    const [cycleOverride] = await h.db.select().from(groceryCycleOverride).limit(1);
    await h.db
      .update(groceryCycleOverride)
      .set({ itemId: kombucha })
      .where(eq(groceryCycleOverride.id, cycleOverride!.id));
    const [job] = await h.db.select().from(auditJob).limit(1);
    await h.db.insert(reviewItem).values({
      id: "rv-merge",
      kind: "merge_suggestion",
      jobId: job!.id,
      itemId: kombucha,
      payload: { merge_into_item_id: target, confidence: 0.9 },
      urgency: "cleanup",
      impactScore: 1,
      defaultAction: { action: "none" },
      expiresAt: "2026-11-20T00:00:00.000Z",
    });
    await h.db.insert(inventoryEvent).values({
      id: "ev-kombucha",
      itemId: kombucha,
      location: "pantry",
      kind: "acquired",
      quantity: 2,
      occurredAt: h.now(),
      source: "manual",
      trust: "confirmed",
    });
    const [p] = await h.db.select().from(product).where(eq(product.itemId, kombucha));
    await mergeItems(
      h.db,
      { reviewId: "rv-merge", itemId: kombucha, intoItemId: target, unitQuantity: 3 * p!.unitQuantity },
      ctx,
    );
    const [ev] = await h.db.select().from(inventoryEvent).where(eq(inventoryEvent.id, "ev-kombucha"));
    expect(ev).toMatchObject({ itemId: target, quantity: 6 });
    const [rv] = await h.db.select().from(reviewItem).where(eq(reviewItem.id, "rv-merge"));
    expect(rv!.status).toBe("confirmed");
    const [o] = await h.db
      .select()
      .from(groceryCycleOverride)
      .where(eq(groceryCycleOverride.id, cycleOverride!.id));
    expect(o!.itemId).toBe(target);
    const [pp] = await h.db.select().from(product).where(eq(product.id, p!.id));
    expect(pp).toMatchObject({ unitQuantity: 3 * p!.unitQuantity, unitQuantityTrust: "confirmed" });
    expect((await telemetry("item_merged"))[0]!.payload).toMatchObject({ eventScale: 3 });
  });

  it("validates the target and the review", async () => {
    const r = await reviewOf("new_product");
    await expect(
      mergeItems(h.db, { reviewId: r.id, itemId: r.itemId!, intoItemId: r.itemId!, unitQuantity: null }, ctx),
    ).rejects.toThrow(/itself/);
    const eggs = await h.itemId("Eggs");
    await expect(
      mergeItems(h.db, { reviewId: r.id, itemId: eggs, intoItemId: r.itemId!, unitQuantity: null }, ctx),
    ).rejects.toThrow(/another item/);
  });
});

describe("confirmItem / answerTrashCam / dismissReview", () => {
  it("confirming an auto-created item (with a rename) closes both new-item reviews", async () => {
    const r = await reviewOf("unverified_item");
    await confirmItem(h.db, { reviewId: r.id, name: "Ginger kombucha" }, ctx);
    const [it] = await h.db.select().from(item).where(eq(item.id, r.itemId!));
    expect(it).toMatchObject({ trust: "confirmed", canonicalName: "Ginger kombucha" });
    const pending = await h.db
      .select()
      .from(reviewItem)
      .where(and(eq(reviewItem.itemId, r.itemId!), eq(reviewItem.status, "pending")));
    expect(pending).toHaveLength(0);
  });

  it("naming what the Trash Cam saw marks it consumed and writes a label", async () => {
    const r = await reviewOf("trash_cam");
    const yogurt = r.itemId!;
    const { eventId } = await answerTrashCam(h.db, { reviewId: r.id, itemId: yogurt }, ctx);
    const [ev] = await h.db.select().from(inventoryEvent).where(eq(inventoryEvent.id, eventId));
    expect(ev).toMatchObject({
      kind: "consumed",
      statusOverride: "consumed",
      source: "trash_cam",
      trust: "confirmed",
      sourceRef: r.jobId,
    });
    const [label] = await h.db
      .select()
      .from(labeledObservation)
      .where(eq(labeledObservation.sourceKind, "trash_cam"));
    expect(label).toMatchObject({ humanLabel: { item_id: yogurt }, keyframeR2Key: expect.any(String) });
    const est = (await loadEstimates(h.db, ctx.now, ctx.config, [yogurt])).get(yogurt)!;
    expect(est.estimate.status).toBe("consumed");
    const [after] = await h.db.select().from(reviewItem).where(eq(reviewItem.id, r.id));
    expect(after!.status).toBe("confirmed");
  });

  it("dismissing applies the default and writes no label", async () => {
    const r = await reviewOf("failed_job");
    await dismissReview(h.db, r.id, ctx);
    const [after] = await h.db.select().from(reviewItem).where(eq(reviewItem.id, r.id));
    expect(after!.status).toBe("dismissed");
    await expect(dismissReview(h.db, r.id, ctx)).rejects.toThrow(/already dismissed/);
    await expect(dismissReview(h.db, "nope", ctx)).rejects.toThrow(/not found/);
  });

  it("no label without a member", async () => {
    const r = await reviewOf("trash_cam");
    const before = (await h.db.select().from(labeledObservation)).length;
    await answerTrashCam(
      h.db,
      { reviewId: r.id, itemId: await h.itemId("Eggs") },
      { ...ctx, actor: { memberId: null, system: "agent" } },
    );
    expect(await h.db.select().from(labeledObservation)).toHaveLength(before);
    const [after] = await h.db.select().from(reviewItem).where(eq(reviewItem.id, r.id));
    expect(after!.status).toBe("corrected");
  });
});
