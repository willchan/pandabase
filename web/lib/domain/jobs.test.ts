import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import {
  failureOutcome,
  isLeaseExpired,
  leaseExpiresAt,
  paperReceiptInput,
  resolveTrashCam,
  vendorSlug,
} from "./jobs";

const config = DEFAULT_CONFIG;
const items = [
  { id: "straw", canonicalName: "Strawberries" },
  { id: "yog", canonicalName: "Greek Yogurt" },
];

describe("leases and retries — DESIGN §5 step 4", () => {
  it("leases last 5 minutes", () => {
    expect(leaseExpiresAt("2026-10-20T16:00:00.000Z", config)).toBe("2026-10-20T16:05:00.000Z");
  });
  it.each([
    [
      "claimed, lease passed",
      { status: "claimed", leaseExpiresAt: "2026-10-20T16:05:00.000Z" },
      true,
    ],
    [
      "claimed, lease running",
      { status: "claimed", leaseExpiresAt: "2026-10-20T16:06:00.000Z" },
      false,
    ],
    ["queued", { status: "queued", leaseExpiresAt: null }, false],
    ["completed", { status: "completed", leaseExpiresAt: "2026-10-20T16:00:00.000Z" }, false],
  ] as const)("%s", (_, job, want) => {
    expect(isLeaseExpired(job, "2026-10-20T16:05:00.000Z")).toBe(want);
  });
  it.each([
    [1, "retry"],
    [2, "retry"],
    [3, "failed"],
    [4, "failed"],
  ] as const)("failure after attempt %i → %s", (attempts, want) => {
    expect(failureOutcome(attempts, config)).toBe(want);
  });
});

describe("paper receipts", () => {
  it.each([
    ["WHOLE FOODS MARKET", "wholefoods"],
    ["Trader Joe's", "traderjoes"],
    ["The Safeway Store #123", "safeway123"],
    ["!!!", "unknown"],
  ])("vendorSlug(%s) = %s", (store, want) => {
    expect(vendorSlug(store)).toBe(want);
  });

  it("maps a transcription to a paper receipt acquired at local noon", () => {
    const r = paperReceiptInput(
      {
        store: "WHOLE FOODS MARKET",
        date: "2026-10-18",
        lines: [
          { rawText: "ORG EGGS", qty: null, unitPriceCents: 599, lineTotalCents: 599 },
          { rawText: "BAG FEE", qty: 2, unitPriceCents: 10, lineTotalCents: 20 },
        ],
        subtotalCents: 619,
        totalCents: 650,
      },
      "America/Los_Angeles",
    );
    expect(r).toMatchObject({
      source: "paper",
      vendor: "wholefoods",
      acquiredAt: "2026-10-18T19:00:00.000Z",
      fulfillment: "in_store",
      totalCents: 650,
    });
    expect(r.lines.map((l) => l.qty)).toEqual([1, 2]);
  });
});

describe("resolveTrashCam — DESIGN §5 step 5", () => {
  it("confident and resolved → consume", () => {
    expect(resolveTrashCam([{ name: "strawberries", confidence: 0.91 }], items, config)).toEqual({
      action: "consume",
      itemId: "straw",
      detection: { name: "strawberries", confidence: 0.91 },
      score: 1,
    });
  });
  it("the most confident detection wins", () => {
    const out = resolveTrashCam(
      [
        { name: "yogurt", confidence: 0.5 },
        { name: "strawberries", confidence: 0.95 },
      ],
      items,
      config,
    );
    expect(out).toMatchObject({ action: "consume", itemId: "straw" });
  });
  it("resolved but below 0.8 → review with the item", () => {
    expect(resolveTrashCam([{ name: "greek yogurt", confidence: 0.41 }], items, config)).toEqual({
      action: "review",
      detection: { name: "greek yogurt", confidence: 0.41 },
      itemId: "yog",
      score: 1,
    });
  });
  it("confident but unresolved → review with the best guess", () => {
    const out = resolveTrashCam([{ name: "kombucha", confidence: 0.99 }], items, config);
    expect(out).toMatchObject({ action: "review", detection: { name: "kombucha" } });
    expect(out.score).toBeLessThan(config.matching.fuzzyApplyThreshold);
  });
  it("no detections → review", () => {
    expect(resolveTrashCam([], items, config)).toEqual({
      action: "review",
      detection: null,
      itemId: null,
      score: 0,
    });
  });
});
