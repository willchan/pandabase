import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import type { InventoryState } from "./inventory";
import type { Alias } from "./matching";
import {
  applyReceipt,
  receiptDedupeKey,
  resolveReceiptReview,
  totalsCheck,
  type CycleCart,
  type ItemRecord,
  type ProductRecord,
  type ReceiptInput,
  type ReceiptLineInput,
  type ReceiptRepository,
} from "./receipts";
import type { Acquisition } from "./velocity";

const config = DEFAULT_CONFIG;
const NOW = "2026-10-25T20:00:00.000Z"; // Sun Oct 25, 1pm LA
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();

const item = (id: string, o: Partial<ItemRecord> = {}): ItemRecord => ({
  id,
  canonicalName: id,
  trackingType: "velocity",
  emaDays: 1,
  defaultEmaDays: null,
  outlierStreak: 0,
  outlierDirection: null,
  defaultLocation: "fridge",
  reorderThreshold: null,
  shelfLifeDays: null,
  switchThreshold: 0.15,
  ...o,
});
const product = (id: string, itemId: string, o: Partial<ProductRecord> = {}): ProductRecord => ({
  id,
  itemId,
  vendor: "wholefoods",
  asin: null,
  title: id,
  unitQuantity: 1,
  stance: "acceptable",
  preferenceScore: 0,
  timesBought: 0,
  consecutiveBuys: 0,
  lastPriceCents: null,
  ...o,
});
const alias = (
  vendor: string,
  kind: Alias["kind"],
  vendorString: string,
  o: Partial<Alias> = {},
): Alias => ({
  vendor,
  kind,
  vendorString,
  itemId: null,
  productId: null,
  confidenceScore: 1,
  ignored: false,
  ...o,
});
const anchor = (location: string, qty: number, at: string): InventoryState => ({
  location,
  anchorQty: qty,
  anchorAt: at,
  anchorKind: "acquired",
  statusOverride: null,
  frozenAt: null,
  lastVerifiedAt: null,
});

interface World {
  items: ItemRecord[];
  products: ProductRecord[];
  aliases: Alias[];
  inventory: Record<string, InventoryState[]>;
  acquisitions: Record<string, Acquisition[]>;
  cycle: CycleCart | null;
}

function world(): World {
  return {
    items: [
      item("eggs", { canonicalName: "Eggs" }), // 1 egg/day
      item("tp", {
        canonicalName: "Toilet Paper",
        trackingType: "static",
        emaDays: null,
        reorderThreshold: 4,
        defaultLocation: "bathroom",
      }),
      item("candles", {
        canonicalName: "Birthday Candles",
        trackingType: "static",
        emaDays: null,
        defaultLocation: "utility",
      }),
      item("spinach", { canonicalName: "Baby Spinach" }),
    ],
    products: [
      product("vital", "eggs", {
        title: "Vital Farms",
        unitQuantity: 12,
        stance: "preferred",
        consecutiveBuys: 1,
      }),
      product("365-18", "eggs", {
        title: "365 Eggs 18ct",
        unitQuantity: 18,
        asin: "B0EGG18",
        consecutiveBuys: 2,
      }),
      product("tp-24", "tp", { vendor: "amazon", asin: "B0TP24", unitQuantity: 24 }),
      product("candles-p", "candles", { vendor: "amazon", asin: "B0CANDLE" }),
    ],
    aliases: [
      alias("wholefoods", "receipt_text", "365 ORG LARGE EGGS", {
        itemId: "eggs",
        productId: "vital",
      }),
      alias("wholefoods", "receipt_text", "ORG EGGS LOOSE", { itemId: "eggs", productId: null }),
      alias("wholefoods", "receipt_text", "BAG FEE", { ignored: true }),
      alias("wholefoods", "asin", "WF-BAGFEE", { ignored: true }),
    ],
    inventory: {
      eggs: [anchor("fridge", 4, daysAgo(1))], // 3 eggs left now
      tp: [anchor("bathroom", 20, daysAgo(10))],
      candles: [anchor("utility", 1, daysAgo(40))],
    },
    acquisitions: {
      eggs: [{ at: daysAgo(12), qty: 12 }],
      candles: [{ at: daysAgo(40), qty: 1 }],
    },
    cycle: {
      cycleId: "c43",
      status: "ready",
      builtAt: daysAgo(1.2),
      cartVendors: ["wholefoods"],
      orderIds: [],
      lines: [{ itemId: "eggs", productId: "vital" }],
      pleaseCheckItemIds: ["spinach"],
    },
  };
}

