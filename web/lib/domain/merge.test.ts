import { describe, expect, it } from "vitest";
import { planMerge, type MergeInput } from "./merge";

const base: MergeInput = {
  source: { id: "kombucha?", mergedIntoItemId: null },
  target: { id: "kombucha", mergedIntoItemId: null },
  sourceProducts: [{ id: "p1", stance: "acceptable", unitQuantity: 1 }],
  unitQuantity: null,
};

describe("planMerge", () => {
  it("moves products as acceptable and keeps history as is", () => {
    expect(
      planMerge({
        ...base,
        sourceProducts: [
          { id: "p1", stance: "preferred", unitQuantity: 1 },
          { id: "p2", stance: "rejected", unitQuantity: 6 },
        ],
      }),
    ).toEqual({
      ok: true,
      eventScale: 1,
      productPatches: [
        { id: "p1", stance: "acceptable" },
        { id: "p2", stance: "rejected" },
      ],
    });
  });

  it("a corrected pack size rescales the history and confirms the unit quantity", () => {
    expect(planMerge({ ...base, unitQuantity: 12 })).toEqual({
      ok: true,
      eventScale: 12,
      productPatches: [
        { id: "p1", stance: "acceptable", unitQuantity: 12, unitQuantityTrust: "confirmed" },
      ],
    });
  });

  it.each([
    [{ target: { id: "kombucha?", mergedIntoItemId: null } }, /itself/],
    [{ source: { id: "a", mergedIntoItemId: "b" } }, /already merged/],
    [{ target: { id: "b", mergedIntoItemId: "c" } }, /merged away/],
    [{ unitQuantity: 0 }, /positive/],
    [{ unitQuantity: 2, sourceProducts: [] }, /one product/],
  ] as [Partial<MergeInput>, RegExp][])("rejects %o", (patch, error) => {
    const plan = planMerge({ ...base, ...patch });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toMatch(error);
  });
});
