import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import {
  mergeSameDay,
  placeAcquisition,
  replayVelocity,
  shouldPromoteToVelocity,
  trackingTypeForBackfill,
  updateVelocity,
  type Acquisition,
  type VelocityState,
} from "./velocity";

const config = DEFAULT_CONFIG;
const TZ = config.householdTz;
const ctx = { away: [], config };
/** Noon LA on Oct 1 2026 + `days`. */
const day = (days: number) =>
  new Date(Date.parse("2026-10-01T19:00:00.000Z") + days * 86_400_000).toISOString();
const st = (s: Partial<VelocityState> = {}): VelocityState => ({
  emaDays: null,
  defaultEmaDays: null,
  outlierStreak: 0,
  outlierDirection: null,
  ...s,
});

describe("updateVelocity — DESIGN §4.1", () => {
  // prev = 12 base units at day 0; `elapsed` days later another acquisition.
  it.each([
    // [case, state, prev qty (null = no prev), elapsed days, outcome, ema after, streak, direction]
    [
      "cold start with seed, first acquisition: seed EMA, stop",
      st({ defaultEmaDays: 2 }),
      null,
      0,
      "first_acquisition",
      2,
      0,
      null,
    ],
    [
      "cold start without seed, first acquisition: record only",
      st(),
      null,
      0,
      "first_acquisition",
      null,
      0,
      null,
    ],
    [
      "cold start without seed, second acquisition: ema = observed",
      st(),
      12,
      24,
      "initialized",
      2,
      0,
      null,
    ],
    [
      "cold start with seed, second acquisition: seed then update",
      st({ defaultEmaDays: 1 }),
      12,
      24,
      "updated",
      1.3,
      0,
      null,
    ],
    [
      "normal update: 0.7 × ema + 0.3 × observed",
      st({ emaDays: 2 }),
      12,
      30,
      "updated",
      2.15,
      0,
      null,
    ],
    [
      "observed exactly 3 × ema is not an outlier",
      st({ emaDays: 2 }),
      12,
      72,
      "updated",
      3.2,
      0,
      null,
    ],
    [
      "observed exactly 0.25 × ema is not an outlier",
      st({ emaDays: 2 }),
      12,
      6,
      "updated",
      1.55,
      0,
      null,
    ],
    [
      "high outlier (trip/off-system) rejected, streak 1",
      st({ emaDays: 2 }),
      12,
      84,
      "outlier_rejected",
      2,
      1,
      "high",
    ],
    [
      "second high outlier rejected, streak 2",
      st({ emaDays: 2, outlierStreak: 1, outlierDirection: "high" }),
      12,
      84,
      "outlier_rejected",
      2,
      2,
      "high",
    ],
    [
      "third high outlier in a row accepted as habit change",
      st({ emaDays: 2, outlierStreak: 2, outlierDirection: "high" }),
      12,
      84,
      "outlier_accepted",
      3.5,
      0,
      null,
    ],
    ["low outlier (stock-up) rejected", st({ emaDays: 2 }), 12, 5, "outlier_rejected", 2, 1, "low"],
    [
      "direction change restarts the streak",
      st({ emaDays: 2, outlierStreak: 2, outlierDirection: "high" }),
      12,
      5,
      "outlier_rejected",
      2,
      1,
      "low",
    ],
    [
      "a normal observation resets the streak",
      st({ emaDays: 2, outlierStreak: 2, outlierDirection: "low" }),
      12,
      24,
      "updated",
      2,
      0,
      null,
    ],
    [
      "seeded EMA with an outlier second acquisition",
      st({ defaultEmaDays: 2 }),
      12,
      84,
      "outlier_rejected",
      2,
      1,
      "high",
    ],
    [
      "previous acquisition without quantity: nothing to measure",
      st({ emaDays: 2 }),
      0,
      10,
      "first_acquisition",
      2,
      0,
      null,
    ],
  ] as const)("%s", (_, state, prevQty, elapsed, outcome, ema, streak, direction) => {
    const prev: Acquisition | null = prevQty === null ? null : { at: day(0), qty: prevQty };
    const s = updateVelocity(state, prev, { at: day(elapsed), qty: 12 }, ctx);
    expect(s.outcome).toBe(outcome);
    if (ema === null) expect(s.state.emaDays).toBeNull();
    else expect(s.state.emaDays).toBeCloseTo(ema, 9);
    expect(s.state.outlierStreak).toBe(streak);
    expect(s.state.outlierDirection).toBe(direction);
  });

  it("subtracts away days from elapsed", () => {
    // 31 days with a 7-day away period in between → 24 effective days / 12 = 2 days per unit.
    const away = [{ startsOn: "2026-10-10", endsOn: "2026-10-16" }];
    const s = updateVelocity(
      st(),
      { at: day(0), qty: 12 },
      { at: day(31), qty: 12 },
      { away, config },
    );
    expect(s.elapsedDays).toBeCloseTo(24, 9);
    expect(s.observedDays).toBeCloseTo(2, 9);
  });

  it("treats an interval spent entirely away as zero elapsed (a low outlier)", () => {
    const away = [{ startsOn: "2026-09-01", endsOn: "2026-10-31" }];
    const s = updateVelocity(
      st({ emaDays: 2 }),
      { at: day(0), qty: 12 },
      { at: day(10), qty: 12 },
      { away, config },
    );
    expect(s.elapsedDays).toBe(0);
    expect(s.outcome).toBe("outlier_rejected");
    expect(s.state.outlierDirection).toBe("low");
  });

  it("skips same-day and out-of-order acquisitions", () => {
    const state = st({ emaDays: 2 });
    expect(
      updateVelocity(state, { at: day(0), qty: 12 }, { at: day(0.2), qty: 6 }, ctx),
    ).toMatchObject({ outcome: "same_day", state });
    expect(
      updateVelocity(state, { at: day(5), qty: 12 }, { at: day(1), qty: 6 }, ctx),
    ).toMatchObject({ outcome: "out_of_order", state });
  });

  it("does not mutate its input", () => {
    const state = st({ emaDays: 2 });
    updateVelocity(state, { at: day(0), qty: 12 }, { at: day(84), qty: 12 }, ctx);
    expect(state).toEqual(st({ emaDays: 2 }));
  });

  it("exposes telemetry for every learning step", () => {
    const prev = { at: day(0), qty: 12 };
    expect(
      updateVelocity(st({ emaDays: 2 }), prev, { at: day(84), qty: 1 }, ctx).telemetry,
    ).toEqual({
      metric: "ema_outlier_rejected",
      observedDays: 7,
      emaDays: 2,
      direction: "high",
      streak: 1,
    });
    expect(
      updateVelocity(
        st({ emaDays: 2, outlierStreak: 2, outlierDirection: "high" }),
        prev,
        { at: day(84), qty: 1 },
        ctx,
      ).telemetry,
    ).toMatchObject({ metric: "ema_outlier_accepted", streak: 3 });
    expect(
      updateVelocity(st({ emaDays: 2 }), prev, { at: day(30), qty: 1 }, ctx).telemetry,
    ).toEqual({
      metric: "ema_updated",
      observedDays: 2.5,
      emaBefore: 2,
      emaAfter: 2.15,
      seeded: false,
    });
    expect(updateVelocity(st(), prev, { at: day(24), qty: 1 }, ctx).telemetry).toMatchObject({
      metric: "ema_updated",
      emaBefore: null,
      emaAfter: 2,
    });
    expect(updateVelocity(st(), null, { at: day(0), qty: 1 }, ctx).telemetry).toBeNull();
  });
});

