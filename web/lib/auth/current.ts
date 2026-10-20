// The signed-in member for pages and server actions. Every UI request re-checks the allowlist
// (a JWT outlives a removed email) and resolves the member row; anything else → /sign-in.
import { member, type Db } from "@pandabase/db";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { auth } from "@/auth";
import { appContext } from "../context";
import { loadConfig } from "../repo/settings";
import type { ServiceCtx } from "../services/types";
import { isAllowedEmail } from "./allowlist";

export interface Current {
  member: typeof member.$inferSelect;
  db: Db;
  ctx: ServiceCtx;
}

export const currentMember = cache(async (): Promise<Current> => {
  await connection();
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email || !isAllowedEmail(email)) redirect("/sign-in");
  const app = appContext();
  const [m] = await app.db.select().from(member).where(eq(member.email, email));
  if (!m) redirect("/sign-in?error=NotAMember");
  const { config } = await loadConfig(app.db);
  return {
    member: m,
    db: app.db,
    ctx: { now: app.now(), config, actor: { memberId: m.id, system: null } },
  };
});
