import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import {
  candidatesFor,
  chooseProduct,
  learnFromOverride,
  pickPreferred,
  recordPurchase,
  rejectProduct,
  switchEvent,
  unitPrice,
  type ProductCandidate,
} from "./productChoice";

const config = DEFAULT_CONFIG;
const p = (id: string, o: Partial<ProductCandidate> = {}): ProductCandidate => ({
  id,
  vendor: "wholefoods",
  title: id,
  unitQuantity: 12,
  stance: "acceptable",
  preferenceScore: 0,
  timesBought: 0,
  consecutiveBuys: 0,
  lastPriceCents: null,
  ...o,
});

// Vital Farms 12 eggs at $8.40 (70¢/egg) is the usual; 365 18 eggs at $9.00 (50¢/egg).
const vital = p("vital", { title: "Vital Farms", stance: "preferred", lastPriceCents: 840 });
const store18 = p("365-18", { title: "365 Eggs 18ct", unitQuantity: 18, lastPriceCents: 900 });

describe("unitPrice — 12 vs 18 pack normalization", () => {
  it.each([
    ["12 pack at $8.40", vital, {}, 70],
    ["18 pack at $9.00", store18, {}, 50],
    ["quote wins over last price", vital, { vital: 600 }, 50],
    ["no price", p("x"), {}, null],
  ] as const)("%s", (_, prod, quotes, out) => expect(unitPrice(prod, quotes)).toBe(out));
});

describe("pickPreferred — §4.4 step 3", () => {
  it.each([
    [
      "stance preferred first",
      [p("a", { preferenceScore: 5 }), p("b", { stance: "preferred" })],
      "b",
    ],
    [
      "else highest preference score",
      [p("a", { preferenceScore: 1 }), p("b", { preferenceScore: 2 })],
      "b",
    ],
    ["else most bought", [p("a", { timesBought: 3 }), p("b", { timesBought: 1 })], "a"],
    ["else by id (deterministic)", [p("b"), p("a")], "a"],
  ] as const)("%s", (_, products, id) => expect(pickPreferred(products)!.id).toBe(id));

  it("null for no products", () => expect(pickPreferred([])).toBeNull());
});

describe("chooseProduct — §4.4", () => {
  const vendors = ["wholefoods"];
  it.each([
    ["no candidates", [], {}, null, false, false, "No acceptable product from the cart's vendors"],
    [
      "rejected products are never candidates",
      [p("x", { stance: "rejected" })],
      {},
      null,
      false,
      false,
      null,
    ],
    [
      "off-vendor products are not candidates",
      [p("x", { vendor: "amazon" })],
      {},
      null,
      false,
      false,
      null,
    ],
    [
      "one candidate → choose it, no price check",
      [vital],
      {},
      "vital",
      false,
      false,
      "Only option: Vital Farms",
    ],
    [
      "cheaper per unit beyond the threshold → switch, with reason",
      [vital, store18],
      {},
      "365-18",
      true,
      true,
      "29% cheaper per egg than your usual Vital Farms",
    ],
    [
      "within the threshold → preferred",
      [vital, store18],
      { "365-18": 1110 },
      "vital",
      true,
      false,
      null,
    ],
    [
      "exactly at the threshold → preferred",
      [vital, store18],
      { "365-18": 1071 },
      "vital",
      true,
      false,
      null,
    ],
    ["quotes override last prices", [vital, store18], { vital: 600 }, "vital", true, false, null],
    [
      "preferred is also cheapest",
      [vital, store18],
      { "365-18": 2000 },
      "vital",
      true,
      false,
      "Your usual Vital Farms",
    ],
    [
      "no price for preferred → preferred",
      [p("vital", { title: "Vital Farms", stance: "preferred" }), store18],
      {},
      "vital",
      true,
      false,
      "Your usual Vital Farms (no price to compare)",
    ],
    [
      "no prices at all → preferred",
      [p("a", { stance: "preferred" }), p("b")],
      {},
      "a",
      true,
      false,
      null,
    ],
  ] as const)("%s", (_, products, quotes, chosen, priceCheck, switched, reason) => {
    const c = chooseProduct({ products, vendors, quotes, switchThreshold: 0.15, baseUnit: "egg" });
    expect(c.product?.id ?? null).toBe(chosen);
    expect(c.needsPriceCheck).toBe(priceCheck);
    expect(c.switched).toBe(switched);
    if (reason) expect(c.reason).toBe(reason);
  });

  it("explains a near miss", () => {
    const c = chooseProduct({
      products: [vital, store18],
      vendors,
      quotes: { "365-18": 1170 },
      switchThreshold: 0.15,
      baseUnit: "egg",
    });
    expect(c.reason).toBe("Your usual Vital Farms (365 Eggs 18ct is only 7% cheaper per egg)");
    expect(c.savingsRatio).toBeCloseTo(1 - 65 / 70, 9);
  });

  it("free products don't divide by zero", () => {
    const c = chooseProduct({
      products: [p("a", { stance: "preferred", lastPriceCents: 0 }), p("b", { lastPriceCents: 0 })],
      vendors,
      switchThreshold: 0.15,
      baseUnit: "egg",
    });
    expect(c.product!.id).toBe("a");
  });

  it("candidatesFor filters stance and vendor", () => {
    expect(
      candidatesFor(
        [vital, p("r", { stance: "rejected" }), p("amz", { vendor: "amazon" })],
        vendors,
      ).map((x) => x.id),
    ).toEqual(["vital"]);
  });

  it("switchEvent records a switch to the cheaper product only", () => {
    const sw = chooseProduct({
      products: [vital, store18],
      vendors,
      switchThreshold: 0.15,
      baseUnit: "egg",
    });
    expect(switchEvent(sw, 0.15)).toEqual({
      kind: "switch",
      fromProductId: "vital",
      toProductId: "365-18",
      thresholdBefore: 0.15,
      thresholdAfter: 0.15,
    });
    const stay = chooseProduct({
      products: [vital],
      vendors,
      switchThreshold: 0.15,
      baseUnit: "egg",
    });
    expect(switchEvent(stay, 0.15)).toBeNull();
  });
});

