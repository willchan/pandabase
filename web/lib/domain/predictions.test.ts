import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import type { InventoryItem } from "./inventory";
import {
  cartQuantity,
  planCart,
  pleaseCheckList,
  pleaseCheckReason,
  restockReason,
  type CycleOverride,
  type PlanItemInput,
} from "./predictions";
import type { ProductCandidate } from "./productChoice";

const config = DEFAULT_CONFIG;
const now = "2026-10-24T17:00:00.000Z"; // Sat Oct 24, 10am LA; today + 3 = Oct 27
const at = (date: string) => `${date}T19:00:00.000Z`;

const eggs: InventoryItem = {
  trackingType: "velocity",
  emaDays: 1,
  defaultLocation: "fridge",
  reorderThreshold: null,
  shelfLifeDays: null,
};
const tp: InventoryItem = {
  trackingType: "static",
  emaDays: null,
  defaultLocation: "bathroom",
  reorderThreshold: 4,
  shelfLifeDays: null,
};

describe("restockReason — DESIGN §4.3", () => {
  it.each([
    [
      "velocity, runout ≤ today + 3",
      eggs,
      { onHand: 3, runoutAt: at("2026-10-27"), status: "low" },
      "runout",
    ],
    [
      "velocity, runout after today + 3",
      eggs,
      { onHand: 5, runoutAt: at("2026-10-28"), status: "stocked" },
      null,
    ],
    [
      "velocity, already out",
      eggs,
      { onHand: 0, runoutAt: at("2026-10-01"), status: "out" },
      "runout",
    ],
    [
      "velocity, no runout (no EMA / never seen)",
      eggs,
      { onHand: 0, runoutAt: null, status: "unknown" },
      null,
    ],
    [
      "override critical",
      eggs,
      { onHand: 9, runoutAt: at("2026-11-30"), status: "critical" },
      "critical",
    ],
    ["override consumed", tp, { onHand: 0, runoutAt: null, status: "consumed" }, "consumed"],
    [
      "static, on_hand ≤ reorder threshold",
      tp,
      { onHand: 4, runoutAt: null, status: "low" },
      "static_threshold",
    ],
    ["static, above threshold", tp, { onHand: 5, runoutAt: null, status: "stocked" }, null],
    [
      "static without threshold",
      { ...tp, reorderThreshold: null },
      { onHand: 0, runoutAt: null, status: "out" },
      null,
    ],
  ] as const)("%s", (_, item, estimate, reason) => {
    expect(restockReason(item, estimate, now, config)).toBe(reason);
  });
});

describe("cartQuantity", () => {
  it.each([
    ["12-egg cartons: 7 days at 1/day with 1 on hand → 6 eggs → 1 carton", eggs, 1, 12, 1],
    ["need exactly one pack (no float round-up)", { ...eggs, emaDays: 7 / 12 }, 0, 12, 1],
    ["need 14 eggs in 12-packs → 2", { ...eggs, emaDays: 0.5 }, 0, 12, 2],
    ["need 14 eggs in 18-packs → 1", { ...eggs, emaDays: 0.5 }, 0, 18, 1],
    ["plenty on hand still buys the minimum 1", eggs, 30, 12, 1],
    ["static → 1", tp, 0, 12, 1],
    ["velocity without EMA → 1", { ...eggs, emaDays: null }, 0, 12, 1],
  ] as const)("%s", (_, item, onHand, unit, qty) => {
    expect(cartQuantity(item, onHand, unit, config)).toBe(qty);
  });
});

