// PLAN M11.2: a digital order read again with different content replaces the stored receipt, and
// ingest rebuilds the touched items' learning within a constant number of round trips.
import {
  inventoryEvent,
  item,
  product,
  receipt,
  receiptLine,
  systemTelemetry,
} from "@pandabase/db";
import { planLearningRebuild } from "@pandabase/db/rebuild-learning";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@/lib/config";
import { setup, type Harness } from "@/test/harness";
import { countRoundTrips } from "@/test/roundTrips";
import { rebuildItemsIn } from "./learning";
import { ingestReceipt } from "./receipts";
import type { ServiceCtx } from "./types";

let h: Harness;
beforeEach(async () => {
  h = await setup({ seed: false });
});
afterEach(() => h.close());

const DAY = 86_400_000;
const day = (d: number) => new Date(Date.parse("2026-08-01T19:00:00.000Z") + d * DAY).toISOString();
const ctx = (now: string): ServiceCtx => ({
  now,
  config: DEFAULT_CONFIG,
  actor: { memberId: null, system: "agent" },
});

type Line = { asin: string; title: string; qty?: number; cents?: number };
const COFFEE: Line = { asin: "B0SYNTHCOF1", title: "Synthetic Coffee Beans, 12 oz" };
const RICE: Line = { asin: "B0SYNTHRIC1", title: "Synthetic Jasmine Rice, 5 lb" };
const TEA: Line = { asin: "B0SYNTHTEA1", title: "Synthetic Green Tea, 20 ct" };

const order = (at: string, lines: Line[], orderId = "ORDER-1", o: { total?: number } = {}) => ({
  source: "digital" as const,
  vendor: "amazon",
  accountMemberId: null,
  externalOrderId: orderId,
  fulfillment: "delivery" as const,
  orderedAt: null,
  acquiredAt: at,
  subtotalCents: o.total ?? null,
  totalCents: null,
  lines: lines.map((l) => ({
    rawText: l.title,
    asin: l.asin,
    vendorSku: null,
    title: l.title,
    qty: l.qty ?? 1,
    unitPriceCents: l.cents ?? 500,
    lineTotalCents: (l.cents ?? 500) * (l.qty ?? 1),
  })),
});

const telemetry = async (metric: string) =>
  (await h.db.select().from(systemTelemetry).where(eq(systemTelemetry.metricType, metric))).map(
    (t) => t.payload as Record<string, unknown>,
  );
const linesOf = (receiptId: string) =>
  h.db.select().from(receiptLine).where(eq(receiptLine.receiptId, receiptId));
const acquired = (receiptId: string) =>
  h.db
    .select()
    .from(inventoryEvent)
    .where(and(eq(inventoryEvent.sourceRef, receiptId), eq(inventoryEvent.kind, "acquired")));
const productOf = async (asin: string) =>
  (await h.db.select().from(product).where(eq(product.asin, asin)))[0]!;
const nothingToRebuild = async () =>
  expect((await planLearningRebuild(h.db, { config: DEFAULT_CONFIG })).changes).toEqual([]);

