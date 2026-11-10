/**
 * How many cards a "Show more" list renders for `?show=`: whole pages, at least one. Anything that
 * isn't a positive number (missing, garbage, repeated) is one page.
 */
export function showCount(show: string | string[] | undefined, pageSize: number): number {
  const n = typeof show === "string" ? Number.parseInt(show, 10) : NaN;
  return Number.isFinite(n) && n > pageSize ? Math.ceil(n / pageSize) * pageSize : pageSize;
}