function repo(w: World): ReceiptRepository {
  const find = <T>(x: T | undefined, what: string): T => {
    if (x === undefined) throw new Error(`missing ${what}`);
    return x;
  };
  return {
    aliases: async (vendor) => w.aliases.filter((a) => a.vendor === vendor),
    canonicalItems: async () => w.items.map((i) => ({ id: i.id, canonicalName: i.canonicalName })),
    productsByAsin: async (vendor, asins) =>
      w.products
        .filter((p) => p.vendor === vendor && p.asin !== null && asins.includes(p.asin))
        .map((p) => ({ id: p.id, itemId: p.itemId, vendor: p.vendor, asin: p.asin })),
    item: async (id) =>
      find(
        w.items.find((i) => i.id === id),
        id,
      ),
    products: async (id) => w.products.filter((p) => p.itemId === id),
    inventory: async (id) => w.inventory[id] ?? [],
    acquisitions: async (id) => w.acquisitions[id] ?? [],
    awayPeriods: async () => [],
    lastBuiltCycle: async () => w.cycle,
  };
}

const ids = () => {
  let n = 0;
  return () => `new${++n}`;
};
const line = (rawText: string, o: Partial<ReceiptLineInput> = {}): ReceiptLineInput => ({
  rawText,
  asin: null,
  qty: 1,
  unitPriceCents: null,
  lineTotalCents: null,
  ...o,
});
const receipt = (o: Partial<ReceiptInput>): ReceiptInput => ({
  source: "digital",
  vendor: "wholefoods",
  accountMemberId: "m1",
  externalOrderId: "o1",
  fulfillment: "pickup",
  orderedAt: null,
  acquiredAt: NOW,
  subtotalCents: null,
  totalCents: null,
  lines: [],
  ...o,
});
const apply = (r: ReceiptInput, w = world()) =>
  applyReceipt(r, repo(w), { config, newId: ids(), now: NOW });