describe("learnFromOverride — §4.4 learning table", () => {
  it.each([
    [
      "override toward pricier preferred: +0.05",
      0.15,
      store18,
      vital,
      false,
      0.2,
      "override_to_preferred",
      null,
    ],
    ["… capped at 0.6", 0.58, store18, vital, false, 0.6, "override_to_preferred", null],
    [
      "override toward cheaper: −0.03, chosen score +1",
      0.15,
      vital,
      store18,
      false,
      0.12,
      "override_to_cheaper",
      1,
    ],
    ["… floored at 0", 0.02, vital, store18, false, 0, "override_to_cheaper", 1],
    [
      "override to a different (non-preferred) product",
      0.15,
      store18,
      p("other", { preferenceScore: 2 }),
      false,
      0.12,
      "override_to_cheaper",
      3,
    ],
    [
      "implicit swap: as above plus implicit_swap",
      0.15,
      vital,
      store18,
      true,
      0.12,
      "implicit_swap",
      1,
    ],
    [
      "implicit swap back to preferred still lowers",
      0.15,
      store18,
      vital,
      true,
      0.12,
      "implicit_swap",
      1,
    ],
  ] as const)("%s", (_, before, cart, chosen, implicit, after, kind, score) => {
    const l = learnFromOverride({
      switchThreshold: before,
      cart,
      chosen,
      preferred: vital,
      implicit,
      config,
    });
    expect(l.switchThreshold).toBeCloseTo(after, 9);
    expect(l.events).toEqual([
      {
        kind,
        fromProductId: cart.id,
        toProductId: chosen.id,
        thresholdBefore: before,
        thresholdAfter: l.switchThreshold,
      },
    ]);
    expect(l.productPatches).toEqual(
      score === null ? [] : [{ id: chosen.id, preferenceScore: score }],
    );
  });

  it("stays on the 0.01 grid over many steps", () => {
    let th = 0.15;
    for (let i = 0; i < 7; i++)
      th = learnFromOverride({
        switchThreshold: th,
        cart: vital,
        chosen: store18,
        preferred: vital,
        config,
      }).switchThreshold;
    expect(th).toBe(0);
    for (let i = 0; i < 20; i++)
      th = learnFromOverride({
        switchThreshold: th,
        cart: store18,
        chosen: vital,
        preferred: vital,
        config,
      }).switchThreshold;
    expect(th).toBe(0.6);
  });

  it("no-op when the override picks the cart's product", () => {
    expect(
      learnFromOverride({
        switchThreshold: 0.15,
        cart: vital,
        chosen: vital,
        preferred: vital,
        config,
      }),
    ).toEqual({ switchThreshold: 0.15, productPatches: [], events: [] });
  });

  it("no preferred product: treated as a different product", () => {
    expect(
      learnFromOverride({
        switchThreshold: 0.15,
        cart: vital,
        chosen: store18,
        preferred: null,
        config,
      }).events[0]!.kind,
    ).toBe("override_to_cheaper");
  });
});

