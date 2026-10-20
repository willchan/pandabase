// DESIGN §4.1 — consumption velocity as an EMA of "days one base unit lasts".
import type { Config } from "../config";
import { daysBetween, effectiveDaysBetween, localDate, type AwayPeriod } from "./time";

/** One acquisition of an item, in base units (after `qty × unit_quantity`). */
export interface Acquisition {
  at: string;
  qty: number;
}

/** The EMA columns of `item`. */
export interface VelocityState {
  emaDays: number | null;
  defaultEmaDays: number | null;
  outlierStreak: number;
  outlierDirection: "high" | "low" | null;
}

export interface VelocityContext {
  away: readonly AwayPeriod[];
  config: Config;
}

export type VelocityOutcome =
  /** No previous acquisition (or it had no quantity): nothing to measure yet. */
  | "first_acquisition"
  /** Second acquisition of an item with no EMA and no seed: EMA = observed. */
  | "initialized"
  | "updated"
  | "outlier_rejected"
  /** Third same-direction outlier in a row: treated as a habit change and blended in. */
  | "outlier_accepted"
  /** Same household-local day as the previous acquisition: merge instead (caller's job). */
  | "same_day"
  /** Earlier than the previous acquisition (late receipt): EMA untouched. */
  | "out_of_order";

/** Telemetry payloads M4 emits to `system_telemetry` (metric = `metric`). */
export type VelocityTelemetry =
  | {
      metric: "ema_outlier_rejected" | "ema_outlier_accepted";
      observedDays: number;
      emaDays: number;
      direction: "high" | "low";
      streak: number;
    }
  | {
      metric: "ema_updated";
      observedDays: number;
      emaBefore: number | null;
      emaAfter: number;
      seeded: boolean;
    };

export interface VelocityStep {
  state: VelocityState;
  outcome: VelocityOutcome;
  /** `default_ema_days` was copied into an empty EMA on this step. */
  seeded: boolean;
  elapsedDays: number | null;
  observedDays: number | null;
  telemetry: VelocityTelemetry | null;
}

/**
 * One EMA step for acquisition `current` given the previous (same-day-merged) acquisition.
 * Pure: returns the new item columns, never mutates `state`.
 */
export function updateVelocity(
  state: VelocityState,
  prev: Acquisition | null,
  current: Acquisition,
  { away, config }: VelocityContext,
): VelocityStep {
  const tz = config.householdTz;
  const step = (
    next: VelocityState,
    outcome: VelocityOutcome,
    extra: Partial<Omit<VelocityStep, "state" | "outcome">> = {},
  ): VelocityStep => ({
    state: next,
    outcome,
    seeded: false,
    elapsedDays: null,
    observedDays: null,
    telemetry: null,
    ...extra,
  });

  if (prev && localDate(prev.at, tz) === localDate(current.at, tz)) return step(state, "same_day");
  if (prev && daysBetween(prev.at, current.at) < 0) return step(state, "out_of_order");

  let ema = state.emaDays;
  let seeded = false;
  if (ema === null && state.defaultEmaDays !== null) {
    ema = state.defaultEmaDays;
    seeded = true;
  }
  if (!prev || prev.qty <= 0) {
    return step({ ...state, emaDays: ema }, "first_acquisition", { seeded });
  }

  const elapsedDays = Math.max(0, effectiveDaysBetween(prev.at, current.at, away, tz));
  const observedDays = elapsedDays / prev.qty;
  const measured = { seeded, elapsedDays, observedDays };

  if (ema === null) {
    return step({ ...state, emaDays: observedDays }, "initialized", {
      ...measured,
      telemetry: {
        metric: "ema_updated",
        observedDays,
        emaBefore: null,
        emaAfter: observedDays,
        seeded,
      },
    });
  }

  const { alpha, highOutlierRatio, lowOutlierRatio, outlierStreakToAccept } = config.ema;
  const direction =
    observedDays > highOutlierRatio * ema
      ? "high"
      : observedDays < lowOutlierRatio * ema
        ? "low"
        : null;
  let outcome: VelocityOutcome = "updated";
  if (direction) {
    const streak = state.outlierDirection === direction ? state.outlierStreak + 1 : 1;
    const telemetry = { observedDays, emaDays: ema, direction, streak } as const;
    if (streak < outlierStreakToAccept) {
      return step(
        { ...state, emaDays: ema, outlierStreak: streak, outlierDirection: direction },
        "outlier_rejected",
        { ...measured, telemetry: { metric: "ema_outlier_rejected", ...telemetry } },
      );
    }
    outcome = "outlier_accepted";
    const emaAfter = (1 - alpha) * ema + alpha * observedDays;
    return step(
      { ...state, emaDays: emaAfter, outlierStreak: 0, outlierDirection: null },
      outcome,
      { ...measured, telemetry: { metric: "ema_outlier_accepted", ...telemetry } },
    );
  }
  const emaAfter = (1 - alpha) * ema + alpha * observedDays;
  return step({ ...state, emaDays: emaAfter, outlierStreak: 0, outlierDirection: null }, outcome, {
    ...measured,
    telemetry: { metric: "ema_updated", observedDays, emaBefore: ema, emaAfter, seeded },
  });
}