describe("applyReceipt — digital", () => {
  it("cart order with a swapped 18-pack: inventory, EMA, stats, auto-promote, implicit swap, cycle closed", async () => {
    const fx = await apply(
      receipt({
        subtotalCents: 999,
        lines: [
          line("365 Eggs 18ct", { asin: "B0EGG18", unitPriceCents: 899, lineTotalCents: 899 }),
          line("Bag", { asin: "wf-bagfee", lineTotalCents: 100 }),
        ],
      }),
    );
    expect(fx.receipt).toEqual({
      dedupeKey: "digital:m1:o1",
      totalsCheck: "pass",
      status: "applied",
    });
    expect(
      fx.lines.map((l) => [l.itemId, l.productId, l.matchMethod, l.baseQty, l.ignored, l.trust]),
    ).toEqual([
      ["eggs", "365-18", "asin", 18, false, "confirmed"],
      [null, null, "asin", 0, true, "confirmed"],
    ]);
    expect(fx.inventoryEvents).toEqual([
      {
        itemId: "eggs",
        location: "fridge",
        kind: "acquired",
        quantity: 18,
        occurredAt: NOW,
        source: "digital_receipt",
        trust: "confirmed",
      },
    ]);
    // EMA: 12 eggs lasted 12 days → observed 1 → stays 1. Implicit swap lowers the threshold.
    expect(fx.itemPatches).toEqual([{ id: "eggs", patch: { switchThreshold: 0.12 } }]);
    expect(fx.productPatches).toEqual([
      {
        id: "365-18",
        timesBought: 1,
        consecutiveBuys: 3,
        lastBoughtAt: NOW,
        lastPriceCents: 899,
        lastPriceAt: NOW,
        stance: "preferred",
      },
      { id: "vital", consecutiveBuys: 0, stance: "acceptable" },
      { id: "365-18", preferenceScore: 1 },
    ]);
    expect(
      fx.preferenceEvents.map((e) => [e.kind, e.fromProductId, e.toProductId, e.cycleId]),
    ).toEqual([
      ["auto_promote", "vital", "365-18", null],
      ["implicit_swap", "vital", "365-18", "c43"],
    ]);
    expect(fx.cycle).toEqual({
      cycleId: "c43",
      patch: { status: "closed", closedAt: NOW, closeReason: "order_ingested" },
    });
    expect(fx.reviews).toEqual([]);
    expect(fx.telemetry).toEqual(
      expect.arrayContaining([
        {
          metric: "ema_updated",
          itemId: "eggs",
          observedDays: 1,
          emaBefore: 1,
          emaAfter: 1,
          seeded: false,
        },
        expect.objectContaining({
          metric: "preference_event",
          kind: "implicit_swap",
          itemId: "eggs",
        }),
        { metric: "receipt_line_match", method: "asin", score: 1, pending: false, ignored: false },
      ]),
    );
  });

  it("buying the cart's product is not a swap", async () => {
    const w = world();
    w.products[0]!.asin = "B0VITAL";
    const fx = await apply(receipt({ lines: [line("Vital", { asin: "B0VITAL" })] }), w);
    expect(fx.preferenceEvents).toEqual([]);
    expect(fx.lines[0]!.baseQty).toBe(12);
  });

  it("unknown ASIN → unverified static item + acceptable product + new_product review (30d, keep)", async () => {
    const fx = await apply(
      receipt({
        vendor: "amazon",
        externalOrderId: "a1",
        lines: [
          line("x", { asin: "b0new", title: "Brand Kombucha - Ginger, Pack of 6", qty: 2 }),
          line("x", { asin: "B0NEW", qty: 1 }),
        ],
      }),
    );
    expect(fx.newItems).toEqual([
      {
        id: "new1",
        canonicalName: "Brand Kombucha",
        category: "Uncategorized",
        defaultLocation: "pantry",
        trackingType: "static",
        baseUnit: "count",
        trust: "unverified",
      },
    ]);
    expect(fx.newProducts).toEqual([
      {
        id: "new2",
        itemId: "new1",
        vendor: "amazon",
        asin: "B0NEW",
        title: "Brand Kombucha - Ginger, Pack of 6",
        unitQuantity: 6,
        unitQuantityTrust: "unverified",
        stance: "acceptable",
      },
    ]);
    expect(fx.lines.map((l) => l.baseQty)).toEqual([12, 6]);
    expect(fx.inventoryEvents).toMatchObject([
      { itemId: "new1", location: "pantry", quantity: 18, trust: "confirmed" },
    ]);
    expect(fx.reviews).toEqual([
      expect.objectContaining({
        kind: "new_product",
        itemId: "new1",
        defaultAction: { action: "keep_auto_created" },
        expiresAt: "2026-11-24T20:00:00.000Z",
        urgency: "cleanup",
        payload: {
          asin: "B0NEW",
          title: "Brand Kombucha - Ginger, Pack of 6",
          unitQuantityParsed: true,
        },
      }),
    ]);
    // Product stats for the new product; no EMA for a new static one-off.
    expect(fx.productPatches[0]).toMatchObject({ id: "new2", timesBought: 1 });
    expect(fx.itemPatches).toEqual([]);
    expect(fx.cycle).toBeNull(); // amazon isn't a cart vendor of this cycle
  });

  it("unknown ASIN without a parsable count → 1 base unit per purchase unit", async () => {
    const fx = await apply(
      receipt({ vendor: "amazon", lines: [line("Olive Oil 500ml", { asin: "B0OIL" })] }),
    );
    expect(fx.newProducts[0]).toMatchObject({
      unitQuantity: 1,
      unitQuantityTrust: "unverified",
      title: "Olive Oil 500ml",
    });
    expect(fx.reviews[0]!.payload).toMatchObject({ unitQuantityParsed: false });
  });

  it("logs overbuy for a static item well above its threshold", async () => {
    const fx = await apply(receipt({ vendor: "amazon", lines: [line("TP", { asin: "B0TP24" })] }));
    expect(fx.inventoryEvents[0]).toMatchObject({ itemId: "tp", quantity: 24 });
    expect(fx.telemetry).toContainEqual({
      metric: "overbuy",
      itemId: "tp",
      onHandBefore: 20,
      acquiredQty: 24,
      daysOfStock: null,
      reorderThreshold: 4,
    });
  });

  it("promotes a one-off static item on a second purchase within 6 months and starts its EMA", async () => {
    const fx = await apply(
      receipt({ vendor: "amazon", lines: [line("Candles", { asin: "B0CANDLE" })] }),
    );
    expect(fx.itemPatches).toEqual([
      { id: "candles", patch: { trackingType: "velocity", emaDays: 40 } },
    ]);
    expect(fx.telemetry).toContainEqual({ metric: "promoted_to_velocity", itemId: "candles" });
  });

  it("requires an order id", async () => {
    await expect(apply(receipt({ externalOrderId: null }))).rejects.toThrow(/external_order_id/);
  });
});