describe("same-day merge", () => {
  it("sums acquisitions on the same household-local date (not UTC date)", () => {
    // 20:00Z Oct 1 and 05:00Z Oct 2 are both Oct 1 in Los Angeles.
    const merged = mergeSameDay(
      [
        { at: "2026-10-02T05:00:00.000Z", qty: 6 },
        { at: "2026-10-01T20:00:00.000Z", qty: 12 },
        { at: "2026-10-02T08:00:00.000Z", qty: 1 },
      ],
      TZ,
    );
    expect(merged).toEqual([
      { at: "2026-10-01T20:00:00.000Z", qty: 18 },
      { at: "2026-10-02T08:00:00.000Z", qty: 1 },
    ]);
  });

  it("feeds the merged quantity into the next step", () => {
    const { state } = replayVelocity(
      st(),
      [
        { at: day(0), qty: 6 },
        { at: day(0.1), qty: 6 },
        { at: day(24), qty: 12 },
      ],
      ctx,
    );
    expect(state.emaDays).toBeCloseTo(2, 9); // 24 days / (6 + 6)
  });
});

describe("replayVelocity (backfill)", () => {
  it("replays chronologically regardless of input order", () => {
    const acqs = [
      { at: day(48), qty: 12 },
      { at: day(0), qty: 12 },
      { at: day(24), qty: 12 },
    ];
    const { state, steps } = replayVelocity(st(), acqs, ctx);
    expect(steps.map((s) => s.outcome)).toEqual(["first_acquisition", "initialized", "updated"]);
    expect(state.emaDays).toBeCloseTo(2, 9);
  });

  it("accepts a habit change after three outliers in a row", () => {
    // EMA 2 days/egg, then the household starts eating half as many eggs: 12 eggs last 84 days.
    const acqs = [0, 84, 168, 252].map((d) => ({ at: day(d), qty: 12 }));
    const { state, steps } = replayVelocity(st({ emaDays: 2 }), acqs, ctx);
    expect(steps.map((s) => s.outcome)).toEqual([
      "first_acquisition",
      "outlier_rejected",
      "outlier_rejected",
      "outlier_accepted",
    ]);
    expect(state).toEqual(st({ emaDays: 3.5 }));
  });

  it("is a no-op on an empty history", () => {
    expect(replayVelocity(st({ emaDays: 2 }), [], ctx)).toEqual({
      state: st({ emaDays: 2 }),
      steps: [],
    });
  });
});

