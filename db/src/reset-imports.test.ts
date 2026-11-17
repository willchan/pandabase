// `reset-imports`: undo the digital receipt import (DESIGN §4.5). Fixtures are synthetic.
//
// Regression (2026-11, W45): live order pages have no <main>, so the parser read Amazon's header
// and footer — every order was tagged `wholefoods` and the footer's "Amazon Business Card" link was
// imported on every order. Ingest dedupes on the order id, so the fixed parser (#38) can't correct
// rows already written; this reset removes them first, refusing if any human data is involved.
import { eq } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "./client";
import {
  applyImportReset,
  formatPlan,
  ImportResetBlocked,
  planImportReset,
  type Blocker,
} from "./reset-imports";
import * as t from "./schema/index";

// ULID-shaped ids (Crockford base32, 26 chars) so the label JSON scan sees them as ids.
const ID = (n: number) => `01JTEST${String(n).padStart(19, "0")}`;
const T1 = "2026-10-01T18:00:00.000Z"; // first import run
const T2 = "2026-10-02T18:00:00.000Z"; // second import run
const T0 = "2026-09-01T12:00:00.000Z"; // before the import

const will = ID(1);
const amz = ID(10); // receipt (T1): business card + floss
const wf = ID(11); // receipt (T2): bananas (+ floss again)
const paper = ID(12); // paper receipt: kept
const card = ID(20); // item: "Amazon Business Card" (created T1)
const floss = ID(21); // item (created T1)
const bananas = ID(22); // item (created T2)
const kept = ID(23); // item from a paper receipt (created T0)
const pCard = ID(30);
const pFloss = ID(31);
const pBananas = ID(32);
const pKept = ID(33);
const job = ID(40); // merge_suggest job
const paperJob = ID(41); // paper_receipt job: kept
const cycle = ID(50);