describe("applyReceipt — EMA placement", () => {
  it.each([
    ["same household day as the last acquisition → merge, skip EMA", daysAgo(0.1), "same_day"],
    ["older than the last acquisition (late receipt) → skip EMA", daysAgo(20), "out_of_order"],
  ])("%s", async (_, prevAt, reason) => {
    const w = world();
    w.acquisitions.eggs = [{ at: prevAt, qty: 12 }];
    const fx = await apply(
      receipt({
        source: "paper",
        acquiredAt: reason === "out_of_order" ? daysAgo(25) : NOW,
        lines: [line("365 ORG LARGE EGGS")],
      }),
      w,
    );
    expect(fx.telemetry).toContainEqual({ metric: "ema_skipped", itemId: "eggs", reason });
    expect(fx.itemPatches).toEqual([]);
  });

  it("first acquisition of a velocity item → record only", async () => {
    const w = world();
    w.acquisitions.eggs = [];
    const fx = await apply(receipt({ source: "paper", lines: [line("365 ORG LARGE EGGS")] }), w);
    expect(fx.telemetry).toContainEqual({
      metric: "ema_skipped",
      itemId: "eggs",
      reason: "no_previous",
    });
  });

  it("an outlier is rejected and the streak persisted", async () => {
    const w = world();
    w.acquisitions.eggs = [{ at: daysAgo(60), qty: 12 }]; // 5 days per egg vs EMA 1
    const fx = await apply(receipt({ source: "paper", lines: [line("365 ORG LARGE EGGS")] }), w);
    expect(fx.itemPatches).toEqual([
      { id: "eggs", patch: { outlierStreak: 1, outlierDirection: "high" } },
    ]);
    expect(fx.telemetry).toContainEqual(
      expect.objectContaining({ metric: "ema_outlier_rejected", itemId: "eggs" }),
    );
  });
});

