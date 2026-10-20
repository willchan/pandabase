import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import {
  checkOverbuy,
  emptyState,
  estimateItem,
  estimateLocation,
  expiredQuantity,
  onHandAt,
  projectInventory,
  shelfLifeDiscards,
  type InventoryEvent,
  type InventoryItem,
  type InventoryState,
} from "./inventory";

const config = DEFAULT_CONFIG;
const ctx = { away: [], config };
/** Noon LA on Oct `d` 2026 (d may be fractional). */
const t = (d: number) =>
  new Date(Date.parse("2026-10-01T19:00:00.000Z") + (d - 1) * 86_400_000).toISOString();

const eggs: InventoryItem = {
  trackingType: "velocity",
  emaDays: 1, // one egg a day
  defaultLocation: "fridge",
  reorderThreshold: null,
  shelfLifeDays: null,
};
const toiletPaper: InventoryItem = {
  trackingType: "static",
  emaDays: null,
  defaultLocation: "bathroom",
  reorderThreshold: 4,
  shelfLifeDays: null,
};

const ev = (
  kind: InventoryEvent["kind"],
  quantity: number | null,
  day: number,
  extra: Partial<InventoryEvent> = {},
): InventoryEvent => ({
  kind,
  location: "fridge",
  quantity,
  toLocation: null,
  statusOverride: null,
  occurredAt: t(day),
  trust: "confirmed",
  ...extra,
});

const state = (s: Partial<InventoryState>): InventoryState => ({ ...emptyState("fridge"), ...s });
const fridgeOf = (events: InventoryEvent[], item = eggs) =>
  projectInventory(item, events, ctx).states.find((s) => s.location === "fridge")!;

describe("projectInventory — DESIGN §4.2 event rules", () => {
  it.each([
    [
      "acquired: anchor = estimate_at(t) + qty",
      [ev("acquired", 12, 1), ev("acquired", 12, 5)],
      { anchorQty: 20, anchorAt: t(5), anchorKind: "acquired" },
    ],
    [
      "observed: absolute anchor, last_verified_at",
      [ev("acquired", 12, 1), ev("observed", 3, 5)],
      { anchorQty: 3, anchorAt: t(5), anchorKind: "observed", lastVerifiedAt: t(5) },
    ],
    [
      "consumed: anchor 0 and override consumed",
      [ev("acquired", 12, 1), ev("consumed", 0, 5, { statusOverride: "consumed" })],
      { anchorQty: 0, anchorAt: t(5), statusOverride: "consumed" },
    ],
    [
      "consumed without an explicit override still sets consumed",
      [ev("acquired", 12, 1), ev("consumed", 0, 5)],
      { anchorQty: 0, statusOverride: "consumed" },
    ],
    [
      "critical (observed, null qty): sets the override, keeps the anchor",
      [ev("acquired", 12, 1), ev("observed", null, 5, { statusOverride: "critical" })],
      {
        anchorQty: 12,
        anchorAt: t(1),
        anchorKind: "acquired",
        statusOverride: "critical",
        lastVerifiedAt: null,
      },
    ],
    [
      "the next acquired clears the override",
      [
        ev("acquired", 12, 1),
        ev("observed", null, 5, { statusOverride: "critical" }),
        ev("acquired", 12, 6),
      ],
      { anchorQty: 19, statusOverride: null },
    ],
    [
      "a fresh count clears an earlier override",
      [ev("consumed", 0, 1), ev("observed", 4, 2)],
      { anchorQty: 4, statusOverride: null },
    ],
    [
      "discarded subtracts from the decayed estimate",
      [ev("acquired", 12, 1), ev("discarded", 5, 3)],
      { anchorQty: 5, anchorAt: t(3), anchorKind: "acquired" },
    ],
    [
      "presumed_discarded (shelf life) subtracts and never goes negative",
      [ev("acquired", 2, 1), ev("presumed_discarded", 5, 2, { trust: "provisional" })],
      { anchorQty: 0, anchorKind: "acquired" },
    ],
    [
      "discard with an override applies it",
      [ev("discarded", 0, 1, { statusOverride: "critical" })],
      { anchorQty: 0, anchorKind: "observed", statusOverride: "critical" },
    ],
    [
      "expired events are ignored",
      [ev("acquired", 12, 1), ev("acquired", 100, 2, { trust: "expired" })],
      { anchorQty: 12, anchorAt: t(1) },
    ],
    [
      "events are folded in occurred_at order",
      [ev("observed", 3, 5), ev("acquired", 12, 1)],
      { anchorQty: 3, anchorAt: t(5) },
    ],
  ] as const)("%s", (_, events, expected) => {
    expect(fridgeOf([...events])).toMatchObject(expected);
  });

  it("moved: subtract from source, add to destination; freezer stamps frozen_at", () => {
    const { states } = projectInventory(
      eggs,
      [ev("acquired", 12, 1), ev("moved", 4, 3, { toLocation: "freezer" })],
      ctx,
    );
    expect(states.find((s) => s.location === "fridge")).toMatchObject({
      anchorQty: 6,
      anchorAt: t(3),
    });
    expect(states.find((s) => s.location === "freezer")).toMatchObject({
      anchorQty: 4,
      anchorAt: t(3),
      anchorKind: "acquired",
      frozenAt: t(3),
    });
  });

  it("moving everything out of the freezer clears frozen_at; non-freezer moves don't stamp it", () => {
    const { states } = projectInventory(
      eggs,
      [
        ev("acquired", 4, 1, { location: "freezer" }),
        ev("moved", 4, 2, { location: "freezer", toLocation: "fridge" }),
      ],
      ctx,
    );
    expect(states.find((s) => s.location === "freezer")).toMatchObject({
      anchorQty: 0,
      frozenAt: null,
    });
    expect(states.find((s) => s.location === "fridge")).toMatchObject({
      anchorQty: 4,
      frozenAt: null,
    });
  });

  it("static items don't decay", () => {
    expect(fridgeOf([ev("acquired", 12, 1), ev("acquired", 12, 20)], toiletPaper)).toMatchObject({
      anchorQty: 24,
    });
  });

  it("logs estimate_vs_observed for every counted observation (diagnostic only)", () => {
    const { estimateVsObserved } = projectInventory(
      eggs,
      [
        ev("acquired", 12, 1),
        ev("observed", 3, 5),
        ev("observed", null, 6, { statusOverride: "critical" }),
      ],
      ctx,
    );
    expect(estimateVsObserved).toEqual([
      { location: "fridge", at: t(5), estimated: 8, observed: 3 },
    ]);
  });
});

