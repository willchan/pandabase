// PLAN M11.1: `db:rebuild-learning` against receipts written by the real ingest path (in-memory
// libSQL). Receipts that arrive in order rebuild to exactly what ingest wrote; a late receipt is
// the difference the rebuild exists for.
import {
  groceryCycle,
  item,
  preferenceEvent,
  product,
  systemTelemetry,
} from "@pandabase/db";
import {
  applyLearningRebuild,
  formatLearningPlan,
  planLearningRebuild,
} from "@pandabase/db/rebuild-learning";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@/lib/config";
import { setup, type Harness } from "@/test/harness";
import { rejectProductById } from "./inventory";
import { ingestReceipt } from "./receipts";
import type { ServiceCtx } from "./types";

let h: Harness;

beforeEach(async () => {
  h = await setup({ seed: false });
});
afterEach(() => h.close());

const DAY = 86_400_000;
/** Noon Los Angeles on Aug 1 2026, plus `d` days. */
const day = (d: number) => new Date(Date.parse("2026-08-01T19:00:00.000Z") + d * DAY).toISOString();
/** Ingest time: an hour after the acquisition, as a daily sweep reads it. */
const hourAfter = (at: string) => new Date(Date.parse(at) + 3_600_000).toISOString();

const ctx = (now: string): ServiceCtx => ({
  now,
  config: DEFAULT_CONFIG,
  actor: { memberId: null, system: "agent" },
});

let order = 0;
async function buy(
  at: string,
  lines: { asin?: string; sku?: string; title: string; qty?: number; cents?: number }[],
  o: { vendor?: string; fulfillment?: "delivery" | "in_store"; orderId?: string; now?: string } = {},
) {
  return ingestReceipt(
    h.db,
    {
      source: "digital",
      vendor: o.vendor ?? "amazon",
      accountMemberId: null,
      externalOrderId: o.orderId ?? `ORDER-${++order}`,
      fulfillment: o.fulfillment ?? "delivery",
      orderedAt: null,
      acquiredAt: at,
      subtotalCents: null,
      totalCents: null,
      lines: lines.map((l) => ({
        rawText: l.title,
        asin: l.asin ?? null,
        vendorSku: l.sku ?? null,
        title: l.title,
        qty: l.qty ?? 1,
        unitPriceCents: l.cents ?? 500,
        lineTotalCents: (l.cents ?? 500) * (l.qty ?? 1),
      })),
    },
    ctx(o.now ?? hourAfter(at)),
  );
}

const COFFEE = { asin: "B0SYNTHCOF1", title: "Synthetic Coffee Beans, 12 oz" };
const COFFEE_2 = { asin: "B0SYNTHCOF2", title: "Synthetic Coffee Beans Decaf, 12 oz" };
const RICE = { asin: "B0SYNTHRIC1", title: "Synthetic Jasmine Rice, 5 lb" };

const plan = () => planLearningRebuild(h.db, { config: DEFAULT_CONFIG });
const nothingChanges = (p: Awaited<ReturnType<typeof plan>>) => {
  expect(p.changes).toEqual([]);
  expect(p.itemsChanged + p.productsChanged + p.events.items).toBe(0);
};