describe("applyReceipt — paper (DESIGN §4.5 table)", () => {
  const paper = (lines: ReceiptLineInput[], o: Partial<ReceiptInput> = {}) =>
    receipt({
      source: "paper",
      externalOrderId: null,
      fulfillment: "in_store",
      totalCents: 1234,
      lines,
      ...o,
    });

  it("exact confirmed alias → applied, confirmed; base units from the alias's product", async () => {
    const fx = await apply(paper([line("365 ORG LARGE EGGS 5.99", { qty: 2 })]));
    expect(fx.receipt).toMatchObject({
      dedupeKey: "paper:wholefoods:2026-10-25:1234",
      status: "applied",
      totalsCheck: "n/a",
    });
    expect(fx.lines[0]).toMatchObject({
      itemId: "eggs",
      productId: "vital",
      matchMethod: "alias_exact",
      trust: "confirmed",
      baseQty: 24,
      normalized: "365 ORG LARGE EGGS",
    });
    expect(fx.inventoryEvents[0]).toMatchObject({
      source: "paper_receipt",
      trust: "confirmed",
      quantity: 24,
    });
    expect(fx.reviews).toEqual([]);
    expect(fx.cycle).toBeNull(); // paper receipts don't close a cart cycle without order ids
  });

  it("alias without a product → the item's preferred product's pack size", async () => {
    const fx = await apply(paper([line("ORG EGGS LOOSE")]));
    expect(fx.lines[0]).toMatchObject({ productId: null, baseQty: 12 });
    expect(fx.productPatches).toEqual([]); // no product → no product learning
  });

  it("fuzzy match → provisional event, no product learning, receipt review", async () => {
    const fx = await apply(paper([line("BABY SPINACH 5OZ")]));
    expect(fx.lines[0]).toMatchObject({
      itemId: "spinach",
      matchMethod: "fuzzy",
      trust: "unverified",
      baseQty: 1,
    });
    expect(fx.inventoryEvents[0]).toMatchObject({ itemId: "spinach", trust: "provisional" });
    expect(fx.receipt.status).toBe("applied");
    expect(fx.reviews).toEqual([
      expect.objectContaining({
        kind: "receipt",
        defaultAction: { action: "drop_pending_lines" },
        expiresAt: "2026-11-08T20:00:00.000Z",
        payload: { pendingLines: [], provisionalLines: [0] },
        impactScore: 3, // spinach is on please-check
        urgency: "this_week",
      }),
    ]);
  });

  it("unmatched lines → pending; partial when something applied", async () => {
    const fx = await apply(
      paper([line("365 ORG LARGE EGGS"), line("DRAGONFRUIT"), line("BAG FEE")]),
    );
    expect(fx.receipt.status).toBe("partial");
    expect(fx.lines.map((l) => [l.pending, l.ignored])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
    expect(fx.reviews[0]).toMatchObject({
      kind: "receipt",
      payload: { pendingLines: [1], provisionalLines: [] },
      impactScore: 1,
      urgency: "cleanup",
    });
    expect(fx.inventoryEvents).toHaveLength(1);
  });

  it("only unmatched lines → pending_review, no inventory", async () => {
    const fx = await apply(paper([line("DRAGONFRUIT")]));
    expect(fx.receipt.status).toBe("pending_review");
    expect(fx.inventoryEvents).toEqual([]);
  });

  it("a provisional line in the cart plan scores 10", async () => {
    const w = world();
    w.cycle!.lines = [{ itemId: "spinach", productId: null }];
    w.cycle!.pleaseCheckItemIds = undefined;
    const fx = await apply(paper([line("BABY SPINACH 5OZ")]), w);
    expect(fx.reviews[0]).toMatchObject({ impactScore: 10 });
  });

  it("no cycle at all", async () => {
    const w = world();
    w.cycle = null;
    const fx = await apply(paper([line("BABY SPINACH 5OZ")]), w);
    expect(fx.reviews[0]).toMatchObject({ impactScore: 1 });
    expect(fx.cycle).toBeNull();
  });

  it("manual receipts dedupe on the idempotency key", async () => {
    const fx = await apply(
      paper([line("365 ORG LARGE EGGS")], { source: "manual", idempotencyKey: "k1" }),
    );
    expect(fx.receipt.dedupeKey).toBe("manual:k1");
    expect(fx.inventoryEvents[0]!.source).toBe("manual");
    await expect(apply(paper([], { source: "manual" }))).rejects.toThrow(/idempotency key/);
  });
});

describe("dedupe key and totals", () => {
  it.each([
    ["digital", receipt({}), "digital:m1:o1"],
    ["digital without account", receipt({ accountMemberId: null }), "digital:-:o1"],
    [
      "paper (household-local date)",
      receipt({ source: "paper", acquiredAt: "2026-10-26T03:00:00.000Z", totalCents: 500 }),
      "paper:wholefoods:2026-10-25:500",
    ],
    ["paper without total", receipt({ source: "paper" }), "paper:wholefoods:2026-10-25:-"],
  ])("%s", (_, r, key) => expect(receiptDedupeKey(r, config.householdTz)).toBe(key));

  it.each([
    ["pass", 300, [100, 200], "pass"],
    ["fail", 301, [100, 200], "fail"],
    ["no subtotal", null, [100], "n/a"],
    ["a line without a total", 100, [100, null], "n/a"],
  ] as const)("totalsCheck %s", (_, subtotalCents, totals, out) => {
    expect(
      totalsCheck({ subtotalCents, lines: totals.map((t) => line("x", { lineTotalCents: t })) }),
    ).toBe(out);
  });
});

describe("resolveReceiptReview", () => {
  const existing = [
    alias("wholefoods", "receipt_text", "BABY SPINACH 5OZ", {
      itemId: "spinach",
      confidenceScore: 0.9,
      productId: "p-sp",
    }),
  ];
  const res = resolveReceiptReview({
    vendor: "wholefoods",
    existingAliases: existing,
    lines: [
      {
        lineId: "l1",
        normalized: "BABY SPINACH 5OZ",
        itemId: "spinach",
        productId: null,
        matchScore: 0.9,
        eventId: "e1",
        decision: { kind: "confirm" },
      },
      {
        lineId: "l2",
        normalized: "ORG KALE",
        itemId: "spinach",
        productId: null,
        matchScore: 0.86,
        eventId: "e2",
        decision: { kind: "correct", itemId: "kale", productId: null },
      },
      {
        lineId: "l3",
        normalized: "DRAGONFRUIT",
        itemId: null,
        productId: null,
        matchScore: 0.4,
        eventId: null,
        decision: { kind: "correct", itemId: "fruit", productId: "p-df" },
      },
      {
        lineId: "l4",
        normalized: "PLASTIC BAG",
        itemId: null,
        productId: null,
        matchScore: null,
        eventId: null,
        decision: { kind: "ignore" },
      },
      {
        lineId: "l5",
        normalized: "MYSTERY",
        itemId: null,
        productId: null,
        matchScore: null,
        eventId: null,
        decision: { kind: "confirm" },
      },
      {
        lineId: "l6",
        normalized: null,
        itemId: "eggs",
        productId: "vital",
        matchScore: 1,
        eventId: "e6",
        decision: { kind: "ignore" },
      },
      {
        lineId: "l7",
        normalized: null,
        itemId: "eggs",
        productId: "vital",
        matchScore: 1,
        eventId: null,
        decision: { kind: "confirm" },
      },
      {
        lineId: "l8",
        normalized: null,
        itemId: "eggs",
        productId: "vital",
        matchScore: 1,
        eventId: null,
        decision: { kind: "correct", itemId: "tp", productId: null },
      },
    ],
  });

  it("confirm upgrades the provisional event and strengthens the alias to 1.0", () => {
    expect(res.eventTrust).toContainEqual({ eventId: "e1", trust: "confirmed" });
    expect(res.aliases).toContainEqual(
      expect.objectContaining({
        vendorString: "BABY SPINACH 5OZ",
        confidenceScore: 1,
        productId: "p-sp",
        created: false,
      }),
    );
  });

  it("correct reverses the provisional event and applies the corrected item", () => {
    expect(res.eventTrust).toContainEqual({ eventId: "e2", trust: "expired" });
    expect(res.applyLines).toEqual([
      { lineId: "l2", itemId: "kale", productId: null },
      { lineId: "l3", itemId: "fruit", productId: "p-df" },
      { lineId: "l8", itemId: "tp", productId: null },
    ]);
    expect(res.lineUpdates).toContainEqual({
      lineId: "l2",
      itemId: "kale",
      productId: null,
      trust: "confirmed",
      ignored: false,
      matchMethod: "manual",
    });
  });

  it("ignore writes an ignored alias and reverses any event", () => {
    expect(res.aliases).toContainEqual(
      expect.objectContaining({ vendorString: "PLASTIC BAG", ignored: true, itemId: null }),
    );
    expect(res.eventTrust).toContainEqual({ eventId: "e6", trust: "expired" });
  });

  it("every human answer is a label; confirming a pending line is a no-op", () => {
    expect(res.labels.map((l) => l.lineId)).toEqual(["l1", "l2", "l3", "l4", "l6", "l7", "l8"]);
    expect(res.labels[1]).toEqual({
      lineId: "l2",
      modelOutput: { itemId: "spinach", productId: null, matchScore: 0.86 },
      humanLabel: { itemId: "kale", productId: null },
    });
    expect(res.lineUpdates.map((l) => l.lineId)).not.toContain("l5");
    expect(res.aliases.map((a) => a.vendorString)).toEqual([
      "BABY SPINACH 5OZ",
      "ORG KALE",
      "DRAGONFRUIT",
      "PLASTIC BAG",
    ]);
  });
});
