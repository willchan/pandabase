import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { diffSubscriptions, isActiveSubscription, subscribedItems } from "./subscriptions";

const config = DEFAULT_CONFIG;
const now = "2026-11-22T18:00:00.000Z"; // Sun Nov 22, 10am LA

describe("isActiveSubscription — DESIGN §4.9", () => {
  it.each([
    ["seen today", { lastSeenAt: now, endedAt: null }, true],
    // 21 days back is the last day it still counts (household-local dates).
    ["seen 21 days ago", { lastSeenAt: "2026-11-01T18:00:00.000Z", endedAt: null }, true],
    ["seen 22 days ago: stale", { lastSeenAt: "2026-10-31T18:00:00.000Z", endedAt: null }, false],
    ["ended", { lastSeenAt: now, endedAt: now }, false],
  ] as const)("%s", (_, row, active) => {
    expect(isActiveSubscription(row, now, config)).toBe(active);
  });
});

describe("diffSubscriptions", () => {
  const seen = (asin: string) => ({ asin, title: asin, nextDeliveryOn: null, schedule: null });

  it("adds new ASINs, refreshes listed ones, ends unlisted open ones", () => {
    const d = diffSubscriptions(
      [
        { id: "r1", asin: "A1", endedAt: null },
        { id: "r2", asin: "A2", endedAt: null },
        { id: "r3", asin: "A3", endedAt: "2026-10-01T00:00:00.000Z" },
        { id: "r4", asin: "A4", endedAt: "2026-10-01T00:00:00.000Z" },
      ],
      [seen("A1"), seen("A3"), seen("A5"), seen("A5")],
    );
    expect(d.added.map((s) => s.asin)).toEqual(["A5"]);
    expect(d.seen.map((s) => [s.id, s.reopened])).toEqual([
      ["r1", false],
      ["r3", true],
    ]);
    // r4 already ended: not ended again.
    expect(d.ended).toEqual(["r2"]);
  });

  it("an empty list ends every open row", () => {
    expect(diffSubscriptions([{ id: "r1", asin: "A1", endedAt: null }], []).ended).toEqual(["r1"]);
  });
});

describe("subscribedItems", () => {
  it("maps items by any product's ASIN, with the soonest next delivery", () => {
    const m = subscribedItems(
      new Map([
        ["soap", [{ asin: "S1" }, { asin: "S2" }]],
        ["milk", [{ asin: null }, { asin: "M1" }]],
        ["floss", [{ asin: "F1" }]],
      ]),
      [
        { asin: "S2", nextDeliveryOn: "2026-12-20" },
        { asin: "S1", nextDeliveryOn: "2026-11-29" },
        { asin: "F1", nextDeliveryOn: null },
      ],
    );
    expect([...m]).toEqual([
      ["soap", { asin: "S1", nextDeliveryOn: "2026-11-29" }],
      ["floss", { asin: "F1", nextDeliveryOn: null }],
    ]);
  });
});
