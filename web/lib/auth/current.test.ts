import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redirectOf, session } from "@/test/ui";
import { setup, type Harness } from "@/test/harness";
import { currentMember } from "./current";

vi.mock("@/auth", async () => (await import("@/test/ui")).authMock);
vi.mock("next/server", async (o) => ({ ...(await o<object>()), connection: async () => {} }));
vi.mock("next/cache", async (o) => ({ ...(await o<object>()), refresh: vi.fn() }));

let h: Harness;
beforeEach(async () => {
  h = await setup();
  session.email = "alex@example.com";
});
afterEach(() => h.close());

describe("currentMember (pages and server actions)", () => {
  it("resolves the signed-in member and a service context", async () => {
    const c = await currentMember();
    expect(c.member.email).toBe("alex@example.com");
    expect(c.ctx.actor).toEqual({ memberId: c.member.id, system: null });
    expect(c.ctx.now).toBe(h.now());
  });

  it("rejects emails outside ALLOWED_EMAILS → /sign-in", async () => {
    session.email = "stranger@example.com";
    expect(await redirectOf(currentMember())).toBe("/sign-in");
  });

  it("re-checks the allowlist (a JWT outlives a removed email)", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "sam@example.com");
    expect(await redirectOf(currentMember())).toBe("/sign-in");
  });

  it("signed out → /sign-in; allowed but not a member → NotAMember", async () => {
    session.email = null;
    expect(await redirectOf(currentMember())).toBe("/sign-in");
    vi.stubEnv("ALLOWED_EMAILS", "new@example.com");
    session.email = "new@example.com";
    expect(await redirectOf(currentMember())).toBe("/sign-in?error=NotAMember");
  });
});
