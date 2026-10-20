// Machine bearer tokens (DESIGN §3.1): constant-time comparison, empty secrets never match.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Scope } from "../contracts/routes";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time string equality (hashing first makes lengths equal). */
export const safeEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null;
  return m ? m[1]!.trim() : null;
}

/** The machine scope a bearer token grants, or null. */
export function scopeForToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Exclude<Scope, "session"> | null {
  const candidates: [Exclude<Scope, "session">, string | undefined][] = [
    ["agent", env.AGENT_API_TOKEN],
    ["worker", env.WORKER_API_TOKEN],
    ["cron", env.CRON_SECRET],
  ];
  let found: Exclude<Scope, "session"> | null = null;
  // Compare against every secret (no early exit) so timing doesn't reveal which one matched.
  for (const [scope, secret] of candidates) {
    if (secret && safeEqual(token, secret) && !found) found = scope;
  }
  return found;
}
