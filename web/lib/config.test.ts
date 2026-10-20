import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, withSettings } from "./config";

describe("withSettings", () => {
  it("returns a copy of the defaults when there are no settings", () => {
    const { config, rejected } = withSettings({});
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config).not.toBe(DEFAULT_CONFIG);
    expect(rejected).toEqual([]);
  });

  /** Read a dotted path from a config. */
  const get = (c: unknown, key: string): unknown =>
    key.split(".").reduce((node, k) => (node as Record<string, unknown>)[k], c);

  it.each([
    ["ema.alpha", 0.5],
    ["lowWithinDays", 2],
    ["householdTz", "Europe/London"],
    ["reviewExpiryDays.receipt", null],
    ["reviewExpiryDays.unverified_item", 90],
    ["cycle.build.hour", 9],
  ])("applies %s", (key, value) => {
    const { config, rejected } = withSettings({ [key]: value });
    expect(get(config, key)).toBe(value);
    expect(rejected).toEqual([]);
  });

  it.each([
    ["unknown key", "nope", 1],
    ["unknown nested key", "ema.nope", 1],
    ["path through a leaf", "lowWithinDays.x", 1],
    ["wrong type", "ema.alpha", "0.5"],
    ["object leaf", "ema", 1],
    ["null on a non-nullable leaf", "ema.alpha", null],
    ["string on a nullable leaf", "reviewExpiryDays.unverified_item", "never"],
    ["inherited property", "constructor", 1],
  ])("rejects %s", (_, key, value) => {
    const { config, rejected } = withSettings({ [key]: value });
    expect(rejected).toEqual([key]);
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});
