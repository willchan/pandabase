import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import {
  defaultActionFor,
  dueExpiries,
  impactScore,
  mayCreateLabel,
  isOneTimeBuy,
  newReview,
  reprioritize,
  reviewExpiresAt,
  trustAfterReview,
  urgencyFor,
  type ReviewRow,
} from "./review";

const config = DEFAULT_CONFIG;
const created = "2026-10-20T16:00:00.000Z";

describe("review expiry — DESIGN §4.6 table", () => {
  it.each([
    ["receipt", { action: "drop_pending_lines" }, "2026-11-03T16:00:00.000Z"],
    ["new_product", { action: "keep_auto_created" }, "2026-11-19T16:00:00.000Z"],
    ["merge_suggestion", { action: "none" }, "2026-11-19T16:00:00.000Z"],
    ["unverified_item", { action: "stay_unverified" }, null],
    ["failed_job", { action: "dismiss" }, "2026-11-03T16:00:00.000Z"],
    ["trash_cam", { action: "none" }, "2026-10-27T16:00:00.000Z"],
  ] as const)("%s: default %j, expires %s", (kind, action, expires) => {
    expect(defaultActionFor(kind)).toEqual(action);
    expect(reviewExpiresAt(kind, created, config)).toBe(expires);
  });

  it("windows are config knobs", () => {
    const c = { ...config, reviewExpiryDays: { ...config.reviewExpiryDays, receipt: null } };
    expect(reviewExpiresAt("receipt", created, c)).toBeNull();
  });
});

describe("impact score and urgency", () => {
  it.each([
    ["in the cart plan", true, false, 10, "this_week"],
    ["in please-check", false, true, 3, "this_week"],
    ["both", true, true, 13, "this_week"],
    ["otherwise", false, false, 1, "cleanup"],
  ] as const)("%s → %i, %s", (_, inCartPlan, inPleaseCheck, score, urgency) => {
    expect(impactScore({ inCartPlan, inPleaseCheck }, config)).toBe(score);
    expect(urgencyFor({ inCartPlan, inPleaseCheck })).toBe(urgency);
  });

  it("newReview fills every derived column", () => {
    expect(
      newReview("receipt", created, { inCartPlan: true, inPleaseCheck: false }, config),
    ).toEqual({
      kind: "receipt",
      status: "pending",
      defaultAction: { action: "drop_pending_lines" },
      expiresAt: "2026-11-03T16:00:00.000Z",
      impactScore: 10,
      urgency: "this_week",
    });
  });
});

describe("dueExpiries (daily cron)", () => {
  const rows: ReviewRow[] = [
    { id: "past", kind: "receipt", status: "pending", expiresAt: "2026-10-19T00:00:00.000Z" },
    { id: "exact", kind: "failed_job", status: "pending", expiresAt: created },
    { id: "future", kind: "trash_cam", status: "pending", expiresAt: "2026-10-21T00:00:00.000Z" },
    { id: "never", kind: "unverified_item", status: "pending", expiresAt: null },
    { id: "answered", kind: "receipt", status: "confirmed", expiresAt: "2026-10-01T00:00:00.000Z" },
  ];
  it("expires pending reviews at or past expires_at, with their default", () => {
    expect(dueExpiries(rows, created)).toEqual([
      { id: "past", kind: "receipt", status: "expired", apply: { action: "drop_pending_lines" } },
      { id: "exact", kind: "failed_job", status: "expired", apply: { action: "dismiss" } },
    ]);
  });
});

describe("trust", () => {
  it.each([
    ["confirmed", "m1", true],
    ["corrected", "m1", true],
    ["confirmed", null, false],
    ["expired", "m1", false],
    ["dismissed", "m1", false],
    ["pending", "m1", false],
  ] as const)("label for %s by %s → %s", (status, member, ok) => {
    expect(mayCreateLabel(status, member)).toBe(ok);
  });

  it.each([
    ["confirmed", { original: "confirmed", writeCorrected: false }],
    ["corrected", { original: "expired", writeCorrected: true }],
    ["expired", { original: "provisional", writeCorrected: false }],
  ] as const)("provisional event after %s", (outcome, out) => {
    expect(trustAfterReview(outcome)).toEqual(out);
  });
});

describe("reprioritize (§4.6, cart plan)", () => {
  const base = { impactScore: 1, urgency: "cleanup" as const };
  const plan = { cart: new Set(["eggs"]), pleaseCheck: new Set(["milk", "eggs"]) };
  it("re-scores item reviews against the plan and returns only changes", () => {
    const out = reprioritize(
      [
        { ...base, id: "np-eggs", kind: "new_product", itemId: "eggs" },
        { ...base, id: "uv-milk", kind: "unverified_item", itemId: "milk" },
        { ...base, id: "np-tea", kind: "new_product", itemId: "tea" },
        {
          id: "ms-old",
          kind: "merge_suggestion",
          itemId: "tea",
          impactScore: 10,
          urgency: "this_week",
        },
        { ...base, id: "rc", kind: "receipt", itemId: "eggs" },
        { ...base, id: "fj", kind: "failed_job", itemId: null },
      ],
      plan,
      config,
    );
    expect(out).toEqual([
      { id: "np-eggs", impactScore: 13, urgency: "this_week" },
      { id: "uv-milk", impactScore: 3, urgency: "this_week" },
      { id: "ms-old", impactScore: 1, urgency: "cleanup" },
    ]);
  });
  it("leaves item reviews without an item alone", () => {
    expect(
      reprioritize([{ ...base, id: "x", kind: "new_product", itemId: null }], plan, config),
    ).toEqual([]);
  });
});

describe("isOneTimeBuy (Cleanup leaves these out)", () => {
  it.each([
    ["new_product", "cleanup", "static", true],
    ["new_product", "cleanup", "velocity", false],
    ["new_product", "this_week", "static", false],
    ["new_product", "cleanup", null, false],
    ["merge_suggestion", "cleanup", "static", false],
  ] as const)("%s / %s / %s → %s", (kind, urgency, tracking, out) => {
    expect(isOneTimeBuy({ kind, urgency }, tracking)).toBe(out);
  });
});