/** Same-day merge: acquisitions on the same household-local date sum into one (at = earliest). */
export function mergeSameDay(acquisitions: readonly Acquisition[], tz: string): Acquisition[] {
  const sorted = [...acquisitions].sort((a, b) => daysBetween(b.at, a.at));
  const out: Acquisition[] = [];
  let lastDate: string | null = null;
  for (const a of sorted) {
    const d = localDate(a.at, tz);
    const last = out.at(-1);
    if (last && d === lastDate) last.qty += a.qty;
    else out.push({ at: a.at, qty: a.qty });
    lastDate = d;
  }
  return out;
}

/** Backfill / rebuild: replay acquisitions chronologically (after same-day merge) from `initial`. */
export function replayVelocity(
  initial: VelocityState,
  acquisitions: readonly Acquisition[],
  ctx: VelocityContext,
): { state: VelocityState; steps: VelocityStep[] } {
  let state = initial;
  let prev: Acquisition | null = null;
  const steps: VelocityStep[] = [];
  for (const a of mergeSameDay(acquisitions, ctx.config.householdTz)) {
    const s = updateVelocity(state, prev, a, ctx);
    steps.push(s);
    state = s.state;
    prev = a;
  }
  return { state, steps };
}

/**
 * Where acquisition `at` falls relative to an item's acquisition history (DESIGN §4.1 applied
 * incrementally, one receipt at a time):
 * - `next`: later than every recorded date; `prev` is the latest same-day-merged acquisition.
 * - `same_day`: on the date of the latest acquisition. That date's EMA step already happened and
 *   merging doesn't change it (merging only changes the *next* step's `prev.qty`, which is
 *   recomputed from history), so the caller skips the EMA.
 * - `out_of_order`: earlier than the latest acquisition (a late receipt); the caller skips the EMA.
 */
export function placeAcquisition(
  history: readonly Acquisition[],
  at: string,
  tz: string,
): { position: "next" | "same_day" | "out_of_order"; prev: Acquisition | null } {
  const day = localDate(at, tz);
  const latest = mergeSameDay(history, tz).at(-1) ?? null;
  if (!latest) return { position: "next", prev: null };
  const latestDay = localDate(latest.at, tz);
  if (latestDay === day) return { position: "same_day", prev: latest };
  if (latestDay > day) return { position: "out_of_order", prev: latest };
  return { position: "next", prev: latest };
}

/** §4.1: an item first seen as a one-off purchase in the 12-month backfill is `static`. */
export const trackingTypeForBackfill = (purchaseCount: number): "velocity" | "static" =>
  purchaseCount >= 2 ? "velocity" : "static";

/**
 * §4.1: a second purchase within `promoteToVelocityWithinDays` promotes a one-off static item to
 * `velocity`. Static items with a `reorder_threshold` are static by design and never promoted.
 */
export function shouldPromoteToVelocity(
  item: { trackingType: "velocity" | "static"; reorderThreshold: number | null },
  prevAcquiredAt: string | null,
  at: string,
  config: Config,
): boolean {
  if (item.trackingType !== "static" || item.reorderThreshold !== null || !prevAcquiredAt) {
    return false;
  }
  const d = daysBetween(prevAcquiredAt, at);
  return d >= 0 && d <= config.promoteToVelocityWithinDays;
}
