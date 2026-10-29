// Server-action / page-helper tests run outside Next. Each test file declares:
//   vi.mock("@/auth", async () => (await import("@/test/ui")).authMock);
//   vi.mock("next/server", async (o) => ({ ...(await o<object>()), connection: async () => {} }));
//   vi.mock("next/cache", async (o) => ({ ...(await o<object>()), refresh: vi.fn() }));
import { vi } from "vitest";

/** The signed-in Google user; `name` is the profile name (null when Google sends none). */
export const session: { email: string | null; name?: string | null } = {
  email: "alex@example.com",
};

/** Factories for the test file's own `vi.mock` calls (mocks must be declared in the test file). */
export const authMock = {
  auth: async () =>
    session.email ? { user: { email: session.email, name: session.name ?? null } } : null,
  signIn: vi.fn(),
  signOut: vi.fn(),
};

/** `redirect()` throws; return where it pointed (or rethrow anything else). */
export async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2]!;
    throw err;
  }
  throw new Error("expected a redirect");
}

export function form(fields: Record<string, string | number>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, String(v));
  return f;
}
