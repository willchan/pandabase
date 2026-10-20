import { member } from "@pandabase/db";
import { eq, or } from "drizzle-orm";
import { badRequest } from "../http";
import type { Q } from "./db";

/** A member by id or Discord user id (the agent knows members by Discord id). */
export async function resolveMemberRef(q: Q, ref: string): Promise<typeof member.$inferSelect> {
  const [m] = await q
    .select()
    .from(member)
    .where(or(eq(member.id, ref), eq(member.discordUserId, ref)));
  if (!m) throw badRequest(`unknown account ${ref}`);
  return m;
}
