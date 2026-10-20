// Display formatting for the UI (household time zone; plain, calm wording).
import { daysBetween, localDate } from "./domain/time";

const fmt = (tz: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts });

/** "Thu, Oct 22" */
export const shortDate = (iso: string, tz: string): string =>
  fmt(tz, { weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));

/** "Oct 22" */
export const monthDay = (iso: string, tz: string): string =>
  fmt(tz, { month: "short", day: "numeric" }).format(new Date(iso));

/** "Fri 6 PM" */
export const dayTime = (iso: string, tz: string): string =>
  fmt(tz, { weekday: "short", hour: "numeric", minute: "2-digit" })
    .format(new Date(iso))
    .replace(":00", "");

/** A household `YYYY-MM-DD` date → "Nov 3". */
export const dateOnly = (ymd: string): string =>
  fmt("UTC", { month: "short", day: "numeric" }).format(new Date(`${ymd}T12:00:00Z`));

/** Whole household days from `now` to `iso` (negative = past). */
export const daysUntil = (iso: string, now: string, tz: string): number =>
  Math.round(
    daysBetween(`${localDate(now, tz)}T00:00:00.000Z`, `${localDate(iso, tz)}T00:00:00.000Z`),
  );

/** "today" / "tomorrow" / "in 4 days" / "yesterday" / "3 days ago" */
export function relativeDay(iso: string, now: string, tz: string): string {
  const d = daysUntil(iso, now, tz);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}

/** Quantities: at most one decimal, no trailing zeros. */
export const qty = (x: number): string =>
  Number.isInteger(x) ? String(x) : (Math.round(x * 10) / 10).toString();

/** "2 eggs", "1 count" → "1", units pluralized naively. */
export function amount(x: number, unit: string): string {
  if (unit === "count") return qty(x);
  const plural = x === 1 || unit.endsWith("s") || /^(oz|lb|ml|l|g|kg)$/.test(unit) ? unit : `${unit}s`;
  return `${qty(x)} ${plural}`;
}

export const money = (cents: number | null): string | null =>
  cents === null ? null : `$${(cents / 100).toFixed(2)}`;

const VENDORS: Record<string, string> = { wholefoods: "Whole Foods", amazon: "Amazon" };
export const vendorName = (v: string): string =>
  VENDORS[v] ?? v.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export const LOCATION_LABELS: Record<string, string> = {
  fridge: "Fridge",
  freezer: "Freezer",
  pantry: "Pantry",
  bathroom: "Bathroom",
  utility: "Utility",
  garden: "Garden",
  garage: "Garage",
};
