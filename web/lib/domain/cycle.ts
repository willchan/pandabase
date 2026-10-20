// DESIGN §4.7 — the weekly grocery cycle state machine and its schedule.
import type { Config } from "../config";
import {
  addDays,
  daysBetween,
  dateInIsoWeek,
  isAwayOn,
  isoWeekLabel,
  isoWeekday,
  localDate,
  zonedToUtc,
  type AwayPeriod,
} from "./time";

export type CycleStatus = "open" | "building" | "ready" | "closed" | "skipped" | "other_store";
export const ACTIVE_STATUSES: readonly CycleStatus[] = ["open", "building", "ready"];
export const isActive = (s: CycleStatus): boolean => ACTIVE_STATUSES.includes(s);

export interface CycleRow {
  weekLabel: string;
  status: CycleStatus;
  nudgeSentAt: string | null;
  builtAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
}

export type CycleEvent =
  /** Friday 6pm nudge posted. */
  | { type: "nudge" }
  /** Saturday 10am build starts. Becomes `skipped` if an away period covers the build date. */
  | { type: "build" }
  /** The agent finished filling the cart. */
  | { type: "built" }
  | { type: "skip" }
  | { type: "other_store" }
  /** A receipt for the cycle's order was ingested (picked up / delivered). */
  | { type: "order_ingested" }
  /** A human said "done". */
  | { type: "done" };

export type CyclePatch = Partial<
  Pick<CycleRow, "status" | "nudgeSentAt" | "builtAt" | "closedAt" | "closeReason">
>;

export type TransitionResult =
  | { ok: true; from: CycleStatus; to: CycleStatus; patch: CyclePatch; noop: boolean }
  | { ok: false; from: CycleStatus; error: string };

/**
 * Apply `event` to `cycle` at `now`. Terminal states accept nothing. `skip` / `other_store` are
 * accepted from any active state (a built cart can still be abandoned; nothing is checked out).
 */
export function transition(
  cycle: CycleRow,
  event: CycleEvent,
  now: string,
  ctx: { away: readonly AwayPeriod[]; config: Config },
): TransitionResult {
  const from = cycle.status;
  const ok = (to: CycleStatus, patch: CyclePatch, noop = false): TransitionResult => ({
    ok: true,
    from,
    to,
    patch: noop ? {} : { ...patch, status: to },
    noop,
  });
  const close = (to: CycleStatus, reason: string) => ok(to, { closedAt: now, closeReason: reason });
  const invalid = (): TransitionResult => ({
    ok: false,
    from,
    error: `cannot ${event.type} a ${from} cycle`,
  });

  if (!isActive(from)) return invalid();
  switch (event.type) {
    case "skip":
      return close("skipped", "skip");
    case "other_store":
      return close("other_store", "other_store");
    case "nudge":
      if (from !== "open") return invalid();
      return cycle.nudgeSentAt ? ok(from, {}, true) : ok("open", { nudgeSentAt: now });
    case "build": {
      if (from !== "open") return invalid();
      const buildDate = cycleSchedule(cycle.weekLabel, ctx.config).buildDate;
      return isAwayOn(buildDate, ctx.away) ? close("skipped", "away") : ok("building", {});
    }
    case "built":
      return from === "building" ? ok("ready", { builtAt: now }) : invalid();
    case "order_ingested":
      return from === "ready" ? close("closed", "order_ingested") : invalid();
    case "done":
      return from === "ready" ? close("closed", "done") : invalid();
  }
}

/** Household-local schedule of the cycle for ISO week `weekLabel`. */
export function cycleSchedule(weekLabel: string, config: Config) {
  const tz = config.householdTz;
  const { nudge, build } = config.cycle;
  const nudgeDate = dateInIsoWeek(weekLabel, nudge.isoWeekday);
  const buildDate = dateInIsoWeek(weekLabel, build.isoWeekday);
  return {
    nudgeDate,
    buildDate,
    nudgeAt: zonedToUtc(nudgeDate, nudge.hour, nudge.minute, tz),
    buildAt: zonedToUtc(buildDate, build.hour, build.minute, tz),
  };
}

