import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, withSettings, type Config } from "../config";
import type { InventoryItem } from "./inventory";
import type { ProductCandidate } from "./productChoice";
import {
  chooseStore,
  costcoListLine,
  costcoTiming,
  learnStoreOverride,
  packLastsDays,
  vendorLabel,
  type StoreChoiceInput,
} from "./storeChoice";

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
const eggsItem: InventoryItem = {
  trackingType: "velocity",
  emaDays: 0.5, // two eggs a day
  defaultLocation: "fridge",
  reorderThreshold: null,
  shelfLifeDays: 35,
};

// Usual Whole Foods eggs: 12 at $8.40 (70¢/egg). Kirkland 24 at $9.60 (40¢/egg, 43% cheaper).
const wfEggs = p("wf", { title: "Vital Farms", stance: "preferred", lastPriceCents: 840 });
const kirkland = p("ks", {
  vendor: "costco",
  title: "Kirkland Organic Eggs 24ct",
  unitQuantity: 24,
  lastPriceCents: 960,
});

const input = (o: Partial<StoreChoiceInput> = {}): StoreChoiceInput => ({
  item: eggsItem,
  baseUnit: "egg",
  products: [wfEggs, kirkland],
  switchThreshold: 0.15,
  pin: null,
  freezesBulk: false,
  config,
  ...o,
});

describe("chooseStore — §4.8", () => {
  it("Costco when cheaper by more than the threshold and the pack keeps", () => {
    const c = chooseStore(input());
    expect(c).toMatchObject({ store: "costco", why: "cheaper", costco: { id: "ks" } });
    expect(c.savingsRatio).toBeCloseTo(3 / 7);
    expect(c.regular.product?.id).toBe("wf");
    expect(c.reason).toBe("Costco: 43% cheaper per egg than Vital Farms");
  });

  it.each([
    ["never bought at Costco", { products: [wfEggs] }, "regular", "no_costco_product"],
    ["only bought at Costco", { products: [kirkland] }, "costco", "costco_only"],
    [
      "a rejected Costco product doesn't count",
      {
        products: [wfEggs, { ...kirkland, stance: "rejected" as const }],
      },
      "regular",
      "no_costco_product",
    ],
    [
      "a rejected regular product leaves Costco only",
      {
        products: [{ ...wfEggs, stance: "rejected" as const }, kirkland],
      },
      "costco",
      "costco_only",
    ],
    ["pinned to Whole Foods", { pin: "regular" as const }, "regular", "pinned"],
    [
      "pinned to Costco",
      { pin: "costco" as const, products: [{ ...wfEggs, lastPriceCents: 400 }, kirkland] },
      "costco",
      "pinned",
    ],
    [
      "a Costco pin without a Costco product stays regular",
      {
        pin: "costco" as const,
        products: [wfEggs],
      },
      "regular",
      "no_costco_product",
    ],
    [
      "no regular price",
      { products: [{ ...wfEggs, lastPriceCents: null }, kirkland] },
      "regular",
      "no_price",
    ],
    [
      "no Costco price",
      { products: [wfEggs, { ...kirkland, lastPriceCents: null }] },
      "regular",
      "no_price",
    ],
    [
      "a regular price of 0",
      { products: [{ ...wfEggs, lastPriceCents: 0 }, kirkland] },
      "regular",
      "no_price",
    ],
  ] as const)("%s", (_, o, store, why) => {
    expect(chooseStore(input(o))).toMatchObject({ store, why });
  });

  it("stays regular at exactly the threshold (strictly more than)", () => {
    // 15% cheaper: Costco 24 at $14.28 = 59.5¢/egg vs 70¢.
    const c = chooseStore(input({ products: [wfEggs, { ...kirkland, lastPriceCents: 1428 }] }));
    expect(c).toMatchObject({ store: "regular", why: "not_cheaper_enough" });
    expect(c.savingsRatio).toBeCloseTo(0.15);
    expect(c.reason).toBe("Costco is only 15% cheaper per egg");
  });

  it("says when Costco isn't cheaper at all", () => {
    const c = chooseStore(input({ products: [wfEggs, { ...kirkland, lastPriceCents: 2400 }] }));
    expect(c.reason).toBe("Costco isn't cheaper per egg");
  });

  it("a household threshold from settings moves the line", () => {
    const strict = withSettings({ "costco.switchThreshold": 0.5 }).config;
    expect(chooseStore(input({ config: strict }))).toMatchObject({
      store: "regular",
      why: "not_cheaper_enough",
    });
  });

  it("uses this cycle's quote for the regular product", () => {
    // Whole Foods eggs on sale at $5.40 (45¢/egg): Costco is only 11% cheaper.
    expect(chooseStore(input({ quotes: { wf: 540 } })).store).toBe("regular");
  });

  describe("spoilage", () => {
    // Berries: one box lasts 3 days, keeps 5; Costco's 4-box pack lasts 12.
    const berries: InventoryItem = { ...eggsItem, emaDays: 3, shelfLifeDays: 5 };
    const wf = p("wf-b", { unitQuantity: 1, lastPriceCents: 500 });
    const ks = p("ks-b", {
      vendor: "costco",
      title: "Berries 4pk",
      unitQuantity: 4,
      lastPriceCents: 1200,
    });
    const base = { item: berries, baseUnit: "box", products: [wf, ks] };

    it("a pack that outlasts the shelf life stays regular", () => {
      const c = chooseStore(input(base));
      expect(c).toMatchObject({ store: "regular", why: "spoils_first" });
      expect(c.reason).toBe("Costco's pack lasts ~12 days but keeps 5");
    });
    it.each([
      ["the household freezes part of it", { freezesBulk: true }],
      ["it's a freezer item", { item: { ...berries, defaultLocation: "freezer" } }],
      ["it has no shelf life", { item: { ...berries, shelfLifeDays: null } }],
      ["it has no EMA yet", { item: { ...berries, emaDays: null } }],
      ["it's a static item", { item: { ...berries, trackingType: "static" as const } }],
    ])("goes to Costco when %s", (_, o) => {
      expect(chooseStore(input({ ...base, ...o })).store).toBe("costco");
    });
  });
});