async function seedImport(db: Db) {
  const base = (id: string, at: string) => ({ id, createdAt: at, updatedAt: at });
  await db.insert(t.member).values({ ...base(will, T0), email: "w@example.com", displayName: "W" });
  await db.insert(t.setting).values({ key: "household", value: { tz: "America/Los_Angeles" } });
  await db
    .insert(t.awayPeriod)
    .values({ ...base(ID(2), T0), startsOn: "2026-12-20", endsOn: "2026-12-27" });
  await db.insert(t.systemTelemetry).values({ source: "agent", metricType: "sweep", payload: {} });
  await db.insert(t.groceryCycle).values({
    ...base(cycle, T0),
    weekLabel: "2026-W40",
    status: "closed",
    openedAt: T0,
    closeReason: "order_ingested",
  });

  const newItem = (id: string, at: string, name: string, location: "pantry" | "bathroom") => ({
    ...base(id, at),
    canonicalName: name,
    category: "misc",
    defaultLocation: location,
    trackingType: "velocity" as const,
    baseUnit: "each",
  });
  await db
    .insert(t.item)
    .values([
      newItem(card, T1, "Amazon Business Card", "pantry"),
      newItem(floss, T1, "Floss", "bathroom"),
      newItem(bananas, T2, "Bananas", "pantry"),
      newItem(kept, T0, "Rice", "pantry"),
    ]);
  const newProduct = (id: string, at: string, itemId: string, vendor: string) => ({
    ...base(id, at),
    itemId,
    vendor,
    asin: id.slice(-10),
    title: "x",
  });
  await db
    .insert(t.product)
    .values([
      newProduct(pCard, T1, card, "wholefoods"),
      newProduct(pFloss, T1, floss, "wholefoods"),
      newProduct(pBananas, T2, bananas, "wholefoods"),
      newProduct(pKept, T0, kept, "costco"),
    ]);

  const newReceipt = (id: string, at: string, source: "digital" | "paper", extra = {}) => ({
    ...base(id, at),
    source,
    vendor: "wholefoods",
    accountMemberId: will,
    dedupeKey: `${source}:${id}`,
    acquiredAt: at,
    status: "applied" as const,
    ...extra,
  });
  await db.insert(t.auditJob).values([
    { ...base(job, T2), jobType: "merge_suggest", status: "completed" },
    { ...base(paperJob, T0), jobType: "paper_receipt", status: "completed" },
  ]);
  await db
    .insert(t.receipt)
    .values([
      newReceipt(amz, T1, "digital", { externalOrderId: "111-1" }),
      newReceipt(wf, T2, "digital", { externalOrderId: "111-2" }),
      newReceipt(paper, T0, "paper", { vendor: "costco", jobId: paperJob }),
    ]);
  const line = (id: number, receiptId: string, at: string, itemId: string, productId: string) => ({
    ...base(ID(id), at),
    receiptId,
    rawText: "x",
    itemId,
    productId,
  });
  await db
    .insert(t.receiptLine)
    .values([
      line(60, amz, T1, card, pCard),
      line(61, amz, T1, floss, pFloss),
      line(62, wf, T2, bananas, pBananas),
      line(63, wf, T2, floss, pFloss),
      line(64, paper, T0, kept, pKept),
    ]);

  const event = (id: number, itemId: string, at: string, sourceRef: string, extra = {}) => ({
    ...base(ID(id), at),
    itemId,
    location: "pantry" as const,
    kind: "acquired" as const,
    quantity: 1,
    occurredAt: at,
    source: "digital_receipt" as const,
    sourceRef,
    actorMemberId: will, // ingest records the member the agent acted for
    actorSystem: "agent" as const,
    ...extra,
  });
  await db.insert(t.inventoryEvent).values([
    event(70, card, T1, amz),
    event(71, floss, T1, amz),
    event(72, bananas, T2, wf),
    event(73, floss, T2, wf),
    // The shelf-life cron acting on an imported item: part of the import's footprint.
    event(74, bananas, T2, wf, {
      kind: "presumed_discarded",
      source: "system",
      sourceRef: null,
      actorMemberId: null,
      actorSystem: "cron",
      trust: "provisional",
    }),
    event(75, kept, T0, paper, { source: "paper_receipt" }),
  ]);
  await db.insert(t.inventoryState).values(
    [card, floss, bananas, kept].map((itemId) => ({
      itemId,
      location: "pantry" as const,
      anchorQty: 1,
      anchorAt: T1,
      anchorKind: "acquired" as const,
    })),
  );

  const review = (id: number, kind: (typeof t.REVIEW_KINDS)[number], extra = {}) => ({
    ...base(ID(id), T2),
    kind,
    payload: {},
    defaultAction: { action: "keep" },
    expiresAt: "2026-12-01T00:00:00.000Z",
    ...extra,
  });
  await db.insert(t.reviewItem).values([
    review(80, "receipt", { receiptId: amz }),
    review(81, "new_product", { itemId: card, receiptId: amz }),
    review(82, "merge_suggestion", { itemId: floss, jobId: job }),
    review(83, "unverified_item", { itemId: bananas, expiresAt: null }),
    review(84, "receipt", { receiptId: wf, status: "expired" }), // no human answer
    review(85, "receipt", { receiptId: paper, jobId: paperJob }), // kept
  ]);
  await db.insert(t.vendorAlias).values({
    ...base(ID(90), T2),
    vendor: "wholefoods",
    kind: "asin",
    vendorString: "B0FLOSS",
    itemId: floss,
    productId: pFloss,
  });
  await db.insert(t.priceQuote).values({
    ...base(ID(91), T2),
    productId: pBananas,
    priceCents: 29,
    observedAt: T2,
  });
  await db.insert(t.preferenceEvent).values({
    ...base(ID(92), T2),
    itemId: bananas,
    kind: "switch",
    toProductId: pBananas,
  });
  await db.insert(t.idempotencyKey).values([
    {
      key: "receipt:100000000000000101:111-1",
      scope: "agent:POST /api/receipts/ingest",
      responseStatus: 200,
    },
    { key: "discord:42", scope: "agent:POST /api/receipts/ingest", responseStatus: 200 }, // manual: kept
    { key: "receipt:x", scope: "agent:POST /api/inventory/events", responseStatus: 200 }, // kept
  ]);
}

const count = async (db: Db, table: SQLiteTable) => (await db.select().from(table)).length;
const eqId = (table: { id: SQLiteColumn }, id: string) => eq(table.id, id);

