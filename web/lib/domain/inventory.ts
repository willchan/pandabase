// DESIGN §4.2 — inventory projection, read-time estimate, shelf life, overbuy.
//
// The event log is the source of truth; `projectInventory` folds it into `inventory_state` anchors
// and `estimate*` decays an anchor to "now" at read time (never stored).
import type { Config } from "../config";
import {
  addDays,
  addEffectiveDays,
  daysBetween,
  effectiveDaysBetween,
  localDate,
  type AwayPeriod,
} from "./time";
import type { Acquisition } from "./velocity";

export type StatusOverride = "critical" | "consumed";
export type AnchorKind = "acquired" | "observed";
export type InventoryEventKind =
  "acquired" | "observed" | "consumed" | "discarded" | "presumed_discarded" | "moved";

/** The columns of `inventory_event` the projection reads. */
export interface InventoryEvent {
  kind: InventoryEventKind;
  location: string;
  /** Null only for an `observed` event that sets `status_override = critical`. */
  quantity: number | null;
  toLocation: string | null;
  statusOverride: StatusOverride | null;
  occurredAt: string;
  trust: "confirmed" | "provisional" | "expired";
}

/** The columns of `item` the estimate reads. */
export interface InventoryItem {
  trackingType: "velocity" | "static";
  /** `current_ema_days`: days one base unit lasts. */
  emaDays: number | null;
  defaultLocation: string;
  reorderThreshold: number | null;
  shelfLifeDays: number | null;
}

/** One `inventory_state` row (minus keys and timestamps). */
export interface InventoryState {
  location: string;
  anchorQty: number | null;
  anchorAt: string | null;
  anchorKind: AnchorKind | null;
  statusOverride: StatusOverride | null;
  frozenAt: string | null;
  lastVerifiedAt: string | null;
}

export interface InventoryContext {
  away: readonly AwayPeriod[];
  config: Config;
}

/** §4.2 `estimate_vs_observed` diagnostic, one per `observed` event with a quantity. */
export interface EstimateVsObserved {
  location: string;
  at: string;
  estimated: number;
  observed: number;
}

export const emptyState = (location: string): InventoryState => ({
  location,
  anchorQty: null,
  anchorAt: null,
  anchorKind: null,
  statusOverride: null,
  frozenAt: null,
  lastVerifiedAt: null,
});

/**
 * Stock in the freezer of an item that normally lives elsewhere is a frozen *reserve*: it doesn't
 * decay and shelf life doesn't apply, so moving half the chicken to the freezer doesn't double
 * its consumption rate.
 */
export const isReserve = (item: InventoryItem, location: string): boolean =>
  location === "freezer" && item.defaultLocation !== "freezer";

const decays = (item: InventoryItem, location: string): boolean =>
  item.trackingType === "velocity" &&
  item.emaDays !== null &&
  item.emaDays > 0 &&
  !isReserve(item, location);

/** §4.2 `on_hand(t)` for one location, before shelf-life drops. */
export function onHandAt(
  state: InventoryState,
  item: InventoryItem,
  t: string,
  { away, config }: InventoryContext,
): number {
  if (state.anchorQty === null || state.anchorAt === null) return 0;
  if (!decays(item, state.location)) return state.anchorQty;
  const days = Math.max(0, effectiveDaysBetween(state.anchorAt, t, away, config.householdTz));
  return Math.max(0, state.anchorQty - days / item.emaDays!);
}

/** Non-`expired` events sorted by `occurred_at` (stable). */
const chronological = (events: readonly InventoryEvent[]): InventoryEvent[] =>
  events
    .filter((e) => e.trust !== "expired")
    .map((e, i) => ({ e, i }))
    .sort((a, b) => daysBetween(b.e.occurredAt, a.e.occurredAt) || a.i - b.i)
    .map(({ e }) => e);

/**
 * Fold an item's events (any order; sorted here by `occurred_at`, stable) into one state row per
 * location. `expired` events are ignored. Decay between events uses the item's *current* EMA.
 */
