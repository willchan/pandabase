// Receipt ingest end-to-end (DESIGN §4.5): digital + paper, dedupe, cursor.
import {
  inventoryEvent,
  inventoryState,
  item,
  product,
  receipt,
  receiptLine,
  reviewItem,
  systemTelemetry,
} from "@pandabase/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobCompleteResponse, ReceiptIngestResponseT } from "@/lib/contracts";
import { ALEX, SAM, setup, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";
import type { z } from "zod";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(() => h.close());

const ingest = (body: Record<string, unknown>, headers?: Record<string, string>) =>
  h.call<ReceiptIngestResponseT>(HANDLERS.receiptsIngest.POST, "/api/receipts/ingest", {
    body: { actor_discord_id: ALEX, ...body },
    headers,
  });

const amazonOrder = {
  source: "digital",
  vendor: "amazon",
  account: ALEX,
  external_order_id: "111-0000001",
  fulfillment: "delivery",
  ordered_at: "2026-10-18T15:00:00Z",
  acquired_at: "2026-10-20T15:59:00Z",
  subtotal_cents: 3498,
  total_cents: 3700,
  lines: [
    {
      raw_text: "Fizzwell Sparkling Water Lime 12pk",
      asin: "B0SEED0002",
      qty: 2,
      unit_price_cents: 599,
      line_total_cents: 1198,
    },
    {
      raw_text: "Zesty Hot Sauce, 3 Pack",
      asin: "B0NEWHOT01",
      title: "Zesty Hot Sauce, 3 Pack",
      qty: 1,
      unit_price_cents: 2300,
      line_total_cents: 2300,
    },
    { raw_text: "Gift wrap", asin: "B0SEEDGIFT", qty: 1, unit_price_cents: 0, line_total_cents: 0 },
  ],
};

describe("digital receipts", () => {
  it("resolves ASINs, auto-creates unknown products, applies inventory and dedupes", async () => {
    const water = await h.itemId("Sparkling Water");
    const before = await h.db.select().from(inventoryState).where(eq(inventoryState.itemId, water));

    const res = await ingest(amazonOrder);
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body).toMatchObject({ duplicate: false, status: "applied", totals_check: "pass" });
    expect(body.lines.map((l) => [l.match_method, l.trust, l.ignored])).toEqual([
      ["asin", "confirmed", false],
      ["asin", "confirmed", false],
      ["asin", "confirmed", true],
    ]);

    // Known ASIN → 24 cans acquired, receipt attributed, inventory_state re-projected.
    const events = await h.db
      .select()
      .from(inventoryEvent)
      .where(eq(inventoryEvent.sourceRef, body.receipt_id));
    expect(events.find((e) => e.itemId === water)).toMatchObject({
      kind: "acquired",
      quantity: 24,
      source: "digital_receipt",
      trust: "confirmed",
      actorSystem: "agent",
      actorMemberId: await h.memberId(ALEX),
    });
    const after = await h.db.select().from(inventoryState).where(eq(inventoryState.itemId, water));
    expect(after[0]!.anchorAt).toBe("2026-10-20T15:59:00.000Z");
    expect(after).not.toEqual(before);

    // Unknown ASIN → unverified static item + acceptable product (3 per pack) + new_product review.
    expect(body.new_item_ids).toHaveLength(1);
    const [created] = await h.db.select().from(item).where(eq(item.id, body.new_item_ids[0]!));
    expect(created).toMatchObject({
      canonicalName: "Zesty Hot Sauce",
      trust: "unverified",
      trackingType: "static",
    });
    const [p] = await h.db.select().from(product).where(eq(product.itemId, created!.id));
    expect(p).toMatchObject({
      asin: "B0NEWHOT01",
      unitQuantity: 3,
      stance: "acceptable",
      timesBought: 1,
    });
    const reviews = await h.db
      .select()
      .from(reviewItem)
      .where(inArray(reviewItem.id, body.review_ids));
    expect(reviews.map((r) => [r.kind, r.receiptId])).toEqual([["new_product", body.receipt_id]]);

    // Product stats on the known product.
    const [fizz] = await h.db.select().from(product).where(eq(product.asin, "B0SEED0002"));
    expect(fizz).toMatchObject({ lastPriceCents: 599, lastBoughtAt: "2026-10-20T15:59:00.000Z" });

    // Domain telemetry emitted with the receipt id.
    const tel = await h.db
      .select()
      .from(systemTelemetry)
      .where(eq(systemTelemetry.source, "state_engine"));
    const metrics = tel
      .filter((t) => (t.payload as { receiptId?: string }).receiptId === body.receipt_id)
      .map((t) => t.metricType);
    expect(metrics).toEqual(expect.arrayContaining(["receipt_line_match", "ema_updated"]));
    expect(metrics.filter((m) => m === "receipt_line_match")).toHaveLength(3);

    // Re-ingest: same receipt, nothing new.
    const counts = async () => ({
      receipts: (await h.db.select().from(receipt)).length,
      events: (await h.db.select().from(inventoryEvent)).length,
      items: (await h.db.select().from(item)).length,
    });
    const c0 = await counts();
    const again = await ingest({ ...amazonOrder, lines: amazonOrder.lines.slice(0, 1) });
    expect(again.body).toMatchObject({ duplicate: true, receipt_id: body.receipt_id });
    expect(again.body.lines).toHaveLength(3);
    expect(await counts()).toEqual(c0);
  });

  it("cursor returns the newest digital order of the account (by member or Discord id)", async () => {
    await ingest(amazonOrder);
    const alex = await h.memberId(ALEX);
    for (const account of [ALEX, alex]) {
      const res = await h.call(HANDLERS.receiptsCursor.GET, "/api/receipts/cursor", {
        query: { account },
      });
      expect(res.body).toMatchObject({
        account_member_id: alex,
        external_order_id: "111-0000001",
        acquired_at: "2026-10-20T15:59:00.000Z",
      });
    }
    const unknown = await h.call(HANDLERS.receiptsCursor.GET, "/api/receipts/cursor", {
      query: { account: "nobody" },
    });
    expect(unknown.status).toBe(400);
    const sam = await h.call(HANDLERS.receiptsCursor.GET, "/api/receipts/cursor", {
      query: { account: SAM },
    });
    expect(sam.body).toMatchObject({ account_member_id: await h.memberId(SAM) });
  });

  it("digital receipts need an order id; manual ones an Idempotency-Key", async () => {
    const noOrder = await ingest({ ...amazonOrder, external_order_id: null });
    expect(noOrder).toMatchObject({
      status: 400,
      body: { error: "digital receipt needs external_order_id" },
    });
    const manual = {
      ...amazonOrder,
      source: "manual",
      external_order_id: null,
      vendor: "farmers_market",
    };
    expect((await ingest(manual)).status).toBe(400);
    const ok = await ingest(manual, { "idempotency-key": "m-1" });
    expect(ok.status).toBe(200);
    const [r] = await h.db.select().from(receipt).where(eq(receipt.id, ok.body.receipt_id));
    expect(r!.dedupeKey).toBe("manual:m-1");
  });
});

