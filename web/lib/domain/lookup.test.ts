import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { lookupAnswer, searchItems, type LookupInput } from "./lookup";

const config = DEFAULT_CONFIG;
const now = "2026-10-20T16:00:00.000Z";
const items = [
  { id: "milk", canonicalName: "Whole Milk" },
  { id: "oat", canonicalName: "Oat Milk" },
  { id: "eggs", canonicalName: "Eggs" },
  { id: "tp", canonicalName: "Toilet Paper" },
];

describe("searchItems", () => {
  it("ranks exact names first and drops weak matches", () => {
    expect(searchItems("oat milk", items, config).map((x) => x.id)).toEqual(["oat", "milk"]);
    expect(searchItems("eggs", items, config)).toEqual([{ id: "eggs", score: 1 }]);
    expect(searchItems("bananas", items, config)).toEqual([]);
    expect(searchItems("  ", items, config)).toEqual([]);
  });
  it("caps results", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, canonicalName: "Milk" }));
    expect(searchItems("milk", many, config)).toHaveLength(config.lookup.maxResults);
  });
});

describe("lookupAnswer — PRD §4.4", () => {
  const base: LookupInput = {
    name: "Milk",
    estimate: { onHand: 2.04, status: "stocked" },
    lastAcquired: { at: "2026-10-12T19:00:00.000Z", trust: "provisional" },
    lastVerifiedAt: null,
    now,
    config,
  };
  it.each([
    ["provisional purchase", {}, "low", "~2 milk (bought Oct 12, unverified) → probably fine"],
    [
      "confirmed purchase",
      { lastAcquired: { at: "2026-10-12T19:00:00.000Z", trust: "confirmed" } },
      "medium",
      "~2 milk (bought Oct 12) → probably fine",
    ],
    [
      "fresh count after the purchase",
      { lastVerifiedAt: "2026-10-18T19:00:00.000Z", estimate: { onHand: 1, status: "low" } },
      "high",
      "~1 milk (counted Oct 18) → running low",
    ],
    [
      "old count, no purchase",
      { lastAcquired: null, lastVerifiedAt: "2026-09-01T19:00:00.000Z" },
      "medium",
      "~2 milk (counted Sep 1) → probably fine",
    ],
    [
      "no history",
      { lastAcquired: null, estimate: { onHand: 0, status: "unknown" } },
      "low",
      "milk → no record",
    ],
    [
      "we're out",
      { estimate: { onHand: 0, status: "consumed" } },
      "low",
      "~0 milk (bought Oct 12, unverified) → marked as finished",
    ],
  ] as const)("%s", (_, o, confidence, text) => {
    expect(lookupAnswer({ ...base, ...o } as LookupInput)).toEqual({ confidence, text });
  });
});