export function projectInventory(
  item: InventoryItem,
  events: readonly InventoryEvent[],
  ctx: InventoryContext,
): { states: InventoryState[]; estimateVsObserved: EstimateVsObserved[] } {
  const rows = new Map<string, InventoryState>();
  const at = (location: string) => {
    let row = rows.get(location);
    if (!row) rows.set(location, (row = emptyState(location)));
    return row;
  };
  const anchor = (row: InventoryState, qty: number, t: string, kind: AnchorKind) => {
    row.anchorQty = Math.max(0, qty);
    row.anchorAt = t;
    row.anchorKind = kind;
  };
  const estimateVsObserved: EstimateVsObserved[] = [];
  for (const e of chronological(events)) {
    const row = at(e.location);
    const t = e.occurredAt;
    const qty = e.quantity ?? 0;
    const before = onHandAt(row, item, t, ctx);
    switch (e.kind) {
      case "acquired":
        anchor(row, before + qty, t, "acquired");
        row.statusOverride = e.statusOverride;
        break;
      case "observed":
        if (e.quantity === null) {
          // Critical flag only: sets the override, leaves the anchor alone.
          row.statusOverride = e.statusOverride ?? row.statusOverride;
          break;
        }
        estimateVsObserved.push({ location: e.location, at: t, estimated: before, observed: qty });
        anchor(row, qty, t, "observed");
        row.lastVerifiedAt = t;
        // A fresh count supersedes an earlier "we're out" / "running low" flag.
        row.statusOverride = e.statusOverride;
        break;
      case "consumed":
        anchor(row, 0, t, "observed");
        row.statusOverride = e.statusOverride ?? "consumed";
        break;
      case "discarded":
      case "presumed_discarded":
        anchor(row, before - qty, t, row.anchorKind ?? "observed");
        if (e.statusOverride) row.statusOverride = e.statusOverride;
        break;
      case "moved": {
        anchor(row, before - qty, t, row.anchorKind ?? "observed");
        if (row.anchorQty === 0) row.frozenAt = null;
        if (e.toLocation) {
          const dest = at(e.toLocation);
          anchor(dest, onHandAt(dest, item, t, ctx) + qty, t, dest.anchorKind ?? "acquired");
          if (e.toLocation === "freezer") dest.frozenAt = t;
        }
        break;
      }
    }
  }
  return { states: [...rows.values()], estimateVsObserved };
}

export type InventoryStatus = "out" | "low" | "stocked" | "unknown" | StatusOverride;

export interface Estimate {
  /** After shelf-life drops. */
  onHand: number;
  runoutAt: string | null;
  status: InventoryStatus;
  /** Units older than `shelf_life_days` dropped from `onHand` (log a `presumed_discarded`). */
  expiredQty: number;
}

/**
 * §4.2 shelf-life batches per location, from an item's events (any order): each `acquired` event
 * starts a batch's clock, and a count (`observed` with a quantity) replaces the batches before it
 * with one batch of the counted units, fresh as of the count. A null-quantity `critical` flag
 * doesn't count anything, so it leaves the clocks alone. Feed the result to `estimate*` /
 * `shelfLifeDiscards`.
 */
export function freshnessBatches(events: readonly InventoryEvent[]): Record<string, Acquisition[]> {
  const out: Record<string, Acquisition[]> = {};
  for (const e of chronological(events)) {
    const batch = { at: e.occurredAt, qty: e.quantity ?? 0 };
    if (e.kind === "acquired") (out[e.location] ??= []).push(batch);
    else if (e.kind === "observed" && e.quantity !== null) out[e.location] = [batch];
  }
  return out;
}

/**
 * §4.2 shelf life, FIFO: the units still on hand are assumed to be the newest ones, so anything
 * beyond the batches (`freshnessBatches`: acquisitions, or the last count and what came after it)
 * started at this location within the last `shelf_life_days` has expired.
 */
export function expiredQuantity(
  item: InventoryItem,
  location: string,
  onHand: number,
  acquisitions: readonly Acquisition[],
  now: string,
): number {
  if (item.shelfLifeDays === null || isReserve(item, location) || onHand <= 0) return 0;
  const fresh = acquisitions
    .filter((a) => {
      const age = daysBetween(a.at, now);
      return age >= 0 && age <= item.shelfLifeDays!;
    })
    .reduce((sum, a) => sum + a.qty, 0);
  return Math.max(0, onHand - fresh);
}

const lowBy = (runoutAt: string, now: string, config: Config): boolean =>
  localDate(runoutAt, config.householdTz) <=
  addDays(localDate(now, config.householdTz), config.lowWithinDays);

function statusFor(
  item: InventoryItem,
  onHand: number,
  runoutAt: string | null,
  hasAnchor: boolean,
  now: string,
  config: Config,
): Exclude<InventoryStatus, StatusOverride> {
  if (!hasAnchor) return "unknown";
  if (onHand <= 0) return "out";
  if (item.trackingType === "static") {
    return item.reorderThreshold !== null && onHand <= item.reorderThreshold ? "low" : "stocked";
  }
  return runoutAt !== null && lowBy(runoutAt, now, config) ? "low" : "stocked";
}

