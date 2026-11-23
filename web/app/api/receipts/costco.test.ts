// Costco receipts (DESIGN §4.8, PLAN M10.3): item numbers, warehouse prices, renames from online
// titles, the trip a warehouse receipt closes, and review answers that teach item numbers.
import {
  costcoTrip,
  item,
  product,
  receiptLine,
  reviewItem,
  systemTelemetry,
  vendorAlias,
} from "@pandabase/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReceiptIngestResponseT } from "@/lib/contracts/receipts";
import { DEFAULT_CONFIG } from "@/lib/config";
import { answerReceiptReview } from "@/lib/services/reviews";
import { ALEX, setup, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";

let h: Harness;
beforeEach(async () => {
  h = await setup(); // seed "now": Tue 2026-10-20, 9am Los Angeles
});
afterEach(() => h.close());

type Body = Record<string, unknown> & { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const ingest = (body: Record<string, unknown>) =>
  h.call<ReceiptIngestResponseT>(HANDLERS.receiptsIngest.POST, "/api/receipts/ingest", {
    body: { actor_discord_id: ALEX, source: "digital", vendor: "costco", account: ALEX, ...body },
  });
const plan = (plannedFor: string) =>
  h.call<Body>(HANDLERS.costcoTripPlan.POST, "/api/costco/trip", {
    body: { planned_for: plannedFor },
  });
const telemetry = async (metric: string) =>
  (await h.db.select().from(systemTelemetry).where(eq(systemTelemetry.metricType, metric))).map(
    (t) => t.payload as Body,
  );
const costcoProduct = async (sku: string) =>
  (
    await h.db
      .select()
      .from(product)
      .where(and(eq(product.vendor, "costco"), eq(product.vendorSku, sku)))
  )[0];

/** The synthetic warehouse receipt of `agent/tools/tests/fixtures/costco` (Sat Oct 24 here). */
const warehouse = (o: Record<string, unknown> = {}) => ({
  external_order_id: "21099920100422610241815",
  fulfillment: "in_store",
  acquired_at: "2026-10-25T01:15:00Z", // Sat Oct 24, 6:15pm Los Angeles
  subtotal_cents: 6787,
  tax_cents: 222,
  total_cents: 7009,
  lines: [
    {
      raw_text: "KS ORG EGGS",
      vendor_sku: "9000101",
      qty: 1,
      unit_price_cents: 949,
      line_total_cents: 949,
    },
    {
      raw_text: "BANANAS",
      vendor_sku: "9000102",
      qty: 1,
      unit_price_cents: 199,
      line_total_cents: 199,
    },
    {
      raw_text: "KS ALMOND MLK",
      vendor_sku: "9000103",
      qty: 2,
      unit_price_cents: 699,
      line_total_cents: 1398,
    },
    {
      raw_text: "CHKN THIGHS",
      vendor_sku: "9000104",
      qty: 1,
      unit_price_cents: 1842,
      line_total_cents: 1842,
    },
    {
      raw_text: "KS BATH TISS",
      vendor_sku: "9000201",
      qty: 1,
      unit_price_cents: 2399,
      line_total_cents: 2399,
    },
  ],
  ...o,
});

describe("Costco warehouse receipts", () => {
  it("resolve by item number, create unverified items for new ones, and keep warehouse prices", async () => {
    const res = await ingest(warehouse());
    expect(res.status).toBe(200);
    expect(res.body.totals_check).toBe("pass");
    const eggs = await h.itemId("Eggs");
    const byText = Object.fromEntries(res.body.lines.map((l) => [l.raw_text, l]));
    // Item numbers the seed's Costco products carry.
    expect(byText["KS ORG EGGS"]).toMatchObject({ item_id: eggs, match_method: "asin" });
    expect(byText["KS BATH TISS"]!.item_id).toBe(await h.itemId("Toilet Paper"));
    // A new item number on an existing item ("Bananas" fuzzy) waits for review, no product yet.
    expect(byText["BANANAS"]).toMatchObject({ match_method: "fuzzy", trust: "unverified" });
    expect(await costcoProduct("9000102")).toBeUndefined();
    // Unknown → new unverified item + Costco product named without the store brand.
    const almond = await costcoProduct("9000103");
    expect(almond).toMatchObject({
      title: "KS ALMOND MLK",
      lastPriceCents: 699,
      lastPriceFulfillment: "in_store",
    });
    const [almondItem] = await h.db.select().from(item).where(eq(item.id, almond!.itemId));
    expect(almondItem).toMatchObject({ canonicalName: "Almond MLK", trust: "unverified" });
    // The seed's stats are synthetic (no receipt behind its `times_bought` 1): ingest rebuilds the
    // product from its receipts (§4.10, PLAN M11.2), and this is the only one.
    expect(await costcoProduct("9000101")).toMatchObject({ lastPriceCents: 949, timesBought: 1 });
    // The item number is kept on the line.
    const lines = await h.db.select().from(receiptLine).where(eq(receiptLine.vendorSku, "9000103"));
    expect(lines).toHaveLength(1);

    // Re-ingesting the same barcode is a duplicate.
    const again = await ingest(warehouse());
    expect(again.body).toMatchObject({ duplicate: true, receipt_id: res.body.receipt_id });
  });

  it("an online order of the same item number keeps the warehouse price and renames the item", async () => {
    await ingest(warehouse());
    const title = "Kirkland Signature Almond Milk, Unsweetened, 32 fl oz, 6-count";
    const res = await ingest({
      external_order_id: "1000000001",
      fulfillment: "delivery",
      acquired_at: "2026-10-27T19:00:00Z",
      subtotal_cents: 1599,
      tax_cents: 0,
      total_cents: 1599,
      lines: [
        {
          raw_text: title,
          title,
          vendor_sku: "9000103",
          qty: 1,
          unit_price_cents: 1599,
          line_total_cents: 1599,
        },
      ],
    });
    expect(res.status).toBe(200);
    const almond = await costcoProduct("9000103");
    expect(almond).toMatchObject({
      title,
      lastPriceCents: 699,
      lastPriceFulfillment: "in_store",
      timesBought: 2,
    });
    const [it] = await h.db.select().from(item).where(eq(item.id, almond!.itemId));
    expect(it!.canonicalName).toBe("Almond Milk");
    expect(await telemetry("costco_item_renamed")).toEqual([
      expect.objectContaining({ itemId: almond!.itemId, changed: true }),
    ]);
  });

  it("a subtotal + tax that doesn't make the total fails the totals check", async () => {
    const res = await ingest(warehouse({ total_cents: 7100 }));
    expect(res.body.totals_check).toBe("fail");
  });

  it("closes the planned trip it belongs to and links it; a later receipt links nothing", async () => {
    const trip = (await plan("2026-10-24")).body.trip;
    h.setNow("2026-10-25T16:00:00.000Z"); // the next morning's sweep
    const res = await ingest(warehouse());
    expect(res.body.costco_trip_id).toBe(trip.id);
    const [row] = await h.db.select().from(costcoTrip).where(eq(costcoTrip.id, trip.id));
    expect(row).toMatchObject({
      status: "done",
      closeReason: "receipt",
      receiptId: res.body.receipt_id,
    });
    expect(await telemetry("costco_trip_receipt")).toEqual([
      expect.objectContaining({ tripId: trip.id, closedTrip: true, lines: 5, bought: 5 }),
    ]);
    expect(await telemetry("costco_trip")).toEqual([
      expect.objectContaining({ tripId: trip.id, outcome: "done", receiptId: res.body.receipt_id }),
    ]);
    const other = await ingest(
      warehouse({
        external_order_id: "21099920100422610251015",
        acquired_at: "2026-10-25T17:15:00Z",
      }),
    );
    expect(other.body.costco_trip_id).toBeNull();
  });

  it('links a trip already closed by "back from Costco"; online orders never link', async () => {
    const trip = (await plan("2026-10-20")).body.trip;
    const closed = await h.call<Body>(
      HANDLERS.costcoTripStatus.POST,
      `/api/costco/trip/${trip.id}/status`,
      {
        params: { id: trip.id },
        body: { status: "done", actor_discord_id: ALEX },
      },
    );
    expect(closed.status).toBe(200);
    const online = await ingest({
      external_order_id: "1000000009",
      fulfillment: "delivery",
      acquired_at: "2026-10-21T19:00:00Z",
      lines: [{ raw_text: "Bath Tissue", title: "Bath Tissue", vendor_sku: "9000201", qty: 1 }],
    });
    expect(online.body.costco_trip_id).toBeNull();
    const res = await ingest(warehouse({ acquired_at: "2026-10-21T01:15:00Z" })); // Oct 20 local
    expect(res.body.costco_trip_id).toBe(trip.id);
    const [row] = await h.db.select().from(costcoTrip).where(eq(costcoTrip.id, trip.id));
    expect(row).toMatchObject({
      status: "done",
      closeReason: "back_from_costco",
      receiptId: res.body.receipt_id,
    });
  });

  it("confirming a fuzzy Costco line teaches its item number; the next receipt resolves by it", async () => {
    const res = await ingest(warehouse());
    const banana = res.body.lines.find((l) => l.raw_text === "BANANAS")!;
    const [review] = await h.db
      .select()
      .from(reviewItem)
      .where(and(eq(reviewItem.receiptId, res.body.receipt_id), eq(reviewItem.kind, "receipt")));
    const ctx = {
      now: h.now(),
      config: DEFAULT_CONFIG,
      actor: { memberId: await h.memberId(ALEX), system: null },
    };
    await answerReceiptReview(h.db, review!.id, [{ lineId: banana.id, answer: "keep" }], ctx);
    const [alias] = await h.db
      .select()
      .from(vendorAlias)
      .where(and(eq(vendorAlias.kind, "item_number"), eq(vendorAlias.vendorString, "9000102")));
    expect(alias).toMatchObject({ vendor: "costco", itemId: banana.item_id, confidenceScore: 1 });

    const next = await ingest(
      warehouse({
        external_order_id: "21099920100422611071815",
        acquired_at: "2026-11-08T02:15:00Z",
        subtotal_cents: 199,
        tax_cents: 0,
        total_cents: 199,
        lines: [
          {
            raw_text: "BANANAS",
            vendor_sku: "9000102",
            qty: 1,
            unit_price_cents: 189,
            line_total_cents: 199,
          },
        ],
      }),
    );
    expect(next.body.lines[0]).toMatchObject({
      item_id: banana.item_id,
      match_method: "asin",
      trust: "confirmed",
    });
    // The alias named no product: the item number joined the item as its Costco product.
    expect(await costcoProduct("9000102")).toMatchObject({
      itemId: banana.item_id,
      lastPriceCents: 189,
    });
  });
});
