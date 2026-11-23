// The import reset (DESIGN §4.5, `db/src/reset-imports.ts`) against rows written by the real ingest
// path: undoes a digital import, then the same orders — same deterministic `receipt:` Idempotency-
// Keys the scraper sends — ingest afresh instead of replaying the old replies.
//
// Regression (2026-11, W45): the W45 import tagged every order `wholefoods` and imported the
// footer's "Amazon Business Card" link on each; ingest dedupes on the order id, so a fixed parser
// could only take effect after a reset.
import {
  item,
  member,
  product,
  receipt,
  receiptHold,
  receiptLine,
  reviewItem,
} from "@pandabase/db";
import { applyImportReset, planImportReset } from "@pandabase/db/reset-imports";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReceiptIngestResponseT } from "@/lib/contracts";
import { ALEX, setup, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";

let h: Harness;
beforeEach(async () => {
  h = await setup({ seed: false });
  await h.db
    .insert(member)
    .values({ email: "alex@example.com", displayName: "Alex", discordUserId: ALEX });
});
afterEach(() => h.close());

const order = (id: string, vendor: string, lines: { raw_text: string; asin: string }[]) => ({
  actor_discord_id: ALEX,
  source: "digital",
  vendor,
  account: ALEX,
  external_order_id: id,
  fulfillment: vendor === "wholefoods" ? "pickup" : "delivery",
  acquired_at: "2026-10-20T15:59:00Z",
  lines: lines.map((l) => ({ ...l, title: l.raw_text, qty: 1, unit_price_cents: 100 })),
});
const ingest = (body: ReturnType<typeof order>) =>
  h.call<ReceiptIngestResponseT>(HANDLERS.receiptsIngest.POST, "/api/receipts/ingest", {
    body,
    headers: { "idempotency-key": `receipt:${ALEX}:${body.external_order_id}` },
  });

const card = { raw_text: "Amazon Business Card", asin: "B0CARD0001" };
const floss = { raw_text: "Mint Floss", asin: "B0FLOSS001" };
const bananas = { raw_text: "Organic Bananas", asin: "B0BANANA01" };

describe("reset-imports on ingested orders", () => {
  it("removes a bad import so the fixed import ingests afresh", async () => {
    // The buggy import: both orders tagged wholefoods, the footer card on each.
    expect((await ingest(order("111-1", "wholefoods", [card, floss]))).status).toBe(200);
    expect((await ingest(order("111-2", "wholefoods", [card, bananas]))).status).toBe(200);
    const plan = await planImportReset(h.db);
    expect(Object.values(plan.blockers).every((n) => n === 0)).toBe(true);
    expect(plan.counts).toMatchObject({ receipt: 2, receipt_line: 4, item: 3, product: 3 });
    expect(plan.counts.idempotency_key).toBe(2);
    expect(plan.info.linesByVendor).toEqual({ wholefoods: 4 });

    await applyImportReset(h.db);
    for (const table of [receipt, receiptLine, item, product, reviewItem]) {
      expect(await h.db.select().from(table)).toEqual([]);
    }

    // The fixed import: same orders and keys, right stores, no card.
    const a = await ingest(order("111-1", "amazon", [floss]));
    const b = await ingest(order("111-2", "wholefoods", [bananas]));
    expect([a.body.duplicate, b.body.duplicate]).toEqual([false, false]);
    const vendors = await h.db.select({ vendor: receipt.vendor }).from(receipt);
    expect(vendors.map((v) => v.vendor).sort()).toEqual(["amazon", "wholefoods"]);
    expect(await h.db.select().from(item).where(eq(item.canonicalName, card.raw_text))).toEqual([]);
  });

  // §10 #90: a failing order applies as read; a hold left from before #90 still goes with its
  // store's import (the table is dropped in a contract PR).
  it("resets one store's failing receipts and legacy holds, so they ingest afresh", async () => {
    const c1 = order("C-1", "costco", [floss]);
    const failing = {
      // the line says $1.00, the subtotal $9.99
      ...c1,
      subtotal_cents: 999,
      lines: c1.lines.map((l) => ({ ...l, line_total_cents: 100 })),
    };
    expect((await ingest(failing)).body).toMatchObject({ status: "applied", totals_check: "fail" });
    expect((await ingest(order("111-1", "amazon", [bananas]))).body.status).toBe("applied");
    const [alex] = await h.db.select().from(member);
    await h.db.insert(receiptHold).values({
      id: "01KLEGACYHOLD0000000000000",
      dedupeKey: `digital:${alex!.id}:C-2`,
      source: "digital",
      vendor: "costco",
      accountMemberId: alex!.id,
      externalOrderId: "C-2",
      acquiredAt: "2026-10-20T15:59:00.000Z",
      input: {},
      status: "held",
      expiresAt: "2026-11-03T15:59:00.000Z",
    });
    const plan = await planImportReset(h.db, { vendor: "costco" });
    expect(plan.counts).toMatchObject({ receipt: 1, receipt_hold: 1, idempotency_key: 1 });

    await applyImportReset(h.db, { vendor: "costco" });
    expect(await h.db.select().from(receiptHold)).toEqual([]);
    expect(await h.db.select().from(receipt)).toHaveLength(1); // Amazon's stays
    const again = await ingest(failing);
    expect(again.body).toMatchObject({ status: "applied", duplicate: false });
    expect(again.headers.get("idempotent-replayed")).toBeNull();
  });

  it("refuses once someone has answered a review about the import", async () => {
    await ingest(order("111-1", "wholefoods", [card]));
    const [r] = await h.db.select().from(reviewItem);
    expect(r).toBeDefined();
    await h.db.update(reviewItem).set({ status: "dismissed" }).where(eq(reviewItem.id, r!.id));
    await expect(applyImportReset(h.db)).rejects.toThrow(/answered_reviews=1/);
    expect(await h.db.select().from(receipt)).toHaveLength(1);
  });
});