describe("reset-imports", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await seedImport(db);
  });

  it("dry run counts the import and deletes nothing", async () => {
    const plan = await planImportReset(db);
    expect(plan.counts).toEqual({
      review_item: 5,
      audit_job: 1,
      price_quote: 1,
      preference_event: 1,
      vendor_alias: 1,
      inventory_state: 3,
      inventory_event: 5,
      receipt_line: 4,
      receipt: 2,
      product: 3,
      item: 3,
      idempotency_key: 1,
    });
    expect(Object.values(plan.blockers).every((n) => n === 0)).toBe(true);
    expect(plan.info.linesByVendor).toEqual({ wholefoods: 4 });
    expect(plan.info.reviewsByKind).toEqual({
      merge_suggestion: 1,
      new_product: 1,
      receipt: 2,
      unverified_item: 1,
    });
    expect(plan.info.cyclesClosedByImport).toBe(1);
    expect(await count(db, t.receipt)).toBe(3);
    expect(await count(db, t.item)).toBe(4);
    expect(formatPlan(plan, false)).toContain("OK to apply");
  });

  it("apply deletes exactly the import and keeps everything else", async () => {
    await applyImportReset(db);
    const ids = async (table: SQLiteTable & { id: SQLiteColumn }) =>
      (await db.select({ id: table.id }).from(table)).map((r) => String(r.id)).sort();
    expect(await ids(t.receipt)).toEqual([paper]);
    expect(await ids(t.receiptLine)).toEqual([ID(64)]);
    expect(await ids(t.item)).toEqual([kept]);
    expect(await ids(t.product)).toEqual([pKept]);
    expect(await ids(t.inventoryEvent)).toEqual([ID(75)]);
    expect(await ids(t.reviewItem)).toEqual([ID(85)]);
    expect(await ids(t.auditJob)).toEqual([paperJob]);
    for (const table of [t.vendorAlias, t.priceQuote, t.preferenceEvent]) {
      expect(await count(db, table)).toBe(0);
    }
    // Rebuilt from the remaining events: only the kept item.
    const states = await db.select().from(t.inventoryState);
    expect(states.map((s) => s.itemId)).toEqual([kept]);
    // A re-import within 24 h must not replay the old ingest replies.
    const keys = (await db.select().from(t.idempotencyKey)).map((k) => k.key).sort();
    expect(keys).toEqual(["discord:42", "receipt:x"]);
    // Kept: members, settings, away periods, cycles, telemetry.
    expect(await count(db, t.member)).toBe(1);
    expect(await count(db, t.setting)).toBe(1);
    expect(await count(db, t.awayPeriod)).toBe(1);
    expect(await count(db, t.groceryCycle)).toBe(1);
    expect(await count(db, t.systemTelemetry)).toBe(1);
    // Idempotent: a second run finds nothing.
    const again = await planImportReset(db);
    expect(Object.values(again.counts).every((n) => n === 0)).toBe(true);
  });

  const at = T2;
  const blockerCases: [Blocker, (db: Db) => Promise<unknown>][] = [
    [
      "answered_reviews",
      (db) =>
        db
          .update(t.reviewItem)
          .set({ status: "confirmed", reviewedByMemberId: will, reviewedAt: at })
          .where(eqId(t.reviewItem, ID(82))),
    ],
    [
      "answered_reviews", // dismissed counts as an answer
      (db) =>
        db
          .update(t.reviewItem)
          .set({ status: "dismissed" })
          .where(eqId(t.reviewItem, ID(80))),
    ],
    [
      "labeled_observations",
      (db) =>
        db.insert(t.labeledObservation).values({
          sourceKind: "trash_cam",
          humanLabel: { item_id: floss },
          memberId: will,
        }),
    ],
    [
      "human_inventory_events",
      (db) =>
        db.insert(t.inventoryEvent).values({
          itemId: bananas,
          location: "pantry",
          kind: "observed",
          quantity: 3,
          occurredAt: at,
          source: "checkin",
          actorMemberId: will,
        }),
    ],
    [
      "cycle_overrides",
      (db) =>
        db.insert(t.groceryCycleOverride).values({ cycleId: cycle, kind: "skip", itemId: floss }),
    ],
    [
      "human_preference_events",
      (db) =>
        db
          .insert(t.preferenceEvent)
          .values({ itemId: floss, kind: "reject", fromProductId: pFloss }),
    ],
    [
      "other_receipt_lines",
      (db) =>
        db.insert(t.receiptLine).values({ receiptId: paper, rawText: "floss", itemId: floss }),
    ],
    [
      "merges",
      (db) => db.update(t.item).set({ mergedIntoItemId: floss }).where(eqId(t.item, kept)),
    ],
    [
      "item_settings",
      (db) => db.update(t.item).set({ shelfLifeDays: 7 }).where(eqId(t.item, bananas)),
    ],
    [
      "items_predating_import", // a digital line matched an item made before the import
      (db) => db.insert(t.receiptLine).values({ receiptId: wf, rawText: "rice", itemId: kept }),
    ],
  ];

  it.each(blockerCases)("refuses on %s and deletes nothing", async (blocker, addHumanData) => {
    await addHumanData(db);
    const plan = await planImportReset(db);
    expect(plan.blockers[blocker]).toBeGreaterThan(0);
    expect(formatPlan(plan, false)).toContain("BLOCKED");
    await expect(applyImportReset(db)).rejects.toBeInstanceOf(ImportResetBlocked);
    expect(await count(db, t.receipt)).toBe(3);
    expect(await count(db, t.item)).toBe(4);
    expect(await count(db, t.reviewItem)).toBe(6);
  });

  it("ignores labels unrelated to the import", async () => {
    await db.insert(t.labeledObservation).values({
      sourceKind: "trash_cam",
      humanLabel: { item_id: kept },
      memberId: will,
    });
    expect((await planImportReset(db)).blockers.labeled_observations).toBe(0);
  });

  it("does nothing on a database with no import", async () => {
    const empty = await createTestDb();
    const plan = await applyImportReset(empty);
    expect(Object.values(plan.counts).every((n) => n === 0)).toBe(true);
  });
});

