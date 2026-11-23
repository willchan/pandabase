// Held digital receipts (DESIGN §4.5 "Held receipts"): a digital receipt whose totals check fails
// is stored but not applied, until a later ingest of the same order adds up (a fixed parser
// re-reading it) or the hold expires.
//
// Regression (Nov 2026, first Costco sweep): the two receipts whose totals check failed — one with
// an instant saving the parser didn't take off its line, one a misread online order — were applied
// anyway. Ingest dedupes on the order id and applying changes shared items (buy streaks, product
// stances, usage rates), so the wrong lines couldn't be corrected without resetting every store's
// import.
import {
  costcoTrip,
  inventoryEvent,
  product,
  receipt,
  receiptHold,
  systemTelemetry,
} from "@pandabase/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@/lib/config";
import type { ReceiptIngestResponseT } from "@/lib/contracts/receipts";
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
const cron = () =>
  h.call<Body>(HANDLERS.cronMaintenance.GET, "/api/cron/maintenance", { auth: "cron" });
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
const digitalEvents = async () =>
  (await h.db.select().from(inventoryEvent).where(eq(inventoryEvent.source, "digital_receipt")))
    .length;
const holds = () => h.db.select().from(receiptHold);

const BARCODE = "21099920100422610241815";
const line = (raw: string, sku: string, qty: number, unit: number, total = unit * qty) => ({
  raw_text: raw,
  vendor_sku: sku,
  qty,
  unit_price_cents: unit,
  line_total_cents: total,
});
/**
 * The synthetic warehouse receipt of `agent/tools/tests/fixtures/costco` with a $3.00 instant
 * saving on the almond milk: SUBTOTAL already has it off (6487), so a parser that leaves it on
 * the line (1398 instead of 1098) sends lines that add up to 6787.
 */
const warehouse = (almondTotal: number) => ({
  external_order_id: BARCODE,
  fulfillment: "in_store",
  acquired_at: "2026-10-25T01:15:00Z", // Sat Oct 24, 6:15pm Los Angeles
  subtotal_cents: 6487,
  tax_cents: 222,
  total_cents: 6709,
  lines: [
    line("KS ORG EGGS", "9000101", 1, 949),
    line("BANANAS", "9000102", 1, 199),
    line("KS ALMOND MLK", "9000103", 2, almondTotal / 2, almondTotal),
    line("CHKN THIGHS", "9000104", 1, 1842),
    line("KS BATH TISS", "9000201", 1, 2399),
  ],
});
const UNAPPLIED_SAVING = warehouse(1398);
const FIXED = warehouse(1098);

