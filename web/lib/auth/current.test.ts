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
  session.name = null;
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

  it("signed out → /sign-in", async () => {
    session.email = null;
    expect(await redirectOf(currentMember())).toBe("/sign-in");
  });

  it("creates the member on an allowed email's first visit, once", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "alex@example.com,New@Example.com");
    session.email = "New@Example.com";
    session.name = "Liza Example";
    const first = await currentMember();
    expect(first.member).toMatchObject({
      email: "new@example.com",
      displayName: "Liza",
      discordUserId: null,
      amazonSweep: "off",
      isCartAccount: false,
    });
    expect(first.ctx.actor.memberId).toBe(first.member.id);
    const again = await currentMember();
    expect(again.member.id).toBe(first.member.id);
  });

  it("names a new member after the email when Google sends no name", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "noname@example.com");
    session.email = "noname@example.com";
    session.name = null;
    expect((await currentMember()).member.displayName).toBe("noname");
  });
});