describe("placeAcquisition", () => {
  const history = [
    { at: day(0), qty: 6 },
    { at: day(10), qty: 6 },
    { at: day(10.1), qty: 6 },
  ];
  it.each([
    ["empty history", [], day(20), "next", null],
    ["after the latest date", history, day(20), "next", { at: day(10), qty: 12 }],
    ["same day as the latest", history, day(10.2), "same_day", { at: day(10), qty: 12 }],
    ["before the latest (late receipt)", history, day(5), "out_of_order", { at: day(10), qty: 12 }],
  ] as const)("%s", (_, h, at, position, prev) => {
    expect(placeAcquisition(h, at, TZ)).toEqual({ position, prev });
  });
});

describe("one-off items", () => {
  it.each([
    [1, "static"],
    [2, "velocity"],
    [5, "velocity"],
  ] as const)("backfill with %i purchase(s) → %s", (n, t) =>
    expect(trackingTypeForBackfill(n)).toBe(t),
  );

  const oneOff = { trackingType: "static" as const, reorderThreshold: null };
  it.each([
    ["second purchase within 6 months", oneOff, day(0), day(100), true],
    ["exactly at the window edge", oneOff, day(0), day(183), true],
    ["second purchase after 6 months", oneOff, day(0), day(200), false],
    ["no previous purchase", oneOff, null, day(10), false],
    ["previous purchase is later (late receipt)", oneOff, day(10), day(0), false],
    [
      "static by design (has a reorder threshold)",
      { trackingType: "static" as const, reorderThreshold: 2 },
      day(0),
      day(10),
      false,
    ],
    [
      "already velocity",
      { trackingType: "velocity" as const, reorderThreshold: null },
      day(0),
      day(10),
      false,
    ],
  ])("promote: %s", (_, item, prev, at, out) => {
    expect(shouldPromoteToVelocity(item, prev, at, config)).toBe(out);
  });
});
