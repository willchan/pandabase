// Data-quality checks (DESIGN §7). Regression shapes from 2026-11 (W45): the live order pages had
// no <main>, so every imported order was tagged `wholefoods` (one store, 100% of lines) and the
// footer's "Amazon Business Card" link became an item on every order.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../config";
import { isLapsed } from "./predictions";
import { adLikePhrase, staleRunoutDays, storeSplit } from "./dataQuality";

const cfg: Config = DEFAULT_CONFIG;
const many = (store: string, n: number) => Array.from({ length: n }, () => store);

describe("storeSplit", () => {
  it("flags a week where one store has every line (the W45 importer bug)", () => {
    const r = storeSplit(many("wholefoods", 40), cfg);
    expect(r).toMatchObject({ lines: 40, topShare: 1, flagged: true });
    expect(r.byStore).toEqual([{ store: "wholefoods", lines: 40 }]);
  });

  it("flags at exactly the share threshold", () => {
    expect(storeSplit([...many("amazon", 19), "wholefoods"], cfg).flagged).toBe(true); // 95%
    expect(storeSplit([...many("amazon", 18), ...many("wholefoods", 2)], cfg).flagged).toBe(false);
  });

  it("doesn't flag a small week", () => {
    expect(storeSplit(many("amazon", 19), cfg)).toMatchObject({ topShare: 1, flagged: false });
  });

  it("orders stores by lines, then name; empty weeks are zero", () => {
    expect(storeSplit(["b", "a", "c", "c"], cfg).byStore).toEqual([
      { store: "c", lines: 2 },
      { store: "a", lines: 1 },
      { store: "b", lines: 1 },
    ]);
    expect(storeSplit([], cfg)).toEqual({ lines: 0, byStore: [], topShare: 0, flagged: false });
  });

  it("follows the config", () => {
    const loose = { ...cfg, dataQuality: { ...cfg.dataQuality, storeSplitMinLines: 2 } };
    expect(storeSplit(many("amazon", 2), loose).flagged).toBe(true);
  });
});

describe("adLikePhrase", () => {
  it.each([
    ["Amazon Business Card", "business card"],
    ["Purchase Subscription", "purchase subscription"],
    ["Learn more about Prime", "learn more"],
  ])("flags %s", (name, phrase) => expect(adLikePhrase(name, cfg)).toBe(phrase));

  it.each(["Organic Bananas", "Cardamom Pods", "Sparkling Water 12pk", "Card stock paper"])(
    "leaves %s alone",
    (name) => expect(adLikePhrase(name, cfg)).toBeNull(),
  );
});

describe("staleRunoutDays", () => {
  const now = "2026-11-08T20:00:00.000Z"; // Nov 8, Los Angeles

  it("is null without a runout or within lapsedAfterDays", () => {
    expect(staleRunoutDays(null, now, cfg)).toBeNull();
    expect(staleRunoutDays("2026-11-01T20:00:00.000Z", now, cfg)).toBeNull();
    expect(staleRunoutDays("2026-09-09T20:00:00.000Z", now, cfg)).toBeNull(); // 60 days
  });

  it("counts days for an older runout", () => {
    expect(staleRunoutDays("2026-09-08T20:00:00.000Z", now, cfg)).toBe(61);
    expect(staleRunoutDays("2026-01-01T20:00:00.000Z", now, cfg)).toBe(311);
  });

  it("uses the same boundary as isLapsed", () => {
    for (const r of ["2026-09-08T20:00:00.000Z", "2026-09-09T20:00:00.000Z"]) {
      expect(staleRunoutDays(r, now, cfg) !== null).toBe(isLapsed(r, now, cfg));
    }
  });
});