describe("paper receipts (via the worker)", () => {
  const paperResult = {
    store: "WHOLE FOODS MARKET",
    date: "2026-10-19",
    lines: [
      {
        raw_text: "365 LARGE BROWN EGGS 12CT 4.99",
        qty: 1,
        unit_price_cents: 499,
        line_total_cents: 499,
      },
      { raw_text: "ORGANIC STRAWBERRIES", qty: 1, unit_price_cents: 499, line_total_cents: 499 },
      { raw_text: "XQZ WIDGET THING", qty: 1, unit_price_cents: 250, line_total_cents: 250 },
      { raw_text: "BAG FEE", qty: 1, unit_price_cents: 10, line_total_cents: 10 },
    ],
    subtotal_cents: 1258,
    tax_cents: 0,
    total_cents: 1258,
    totals_check: "pass",
  };

  async function runJob(result: unknown) {
    const created = await h.call<{ job: { id: string } }>(HANDLERS.jobsCreate.POST, "/api/jobs", {
      body: {
        actor_discord_id: SAM,
        job_type: "paper_receipt",
        media_r2_key: "media/2026/10/receipt.jpg",
        discord_channel_id: "1",
        discord_message_id: "2",
      },
    });
    const claim = await h.call<{ job: { id: string; attempt: number } }>(
      HANDLERS.jobsClaim.POST,
      "/api/jobs/claim",
      { auth: "worker", body: { job_types: ["paper_receipt"] } },
    );
    expect(claim.body.job.id).toBe(created.body.job.id);
    return h.call<z.input<typeof JobCompleteResponse>>(
      HANDLERS.jobsComplete.POST,
      "/api/jobs/complete",
      {
        auth: "worker",
        body: {
          job_id: claim.body.job.id,
          attempt: claim.body.job.attempt,
          status: "completed",
          result,
          model: "qwen-vl:8b",
          prompt_version: "paper_receipt.v1",
          keyframe_r2_keys: [`keyframes/${claim.body.job.id}/0.jpg`],
        },
      },
    );
  }

  it("exact alias → confirmed, fuzzy → provisional, unknown → pending review; fee ignored", async () => {
    const res = await runJob(paperResult);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "review", job: { status: "completed" } });
    const receiptId = res.body.receipt_id!;
    const [r] = await h.db.select().from(receipt).where(eq(receipt.id, receiptId));
    expect(r).toMatchObject({
      source: "paper",
      vendor: "wholefoods",
      status: "partial",
      dedupeKey: "paper:wholefoods:2026-10-19:1258",
      acquiredAt: "2026-10-19T19:00:00.000Z",
      jobId: res.body.job.id,
    });
    const lines = await h.db.select().from(receiptLine).where(eq(receiptLine.receiptId, receiptId));
    const byText = Object.fromEntries(lines.map((l) => [l.rawText, l]));
    expect(byText["365 LARGE BROWN EGGS 12CT 4.99"]).toMatchObject({
      matchMethod: "alias_exact",
      trust: "confirmed",
      itemId: await h.itemId("Eggs"),
    });
    expect(byText["ORGANIC STRAWBERRIES"]).toMatchObject({
      matchMethod: "fuzzy",
      trust: "unverified",
      itemId: await h.itemId("Strawberries"),
    });
    expect(byText["XQZ WIDGET THING"]).toMatchObject({ matchMethod: "none", itemId: null });
    expect(byText["BAG FEE"]).toMatchObject({ ignored: true });

    const events = await h.db
      .select()
      .from(inventoryEvent)
      .where(eq(inventoryEvent.sourceRef, receiptId));
    expect(events.map((e) => [e.trust, e.source, e.actorSystem])).toEqual(
      expect.arrayContaining([
        ["confirmed", "paper_receipt", "worker"],
        ["provisional", "paper_receipt", "worker"],
      ]),
    );
    const [review] = await h.db
      .select()
      .from(reviewItem)
      .where(and(eq(reviewItem.receiptId, receiptId), eq(reviewItem.kind, "receipt")));
    expect(review!.payload).toMatchObject({
      pending_line_ids: [byText["XQZ WIDGET THING"]!.id],
      provisional_line_ids: [byText["ORGANIC STRAWBERRIES"]!.id],
    });
    expect(review!.expiresAt).toBe("2026-11-03T16:00:00.000Z");

    // The same receipt photographed again is a duplicate.
    const again = await runJob(paperResult);
    expect(again.body).toMatchObject({ outcome: "review", receipt_id: receiptId });
    expect(
      await h.db.select().from(receipt).where(eq(receipt.dedupeKey, r!.dedupeKey)),
    ).toHaveLength(1);
  });

  it("an invalid transcription is a failed attempt, retried", async () => {
    const res = await runJob({ store: "WF", lines: "nope" });
    expect(res.body).toMatchObject({ outcome: "retry", job: { status: "queued" } });
    expect(res.body.job!.error).toMatch(/^invalid result: /);
  });
});
