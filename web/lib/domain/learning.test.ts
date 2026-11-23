import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import {
  changedColumns,
  eventKey,
  eventsDiffer,
  rebuildItemLearning,
  sameValue,
  type LearningCycle,
  type LearningInput,
  type LearningReceipt,
} from "./learning";

const config = DEFAULT_CONFIG;
const DAY = 86_400_000;
/** Noon Los Angeles on Aug 1 2026, plus `d` days. */
const day = (d: number) => new Date(Date.parse("2026-08-01T19:00:00.000Z") + d * DAY).toISOString();
const hourAfter = (at: string) => new Date(Date.parse(at) + 3_600_000).toISOString();

const A = { id: "PA", vendor: "amazon", title: "Product A", unitQuantity: 1 };
const B = { id: "PB", vendor: "amazon", title: "Product B", unitQuantity: 1 };

let n = 0;
const receipt = (
  at: string,
  lines: { productId: string | null; cents?: number | null; trust?: "confirmed" | "unverified" }[],
  o: Partial<LearningReceipt> = {},
): LearningReceipt => ({
  id: `R${String(++n).padStart(4, "0")}`,
  source: "digital",
  vendor: "amazon",
  fulfillment: "delivery",
  externalOrderId: `O${n}`,
  acquiredAt: at,
  createdAt: hourAfter(at),
  lines: lines.map((l) => ({
    productId: l.productId,
    trust: l.trust ?? "confirmed",
    unitPriceCents: l.cents === undefined ? 500 : l.cents,
  })),
  ...o,
});

const input = (o: Partial<LearningInput> = {}): LearningInput => ({
  item: { id: "I1", trackingType: "static", defaultEmaDays: null, reorderThreshold: null },
  products: [A, B],
  receipts: [],
  acquisitions: [],
  humanEvents: [],
  cycles: [],
  away: [],
  paused: [],
  config,
  ...o,
});

describe("rebuildItemLearning — velocity (§4.1)", () => {
  it("starts static, promotes on a second purchase within the window, then learns", () => {
    const r = rebuildItemLearning(
      input({
        acquisitions: [
          { at: day(20), qty: 1 },
          { at: day(0), qty: 1 },
          { at: day(10), qty: 1 },
          { at: day(10), qty: 1 }, // same day: merged
        ],
      }),
    );
    expect(r.promoted).toBe(true);
    expect(r.item.trackingType).toBe("velocity");
    expect(r.outcomes).toEqual({ initialized: 1, updated: 1 });
    // day 10 initializes at 10 days per unit; day 20: 10 days over 2 units = 5.
    expect(r.item.currentEmaDays).toBeCloseTo(0.7 * 10 + 0.3 * 5);
  });

  it("stays static without a purchase in the window, and with a reorder threshold", () => {
    const far = [
      { at: day(0), qty: 1 },
      { at: day(300), qty: 1 },
    ];
    expect(rebuildItemLearning(input({ acquisitions: far })).item).toMatchObject({
      trackingType: "static",
      currentEmaDays: null,
    });
    const near = [
      { at: day(0), qty: 1 },
      { at: day(10), qty: 1 },
    ];
    const thr = rebuildItemLearning(
      input({
        item: { id: "I1", trackingType: "static", defaultEmaDays: null, reorderThreshold: 2 },
        acquisitions: near,
      }),
    );
    expect(thr.item.trackingType).toBe("static");
    expect(thr.promoted).toBe(false);
  });

  it("an item velocity now that the replay never promotes learns from its first purchase", () => {
    const r = rebuildItemLearning(
      input({
        item: { id: "I1", trackingType: "velocity", defaultEmaDays: 7, reorderThreshold: null },
        acquisitions: [
          { at: day(0), qty: 1 },
          { at: day(300), qty: 1 },
        ],
      }),
    );
    expect(r.promoted).toBe(false);
    expect(r.item.trackingType).toBe("velocity");
    expect(r.outcomes.first_acquisition).toBe(1);
    expect(r.outcomes.outlier_rejected).toBe(1); // 300 days vs the seeded 7
    expect(r.item).toMatchObject({ currentEmaDays: 7, emaOutlierStreak: 1 });
    expect(r.item.emaOutlierDirection).toBe("high");
  });

  it("freezes EMA steps across a cart pause, as ingest does (#84)", () => {
    const r = rebuildItemLearning(
      input({
        acquisitions: [
          { at: day(0), qty: 1 },
          { at: day(10), qty: 1 },
          { at: day(20), qty: 1 },
        ],
        paused: [{ startsOn: "2026-08-15", endsOn: "2026-08-16" }],
      }),
    );
    expect(r.outcomes).toEqual({ initialized: 1, paused: 1 });
    expect(r.item.currentEmaDays).toBe(10);
  });
});