describe("onHandAt", () => {
  it.each([
    ["decays one unit per ema days", eggs, state({ anchorQty: 12, anchorAt: t(1) }), t(4), 9],
    ["never below zero", eggs, state({ anchorQty: 2, anchorAt: t(1) }), t(10), 0],
    ["no decay before the anchor", eggs, state({ anchorQty: 2, anchorAt: t(5) }), t(1), 2],
    ["no anchor", eggs, state({}), t(4), 0],
    ["static: on_hand = anchor", toiletPaper, state({ anchorQty: 7, anchorAt: t(1) }), t(30), 7],
    [
      "velocity without EMA: no decay",
      { ...eggs, emaDays: null },
      state({ anchorQty: 7, anchorAt: t(1) }),
      t(30),
      7,
    ],
    [
      "frozen reserve doesn't decay",
      eggs,
      state({ location: "freezer", anchorQty: 4, anchorAt: t(1) }),
      t(30),
      4,
    ],
    [
      "freezer items decay in the freezer",
      { ...eggs, defaultLocation: "freezer" },
      state({ location: "freezer", anchorQty: 4, anchorAt: t(1) }),
      t(3),
      2,
    ],
  ] as const)("%s", (_, item, s, at, out) => {
    expect(onHandAt(s, item, at, ctx)).toBeCloseTo(out, 9);
  });

  it("subtracts away days", () => {
    const away = [{ startsOn: "2026-10-02", endsOn: "2026-10-03" }];
    expect(
      onHandAt(state({ anchorQty: 12, anchorAt: t(1) }), eggs, t(6), { away, config }),
    ).toBeCloseTo(9, 9);
  });
});

