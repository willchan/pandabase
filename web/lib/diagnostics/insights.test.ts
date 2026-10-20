import { systemTelemetry } from "@pandabase/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@/lib/config";
import { setup, type Harness } from "@/test/harness";
import { weeklyInsights } from "./insights";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(() => h.close());

describe("weeklyInsights", () => {
  it("buckets receipt lines, reviews and telemetry by household week", async () => {
    await h.db.insert(systemTelemetry).values([
      {
        id: "t1",
        source: "state_engine",
        metricType: "cart_line_result",
        payload: { outcome: "tier1" },
        createdAt: h.now(),
      },
      {
        id: "t2",
        source: "state_engine",
        metricType: "cart_line_result",
        payload: { outcome: "failed" },
        createdAt: h.now(),
      },
      {
        id: "t3",
        source: "state_engine",
        metricType: "estimate_vs_observed",
        payload: { estimated: 5, observed: 2 },
        createdAt: h.now(),
      },
      { id: "t4", source: "state_engine", metricType: "overbuy", payload: {}, createdAt: h.now() },
    ]);
    const weeks = await weeklyInsights(h.db, { now: h.now(), config: DEFAULT_CONFIG }, 8);
    expect(weeks).toHaveLength(8);
    expect(weeks.at(-1)!.week).toBe("2026-W43");
    const last = weeks.at(-1)!;
    expect(last.cart).toEqual({ tier1: 1, tier2: 0, failed: 1 });
    expect(last.overbuys).toBeGreaterThanOrEqual(1);
    expect(last.estimateError).not.toBeNull();
    const lines = weeks.reduce(
      (s, w) => s + w.lines.auto + w.lines.provisional + w.lines.pending,
      0,
    );
    expect(lines).toBeGreaterThan(20);
    expect(weeks.some((w) => w.lines.provisional > 0)).toBe(true);
  });
});
