// Auth.js config (DESIGN §3.1): the Google allowlist, and the dev sign-in that must not exist
// outside NODE_ENV=development.
import { describe, expect, it } from "vitest";
import { authConfig, DEV_PROVIDER_ID } from "./auth";

const env = (o: Record<string, string>) =>
  ({ ALLOWED_EMAILS: "alex@example.com, Sam@Example.com", ...o }) as unknown as NodeJS.ProcessEnv;

type Provider = { id?: string; options?: { id?: string; authorize?: (c: unknown) => unknown } };
const idOf = (p: Provider) => p.options?.id ?? p.id;
const ids = (e: NodeJS.ProcessEnv) =>
  (authConfig(e).providers as unknown as Provider[]).map((p) =>
    typeof p === "function" ? (p as () => Provider)().id : idOf(p),
  );
const devProvider = (e: NodeJS.ProcessEnv) =>
  (authConfig(e).providers as unknown as Provider[]).find((p) => idOf(p) === DEV_PROVIDER_ID);

describe("authConfig", () => {
  it("signIn callback rejects emails outside ALLOWED_EMAILS (case-insensitive)", async () => {
    const signIn = authConfig(env({ NODE_ENV: "production" })).callbacks!.signIn!;
    const call = (email: string | null) =>
      signIn({ user: { email }, account: null } as unknown as Parameters<typeof signIn>[0]);
    expect(await call("alex@example.com")).toBe(true);
    expect(await call("sam@example.com")).toBe(true);
    expect(await call("stranger@example.com")).toBe(false);
    expect(await call(null)).toBe(false);
    // No allowlist → nobody gets in.
    const closed = authConfig({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv);
    expect(await closed.callbacks!.signIn!({ user: { email: "alex@example.com" } } as never)).toBe(
      false,
    );
  });

  it.each(["production", "test", ""])(
    "DEV_AUTH_BYPASS=1 adds no dev sign-in when NODE_ENV=%j",
    (nodeEnv) => {
      expect(ids(env({ NODE_ENV: nodeEnv, DEV_AUTH_BYPASS: "1" }))).not.toContain(DEV_PROVIDER_ID);
    },
  );

  it("dev sign-in exists only with DEV_AUTH_BYPASS=1 in development, for allowed emails", async () => {
    expect(ids(env({ NODE_ENV: "development" }))).not.toContain(DEV_PROVIDER_ID);
    expect(ids(env({ NODE_ENV: "development", DEV_AUTH_BYPASS: "true" }))).not.toContain(
      DEV_PROVIDER_ID,
    );
    const dev = devProvider(env({ NODE_ENV: "development", DEV_AUTH_BYPASS: "1" }));
    expect(dev).toBeDefined();
    const authorize = dev!.options!.authorize!;
    expect(await authorize({ email: " Alex@example.com " })).toMatchObject({
      email: "alex@example.com",
    });
    expect(await authorize({ email: "stranger@example.com" })).toBeNull();
    expect(await authorize({})).toBeNull();
  });

  it("uses JWT sessions and the app's sign-in page", () => {
    const c = authConfig(env({ NODE_ENV: "production" }));
    expect(c.session?.strategy).toBe("jwt");
    expect(c.pages).toEqual({ signIn: "/sign-in", error: "/sign-in" });
  });
});
