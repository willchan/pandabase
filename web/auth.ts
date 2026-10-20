// Auth.js v5 (DESIGN §3.1): Google sign-in, JWT sessions, `ALLOWED_EMAILS` allowlist.
// Minimal in M4 (API session checks); M5 adds the sign-in UI.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { isAllowedEmail } from "@/lib/auth/allowlist";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    signIn: ({ user }) => isAllowedEmail(user.email),
  },
});