describe("db:rebuild-learning over ingested receipts (PLAN M11.1)", () => {
  it("rebuilds in-order receipts to exactly what ingest wrote", async () => {
    // Coffee: promoted to velocity on the 2nd buy, auto-promoted on the 3rd in a row, an
    // outlier, a same-day second order, a streak broken by the other product.
    await buy(day(0), [COFFEE, RICE]);
    await buy(day(10), [{ ...COFFEE, qty: 2 }]);
    await buy(day(20), [COFFEE]);
    await buy(day(20), [{ ...COFFEE, cents: 450 }]);
    const r = await buy(day(30), [COFFEE, RICE]);
    const coffeeItem = r.lines[0]!.item_id!;
    await buy(day(40), [{ ...COFFEE_2, title: "Synthetic Coffee Beans Decaf, 12 oz" }]);
    await buy(day(150), [COFFEE]); // a long gap: high outlier
    await buy(day(160), [COFFEE]);

    const [coffee] = await h.db.select().from(item).where(eq(item.id, coffeeItem));
    expect(coffee).toMatchObject({ trackingType: "velocity" });
    expect(coffee!.currentEmaDays).not.toBeNull();
    const promotes = await h.db
      .select()
      .from(preferenceEvent)
      .where(eq(preferenceEvent.kind, "auto_promote"));
    expect(promotes.length).toBeGreaterThan(0);

    const p = await plan();
    expect(p.items).toBeGreaterThanOrEqual(2);
    nothingChanges(p);
    expect(p.outcomes.initialized).toBeGreaterThan(0);
  });

  it("keeps the Costco warehouse price over a delivery one, as ingest does (§4.8)", async () => {
    const MILK = { sku: "1234567", title: "SYNTH ORG MILK 3PK" };
    await buy(day(0), [{ ...MILK, cents: 1199 }], { vendor: "costco", fulfillment: "in_store" });
    await buy(day(7), [{ ...MILK, cents: 1499 }], { vendor: "costco", fulfillment: "delivery" });
    await buy(day(14), [{ ...MILK, cents: 1249 }], { vendor: "costco", fulfillment: "in_store" });
    const [p] = await h.db.select().from(product).where(eq(product.vendorSku, MILK.sku));
    expect(p).toMatchObject({ lastPriceCents: 1249, lastPriceFulfillment: "in_store" });
    nothingChanges(await plan());
  });

  it("replays a rejection (a human event) in its place in the history", async () => {
    await buy(day(0), [COFFEE]);
    const r = await buy(day(10), [COFFEE]);
    await rejectProductById(h.db, r.lines[0]!.product_id!, ctx(day(15)));
    await buy(day(20), [COFFEE]);
    await buy(day(30), [COFFEE]); // 4 in a row, but rejected: never auto-promoted
    const [p] = await h.db.select().from(product).where(eq(product.id, r.lines[0]!.product_id!));
    expect(p!.stance).toBe("rejected");
    const out = await plan();
    nothingChanges(out);
  });

  it("regenerates an implicit swap against the cart built before the order was ingested", async () => {
    const first = await buy(day(0), [COFFEE]);
    const itemId = first.lines[0]!.item_id!;
    // A second product of the coffee item (as a merge or a new-product answer would leave it).
    const cartProduct = first.lines[0]!.product_id!;
    const [other] = await h.db
      .insert(product)
      .values({
        id: ulid(),
        createdAt: day(1),
        updatedAt: day(1),
        itemId,
        vendor: "amazon",
        asin: "B0SYNTHCOF9",
        title: "Synthetic Coffee Beans Dark, 12 oz",
        unitQuantity: 1,
      })
      .returning();
    await h.db.insert(groceryCycle).values({
      id: ulid(),
      createdAt: day(2),
      updatedAt: day(2),
      weekLabel: "2026-W32",
      status: "ready",
      openedAt: day(2),
      builtAt: day(3),
      cartResult: {
        vendors: ["amazon"],
        order_ids: ["ORDER-SWAP"],
        lines: [{ item_id: itemId, product_id: cartProduct, quantity: 1, outcome: "tier1" }],
        please_check_item_ids: [],
        recorded_at: day(3),
      },
    });
    await buy(day(5), [{ asin: "B0SYNTHCOF9", title: other!.title }], { orderId: "ORDER-SWAP" });
    const swaps = await h.db
      .select()
      .from(preferenceEvent)
      .where(eq(preferenceEvent.kind, "implicit_swap"));
    expect(swaps).toHaveLength(1);
    nothingChanges(await plan());
  });

  // The bug M11 exists for (prod copy 2026-11-23: a Costco delivery receipt acquired before two
  // warehouse receipts but read after them): ingest skipped its EMA step and moved
  // `last_bought_at` back to the older date.
  it("puts a late receipt in its place: EMA step taken, last_bought_at not moved back", async () => {
    await buy(day(0), [COFFEE]);
    const r = await buy(day(10), [COFFEE]);
    await buy(day(30), [COFFEE]);
    // Late: acquired before the day-30 one, ingested after it.
    await buy(day(20), [COFFEE], { now: hourAfter(day(30)) });
    const productId = r.lines[0]!.product_id!;
    const [stored] = await h.db.select().from(product).where(eq(product.id, productId));
    expect(stored!.lastBoughtAt).toBe(day(20)); // ingest: moved back

    const p = await plan();
    expect(p.changes).toHaveLength(1);
    expect(p.causes).toMatchObject({ late_receipt: 1, unexplained: 0 });
    expect(p.itemColumns.currentEmaDays).toBe(1);
    expect(p.productColumns.lastBoughtAt).toBe(1);
    expect(p.changes[0]!.products[0]!.patch).toMatchObject({ lastBoughtAt: day(30) });
    expect(formatLearningPlan(p, false)).toContain("dry run");

    const now = day(31);
    await applyLearningRebuild(h.db, { config: DEFAULT_CONFIG, now });
    const [after] = await h.db.select().from(product).where(eq(product.id, productId));
    expect(after!.lastBoughtAt).toBe(day(30));
    nothingChanges(await plan()); // idempotent
    const [t] = await h.db
      .select()
      .from(systemTelemetry)
      .where(eq(systemTelemetry.metricType, "learning_rebuilt"));
    expect(t!.payload).toMatchObject({ scope: "all", itemsChanged: 1, productsChanged: 1 });
  });

  it("--items limits the rebuild to those items", async () => {
    const a = await buy(day(0), [COFFEE, RICE]);
    const p = await planLearningRebuild(h.db, {
      config: DEFAULT_CONFIG,
      items: [a.lines[0]!.item_id!],
    });
    expect(p.items).toBe(1);
  });
});
