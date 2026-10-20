// Auth.js v5 (DESIGN §3.1): Google sign-in, JWT sessions, `ALLOWED_EMAILS` allowlist. With
// `DEV_AUTH_BYPASS=1` in `NODE_ENV=development` only, a "dev" credentials provider signs in as any
// allowed email without the Google round-trip (local dev and the e2e suite).
import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { devBypassEnabled, isAllowedEmail } from "@/lib/auth/allowlist";

export const DEV_PROVIDER_ID = "dev";

export function authConfig(env: NodeJS.ProcessEnv = process.env): NextAuthConfig {
  const providers: NextAuthConfig["providers"] = [Google];
  if (devBypassEnabled(env)) {
    providers.push(
      Credentials({
        id: DEV_PROVIDER_ID,
        name: "Dev sign-in",
        credentials: { email: { label: "Email", type: "email" } },
        authorize: (c) => {
          const email = typeof c?.email === "string" ? c.email.trim().toLowerCase() : "";
          return isAllowedEmail(email, env) ? { id: email, email, name: email.split("@")[0] } : null;
        },
      }),
    );
  }
  return {
    providers,
    session: { strategy: "jwt" },
    pages: { signIn: "/sign-in", error: "/sign-in" },
    callbacks: {
      // Rejected Google accounts land on /sign-in?error=AccessDenied.
      signIn: ({ user }) => isAllowedEmail(user.email, env),
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig());
