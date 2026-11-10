import { describe, expect, it } from "vitest";
import { showCount } from "./paging";

describe("showCount", () => {
  it("defaults to one page", () => {
    expect(showCount(undefined, 20)).toBe(20);
    expect(showCount("abc", 20)).toBe(20);
    expect(showCount("-5", 20)).toBe(20);
    expect(showCount(["40", "60"], 20)).toBe(20);
  });
  it("rounds up to whole pages", () => {
    expect(showCount("40", 20)).toBe(40);
    expect(showCount("41", 20)).toBe(60);
    expect(showCount("10", 20)).toBe(20);
  });
});