/** §4.2 read-time estimate for one (item, location). */
export function estimateLocation(
  item: InventoryItem,
  state: InventoryState,
  now: string,
  ctx: InventoryContext,
  acquisitions: readonly Acquisition[] = [],
): Estimate {
  const raw = onHandAt(state, item, now, ctx);
  const expiredQty = expiredQuantity(item, state.location, raw, acquisitions, now);
  const onHand = raw - expiredQty;
  const tz = ctx.config.householdTz;
  let runoutAt: string | null = null;
  if (decays(item, state.location) && state.anchorAt !== null && state.anchorQty !== null) {
    runoutAt =
      onHand > 0 || expiredQty > 0
        ? addEffectiveDays(now, onHand * item.emaDays!, ctx.away, tz)
        : addEffectiveDays(state.anchorAt, state.anchorQty * item.emaDays!, ctx.away, tz);
  }
  const hasAnchor = state.anchorQty !== null;
  return {
    onHand,
    runoutAt,
    status: state.statusOverride ?? statusFor(item, onHand, runoutAt, hasAnchor, now, ctx.config),
    expiredQty,
  };
}

/**
 * Item-level estimate across locations: on-hand sums; an override anywhere wins (`critical` over
 * `consumed`); runout is when the combined stock (frozen reserve included) runs out.
 */
export function estimateItem(
  item: InventoryItem,
  states: readonly InventoryState[],
  now: string,
  ctx: InventoryContext,
  acquisitionsByLocation: Readonly<Record<string, readonly Acquisition[]>> = {},
): Estimate & { byLocation: (Estimate & { location: string })[] } {
  const byLocation = states.map((s) => ({
    location: s.location,
    ...estimateLocation(item, s, now, ctx, acquisitionsByLocation[s.location] ?? []),
  }));
  const onHand = byLocation.reduce((sum, e) => sum + e.onHand, 0);
  const expiredQty = byLocation.reduce((sum, e) => sum + e.expiredQty, 0);
  const tz = ctx.config.householdTz;
  let runoutAt: string | null = null;
  if (item.trackingType === "velocity" && item.emaDays !== null && item.emaDays > 0) {
    if (onHand > 0) runoutAt = addEffectiveDays(now, onHand * item.emaDays, ctx.away, tz);
    else {
      const past = byLocation.map((e) => e.runoutAt).filter((r): r is string => r !== null);
      runoutAt = past.sort().at(-1) ?? null;
    }
  }
  const overrides = states.map((s) => s.statusOverride);
  const override = overrides.includes("critical")
    ? "critical"
    : overrides.includes("consumed")
      ? "consumed"
      : null;
  const hasAnchor = states.some((s) => s.anchorQty !== null);
  return {
    onHand,
    runoutAt,
    status: override ?? statusFor(item, onHand, runoutAt, hasAnchor, now, ctx.config),
    expiredQty,
    byLocation,
  };
}

/** The `presumed_discarded` events the daily cron logs for shelf-life drops (§4.2). */
export function shelfLifeDiscards(
  item: InventoryItem,
  states: readonly InventoryState[],
  now: string,
  ctx: InventoryContext,
  acquisitionsByLocation: Readonly<Record<string, readonly Acquisition[]>> = {},
): InventoryEvent[] {
  return states.flatMap((s) => {
    const { expiredQty } = estimateLocation(
      item,
      s,
      now,
      ctx,
      acquisitionsByLocation[s.location] ?? [],
    );
    return expiredQty > 0
      ? [
          {
            kind: "presumed_discarded" as const,
            location: s.location,
            quantity: expiredQty,
            toLocation: null,
            statusOverride: null,
            occurredAt: now,
            trust: "provisional" as const,
          },
        ]
      : [];
  });
}

/** §4.2 overbuy telemetry payload (`metric = overbuy`) or null. */
export interface Overbuy {
  metric: "overbuy";
  onHandBefore: number;
  acquiredQty: number;
  /** Velocity: days the stock on hand would have lasted. */
  daysOfStock: number | null;
  reorderThreshold: number | null;
}

export function checkOverbuy(
  item: InventoryItem,
  onHandBefore: number,
  acquiredQty: number,
  config: Config,
): Overbuy | null {
  const base = { metric: "overbuy" as const, onHandBefore, acquiredQty };
  if (item.trackingType === "velocity") {
    if (item.emaDays === null) return null;
    const daysOfStock = onHandBefore * item.emaDays;
    return daysOfStock >= config.overbuyDaysOfStock
      ? { ...base, daysOfStock, reorderThreshold: null }
      : null;
  }
  if (item.reorderThreshold === null) return null;
  return onHandBefore > item.reorderThreshold * config.staticOverbuyMultiplier
    ? { ...base, daysOfStock: null, reorderThreshold: item.reorderThreshold }
    : null;
}
