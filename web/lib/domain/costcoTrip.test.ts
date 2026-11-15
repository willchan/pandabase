import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { costcoTripList, isTripExpired, tripDateProblem } from "./costcoTrip";
import type { PlanItemInput } from "./predictions";
import type { ProductCandidate } from "./productChoice";

const config = DEFAULT_CONFIG;
const now = "2026-11-16T18:00:00.000Z"; // Mon Nov 16, 10am Los Angeles
const at = (date: string) => `${date}T19:00:00.000Z`;

describe("tripDateProblem", () => {
  it.each([
    ["today", "2026-11-16", null],
    ["Saturday", "2026-11-21", null],
    ["the last allowed day", "2027-01-15", null],
    ["yesterday", "2026-11-15", "2026-11-15 is in the past"],
    ["too far ahead", "2027-01-16", "2027-01-16 is more than 60 days ahead"],
  ])("%s", (_, date, problem) => {
    expect(tripDateProblem(date, now, config)).toBe(problem);
  });
});

describe("isTripExpired — the cron's default outcome", () => {
  it.each([
    ["the trip is today", "2026-11-16", false],
    ["exactly tripExpireAfterDays ago", "2026-11-09", false],
    ["one more day", "2026-11-08", true],
  ])("%s", (_, date, expired) => {
    expect(isTripExpired(date, now, config)).toBe(expired);
  });
});

describe("costcoTripList", () => {
  const p = (id: string, o: Partial<ProductCandidate> = {}): ProductCandidate => ({
    id,
    vendor: "wholefoods",
    title: id,
    unitQuantity: 12,
    stance: "acceptable",
    preferenceScore: 0,
    timesBought: 1,
    consecutiveBuys: 0,
    lastPriceCents: null,
    ...o,
  });
  const velocity = (emaDays: number, shelfLifeDays: number | null = null) => ({
    trackingType: "velocity" as const,
    emaDays,
    defaultLocation: "fridge" as const,
    reorderThreshold: null,
    shelfLifeDays,
  });
  const item = (itemId: string, o: Partial<PlanItemInput>): PlanItemInput => ({
    itemId,
    item: velocity(0.5, 35),
    baseUnit: "egg",
    switchThreshold: 0.15,
    estimate: { onHand: 6, runoutAt: at("2026-11-19"), status: "low" },
    products: [
      p(`${itemId}-wf`, { lastPriceCents: 840 }),
      p(`${itemId}-ks`, { vendor: "costco", unitQuantity: 24, lastPriceCents: 960 }),
    ],
    ...o,
  });
  const list = (items: PlanItemInput[], tripDate = "2026-11-21") =>
    costcoTripList({ items, tripDate, now, config });

  it("lists Costco items that run out before the trip after, with packs to cover it", () => {
    const out = list([
      item("eggs", {}),
      // Runs out after Nov 21 + 35 days: not on this list.
      item("later", { estimate: { onHand: 200, runoutAt: at("2027-02-01"), status: "stocked" } }),
      // Never bought at Costco.
      item("milk", { products: [p("milk-wf", { lastPriceCents: 500 })] }),
    ]);
    expect(out.map((l) => [l.itemId, l.reason, l.quantity, l.product.id])).toEqual([
      // Left at the trip: 6 − 5 / 0.5 → 0; 35 days ÷ 0.5 = 70 eggs → 3 packs of 24.
      ["eggs", "runout", 3, "eggs-ks"],
    ]);
    expect(out[0]!.choice.why).toBe("cheaper");
  });

  it("orders flagged items first, then by runout, and follows pins", () => {
    const out = list([
      item("b", { estimate: { onHand: 10, runoutAt: at("2026-11-30"), status: "stocked" } }),
      item("a", { estimate: { onHand: 10, runoutAt: at("2026-11-25"), status: "stocked" } }),
      item("out", { estimate: { onHand: 0, runoutAt: null, status: "consumed" } }),
      item("pinned", { storePin: "regular" }),
    ]);
    expect(out.map((l) => l.itemId)).toEqual(["out", "a", "b"]);
  });

  it("keeps perishables nobody freezes to what keeps", () => {
    const [l] = list([
      item("berries", {
        item: velocity(0.5, 10),
        products: [
          p("wf", { unitQuantity: 6, lastPriceCents: 600 }),
          p("ks", { vendor: "costco", unitQuantity: 18, lastPriceCents: 900 }),
        ],
        estimate: { onHand: 0, runoutAt: at("2026-11-16"), status: "out" },
      }),
    ]);
    // 18 berries last 9 days < 10 → cheaper; cover capped at 10 days = 20 → 2 packs.
    expect([l!.quantity, l!.choice.why]).toEqual([2, "cheaper"]);
  });
});