// `--vendor costco` (2026-11, M10.3): the first Costco sweep imported 6 receipts with a parser that
// left instant savings unapplied and misread one-item online orders (#76). Ingest dedupes on the
// order id, so they need a reset — but only Costco's, keeping the Amazon / Whole Foods import.
const costcoReceipt = ID(13); // digital Costco receipt (T2): paper towels
const towels = ID(24); // item (created T2 by the Costco receipt)
const pTowels = ID(34);
const trip = ID(51); // the Costco trip that receipt closed

async function seedCostco(db: Db) {
  const base = (id: string, at: string) => ({ id, createdAt: at, updatedAt: at });
  await db.insert(t.item).values({
    ...base(towels, T2),
    canonicalName: "Paper Towels",
    category: "household",
    defaultLocation: "pantry",
    trackingType: "velocity",
    baseUnit: "each",
  });
  await db.insert(t.product).values({
    ...base(pTowels, T2),
    itemId: towels,
    vendor: "costco",
    vendorSku: "1234567",
    title: "x",
  });
  await db.insert(t.receipt).values({
    ...base(costcoReceipt, T2),
    source: "digital",
    vendor: "costco",
    accountMemberId: will,
    externalOrderId: "C-1",
    dedupeKey: `digital:${costcoReceipt}`,
    acquiredAt: T2,
    status: "applied",
  });
  await db.insert(t.receiptLine).values({
    ...base(ID(65), T2),
    receiptId: costcoReceipt,
    rawText: "x",
    itemId: towels,
    productId: pTowels,
  });
  await db.insert(t.inventoryEvent).values({
    ...base(ID(76), T2),
    itemId: towels,
    location: "pantry",
    kind: "acquired",
    quantity: 1,
    occurredAt: T2,
    source: "digital_receipt",
    sourceRef: costcoReceipt,
    actorMemberId: will,
    actorSystem: "agent",
  });
  await db.insert(t.inventoryState).values({
    itemId: towels,
    location: "pantry",
    anchorQty: 1,
    anchorAt: T2,
    anchorKind: "acquired",
  });
  await db.insert(t.reviewItem).values([
    {
      ...base(ID(86), T2),
      kind: "receipt",
      receiptId: costcoReceipt,
      payload: {},
      defaultAction: { action: "keep" },
      expiresAt: "2026-12-01T00:00:00.000Z",
    },
    {
      // A merge suggestion whose *other* side is the Costco item: stale once it's gone.
      ...base(ID(87), T2),
      kind: "merge_suggestion",
      itemId: floss,
      jobId: job,
      payload: { merge_into_item_id: towels },
      defaultAction: { action: "keep" },
      expiresAt: "2026-12-01T00:00:00.000Z",
    },
  ]);
  await db.insert(t.costcoTrip).values({
    ...base(trip, T0),
    plannedFor: "2026-10-02",
    status: "done",
    list: [],
    receiptId: costcoReceipt,
    closedAt: T2,
    closeReason: "receipt",
  });
  await db.insert(t.idempotencyKey).values({
    key: "receipt:100000000000000101:C-1",
    scope: "agent:POST /api/receipts/ingest",
    responseStatus: 200,
  });
}