describe("rejectProduct — never buy X", () => {
  it("sets stance rejected and logs reject", () => {
    expect(rejectProduct(vital, 0.15)).toEqual({
      switchThreshold: 0.15,
      productPatches: [{ id: "vital", stance: "rejected" }],
      events: [
        {
          kind: "reject",
          fromProductId: "vital",
          toProductId: null,
          thresholdBefore: 0.15,
          thresholdAfter: 0.15,
        },
      ],
    });
  });
  it("is idempotent", () => {
    expect(rejectProduct(p("x", { stance: "rejected" }), 0.15)).toEqual({
      switchThreshold: 0.15,
      productPatches: [],
      events: [],
    });
  });
});

describe("recordPurchase — stats and auto-promotion", () => {
  const at = "2026-10-20T16:00:00.000Z";
  const run = (products: ProductCandidate[], boughtId: string, price: number | null = 899) =>
    recordPurchase({
      products,
      boughtId,
      at,
      unitPriceCents: price,
      switchThreshold: 0.15,
      config,
    });

  it("updates times bought, streak, last price; resets other streaks", () => {
    const l = run([vital, p("365", { consecutiveBuys: 2 })], "vital");
    expect(l.productPatches).toEqual([
      {
        id: "vital",
        timesBought: 1,
        consecutiveBuys: 1,
        lastBoughtAt: at,
        lastPriceCents: 899,
        lastPriceAt: at,
      },
      { id: "365", consecutiveBuys: 0 },
    ]);
    expect(l.events).toEqual([]);
  });

  it("keeps the last price when the line had none", () => {
    expect(run([vital], "vital", null).productPatches[0]).toEqual({
      id: "vital",
      timesBought: 1,
      consecutiveBuys: 1,
      lastBoughtAt: at,
    });
  });

  it.each([
    ["2nd consecutive buy: no promotion", p("365", { consecutiveBuys: 1 }), false],
    ["3rd consecutive buy: promote to preferred", p("365", { consecutiveBuys: 2 }), true],
    [
      "rejected products are never promoted",
      p("365", { consecutiveBuys: 2, stance: "rejected" }),
      false,
    ],
  ] as const)("%s", (_, bought, promoted) => {
    const l = run([vital, bought], "365");
    const patch = l.productPatches.find((x) => x.id === "365")!;
    expect(patch.stance === "preferred").toBe(promoted);
    if (promoted) {
      expect(l.productPatches.find((x) => x.id === "vital")).toEqual({
        id: "vital",
        stance: "acceptable",
      });
      expect(l.events).toEqual([
        {
          kind: "auto_promote",
          fromProductId: "vital",
          toProductId: "365",
          thresholdBefore: 0.15,
          thresholdAfter: 0.15,
        },
      ]);
    } else expect(l.events).toEqual([]);
  });

  it("demotes a previous preferred that also had a streak to reset", () => {
    const l = run(
      [p("old", { stance: "preferred", consecutiveBuys: 1 }), p("365", { consecutiveBuys: 2 })],
      "365",
    );
    expect(l.productPatches.find((x) => x.id === "old")).toEqual({
      id: "old",
      consecutiveBuys: 0,
      stance: "acceptable",
    });
  });

  it("promotion with no previous preferred", () => {
    expect(run([p("365", { consecutiveBuys: 5 })], "365").events[0]).toMatchObject({
      kind: "auto_promote",
      fromProductId: null,
    });
  });

  it("an already-preferred product isn't re-promoted", () => {
    expect(run([p("v", { stance: "preferred", consecutiveBuys: 5 })], "v").events).toEqual([]);
  });

  it("throws for a product of another item", () => {
    expect(() => run([vital], "nope")).toThrow();
  });
});
