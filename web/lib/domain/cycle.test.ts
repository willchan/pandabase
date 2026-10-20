import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import {
  cycleSchedule,
  isBuildDue,
  isNudgeDue,
  isOpenOverdue,
  openDeadline,
  receiptClosesCycle,
  receiptMatchesCycleOrder,
  transition,
  weekLabelToOpen,
  type CycleEvent,
  type CycleRow,
  type CycleStatus,
} from "./cycle";

const config = DEFAULT_CONFIG;
const ctx = { away: [], config };
const now = "2026-10-24T17:00:00.000Z";
const cycle = (status: CycleStatus, o: Partial<CycleRow> = {}): CycleRow => ({
  weekLabel: "2026-W43",
  status,
  nudgeSentAt: null,
  builtAt: null,
  closedAt: null,
  closeReason: null,
  ...o,
});

describe("transition — every DESIGN §4.7 edge", () => {
  it.each([
    ["open", "nudge", "open", { nudgeSentAt: now }],
    ["open", "build", "building", {}],
    ["open", "skip", "skipped", { closedAt: now, closeReason: "skip" }],
    ["open", "other_store", "other_store", { closedAt: now, closeReason: "other_store" }],
    ["building", "built", "ready", { builtAt: now }],
    ["building", "skip", "skipped", { closeReason: "skip" }],
    ["building", "other_store", "other_store", { closeReason: "other_store" }],
    ["ready", "order_ingested", "closed", { closedAt: now, closeReason: "order_ingested" }],
    ["ready", "done", "closed", { closedAt: now, closeReason: "done" }],
    ["ready", "skip", "skipped", { closeReason: "skip" }],
    ["ready", "other_store", "other_store", { closeReason: "other_store" }],
  ] as const)("%s --%s--> %s", (from, type, to, patch) => {
    const r = transition(cycle(from), { type } as CycleEvent, now, ctx);
    expect(r).toMatchObject({ ok: true, from, to, noop: false, patch: { status: to, ...patch } });
  });

  it("build is a no-op skip when an away period covers the build date", () => {
    const away = [{ startsOn: "2026-10-23", endsOn: "2026-10-26" }];
    expect(transition(cycle("open"), { type: "build" }, now, { away, config })).toMatchObject({
      ok: true,
      to: "skipped",
      patch: { status: "skipped", closeReason: "away" },
    });
  });

  it("a second nudge is an idempotent no-op", () => {
    expect(transition(cycle("open", { nudgeSentAt: "x" }), { type: "nudge" }, now, ctx)).toEqual({
      ok: true,
      from: "open",
      to: "open",
      patch: {},
      noop: true,
    });
  });

  const all: CycleEvent["type"][] = [
    "nudge",
    "build",
    "built",
    "skip",
    "other_store",
    "order_ingested",
    "done",
  ];
  const allowed: Record<CycleStatus, CycleEvent["type"][]> = {
    open: ["nudge", "build", "skip", "other_store"],
    building: ["built", "skip", "other_store"],
    ready: ["order_ingested", "done", "skip", "other_store"],
    closed: [],
    skipped: [],
    other_store: [],
  };
  const invalid = (Object.keys(allowed) as CycleStatus[]).flatMap((s) =>
    all.filter((e) => !allowed[s].includes(e)).map((e) => [s, e] as const),
  );
  it.each(invalid)("rejects %s --%s-->", (from, type) => {
    const r = transition(cycle(from), { type } as CycleEvent, now, ctx);
    expect(r).toEqual({ ok: false, from, error: `cannot ${type} a ${from} cycle` });
  });
});

describe("schedule (household-local)", () => {
  it("Friday 6pm nudge, Saturday 10am build", () => {
    expect(cycleSchedule("2026-W43", config)).toEqual({
      nudgeDate: "2026-10-23",
      buildDate: "2026-10-24",
      nudgeAt: "2026-10-24T01:00:00.000Z",
      buildAt: "2026-10-24T17:00:00.000Z",
    });
  });

  it.each([
    ["before the nudge", cycle("open"), "2026-10-24T00:59:00.000Z", false, false],
    ["at the nudge", cycle("open"), "2026-10-24T01:00:00.000Z", true, false],
    [
      "nudge already sent",
      cycle("open", { nudgeSentAt: "x" }),
      "2026-10-24T02:00:00.000Z",
      false,
      false,
    ],
    ["at build time", cycle("open", { nudgeSentAt: "x" }), now, false, true],
    ["not open", cycle("building"), now, false, false],
  ])("%s", (_, c, at, nudge, build) => {
    expect(isNudgeDue(c, at, config)).toBe(nudge);
    expect(isBuildDue(c, at, config)).toBe(build);
  });
});