const prod = (id: string, o: Partial<ProductCandidate> = {}): ProductCandidate => ({
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

describe("planCart — flags, overrides, product choice", () => {
  const items: PlanItemInput[] = [
    {
      itemId: "eggs",
      item: { ...eggs, emaDays: 0.5 },
      baseUnit: "egg",
      switchThreshold: 0.15,
      estimate: { onHand: 0, runoutAt: at("2026-10-23"), status: "out" },
      products: [
        prod("vital", { stance: "preferred", lastPriceCents: 840 }),
        prod("365-18", { unitQuantity: 18, lastPriceCents: 900 }),
      ],
    },
    {
      itemId: "tp",
      item: tp,
      baseUnit: "roll",
      switchThreshold: 0.15,
      estimate: { onHand: 2, runoutAt: null, status: "low" },
      products: [prod("tp-24", { unitQuantity: 24 })],
    },
    {
      itemId: "rice",
      item: { ...eggs, emaDays: 1 },
      baseUnit: "oz",
      switchThreshold: 0.15,
      estimate: { onHand: 40, runoutAt: at("2026-12-01"), status: "stocked" },
      products: [prod("rice-32", { unitQuantity: 32 })],
    },
  ];
  const o = (
    kind: CycleOverride["kind"],
    itemId: string | null,
    extra: Partial<CycleOverride> = {},
  ): CycleOverride => ({
    kind,
    itemId,
    freeText: null,
    quantity: null,
    productId: null,
    ...extra,
  });
  const plan = (overrides: CycleOverride[] = [], vendors = ["wholefoods"]) =>
    planCart({ items, overrides, vendors, now, config });
  const line = (p: ReturnType<typeof plan>, id: string) => p.lines.find((l) => l.itemId === id);

  it("flags restock items and chooses products", () => {
    const p = plan();
    expect(p.lines.map((l) => l.itemId)).toEqual(["eggs", "tp"]);
    // 18-pack is 50¢/egg vs 70¢ → switch; 14 eggs needed → one 18-pack.
    expect(line(p, "eggs")).toMatchObject({
      product: { id: "365-18" },
      quantity: 1,
      reason: "runout",
    });
    expect(line(p, "tp")).toMatchObject({
      product: { id: "tp-24" },
      quantity: 1,
      reason: "static_threshold",
    });
    expect(p.needsPriceCheckItemIds).toEqual(["eggs"]);
    expect(p.skippedItemIds).toEqual([]);
  });

  it.each([
    ["skip removes", [o("skip", "eggs")], { eggs: undefined }, ["eggs"]],
    ["skip of an unflagged item does nothing", [o("skip", "rice")], { rice: undefined }, []],
    ["qty replaces", [o("qty", "tp", { quantity: 3 })], { tp: 3 }, []],
    ["qty inserts an unflagged item", [o("qty", "rice", { quantity: 2 })], { rice: 2 }, []],
    [
      "add inserts an unflagged item with its computed quantity",
      [o("add", "rice")],
      { rice: 1 },
      [],
    ],
    [
      "add after skip re-adds",
      [o("skip", "eggs"), o("add", "eggs", { quantity: 2 })],
      { eggs: 2 },
      [],
    ],
    [
      "add of an item outside the plan input",
      [o("add", "mystery", { quantity: 1 })],
      { mystery: 1 },
      [],
    ],
  ] as const)("override: %s", (_, overrides, expected, skipped) => {
    const p = plan([...overrides]);
    for (const [id, qty] of Object.entries(expected)) expect(line(p, id)?.quantity).toBe(qty);
    expect(p.skippedItemIds).toEqual(skipped);
  });

  it("add with free text inserts a one-off line", () => {
    const p = plan([
      o("add", null, { freeText: "birthday candles" }),
      o("add", null, { freeText: "balloons", quantity: 2 }),
      o("qty", null),
    ]);
    expect(
      p.lines.filter((l) => l.freeText).map((l) => [l.freeText, l.quantity, l.itemId]),
    ).toEqual([
      ["birthday candles", 1, null],
      ["balloons", 2, null],
    ]);
  });

  it("product override replaces the product and re-sizes unless a human set the quantity", () => {
    expect(line(plan([o("product", "eggs", { productId: "vital" })]), "eggs")).toMatchObject({
      product: { id: "vital" },
      quantity: 2,
      overrides: ["product"],
    });
    expect(
      line(
        plan([o("qty", "eggs", { quantity: 5 }), o("product", "eggs", { productId: "vital" })]),
        "eggs",
      ),
    ).toMatchObject({ product: { id: "vital" }, quantity: 5 });
    // Unknown product id: keep the chosen one.
    expect(line(plan([o("product", "eggs", { productId: "nope" })]), "eggs")).toMatchObject({
      product: { id: "365-18" },
    });
  });

  it("no candidate from the cart vendors → line without a product", () => {
    // Sized in base units (14 eggs) so a human can still act on it.
    expect(line(plan([], ["amazon"]), "eggs")).toMatchObject({ product: null, quantity: 14 });
  });
});

describe("pleaseCheckReason / pleaseCheckList — PRD §4.1", () => {
  const base = {
    item: { ...eggs, auditHint: null },
    estimate: { runoutAt: at("2026-10-30"), status: "stocked" as const },
    lastVerifiedAt: null,
    inPlan: false,
    now,
    config,
  };
  it.each([
    ["runout within today + 3 + 4 days", {}, "near_runout"],
    ["already in the plan", { inPlan: true }, null],
    [
      "runout beyond the margin",
      { estimate: { runoutAt: at("2026-11-01"), status: "stocked" } },
      null,
    ],
    ["no runout (no EMA)", { estimate: { runoutAt: null, status: "unknown" } }, null],
    [
      "audit hint, never counted",
      {
        item: { ...tp, auditHint: "count the rolls" },
        estimate: { runoutAt: null, status: "stocked" },
      },
      "audit_hint",
    ],
    [
      "audit hint, counted recently",
      {
        item: { ...tp, auditHint: "count the rolls" },
        estimate: { runoutAt: null, status: "stocked" },
        lastVerifiedAt: at("2026-10-10"),
      },
      null,
    ],
    [
      "audit hint, counted > 21 days ago",
      {
        item: { ...tp, auditHint: "count the rolls" },
        estimate: { runoutAt: null, status: "stocked" },
        lastVerifiedAt: at("2026-09-01"),
      },
      "audit_hint",
    ],
  ] as const)("%s", (_, o, want) => {
    expect(pleaseCheckReason({ ...base, ...o } as Parameters<typeof pleaseCheckReason>[0])).toBe(
      want,
    );
  });

  it("orders near-runout (soonest first) before audit hints and caps the list", () => {
    const list = pleaseCheckList(
      [
        { id: "a", reason: "audit_hint" as const, runoutAt: null },
        { id: "b", reason: "near_runout" as const, runoutAt: at("2026-10-30") },
        { id: "c", reason: "near_runout" as const, runoutAt: at("2026-10-29") },
        ...Array.from({ length: 6 }, (_, i) => ({
          id: `z${i}`,
          reason: "audit_hint" as const,
          runoutAt: null,
        })),
      ],
      config,
    );
    expect(list.map((x) => x.id).slice(0, 3)).toEqual(["c", "b", "a"]);
    expect(list).toHaveLength(config.checkin.pleaseCheckMax);
  });
});