describe("estimateLocation — status", () => {
  // "now" = Oct 10 noon LA; today + 3 = Oct 13.
  const now = t(10);
  it.each([
    ["out: nothing left", eggs, state({ anchorQty: 5, anchorAt: t(1) }), "out", 0],
    ["low: runs out within 3 days", eggs, state({ anchorQty: 12, anchorAt: t(1) }), "low", 3],
    ["low: runout on today + 3", eggs, state({ anchorQty: 12.4, anchorAt: t(1) }), "low", 3.4],
    [
      "stocked: runs out after today + 3",
      eggs,
      state({ anchorQty: 14, anchorAt: t(1) }),
      "stocked",
      5,
    ],
    [
      "override wins over the estimate",
      eggs,
      state({ anchorQty: 30, anchorAt: t(1), statusOverride: "critical" }),
      "critical",
      21,
    ],
    [
      "consumed override",
      eggs,
      state({ anchorQty: 0, anchorAt: t(9), statusOverride: "consumed" }),
      "consumed",
      0,
    ],
    ["unknown: never seen", eggs, state({}), "unknown", 0],
    [
      "static low: ≤ reorder threshold",
      toiletPaper,
      state({ anchorQty: 4, anchorAt: t(1) }),
      "low",
      4,
    ],
    ["static stocked", toiletPaper, state({ anchorQty: 5, anchorAt: t(1) }), "stocked", 5],
    ["static out", toiletPaper, state({ anchorQty: 0, anchorAt: t(1) }), "out", 0],
    [
      "static without threshold",
      { ...toiletPaper, reorderThreshold: null },
      state({ anchorQty: 1, anchorAt: t(1) }),
      "stocked",
      1,
    ],
    [
      "velocity without EMA",
      { ...eggs, emaDays: null },
      state({ anchorQty: 1, anchorAt: t(1) }),
      "stocked",
      1,
    ],
  ] as const)("%s", (_, item, s, status, onHand) => {
    const e = estimateLocation(item, s, now, ctx);
    expect(e.status).toBe(status);
    expect(e.onHand).toBeCloseTo(onHand, 9);
  });

  it("runout = anchor_at + anchor_qty × ema, plus away days", () => {
    const s = state({ anchorQty: 12, anchorAt: t(1) });
    expect(estimateLocation(eggs, s, t(2), ctx).runoutAt).toBe(t(13));
    const away = [{ startsOn: "2026-10-05", endsOn: "2026-10-06" }];
    expect(estimateLocation(eggs, s, t(2), { away, config }).runoutAt).toBe(t(15));
    expect(estimateLocation(eggs, s, t(20), ctx).runoutAt).toBe(t(13)); // already out
    expect(estimateLocation(toiletPaper, s, t(2), ctx).runoutAt).toBeNull();
  });
});

describe("shelf life", () => {
  const milk: InventoryItem = { ...eggs, emaDays: 10, shelfLifeDays: 7 }; // 1 unit lasts 10 days
  const acquisitions = [
    { at: t(1), qty: 2 },
    { at: t(6), qty: 1 },
  ];
  const s = state({ anchorQty: 3, anchorAt: t(6) });

  it.each([
    ["nothing expired inside the window", t(7), 0],
    ["units older than shelf_life_days are dropped (FIFO)", t(10), 3 - 0.4 - 1],
    ["everything expired", t(20), 1.6],
  ])("%s", (_, now, expired) => {
    const e = estimateLocation(milk, s, now, ctx, acquisitions);
    expect(e.expiredQty).toBeCloseTo(expired, 9);
  });

  it("drops expired units from on_hand and moves runout earlier", () => {
    const e = estimateLocation(milk, s, t(10), ctx, acquisitions);
    expect(e.onHand).toBeCloseTo(1, 9);
    expect(e.runoutAt).toBe(t(20));
    const all = estimateLocation(milk, s, t(20), ctx, acquisitions);
    expect(all).toMatchObject({ onHand: 0, status: "out", runoutAt: t(20) });
  });

  it.each([
    ["no shelf life", { ...milk, shelfLifeDays: null }, "fridge", 3, [], 0],
    ["frozen reserve", milk, "freezer", 3, [], 0],
    ["nothing on hand", milk, "fridge", 0, [], 0],
    ["acquired today is fresh", milk, "fridge", 3, [{ at: t(30), qty: 3 }], 0],
    ["acquisitions after now don't count", milk, "fridge", 3, [{ at: t(31), qty: 3 }], 3],
  ] as const)("expiredQuantity: %s", (_, item, location, onHand, acqs, out) => {
    expect(expiredQuantity(item, location, onHand, acqs, t(30))).toBe(out);
  });

  it("shelfLifeDiscards emits provisional presumed_discarded events", () => {
    const states = [s, state({ location: "pantry", anchorQty: 1, anchorAt: t(9) })];
    expect(
      shelfLifeDiscards(milk, states, t(10), ctx, {
        fridge: acquisitions,
        pantry: [{ at: t(9), qty: 1 }],
      }),
    ).toEqual([
      {
        kind: "presumed_discarded",
        location: "fridge",
        quantity: expect.closeTo(1.6, 9),
        toLocation: null,
        statusOverride: null,
        occurredAt: t(10),
        trust: "provisional",
      },
    ]);
    expect(shelfLifeDiscards(milk, states, t(10), ctx)).toHaveLength(2); // no history → all expired
  });
});