describe("packLastsDays", () => {
  it.each([
    ["24 eggs at 2 a day", eggsItem, 12],
    ["no EMA", { ...eggsItem, emaDays: null }, null],
    ["zero EMA", { ...eggsItem, emaDays: 0 }, null],
    ["static", { ...eggsItem, trackingType: "static" as const }, null],
  ] as const)("%s", (_, item, out) => expect(packLastsDays(item, kirkland)).toBe(out));
});

describe("vendorLabel", () => {
  it.each([
    ["wholefoods", "Whole Foods"],
    ["amazon", "Amazon"],
    ["costco", "Costco"],
    ["traderjoes", "traderjoes"],
  ])("%s", (v, out) => expect(vendorLabel(v)).toBe(out));
});

describe("costcoTiming — a Costco item in this week's plan", () => {
  // Runs out Tuesday Nov 17 (household time).
  const runout = { runoutAt: "2026-11-17T20:00:00Z", status: "stocked" as const };
  it.each([
    ["no trip planned", runout, null, "bridge"],
    ["trip before the runout", runout, "2026-11-16", "wait"],
    ["trip on the runout day", runout, "2026-11-17", "wait"],
    ["trip after the runout", runout, "2026-11-18", "bridge"],
    [
      "critical bridges even with a trip",
      { runoutAt: null, status: "critical" as const },
      "2026-11-16",
      "bridge",
    ],
    [
      "out bridges even with a trip",
      { runoutAt: null, status: "consumed" as const },
      "2026-11-16",
      "bridge",
    ],
    [
      "no runout known waits for the trip",
      { runoutAt: null, status: "stocked" as const },
      "2026-11-16",
      "wait",
    ],
  ] as const)("%s", (_, estimate, tripDate, out) => {
    expect(costcoTiming({ estimate, tripDate, config })).toBe(out);
  });
});