describe("rebuildItemLearning — product stats and preferences (§4.4)", () => {
  it("folds receipts by acquisition date: stats, auto-promotion, streak reset", () => {
    const receipts = [
      receipt(day(30), [{ productId: "PA", cents: 450 }]),
      receipt(day(0), [{ productId: "PA" }, { productId: "PA", cents: 999 }]),
      receipt(day(10), [{ productId: "PA", cents: null }]),
      receipt(day(20), [{ productId: "PA" }, { productId: "PX" }, { productId: null }]),
      receipt(day(40), [{ productId: "PB", trust: "unverified" }]),
      receipt(day(50), [{ productId: "PB" }]),
    ];
    const r = rebuildItemLearning(input({ receipts }));
    expect(r.products.get("PA")).toMatchObject({
      stance: "preferred",
      timesBought: 4,
      consecutiveBuys: 0,
      lastBoughtAt: day(30),
      lastPriceCents: 450,
      lastPriceAt: day(30),
      lastPriceFulfillment: null,
    });
    expect(r.products.get("PB")).toMatchObject({ timesBought: 1, consecutiveBuys: 1 });
    expect(r.events).toEqual([
      {
        kind: "auto_promote",
        fromProductId: null,
        toProductId: "PA",
        thresholdBefore: 0.15,
        thresholdAfter: 0.15,
        cycleId: null,
        at: hourAfter(day(20)),
      },
    ]);
  });

  it("keeps a Costco warehouse price over a later delivery one", () => {
    const costco = { vendor: "costco" };
    const r = rebuildItemLearning(
      input({
        products: [{ ...A, vendor: "costco" }],
        receipts: [
          receipt(day(0), [{ productId: "PA", cents: 1199 }], { ...costco, fulfillment: "in_store" }),
          receipt(day(5), [{ productId: "PA", cents: 1499 }], { ...costco, fulfillment: "delivery" }),
        ],
      }),
    );
    expect(r.products.get("PA")).toMatchObject({
      lastPriceCents: 1199,
      lastPriceAt: day(0),
      lastPriceFulfillment: "in_store",
      lastBoughtAt: day(5),
    });
  });

  it("replays rejections and overrides by their recorded kind, in time order", () => {
    const r = rebuildItemLearning(
      input({
        receipts: [receipt(day(0), [{ productId: "PA" }]), receipt(day(20), [{ productId: "PA" }])],
        humanEvents: [
          { id: "H1", kind: "override_to_cheaper", fromProductId: "PA", toProductId: "PB", at: day(5) },
          { id: "H2", kind: "override_to_preferred", fromProductId: "PB", toProductId: "PA", at: day(6) },
          { id: "H3", kind: "override_to_preferred", fromProductId: "PB", toProductId: "PA", at: day(7) },
          { id: "H4", kind: "reject", fromProductId: "PB", toProductId: null, at: day(8) },
          { id: "H5", kind: "reject", fromProductId: "PB", toProductId: null, at: day(9) },
          // Not this item's products (moved away by a merge): ignored.
          { id: "H6", kind: "reject", fromProductId: "PZ", toProductId: null, at: day(9) },
          { id: "H7", kind: "override_to_cheaper", fromProductId: "PA", toProductId: "PZ", at: day(9) },
          { id: "H8", kind: "override_to_cheaper", fromProductId: null, toProductId: "PB", at: day(9) },
        ],
      }),
    );
    // 0.15 − 0.03 + 0.05 + 0.05
    expect(r.item.switchThreshold).toBeCloseTo(0.22);
    expect(r.products.get("PB")).toMatchObject({ stance: "rejected", preferenceScore: 1 });
    expect(r.products.get("PA")).toMatchObject({ preferenceScore: 0, timesBought: 2 });
    expect(r.events).toEqual([]);
  });

  const cycle = (o: Partial<LearningCycle> = {}): LearningCycle => ({
    id: "C1",
    status: "ready",
    builtAt: day(2),
    cartVendors: ["amazon"],
    orderIds: [],
    lines: [{ itemId: "I1", productId: "PA" }],
    ...o,
  });

  it("an order unlike its cart is an implicit swap against the cart built before ingest", () => {
    const r = rebuildItemLearning(
      input({
        receipts: [
          receipt(day(0), [{ productId: "PA" }]),
          receipt(day(3), [{ productId: "PB" }]),
          receipt(day(4), [{ productId: "PA" }]), // the cart's product: no swap
        ],
        cycles: [cycle(), cycle({ id: "C0", builtAt: day(1) }), cycle({ id: "C9", builtAt: day(30) })],
      }),
    );
    expect(r.events).toEqual([
      {
        kind: "implicit_swap",
        fromProductId: "PA",
        toProductId: "PB",
        thresholdBefore: 0.15,
        thresholdAfter: 0.12,
        cycleId: "C1",
        at: hourAfter(day(3)),
      },
    ]);
    expect(r.item.switchThreshold).toBe(0.12);
    expect(r.products.get("PB")!.preferenceScore).toBe(1);
  });

  it("no swap without a matching cart, a cart product of this item, or a confirmed buy", () => {
    const none = (o: Partial<LearningInput>) => rebuildItemLearning(input(o)).events;
    const buyB = [receipt(day(3), [{ productId: "PB" }])];
    expect(none({ receipts: buyB })).toEqual([]);
    expect(none({ receipts: buyB, cycles: [cycle({ builtAt: day(10) })] })).toEqual([]);
    expect(none({ receipts: buyB, cycles: [cycle({ cartVendors: ["wholefoods"] })] })).toEqual([]);
    expect(none({ receipts: buyB, cycles: [cycle({ lines: [] })] })).toEqual([]);
    expect(
      none({ receipts: buyB, cycles: [cycle({ lines: [{ itemId: "I1", productId: "PZ" }] })] }),
    ).toEqual([]);
    expect(
      none({
        receipts: [receipt(day(3), [{ productId: "PB", trust: "unverified" }])],
        cycles: [cycle()],
      }),
    ).toEqual([]);
  });
});

describe("comparing stored and rebuilt values", () => {
  it("compares reals within 1e-9 and everything else exactly", () => {
    expect(sameValue(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameValue(10, 10.001)).toBe(false);
    expect(sameValue(null, 0)).toBe(false);
    expect(sameValue("a", "a")).toBe(true);
    expect(changedColumns({ a: 1, b: "x" }, { a: 1, b: "y" }, ["a", "b"])).toEqual(["b"]);
  });

  it("compares preference events as multisets, ids and timestamps aside", () => {
    const e = {
      kind: "auto_promote",
      fromProductId: null,
      toProductId: "PA",
      thresholdBefore: 0.15,
      thresholdAfter: 0.15,
      cycleId: null,
    };
    const f = { ...e, toProductId: "PB", thresholdBefore: null, thresholdAfter: null, cycleId: "C" };
    expect(eventKey(f)).toBe("auto_promote||PB|||C");
    expect(eventsDiffer([e, f], [f, { ...e }])).toBe(false);
    expect(eventsDiffer([e], [e, f])).toBe(true);
    expect(eventsDiffer([e], [f])).toBe(true);
  });
});
