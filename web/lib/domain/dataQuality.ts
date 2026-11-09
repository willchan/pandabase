// DESIGN §7 data-quality checks (weekly report §3 "Data quality"). Two failure shapes that every
// test missed in 2026-11 because fixtures were cleaner than real pages: an importer tagging every
// order with one store, and page furniture ("Amazon Business Card") imported as groceries. Plus
// a guard on §4.3: nothing planned should have run out longer ago than an item counts as lapsed.
import type { Config } from "../config";
import { addDays, localDate } from "./time";

export interface StoreSplit {
  /** Lines counted (non-ignored). */
  lines: number;
  /** Lines per store, most first (ties by name). */
  byStore: { store: string; lines: number }[];
  /** The top store's share of lines (0 when there are none). */
  topShare: number;
  /** Enough lines, and one store has `storeSplitShare` or more of them. */
  flagged: boolean;
}

/** How a week's receipt lines split across stores, flagged when one store has (nearly) all. */
export function storeSplit(stores: readonly string[], config: Config): StoreSplit {
  const counts = new Map<string, number>();
  for (const st of stores) counts.set(st, (counts.get(st) ?? 0) + 1);
  const byStore = [...counts.entries()]
    .map(([store, lines]) => ({ store, lines }))
    .sort((a, b) => b.lines - a.lines || a.store.localeCompare(b.store));
  const lines = stores.length;
  const topShare = lines ? byStore[0]!.lines / lines : 0;
  const { storeSplitShare, storeSplitMinLines } = config.dataQuality;
  return {
    lines,
    byStore,
    topShare,
    flagged: lines >= storeSplitMinLines && topShare >= storeSplitShare,
  };
}

/** The `adLikeNames` phrase `name` contains (case-insensitive), or null. */
export function adLikePhrase(name: string, config: Config): string | null {
  const lower = name.toLowerCase();
  return config.dataQuality.adLikeNames.find((p) => lower.includes(p.toLowerCase())) ?? null;
}

/**
 * Whole days `runoutAt` is before today (household TZ) when that is more than `lapsedAfterDays`
 * — an item planned this long after it ran out — else null.
 */
export function staleRunoutDays(
  runoutAt: string | null,
  now: string,
  config: Config,
): number | null {
  if (runoutAt === null) return null;
  const tz = config.householdTz;
  const today = localDate(now, tz);
  if (localDate(runoutAt, tz) >= addDays(today, -config.lapsedAfterDays)) return null;
  return Math.round((Date.parse(today) - Date.parse(localDate(runoutAt, tz))) / 86_400_000);
}