describe("costcoListLine — §4.8 trip list", () => {
  const now = "2026-11-15T18:00:00Z"; // Sunday Nov 15, household time
  const tripDate = "2026-11-21"; // 6 days out; next trip ~Dec 26
  const line = (o: Partial<Parameters<typeof costcoListLine>[0]> = {}, c: Config = config) =>
    costcoListLine({
      item: { ...eggsItem, shelfLifeDays: null },
      estimate: { onHand: 10, runoutAt: "2026-11-20T18:00:00Z", status: "stocked" },
      product: kirkland,
      tripDate,
      freezesBulk: false,
      now,
      config: c,
      ...o,
    });

  it("covers until the next trip: 35 days at 2 eggs/day from 0 left = 70 eggs = 3 packs", () => {
    // 10 eggs last 5 days, so nothing is left at the trip.
    expect(line()).toEqual({ reason: "runout", quantity: 3 });
  });
  it("counts what's left at the trip", () => {
    // 40 eggs on hand, 12 used before the trip, 28 left: 70 − 28 = 42 → 2 packs.
    expect(
      line({ estimate: { onHand: 40, runoutAt: "2026-12-05T18:00:00Z", status: "stocked" } }),
    ).toEqual({ reason: "runout", quantity: 2 });
  });
  it("leaves off items that last past the trip after", () => {
    expect(
      line({ estimate: { onHand: 200, runoutAt: "2027-02-01T18:00:00Z", status: "stocked" } }),
    ).toBeNull();
  });
  it("the window ends at trip + tripGapDays", () => {
    const at = (runoutAt: string) =>
      line({ estimate: { onHand: 80, runoutAt, status: "stocked" } })?.reason ?? null;
    expect(at("2026-12-26T18:00:00Z")).toBe("runout");
    expect(at("2026-12-27T18:00:00Z")).toBeNull();
  });
  it("leaves off lapsed items", () => {
    expect(
      line({ estimate: { onHand: 0, runoutAt: "2026-08-01T18:00:00Z", status: "stocked" } }),
    ).toBeNull();
  });
  it("no runout known → not on the list", () => {
    expect(line({ estimate: { onHand: 0, runoutAt: null, status: "stocked" } })).toBeNull();
  });
  it.each(["critical", "consumed"] as const)("%s is always on the list", (status) => {
    expect(line({ estimate: { onHand: 0, runoutAt: null, status } })).toEqual({
      reason: status,
      quantity: 3,
    });
  });
  // Owner decision 2026-11-15: an item that's out with a trip within `lowWithinDays` was both
  // bridged in the weekly cart (`costcoTiming` → needed now) and on the trip list, so it could be
  // bought twice. The weekly cart buys it; the trip list leaves it off.
  it.each(["critical", "consumed"] as const)(
    "%s with a trip within lowWithinDays is left to the weekly cart (bought once)",
    (status) => {
      const out = { estimate: { onHand: 0, runoutAt: null, status } };
      expect(line({ ...out, tripDate: "2026-11-18" })).toBeNull(); // today + 3
      expect(line({ ...out, tripDate: "2026-11-15" })).toBeNull(); // today
      expect(line({ ...out, tripDate: "2026-11-19" })).toEqual({ reason: status, quantity: 3 });
    },
  );
  it("caps perishables nobody freezes at the shelf life", () => {
    // Keeps 21 days: 42 eggs → 2 packs instead of 3.
    expect(line({ item: { ...eggsItem, shelfLifeDays: 21 } })).toEqual({
      reason: "runout",
      quantity: 2,
    });
  });
  it("no cap when the household freezes part of the pack, or it's a freezer item", () => {
    const item = { ...eggsItem, shelfLifeDays: 21 };
    expect(line({ item, freezesBulk: true })?.quantity).toBe(3);
    expect(line({ item: { ...item, defaultLocation: "freezer" } })?.quantity).toBe(3);
  });
  it("at least one pack, and exact fits don't round up", () => {
    // 70 eggs needed exactly, in a 70-egg pack.
    expect(line({ product: { ...kirkland, unitQuantity: 70 } })?.quantity).toBe(1);
    // A trip in the past counts as today.
    expect(line({ tripDate: "2026-11-10" })?.quantity).toBe(3);
  });
  it("static items at the threshold get staticCartUnits", () => {
    const tp: InventoryItem = {
      ...eggsItem,
      trackingType: "static",
      emaDays: null,
      reorderThreshold: 1,
    };
    expect(line({ item: tp, estimate: { onHand: 1, runoutAt: null, status: "stocked" } })).toEqual({
      reason: "static_threshold",
      quantity: config.staticCartUnits,
    });
    expect(
      line({ item: tp, estimate: { onHand: 2, runoutAt: null, status: "stocked" } }),
    ).toBeNull();
    expect(
      line({
        item: { ...tp, reorderThreshold: null },
        estimate: { onHand: 0, runoutAt: null, status: "stocked" },
      }),
    ).toBeNull();
  });
  it("velocity without an EMA gets staticCartUnits", () => {
    expect(line({ item: { ...eggsItem, emaDays: null } })).toEqual({
      reason: "runout",
      quantity: config.staticCartUnits,
    });
  });
});

describe("learnStoreOverride — threshold learning bounds", () => {
  const learn = (
    store: "costco" | "regular",
    why: Parameters<typeof learnStoreOverride>[0]["choice"]["why"],
    to: "costco" | "regular",
    t: number,
  ) => learnStoreOverride({ choice: { store, why }, to, switchThreshold: t, config });

  it("away from a price-based Costco choice raises the threshold and pins", () => {
    expect(learn("costco", "cheaper", "regular", 0.15)).toEqual({
      pin: "regular",
      switchThreshold: 0.2,
      event: { kind: "store_override_to_regular", thresholdBefore: 0.15, thresholdAfter: 0.2 },
    });
  });
  it("toward Costco against a price-based choice lowers it", () => {
    expect(learn("regular", "not_cheaper_enough", "costco", 0.15)).toMatchObject({
      pin: "costco",
      switchThreshold: 0.12,
      event: { kind: "store_override_to_costco" },
    });
  });
  it.each([
    ["cap", "costco", "cheaper", "regular", 0.58, 0.6],
    ["floor", "regular", "not_cheaper_enough", "costco", 0.01, 0],
  ] as const)("clamps at the %s", (_, store, why, to, before, after) => {
    expect(learn(store, why, to, before).switchThreshold).toBe(after);
  });
  it.each([
    ["same store", "costco", "cheaper", "costco"],
    ["spoilage", "regular", "spoils_first", "costco"],
    ["no price", "regular", "no_price", "costco"],
    ["already pinned", "regular", "pinned", "costco"],
    ["Costco only", "costco", "costco_only", "regular"],
  ] as const)("%s: pin only, threshold unchanged", (_, store, why, to) => {
    expect(learn(store, why, to, 0.15)).toEqual({ pin: to, switchThreshold: 0.15, event: null });
  });
});
