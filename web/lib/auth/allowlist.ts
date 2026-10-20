/** `ALLOWED_EMAILS` (comma-separated, case-insensitive) — the Google sign-in allowlist. */
export function isAllowedEmail(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!email) return false;
  const allowed = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

/** `DEV_AUTH_BYPASS=1` only counts in `NODE_ENV=development` (DESIGN §3.1). */
export const devBypassEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.DEV_AUTH_BYPASS === "1" && env.NODE_ENV === "development";
