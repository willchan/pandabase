import { describe, expect, it } from "vitest";
import {
  addDays,
  addDaysToInstant,
  addEffectiveDays,
  awayDaysBetween,
  dateInIsoWeek,
  daysBetween,
  effectiveDaysBetween,
  isAwayOn,
  isoWeekLabel,
  isoWeekday,
  localDate,
  zonedToUtc,
} from "./time";

const TZ = "America/Los_Angeles";

describe("localDate (household TZ)", () => {
  it.each([
    ["2026-10-20T16:00:00.000Z", "2026-10-20"],
    ["2026-10-20T06:59:59.000Z", "2026-10-19"], // 23:59 PDT the day before
    ["2026-10-20T07:00:00.000Z", "2026-10-20"],
    ["2026-12-01T07:59:00.000Z", "2026-11-30"], // PST is UTC−8
  ])("%s → %s", (iso, date) => expect(localDate(iso, TZ)).toBe(date));

  it("rejects invalid instants", () => expect(() => localDate("nope", TZ)).toThrow(RangeError));
});

describe("zonedToUtc", () => {
  it.each([
    ["2026-10-20", 0, 0, "2026-10-20T07:00:00.000Z"],
    ["2026-12-01", 0, 0, "2026-12-01T08:00:00.000Z"],
    ["2026-10-24", 10, 0, "2026-10-24T17:00:00.000Z"], // Saturday 10am build
    ["2026-03-08", 0, 0, "2026-03-08T08:00:00.000Z"], // DST starts at 2am
    ["2026-03-08", 12, 0, "2026-03-08T19:00:00.000Z"], // …so noon is PDT
    ["2026-11-01", 0, 0, "2026-11-01T07:00:00.000Z"], // DST ends at 2am
    ["2026-11-01", 12, 0, "2026-11-01T20:00:00.000Z"],
  ])("%s %i:%i → %s", (d, h, m, iso) => expect(zonedToUtc(d, h, m, TZ)).toBe(iso));

  it("rejects malformed dates", () => expect(() => zonedToUtc("10/20/2026", 0, 0, TZ)).toThrow());
});

describe("calendar arithmetic", () => {
  it.each([
    ["2026-10-31", 1, "2026-11-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2028-02-28", 1, "2028-02-29"],
  ])("addDays(%s, %i) = %s", (d, n, out) => expect(addDays(d, n)).toBe(out));

  it.each([
    ["2026-10-19", 1],
    ["2026-10-24", 6],
    ["2026-10-25", 7],
  ])("isoWeekday(%s) = %i", (d, n) => expect(isoWeekday(d)).toBe(n));

  it.each([
    ["2026-10-20", "2026-W43"],
    ["2026-01-01", "2026-W01"],
    ["2027-01-01", "2026-W53"],
    ["2024-12-30", "2025-W01"],
  ])("isoWeekLabel(%s) = %s", (d, label) => expect(isoWeekLabel(d)).toBe(label));

  it.each([
    ["2026-W43", 6, "2026-10-24"],
    ["2026-W43", 1, "2026-10-19"],
    ["2026-W01", 1, "2025-12-29"],
    ["2026-W53", 5, "2027-01-01"],
  ])("dateInIsoWeek(%s, %i) = %s", (label, wd, d) => expect(dateInIsoWeek(label, wd)).toBe(d));

  it("rejects malformed week labels", () => expect(() => dateInIsoWeek("2026-43", 1)).toThrow());

  it("daysBetween / addDaysToInstant", () => {
    expect(daysBetween("2026-10-01T00:00:00.000Z", "2026-10-02T12:00:00.000Z")).toBe(1.5);
    expect(daysBetween("2026-10-02T00:00:00.000Z", "2026-10-01T00:00:00.000Z")).toBe(-1);
    expect(addDaysToInstant("2026-10-01T00:00:00.000Z", 14)).toBe("2026-10-15T00:00:00.000Z");
  });
});

describe("away days", () => {
  // Away Mon 5 – Wed 7 Oct inclusive = [Oct 5 07:00Z, Oct 8 07:00Z).
  const away = [{ startsOn: "2026-10-05", endsOn: "2026-10-07" }];
  const at = (d: string, h = 7) => `2026-10-${d}T${String(h).padStart(2, "0")}:00:00.000Z`;

  it.each([
    ["spans the whole period", at("01"), at("11"), away, 3],
    ["starts inside", at("06", 19), at("11"), away, 1.5],
    ["ends inside", at("01"), at("06"), away, 1],
    ["before it", at("01"), at("04"), away, 0],
    ["reversed range", at("11"), at("01"), away, 0],
    [
      "overlapping periods counted once",
      at("01"),
      at("11"),
      [...away, { startsOn: "2026-10-06", endsOn: "2026-10-08" }],
      4,
    ],
    ["no periods", at("01"), at("11"), [], 0],
  ])("awayDaysBetween: %s", (_, from, to, periods, days) => {
    expect(awayDaysBetween(from, to, periods, TZ)).toBeCloseTo(days, 9);
  });

  it("counts a DST-change day as its real length", () => {
    // Oct 31 – Nov 1 local: 24h + 25h.
    const p = [{ startsOn: "2026-10-31", endsOn: "2026-11-01" }];
    expect(awayDaysBetween(at("20"), "2026-11-10T00:00:00.000Z", p, TZ)).toBeCloseTo(49 / 24, 9);
  });

  it("effectiveDaysBetween subtracts away days", () => {
    expect(effectiveDaysBetween(at("01"), at("11"), away, TZ)).toBeCloseTo(7, 9);
  });

  it.each([
    ["no away in range", at("10"), 2, at("12")],
    ["skips the away period", at("01"), 5, at("09")],
    ["ends exactly where away begins", at("01"), 4, at("05")],
    ["starts inside away", at("06", 12), 1, at("09")],
    ["zero days", at("06", 12), 0, at("06", 12)],
    ["negative days ignore away", at("09"), -5, at("04")],
  ])("addEffectiveDays: %s", (_, from, days, out) => {
    expect(addEffectiveDays(from, days, away, TZ)).toBe(out);
  });

  it.each([
    ["2026-10-04", false],
    ["2026-10-05", true],
    ["2026-10-07", true],
    ["2026-10-08", false],
  ])("isAwayOn(%s) = %s", (d, out) => expect(isAwayOn(d, away)).toBe(out));

  it("ignores degenerate periods", () => {
    expect(
      awayDaysBetween(at("01"), at("11"), [{ startsOn: "2026-10-07", endsOn: "2026-10-05" }], TZ),
    ).toBe(0);
  });
});
