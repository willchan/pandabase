// Household-TZ date arithmetic and away-day subtraction (DESIGN §4.1, §4.2, §8).
//
// Instants are UTC ISO strings (`2026-10-20T16:00:00.000Z`); household dates are `YYYY-MM-DD` in
// the household time zone. No DST-naive "add 24h" on local dates: local midnights go through
// `zonedToUtc`.

export const DAY_MS = 86_400_000;

/** `away_period` rows: inclusive household-local dates. */
export interface AwayPeriod {
  startsOn: string;
  endsOn: string;
}

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new RangeError(`invalid instant: ${iso}`);
  return t;
};

export const toIso = (t: number): string => new Date(t).toISOString();

/** Fractional days from `from` to `to` (negative if `to` is earlier). */
export const daysBetween = (from: string, to: string): number => (ms(to) - ms(from)) / DAY_MS;

export const addDaysToInstant = (iso: string, days: number): string =>
  toIso(ms(iso) + days * DAY_MS);

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** Household-local calendar date of an instant. */
export function localDate(iso: string, tz: string): string {
  let f = dateFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short" });
    dateFormatters.set(tz, f);
  }
  return f.format(ms(iso));
}

/** Offset of `tz` from UTC at instant `t`, in ms (e.g. −7h for PDT). */
function tzOffsetMs(t: number, tz: string): number {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partsFormatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(t / 1000) * 1000;
}

const parseDate = (date: string): [number, number, number] => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`invalid date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

/** The UTC instant of household-local `date` at `hour:minute`. */
export function zonedToUtc(date: string, hour: number, minute: number, tz: string): string {
  const [y, mo, d] = parseDate(date);
  const guess = Date.UTC(y, mo - 1, d, hour, minute);
  let t = guess - tzOffsetMs(guess, tz);
  const second = tzOffsetMs(t, tz);
  if (second !== guess - t) t = guess - second;
  return toIso(t);
}

/** Calendar arithmetic on `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

/** ISO-8601 week label of a calendar date, e.g. `2026-W43`. */
export function isoWeekLabel(date: string): string {
  const thursday = addDays(date, 4 - isoWeekday(date));
  const [y] = parseDate(thursday);
  const jan1 = Date.UTC(y, 0, 1);
  const week = Math.floor((Date.parse(`${thursday}T00:00:00Z`) - jan1) / DAY_MS / 7) + 1;
  return `${y}-W${String(week).padStart(2, "0")}`;
}

/** Calendar date of ISO weekday `isoWeekdayN` (1–7) in the ISO week `label`. */
export function dateInIsoWeek(label: string, isoWeekdayN: number): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) throw new RangeError(`invalid week label: ${label}`);
  const jan4 = `${m[1]}-01-04`;
  const week1Monday = addDays(jan4, 1 - isoWeekday(jan4));
  return addDays(week1Monday, (Number(m[2]) - 1) * 7 + isoWeekdayN - 1);
}

export const isAwayOn = (date: string, away: readonly AwayPeriod[]): boolean =>
  away.some((p) => p.startsOn <= date && date <= p.endsOn);

/** Away periods as sorted, merged half-open UTC intervals [start, end) in ms. */
export function awayIntervals(away: readonly AwayPeriod[], tz: string): [number, number][] {
  const raw = away
    .map((p): [number, number] => [
      ms(zonedToUtc(p.startsOn, 0, 0, tz)),
      ms(zonedToUtc(addDays(p.endsOn, 1), 0, 0, tz)),
    ])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const iv of raw) {
    const last = out.at(-1);
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/** Days of `[from, to]` that fall inside an away period (0 if `to ≤ from`). */
export function awayDaysBetween(
  from: string,
  to: string,
  away: readonly AwayPeriod[],
  tz: string,
): number {
  const a = ms(from);
  const b = ms(to);
  if (b <= a) return 0;
  let total = 0;
  for (const [s, e] of awayIntervals(away, tz))
    total += Math.max(0, Math.min(b, e) - Math.max(a, s));
  return total / DAY_MS;
}

/** Days from `from` to `to` with away days subtracted (DESIGN §4.1 `elapsed`). */
export const effectiveDaysBetween = (
  from: string,
  to: string,
  away: readonly AwayPeriod[],
  tz: string,
): number => daysBetween(from, to) - awayDaysBetween(from, to, away, tz);

/** The instant `days` at-home days after `from`, skipping away periods (DESIGN §4.2 runout). */
export function addEffectiveDays(
  from: string,
  days: number,
  away: readonly AwayPeriod[],
  tz: string,
): string {
  let t = ms(from);
  let remaining = days * DAY_MS;
  if (remaining <= 0) return toIso(t + remaining);
  for (const [s, e] of awayIntervals(away, tz)) {
    if (e <= t) continue;
    if (s > t) {
      if (remaining <= s - t) return toIso(t + remaining);
      remaining -= s - t;
    }
    t = e;
  }
  return toIso(t + remaining);
}