export const isNudgeDue = (cycle: CycleRow, now: string, config: Config): boolean =>
  cycle.status === "open" &&
  cycle.nudgeSentAt === null &&
  daysBetween(cycleSchedule(cycle.weekLabel, config).nudgeAt, now) >= 0;

export const isBuildDue = (cycle: CycleRow, now: string, config: Config): boolean =>
  cycle.status === "open" && daysBetween(cycleSchedule(cycle.weekLabel, config).buildAt, now) >= 0;

/**
 * The week label of the cycle to open at `now`, or null if a cycle is still active. It's the
 * current ISO week unless that week's build time has passed or its label is taken (opening is
 * idempotent per label), in which case the next free week.
 */
export function weekLabelToOpen(
  cycles: readonly Pick<CycleRow, "weekLabel" | "status">[],
  now: string,
  config: Config,
): string | null {
  if (cycles.some((c) => isActive(c.status))) return null;
  const taken = new Set(cycles.map((c) => c.weekLabel));
  let date = localDate(now, config.householdTz);
  let label = isoWeekLabel(date);
  if (daysBetween(cycleSchedule(label, config).buildAt, now) >= 0) {
    date = addDays(date, 7);
    label = isoWeekLabel(date);
  }
  while (taken.has(label)) {
    date = addDays(date, 7);
    label = isoWeekLabel(date);
  }
  return label;
}

/** "Monday 9am at the latest": the open deadline after a cycle ended at `endedAt`. */
export function openDeadline(endedAt: string, config: Config): string {
  const tz = config.householdTz;
  const { isoWeekday: wd, hour, minute } = config.cycle.openBy;
  const day = localDate(endedAt, tz);
  let date = addDays(day, (wd - isoWeekday(day) + 7) % 7);
  let at = zonedToUtc(date, hour, minute, tz);
  if (daysBetween(endedAt, at) <= 0) {
    date = addDays(date, 7);
    at = zonedToUtc(date, hour, minute, tz);
  }
  return at;
}

/** Cron fallback: no active cycle and the open deadline after the last one has passed. */
export function isOpenOverdue(
  cycles: readonly Pick<CycleRow, "status" | "closedAt">[],
  now: string,
  config: Config,
): boolean {
  if (cycles.some((c) => isActive(c.status))) return false;
  const ended = cycles
    .map((c) => c.closedAt)
    .filter((t): t is string => t !== null)
    .sort()
    .at(-1);
  return ended === undefined || daysBetween(openDeadline(ended, config), now) >= 0;
}

export interface CycleOrder {
  status: CycleStatus;
  builtAt: string | null;
  /** Vendors whose carts this cycle filled. */
  cartVendors: readonly string[];
  /** Order ids recorded in `cart_result`, if any. */
  orderIds: readonly string[];
}

export interface ReceiptForCycle {
  source: "digital" | "paper" | "manual";
  vendor: string;
  externalOrderId: string | null;
  acquiredAt: string;
}

/**
 * Is this receipt the cycle's cart order? Its vendor must be a cart vendor; if the cart recorded
 * order ids the receipt's order id must be one of them, otherwise a digital receipt acquired after
 * the build counts.
 */
export function receiptMatchesCycleOrder(cycle: CycleOrder, receipt: ReceiptForCycle): boolean {
  if (!cycle.cartVendors.includes(receipt.vendor) || cycle.builtAt === null) return false;
  if (cycle.orderIds.length > 0) {
    return receipt.externalOrderId !== null && cycle.orderIds.includes(receipt.externalOrderId);
  }
  return receipt.source === "digital" && daysBetween(cycle.builtAt, receipt.acquiredAt) >= 0;
}

/** §4.5 / §4.7: the ingested order closes a `ready` cycle. */
export const receiptClosesCycle = (cycle: CycleOrder, receipt: ReceiptForCycle): boolean =>
  cycle.status === "ready" && receiptMatchesCycleOrder(cycle, receipt);
