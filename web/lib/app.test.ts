import { describe, expect, it } from "vitest";

import { APP_NAME } from "@/lib/app";

describe("app metadata", () => {
  it("names the app", () => {
    expect(APP_NAME).toBe("PandaBase");
  });
});
