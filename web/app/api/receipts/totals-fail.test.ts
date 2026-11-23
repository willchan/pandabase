// Digital receipts whose totals check fails (DESIGN §4.5, §10 #90): applied as read, and a later
// read of the order that differs replaces it. Held receipts (#78/#79, §10 #83) are retired: since
// M11.2 a re-read corrects an applied misread, so holding one only lost the purchase for up to two
// weeks (the cart re-bought the item, the cycle didn't close).
//
// Regression (PLAN M11.2 Notes, 2026-11-23): a failing order was held — not applied — until a
// re-read added up or 14 days passed; prod still had two Whole Foods holds from 2026-11-18/20.
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
import type { ReceiptIngestResponseT } from "@/lib/contracts/receipts";
import { resolveMemberRef } from "@/lib/repo/members";
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
const costcoReceipts = () => h.db.select().from(receipt).where(eq(receipt.vendor, "costco"));

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

/**
 * A hold as #78 stored it before ingest stopped holding: the order's `ReceiptInput` (what the
 * ingest route builds from the request), unapplied, expiring 14 days after it was held.
 */
async function legacyHold(w: ReturnType<typeof warehouse>, heldAt = h.now()) {
  const account = (await resolveMemberRef(h.db, ALEX)).id;
  const id = "01KLEGACYHOLD0000000000000";
  await h.db.insert(receiptHold).values({
    id,
    dedupeKey: `digital:${account}:${w.external_order_id}`,
    source: "digital",
    vendor: "costco",
    accountMemberId: account,
    externalOrderId: w.external_order_id,
    acquiredAt: w.acquired_at,
    input: {
      source: "digital",
      vendor: "costco",
      accountMemberId: account,
      externalOrderId: w.external_order_id,
      fulfillment: w.fulfillment,
      orderedAt: null,
      acquiredAt: "2026-10-25T01:15:00.000Z",
      subtotalCents: w.subtotal_cents,
      totalCents: w.total_cents,
      taxCents: w.tax_cents,
      lines: w.lines.map((l) => ({
        rawText: l.raw_text,
        asin: null,
        vendorSku: l.vendor_sku,
        title: null,
        qty: l.qty,
        unitPriceCents: l.unit_price_cents,
        lineTotalCents: l.line_total_cents,
        itemId: null,
        productId: null,
      })),
    },
    attempts: 2,
    status: "held",
    expiresAt: new Date(Date.parse(heldAt) + 14 * 86_400_000).toISOString(),
    createdAt: heldAt,
    updatedAt: heldAt,
  });
  return id;
}

describe("digital receipts whose totals check fails", () => {
  // Regression (§10 #90): this order used to be held — no receipt, no events, no trip link.
  it("is applied as read, not held, and a fixed re-read replaces it", async () => {
    const eventsBefore = await digitalEvents();
    const trip = (
      await h.call<Body>(HANDLERS.costcoTripPlan.POST, "/api/costco/trip", {
        body: { planned_for: "2026-10-24" },
      })
    ).body.trip;
    h.setNow("2026-10-25T16:00:00.000Z"); // the next morning's sweep

    const res = await ingest(UNAPPLIED_SAVING);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "applied", totals_check: "fail", duplicate: false });
    expect(res.body.held_until).toBeUndefined();
    expect(res.body.lines).toHaveLength(5);
    expect(res.body.costco_trip_id).toBe(trip.id);
    const [r] = await costcoReceipts();
    expect(r).toMatchObject({ id: res.body.receipt_id, totalsCheck: "fail" });
    expect(await digitalEvents()).toBeGreaterThan(eventsBefore);
    expect(await costcoProduct("9000103")).toMatchObject({ lastPriceCents: 699 }); // as read
    const [t] = await h.db.select().from(costcoTrip).where(eq(costcoTrip.id, trip.id));
    expect(t).toMatchObject({ receiptId: r!.id });
    expect(await holds()).toEqual([]);
    expect(await telemetry("receipt_held")).toEqual([]);

    // The same read again (an unchanged parser): a duplicate, nothing changes.
    expect((await ingest(UNAPPLIED_SAVING)).body).toMatchObject({
      duplicate: true,
      receipt_id: r!.id,
      totals_check: "fail",
    });

    // A fixed parser re-reads it: the receipt is replaced in place (PLAN M11.2), only the almond
    // line changes, its price is corrected, and the trip link stays.
    const fixed = await ingest(FIXED);
    expect(fixed.body).toMatchObject({
      duplicate: false,
      replaced: true,
      receipt_id: r!.id,
      status: "applied",
      totals_check: "pass",
    });
    expect(await costcoProduct("9000103")).toMatchObject({ lastPriceCents: 549 });
    expect(await costcoReceipts()).toEqual([expect.objectContaining({ totalsCheck: "pass" })]);
    expect(await telemetry("receipt_replaced")).toEqual([
      expect.objectContaining({ outcome: "replaced", linesKept: 4, linesNew: 1, linesRemoved: 1 }),
    ]);
    // A worse read can no longer replace it.
    expect((await ingest(UNAPPLIED_SAVING)).body).toMatchObject({ duplicate: true });
    expect(await costcoProduct("9000103")).toMatchObject({ lastPriceCents: 549 });
  });

  it("applies for every store (a Whole Foods order too)", async () => {
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
    expect((await ingest(FIXED)).body).toMatchObject({ status: "applied", totals_check: "pass" });
    const noTotals = { ...FIXED, external_order_id: "1000000009", subtotal_cents: undefined };
    expect((await ingest(noTotals)).body).toMatchObject({ totals_check: "n/a" });
    expect(await holds()).toEqual([]);
  });
});

// Holds left on production from before #90 (2 Whole Foods holds, 2026-11-18/20): the daily cron
// releases them — applied as read, whatever their expiry — and a re-read resolves one too.
describe("legacy holds", () => {
  it("the daily cron applies a hold left from before #90 as read, before its expiry", async () => {
    const id = await legacyHold(UNAPPLIED_SAVING);
    h.advance(3600_000); // well before expires_at
    expect((await cron()).body.applied_held_receipts).toBe(1);
    const [r] = await costcoReceipts();
    expect(r).toMatchObject({ totalsCheck: "fail" });
    expect((await holds())[0]).toMatchObject({ id, status: "expired", receiptId: r!.id });
    expect(await costcoProduct("9000103")).toMatchObject({ lastPriceCents: 699 });
    expect(await telemetry("receipt_hold_released")).toEqual([
      expect.objectContaining({ holdId: id, receiptId: r!.id, outcome: "released", attempts: 2 }),
    ]);
    // Re-runs change nothing; a fixed read replaces the released receipt like any other.
    expect((await cron()).body.applied_held_receipts).toBe(0);
    expect((await ingest(FIXED)).body).toMatchObject({ replaced: true, receipt_id: r!.id });
    expect(await costcoProduct("9000103")).toMatchObject({ lastPriceCents: 549 });
  });

  it("a sweep's re-read of a held order applies it and resolves the hold", async () => {
    const id = await legacyHold(UNAPPLIED_SAVING);
    const res = await ingest(UNAPPLIED_SAVING); // still the old misread: applied as read now
    expect(res.body).toMatchObject({ status: "applied", totals_check: "fail", duplicate: false });
    expect((await holds())[0]).toMatchObject({
      id,
      status: "applied",
      receiptId: res.body.receipt_id,
      attempts: 3,
    });
    expect(await telemetry("receipt_hold_released")).toEqual([
      expect.objectContaining({ holdId: id, outcome: "totals_fail" }),
    ]);
    expect((await cron()).body.applied_held_receipts).toBe(0);
  });
});