describe("held digital receipts", () => {
  it("a receipt whose lines don't add up (unapplied instant saving) is held: nothing applied", async () => {
    const eggsBefore = await costcoProduct("9000101");
    const eventsBefore = await digitalEvents();
    const trip = (
      await h.call<Body>(HANDLERS.costcoTripPlan.POST, "/api/costco/trip", {
        body: { planned_for: "2026-10-24" },
      })
    ).body.trip;
    h.setNow("2026-10-25T16:00:00.000Z"); // the next morning's sweep

    const res = await ingest(UNAPPLIED_SAVING);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "held",
      totals_check: "fail",
      duplicate: false,
      lines: [],
      new_item_ids: [],
      review_ids: [],
      closed_cycle_id: null,
      costco_trip_id: null,
    });
    // No receipt, events, items, product stats or trip link.
    expect(await h.db.select().from(receipt).where(eq(receipt.vendor, "costco"))).toEqual([]);
    expect(await digitalEvents()).toBe(eventsBefore);
    expect(await costcoProduct("9000103")).toBeUndefined();
    expect(await costcoProduct("9000101")).toEqual(eggsBefore);
    const [t] = await h.db.select().from(costcoTrip).where(eq(costcoTrip.id, trip.id));
    expect(t).toMatchObject({ status: "planned", receiptId: null });
    // Stored as a hold.
    const [hold] = await holds();
    expect(hold).toMatchObject({
      id: res.body.receipt_id,
      status: "held",
      vendor: "costco",
      externalOrderId: BARCODE,
      attempts: 1,
      receiptId: null,
    });
    expect(res.body.held_until).toBe(hold!.expiresAt);
    expect(await telemetry("receipt_held")).toEqual([
      expect.objectContaining({ holdId: hold!.id, vendor: "costco", attempt: 1, lines: 5 }),
    ]);

    // The same held order again (an unchanged parser): still held, nothing applied.
    const again = await ingest(UNAPPLIED_SAVING);
    expect(again.body).toMatchObject({ status: "held", receipt_id: hold!.id });
    expect(await digitalEvents()).toBe(eventsBefore);
    expect((await holds())[0]).toMatchObject({ attempts: 2, status: "held" });

    // A fixed parser re-reads it: the lines add up, the receipt applies and links the trip.
    const fixed = await ingest(FIXED);
    expect(fixed.body).toMatchObject({ status: "applied", totals_check: "pass", duplicate: false });
    expect(fixed.body.costco_trip_id).toBe(trip.id);
    expect(await costcoProduct("9000103")).toMatchObject({ lastPriceCents: 549 });
    expect(await digitalEvents()).toBeGreaterThan(eventsBefore);
    expect((await holds())[0]).toMatchObject({
      status: "applied",
      receiptId: fixed.body.receipt_id,
      attempts: 3,
    });
    expect(await telemetry("receipt_hold_released")).toEqual([
      expect.objectContaining({
        holdId: hold!.id,
        receiptId: fixed.body.receipt_id,
        outcome: "totals_pass",
        attempts: 3,
      }),
    ]);
    // From now on it's an ordinary duplicate.
    expect((await ingest(FIXED)).body).toMatchObject({
      duplicate: true,
      receipt_id: fixed.body.receipt_id,
    });
  });

  it("a re-ingest that still fails replaces the held lines", async () => {
    await ingest(UNAPPLIED_SAVING);
    const still = warehouse(1298); // a different wrong reading
    await ingest(still);
    const [hold] = await holds();
    expect(hold!.attempts).toBe(2);
    expect((hold!.input as Body).lines[2]).toMatchObject({ lineTotalCents: 1298 });
    expect(await telemetry("receipt_held")).toEqual([
      expect.objectContaining({ attempt: 1, replaced: false }),
      expect.objectContaining({ attempt: 2, replaced: true }),
    ]);
  });

  it("an unfixed hold is applied as-is when it expires (default outcome)", async () => {
    const res = await ingest(UNAPPLIED_SAVING);
    const days = DEFAULT_CONFIG.receipts.heldExpireDays;
    h.setNow(new Date(Date.parse(h.now()) + (days * 24 - 1) * 3600_000).toISOString());
    expect((await cron()).body.applied_held_receipts).toBe(0);
    expect(await h.db.select().from(receipt).where(eq(receipt.vendor, "costco"))).toEqual([]);

    h.advance(2 * 3600_000);
    expect((await cron()).body.applied_held_receipts).toBe(1);
    const [r] = await h.db.select().from(receipt).where(eq(receipt.vendor, "costco"));
    expect(r).toMatchObject({ totalsCheck: "fail" });
    const [hold] = await holds();
    expect(hold).toMatchObject({ id: res.body.receipt_id, status: "expired", receiptId: r!.id });
    expect(await costcoProduct("9000103")).toMatchObject({ lastPriceCents: 699 });
    expect(await telemetry("receipt_hold_released")).toEqual([
      expect.objectContaining({ holdId: hold!.id, outcome: "expired", attempts: 1 }),
    ]);
    // Re-runs change nothing; the same read again is a duplicate.
    expect((await cron()).body.applied_held_receipts).toBe(0);
    expect((await ingest(UNAPPLIED_SAVING)).body).toMatchObject({
      duplicate: true,
      receipt_id: r!.id,
    });
    // A fixed parser's read after the expiry replaces it (PLAN M11.2): only the almond line
    // changes, the price is corrected, and a worse read can no longer replace it.
    const fixed = await ingest(FIXED);
    expect(fixed.body).toMatchObject({
      duplicate: false,
      replaced: true,
      receipt_id: r!.id,
      totals_check: "pass",
    });
    expect(await costcoProduct("9000103")).toMatchObject({ lastPriceCents: 549 });
    expect(await telemetry("receipt_replaced")).toEqual([
      expect.objectContaining({ outcome: "replaced", linesKept: 4, linesNew: 1, linesRemoved: 1 }),
    ]);
    expect((await ingest(UNAPPLIED_SAVING)).body).toMatchObject({ duplicate: true });
  });

  // Regression (prod copy, 2026-11-17): 33 of 35 checked Whole Foods orders and 11 of 163 Amazon
  // ones fail the totals check (the parser misread Whole Foods' item grid: per-lb prices, bare
  // quantities, unsupplied units), and #78 held them all, the weekly cart's order included.
  it("a Whole Foods order whose lines don't add up applies at once (not held)", async () => {
    const res = await ingest({
      vendor: "wholefoods",
      external_order_id: "112-0000002-0000099",
      fulfillment: "pickup",
      acquired_at: "2026-10-17T19:00:00Z",
      subtotal_cents: 512, // the bananas weighed a little more than listed
      lines: [{ raw_text: "Organic Bananas", asin: "B0SYNTHWF1", qty: 6, line_total_cents: 474 }],
    });
    expect(res.body).toMatchObject({ status: "applied", totals_check: "fail" });
    expect(await holds()).toEqual([]);
  });

  it("a passing or unchecked digital receipt applies at once, as before", async () => {
    expect((await ingest(FIXED)).body.status).toBe("applied");
    const noTotals = { ...FIXED, external_order_id: "1000000009", subtotal_cents: undefined };
    expect((await ingest(noTotals)).body).toMatchObject({ totals_check: "n/a" });
    expect(await holds()).toEqual([]);
  });
});