describe("estimateItem (across locations)", () => {
  it("sums locations; frozen reserve extends the runout", () => {
    const e = estimateItem(
      eggs,
      [
        state({ anchorQty: 6, anchorAt: t(1) }),
        state({ location: "freezer", anchorQty: 4, anchorAt: t(1) }),
      ],
      t(3),
      ctx,
    );
    expect(e.onHand).toBeCloseTo(8, 9);
    expect(e.runoutAt).toBe(t(11));
    expect(e.byLocation).toHaveLength(2);
    expect(e.status).toBe("stocked");
  });

  it.each([
    ["critical beats consumed", ["consumed", "critical"], "critical"],
    ["consumed anywhere", [null, "consumed"], "consumed"],
    ["no override", [null, null], "stocked"],
  ] as const)("override: %s", (_, overrides, status) => {
    const states = overrides.map((o, i) =>
      state({
        location: i ? "freezer" : "fridge",
        anchorQty: 30,
        anchorAt: t(1),
        statusOverride: o,
      }),
    );
    expect(estimateItem(eggs, states, t(2), ctx).status).toBe(status);
  });

  it("when everything is gone, runout is the latest past runout", () => {
    const e = estimateItem(
      eggs,
      [
        state({ anchorQty: 2, anchorAt: t(1) }),
        state({ location: "pantry", anchorQty: 3, anchorAt: t(1) }),
      ],
      t(10),
      ctx,
    );
    expect(e).toMatchObject({ onHand: 0, status: "out", runoutAt: t(4) });
  });

  it("unknown with no anchors; static has no runout", () => {
    expect(estimateItem(eggs, [], t(1), ctx)).toMatchObject({
      onHand: 0,
      status: "unknown",
      runoutAt: null,
    });
    expect(
      estimateItem(toiletPaper, [state({ anchorQty: 3, anchorAt: t(1) })], t(1), ctx),
    ).toMatchObject({ status: "low", runoutAt: null });
  });

  it("includes shelf-life drops", () => {
    const milk = { ...eggs, emaDays: 10, shelfLifeDays: 7 };
    const e = estimateItem(milk, [state({ anchorQty: 3, anchorAt: t(1) })], t(10), ctx, {
      fridge: [{ at: t(9), qty: 1 }],
    });
    expect(e.expiredQty).toBeCloseTo(3 - 0.9 - 1, 9);
    expect(e.onHand).toBeCloseTo(1, 9);
  });
});

describe("checkOverbuy — DESIGN §4.2", () => {
  it.each([
    ["velocity: stock on hand lasts ≥ 14 days", eggs, 14, { daysOfStock: 14 }],
    ["velocity: under 14 days", eggs, 13.9, null],
    ["velocity without EMA: unknown", { ...eggs, emaDays: null }, 100, null],
    ["static: on_hand_before > 2 × threshold", toiletPaper, 9, { reorderThreshold: 4 }],
    ["static: exactly 2 × threshold", toiletPaper, 8, null],
    ["static without threshold", { ...toiletPaper, reorderThreshold: null }, 100, null],
  ] as const)("%s", (_, item, before, expected) => {
    const out = checkOverbuy(item, before, 12, config);
    if (expected === null) expect(out).toBeNull();
    else
      expect(out).toMatchObject({
        metric: "overbuy",
        onHandBefore: before,
        acquiredQty: 12,
        ...expected,
      });
  });
});