describe("reset-imports --vendor", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await seedImport(db);
    await seedCostco(db);
  });
  const ids = async (table: SQLiteTable & { id: SQLiteColumn }) =>
    (await db.select({ id: table.id }).from(table)).map((r) => String(r.id)).sort();

  it("counts only that store's import", async () => {
    const plan = await planImportReset(db, { vendor: "costco" });
    expect(plan.vendor).toBe("costco");
    expect(plan.counts).toEqual({
      review_item: 2,
      audit_job: 0,
      price_quote: 0,
      preference_event: 0,
      vendor_alias: 0,
      inventory_state: 1,
      inventory_event: 1,
      receipt_line: 1,
      receipt: 1,
      product: 1,
      item: 1,
      idempotency_key: 1,
    });
    expect(Object.values(plan.blockers).every((n) => n === 0)).toBe(true);
    expect(plan.info.linesByVendor).toEqual({ costco: 1 });
    expect(plan.info.tripsUnlinked).toBe(1);
    const text = formatPlan(plan, false);
    expect(text).toContain("(costco only)");
    expect(text).toContain("OK to apply");
  });

  it("apply deletes that store's import and keeps the others'", async () => {
    await applyImportReset(db, { vendor: "costco" });
    expect(await ids(t.receipt)).toEqual([amz, wf, paper]);
    expect(await ids(t.item)).toEqual([card, floss, bananas, kept]);
    expect(await ids(t.product)).toEqual([pCard, pFloss, pBananas, pKept]);
    expect(await ids(t.auditJob)).toEqual([job, paperJob]); // merge job kept
    expect(await ids(t.reviewItem)).toEqual([80, 81, 82, 83, 84, 85].map(ID));
    expect(await count(db, t.receiptLine)).toBe(5);
    // The trip stays done; only its link goes, so the re-imported receipt re-links it.
    const [tr] = await db.select().from(t.costcoTrip);
    expect(tr).toMatchObject({ id: trip, status: "done", receiptId: null });
    const keys = (await db.select().from(t.idempotencyKey)).map((k) => k.key).sort();
    expect(keys).toEqual(["discord:42", "receipt:100000000000000101:111-1", "receipt:x"]);
    const states = (await db.select().from(t.inventoryState)).map((s) => s.itemId);
    expect(states).not.toContain(towels);
    expect(Object.values((await planImportReset(db, { vendor: "costco" })).counts)).toEqual(
      Array(12).fill(0),
    );
  });

  it("refuses when another store's import names an item it would delete", async () => {
    await db.insert(t.receiptLine).values({ receiptId: wf, rawText: "towels", itemId: towels });
    const plan = await planImportReset(db, { vendor: "costco" });
    expect(plan.blockers.other_store_lines).toBe(1);
    await expect(applyImportReset(db, { vendor: "costco" })).rejects.toBeInstanceOf(
      ImportResetBlocked,
    );
    expect(await count(db, t.receipt)).toBe(4);
  });

  it("finds nothing for a store with no import", async () => {
    const plan = await planImportReset(db, { vendor: "amazon" });
    expect(plan.counts.receipt).toBe(0);
  });

  // Regression: a full reset deleted a receipt a Costco trip still pointed at (FK violation).
  it("a full reset unlinks the Costco trip instead of failing", async () => {
    await applyImportReset(db);
    const [tr] = await db.select().from(t.costcoTrip);
    expect(tr).toMatchObject({ status: "done", receiptId: null });
    expect(await ids(t.receipt)).toEqual([paper]);
  });

  it("rejects a malformed vendor", async () => {
    await expect(planImportReset(db, { vendor: "Costco; drop" })).rejects.toThrow("bad vendor");
  });
});