describe("opening the next cycle", () => {
  it.each([
    ["mid-week, nothing yet → this week", [], "2026-10-20T16:00:00.000Z", "2026-W43"],
    ["after this week's build → next week", [], "2026-10-24T18:00:00.000Z", "2026-W44"],
    [
      "this week's label taken → next week (idempotent per label)",
      [{ weekLabel: "2026-W43", status: "skipped" }],
      "2026-10-20T16:00:00.000Z",
      "2026-W44",
    ],
    [
      "closed Saturday → opens next week immediately",
      [{ weekLabel: "2026-W43", status: "closed" }],
      "2026-10-24T22:00:00.000Z",
      "2026-W44",
    ],
    [
      "an active cycle → nothing to open",
      [{ weekLabel: "2026-W43", status: "ready" }],
      "2026-10-24T22:00:00.000Z",
      null,
    ],
  ] as const)("%s", (_, cycles, at, label) => {
    expect(weekLabelToOpen(cycles, at, config)).toBe(label);
  });

  it.each([
    ["closed Saturday → Monday 9am", "2026-10-24T22:00:00.000Z", "2026-10-26T16:00:00.000Z"],
    ["closed Monday 8am → same day 9am", "2026-10-26T15:00:00.000Z", "2026-10-26T16:00:00.000Z"],
    ["closed Monday 10am → next Monday", "2026-10-26T17:00:00.000Z", "2026-11-02T17:00:00.000Z"], // PST after DST ends
  ])("openDeadline: %s", (_, ended, deadline) => {
    expect(openDeadline(ended, config)).toBe(deadline);
  });

  it.each([
    ["no cycles ever", [], true],
    ["active cycle", [{ status: "open", closedAt: null }], false],
    [
      "closed, before Monday 9am",
      [{ status: "closed", closedAt: "2026-10-24T22:00:00.000Z" }],
      false,
    ],
    ["closed, past Monday 9am", [{ status: "closed", closedAt: "2026-10-17T22:00:00.000Z" }], true],
  ] as const)("isOpenOverdue: %s", (_, cycles, out) => {
    expect(isOpenOverdue(cycles, "2026-10-25T12:00:00.000Z", config)).toBe(out);
  });
});

describe("receipt → cycle", () => {
  const ready = {
    status: "ready" as const,
    builtAt: now,
    cartVendors: ["wholefoods"],
    orderIds: [],
  };
  const receipt = {
    source: "digital" as const,
    vendor: "wholefoods",
    externalOrderId: "o1",
    acquiredAt: "2026-10-25T18:00:00.000Z",
  };
  it.each([
    ["digital, cart vendor, after build", ready, receipt, true],
    ["before the build", ready, { ...receipt, acquiredAt: "2026-10-20T18:00:00.000Z" }, false],
    ["other vendor", ready, { ...receipt, vendor: "amazon" }, false],
    ["paper receipt without order ids", ready, { ...receipt, source: "paper" as const }, false],
    ["order id recorded and matching", { ...ready, orderIds: ["o1"] }, receipt, true],
    ["order id recorded, different order", { ...ready, orderIds: ["o2"] }, receipt, false],
    [
      "order id recorded, receipt has none",
      { ...ready, orderIds: ["o1"] },
      { ...receipt, externalOrderId: null },
      false,
    ],
    ["never built", { ...ready, builtAt: null }, receipt, false],
  ])("matches order: %s", (_, c, r, out) => {
    expect(receiptMatchesCycleOrder(c, r)).toBe(out);
  });

  it("only a ready cycle closes", () => {
    expect(receiptClosesCycle(ready, receipt)).toBe(true);
    expect(receiptClosesCycle({ ...ready, status: "closed" }, receipt)).toBe(false);
  });
});