describe("re-reading an order (PLAN M11.2)", () => {
  it("the same content again is a duplicate and writes nothing", async () => {
    const first = await ingestReceipt(h.db, order(day(0), [COFFEE, RICE]), ctx(day(0)));
    const again = await ingestReceipt(h.db, order(day(0), [COFFEE, RICE]), ctx(day(1)));
    expect(again).toMatchObject({ duplicate: true, receipt_id: first.receipt_id });
    expect(again.replaced).toBeUndefined();
    expect(await telemetry("receipt_replaced")).toEqual([]);
    const [r] = await h.db.select().from(receipt);
    expect(r!.updatedAt).toBe(day(0));
  });

  it("a changed quantity replaces that line and its event; the unchanged line keeps its row", async () => {
    await ingestReceipt(h.db, order(day(-10), [COFFEE], "EARLIER"), ctx(day(-10)));
    const first = await ingestReceipt(h.db, order(day(0), [COFFEE, RICE]), ctx(day(0)));
    const [coffeeLine, riceLine] = first.lines;
    // The parser read the rice as 1; it was 3.
    const again = await ingestReceipt(
      h.db,
      order(day(0), [COFFEE, { ...RICE, qty: 3 }]),
      ctx(day(1)),
    );
    expect(again).toMatchObject({ duplicate: false, replaced: true, receipt_id: first.receipt_id });
    const lines = await linesOf(first.receipt_id);
    expect(lines.map((l) => l.id)).toContain(coffeeLine!.id);
    expect(lines.map((l) => l.id)).not.toContain(riceLine!.id);
    expect(lines.find((l) => l.itemId === riceLine!.item_id)).toMatchObject({ qty: 3 });
    const events = await acquired(first.receipt_id);
    expect(events.find((e) => e.itemId === riceLine!.item_id)).toMatchObject({ quantity: 3 });
    expect(events).toHaveLength(2);
    // Same items, products and stats: still one purchase of each on this order.
    expect(await h.db.select().from(item)).toHaveLength(2);
    expect(await productOf(RICE.asin)).toMatchObject({ timesBought: 1 });
    expect(await productOf(COFFEE.asin)).toMatchObject({ timesBought: 2 });
    expect(await telemetry("receipt_replaced")).toEqual([
      expect.objectContaining({
        outcome: "replaced",
        linesKept: 1,
        linesNew: 1,
        linesRemoved: 1,
        newItems: 0,
      }),
    ]);
    await nothingToRebuild();
  });

  it("a line misread onto the wrong product is rebuilt away from it", async () => {
    await ingestReceipt(h.db, order(day(-20), [COFFEE], "EARLIER-2"), ctx(day(-20)));
    await ingestReceipt(h.db, order(day(-10), [COFFEE], "EARLIER"), ctx(day(-10)));
    // The misread: tea read as coffee.
    const first = await ingestReceipt(h.db, order(day(0), [COFFEE]), ctx(day(0)));
    expect(await productOf(COFFEE.asin)).toMatchObject({ timesBought: 3, lastBoughtAt: day(0) });
    const again = await ingestReceipt(h.db, order(day(0), [TEA]), ctx(day(1)));
    expect(again).toMatchObject({ replaced: true, receipt_id: first.receipt_id });
    expect(again.new_item_ids).toHaveLength(1);
    // Coffee loses the purchase it never had; tea is a new item stamped with the receipt's time.
    expect(await productOf(COFFEE.asin)).toMatchObject({ timesBought: 2, lastBoughtAt: day(-10) });
    const tea = await productOf(TEA.asin);
    expect(tea).toMatchObject({ timesBought: 1, createdAt: day(0) });
    const [teaItem] = await h.db.select().from(item).where(eq(item.id, tea.itemId));
    expect(teaItem!.createdAt).toBe(day(0));
    expect(again.review_ids).toHaveLength(1); // its new_product review
    await nothingToRebuild();
  });

  it("keeps a review answer on an unchanged line", async () => {
    const first = await ingestReceipt(h.db, order(day(0), [COFFEE, RICE]), ctx(day(0)));
    const other = await ingestReceipt(h.db, order(day(-5), [TEA], "ORDER-0"), ctx(day(-5)));
    // A person moved the coffee line to the tea item (as a receipt review correction would).
    const coffeeLine = first.lines[0]!;
    await h.db
      .update(receiptLine)
      .set({ itemId: other.lines[0]!.item_id, productId: null, updatedAt: day(1) })
      .where(eq(receiptLine.id, coffeeLine.id));
    await ingestReceipt(h.db, order(day(0), [COFFEE, { ...RICE, cents: 650 }]), ctx(day(2)));
    const [kept] = await h.db.select().from(receiptLine).where(eq(receiptLine.id, coffeeLine.id));
    expect(kept).toMatchObject({ itemId: other.lines[0]!.item_id, productId: null });
    expect(await productOf(RICE.asin)).toMatchObject({ lastPriceCents: 650 });
  });

  it("a corrected date moves the events and puts the purchase in its place", async () => {
    await ingestReceipt(h.db, order(day(0), [COFFEE], "A"), ctx(day(0)));
    await ingestReceipt(h.db, order(day(10), [COFFEE], "B"), ctx(day(10)));
    const late = await ingestReceipt(h.db, order(day(40), [COFFEE], "C"), ctx(day(40)));
    // Order C was really delivered on day 20.
    await ingestReceipt(h.db, order(day(20), [COFFEE], "C"), ctx(day(41)));
    const [e] = await acquired(late.receipt_id);
    expect(e!.occurredAt).toBe(day(20));
    expect(await productOf(COFFEE.asin)).toMatchObject({ timesBought: 3, lastBoughtAt: day(20) });
    await nothingToRebuild();
  });

  it("a paper or manual receipt is never replaced", async () => {
    const manual = {
      ...order(day(0), [COFFEE]),
      source: "manual" as const,
      externalOrderId: null,
      idempotencyKey: "k-1",
    };
    const first = await ingestReceipt(h.db, manual, ctx(day(0)));
    const again = await ingestReceipt(
      h.db,
      { ...manual, lines: manual.lines.map((l) => ({ ...l, qty: 4 })) },
      ctx(day(1)),
    );
    expect(again).toMatchObject({ duplicate: true, receipt_id: first.receipt_id });
  });
});

describe("rebuilding at ingest (PLAN M11.2, DESIGN §8 round trips)", () => {
  it("rebuilds any number of items in a constant number of round trips", async () => {
    const many: Line[] = Array.from({ length: 8 }, (_, i) => ({
      asin: `B0SYNTHMNY${i}`,
      title: `Synthetic Thing ${i}`,
    }));
    const r1 = await ingestReceipt(h.db, order(day(0), many.slice(0, 1), "ONE"), ctx(day(0)));
    const r8 = await ingestReceipt(h.db, order(day(0), many, "EIGHT"), ctx(day(0)));
    // Make every item's stored stats drift so the rebuild has something to write.
    await h.db.update(product).set({ timesBought: 9 });
    const count = async (ids: string[]) => {
      const rt = countRoundTrips(h.db);
      try {
        await rebuildItemsIn(h.db, ids, ctx(day(1)), { scope: "reset" });
        return rt.count();
      } finally {
        rt.restore();
      }
    };
    const one = await count(r1.lines.map((l) => l.item_id!));
    const eight = await count(r8.lines.map((l) => l.item_id!));
    expect(one).toBe(2); // one read batch, one write batch
    expect(eight).toBe(one);
    await nothingToRebuild();
  });

  it("the per-item loader plans exactly what the whole-table plan does for those items", async () => {
    await ingestReceipt(h.db, order(day(0), [COFFEE, RICE], "A"), ctx(day(0)));
    await ingestReceipt(h.db, order(day(10), [COFFEE], "B"), ctx(day(10)));
    await ingestReceipt(h.db, order(day(20), [TEA, RICE], "C"), ctx(day(20)));
    await h.db.update(product).set({ timesBought: 7, stance: "preferred" });
    await h.db.update(item).set({ currentEmaDays: 3 });
    const whole = await planLearningRebuild(h.db, { config: DEFAULT_CONFIG });
    for (const c of whole.changes) {
      const scoped = await planLearningRebuild(h.db, { config: DEFAULT_CONFIG, items: [c.itemId] });
      expect(scoped.changes).toEqual([c]);
    }
    expect(whole.changes.length).toBe(3);
  });
});
