// Every tunable the domain logic uses (DESIGN §4). Code defaults live here; a `setting` row with the
// same dotted key path overrides them (see `withSettings`). Domain functions take a `Config` so
// tests can vary one knob at a time.

export const DEFAULT_CONFIG = {
  /** Defines "today", same-day merges, away dates and cycle schedules (DESIGN §8). */
  householdTz: "America/Los_Angeles",

  /** §4.1 Velocity (EMA over "days one base unit lasts"). */
  ema: {
    /** Weight of the new observation: `ema = (1 − alpha) × ema + alpha × observed`. */
    alpha: 0.3,
    /** `observed > highOutlierRatio × ema` is a trip / off-system buy. */
    highOutlierRatio: 3.0,
    /** `observed < lowOutlierRatio × ema` is a stock-up. */
    lowOutlierRatio: 0.25,
    /** Consecutive same-direction outliers that count as a real habit change. */
    outlierStreakToAccept: 3,
  },

  /** §4.1 One-off items: bought once → static; a second purchase within this window → velocity. */
  promoteToVelocityWithinDays: 183,

  /** §4.2 / §4.3 `runout ≤ today + lowWithinDays` → low / in the cart plan. */
  lowWithinDays: 3,
  /** §4.2 Overbuy: stock on hand at acquisition would have lasted at least this long. */
  overbuyDaysOfStock: 14,
  /** §4.2 Overbuy for static items: `on_hand_before > reorder_threshold × this`. */
  staticOverbuyMultiplier: 2,

  /** §4.3 Velocity cart quantity covers this many days (until the next weekly cycle). */
  cartCoverDays: 7,
  /** §4.3 Static items: purchase units added when at/below the reorder threshold. */
  staticCartUnits: 1,

  /** §4.4 Product choice & learning. */
  product: {
    defaultSwitchThreshold: 0.15,
    /** Override toward the pricier preferred product. */
    thresholdStepUp: 0.05,
    thresholdCap: 0.6,
    /** Override toward a cheaper / different product, or an implicit swap. */
    thresholdStepDown: 0.03,
    thresholdFloor: 0,
    preferenceScoreStep: 1,
    /** Same product bought this many times in a row → stance `preferred`. */
    autoPromoteConsecutiveBuys: 3,
  },

  /** §4.5 Receipt matching. */
  matching: {
    /** Fuzzy (token-set ratio) score at or above which a paper line is applied provisionally. */
    fuzzyApplyThreshold: 0.85,
  },

  /** §4.6 Review expiry windows in days (`null` = never expires). */
  reviewExpiryDays: {
    receipt: 14,
    new_product: 30,
    merge_suggestion: 30,
    unverified_item: null,
    failed_job: 14,
    trash_cam: 7,
  },
  /** §4.6 `impact_score` weights. */
  impact: { inCartPlan: 10, inPleaseCheck: 3, otherwise: 1 },

  /** §4.7 Weekly schedule, household-local (ISO weekday: 1 = Monday … 7 = Sunday). */
  cycle: {
    nudge: { isoWeekday: 5, hour: 18, minute: 0 },
    build: { isoWeekday: 6, hour: 10, minute: 0 },
    /** Latest time the next cycle is opened if the agent didn't open it right after closing. */
    openBy: { isoWeekday: 1, hour: 9, minute: 0 },
  },
} as const;

type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends null
      ? number | null
      : { -readonly [K in keyof T]: Widen<T[K]> };

export type ReviewKindForExpiry = keyof (typeof DEFAULT_CONFIG)["reviewExpiryDays"];

export type Config = Omit<Widen<typeof DEFAULT_CONFIG>, "reviewExpiryDays"> & {
  reviewExpiryDays: Record<ReviewKindForExpiry, number | null>;
};

/**
 * Apply `setting` rows (`key` = dotted path into the config, e.g. `ema.alpha`, `value` = JSON) on
 * top of `base`. Unknown keys and values whose type doesn't match the default are ignored and
 * returned in `rejected`, so a bad row can't break the domain logic.
 */
export function withSettings(
  settings: Readonly<Record<string, unknown>>,
  base: Config = DEFAULT_CONFIG,
): { config: Config; rejected: string[] } {
  const config = structuredClone(base) as Config;
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const path = key.split(".");
    let node: Record<string, unknown> = config as unknown as Record<string, unknown>;
    for (const part of path.slice(0, -1)) {
      const next = Object.hasOwn(node, part) ? node[part] : undefined;
      node = next !== null && typeof next === "object" ? (next as Record<string, unknown>) : {};
    }
    const leaf = path.at(-1)!;
    const current = Object.hasOwn(node, leaf) ? node[leaf] : undefined;
    const ok =
      current !== undefined &&
      (typeof current === "object" && current !== null
        ? false
        : current === null
          ? value === null || typeof value === "number"
          : typeof value === typeof current || (value === null && isNullableLeaf(key)));
    if (ok) node[leaf] = value;
    else rejected.push(key);
  }
  return { config, rejected };
}

/** Leaves whose default is a number but which also accept `null` (= never). */
const isNullableLeaf = (key: string) => key.startsWith("reviewExpiryDays.");
