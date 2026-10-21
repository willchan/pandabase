// `pnpm db:add-member --email … --name … [--discord ID] [--profile NAME] [--sweep daily|weekly|off]
// [--cart]`: create or update a household member by email (PLAN M8). The web UI can edit members
// but not create them, and sign-in needs a member row for every allowed email, so a fresh
// production database is bootstrapped with this. Idempotent: re-running updates the same row.
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { eq, ne } from "drizzle-orm";
import { createDb, type Db } from "./client";
import { databaseUrlFromEnv } from "./env";
import { AMAZON_SWEEPS, member } from "./schema/people";

export interface MemberInput {
  email: string;
  displayName: string;
  discordUserId?: string | null;
  chromiumProfile?: string | null;
  amazonSweep?: (typeof AMAZON_SWEEPS)[number];
  isCartAccount?: boolean;
}

export async function upsertMember(
  db: Db,
  input: MemberInput,
): Promise<{ id: string; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error(`not an email: ${input.email}`);
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error("--name is required");
  if (input.discordUserId && !/^\d{5,25}$/.test(input.discordUserId))
    throw new Error("a Discord user id is digits only");
  if (input.amazonSweep && !AMAZON_SWEEPS.includes(input.amazonSweep))
    throw new Error(`--sweep must be one of ${AMAZON_SWEEPS.join(", ")}`);

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(member).where(eq(member.email, email));
    const fields = {
      displayName,
      ...(input.discordUserId !== undefined && { discordUserId: input.discordUserId }),
      ...(input.chromiumProfile !== undefined && { chromiumProfile: input.chromiumProfile }),
      ...(input.amazonSweep !== undefined && { amazonSweep: input.amazonSweep }),
    };
    let id: string;
    if (existing) {
      id = existing.id;
      await tx.update(member).set(fields).where(eq(member.id, id));
    } else {
      const [row] = await tx
        .insert(member)
        .values({ email, ...fields })
        .returning({ id: member.id });
      id = row!.id;
    }
    // Exactly one cart account (DESIGN §2.1): clear the others, then set this one.
    if (input.isCartAccount) {
      await tx.update(member).set({ isCartAccount: false }).where(ne(member.id, id));
      await tx.update(member).set({ isCartAccount: true }).where(eq(member.id, id));
    }
    return { id, created: !existing };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      discord: { type: "string" },
      profile: { type: "string" },
      sweep: { type: "string" },
      cart: { type: "boolean", default: false },
    },
  });
  if (!values.email || !values.name) {
    console.error(
      "usage: pnpm db:add-member --email E --name N [--discord ID] [--profile P] [--sweep daily|weekly|off] [--cart]",
    );
    process.exit(2);
  }
  const url = databaseUrlFromEnv();
  const db = createDb({ url });
  try {
    const res = await upsertMember(db, {
      email: values.email,
      displayName: values.name,
      discordUserId: values.discord,
      chromiumProfile: values.profile,
      amazonSweep: values.sweep as MemberInput["amazonSweep"],
      isCartAccount: values.cart,
    });
    console.log(
      `${res.created ? "added" : "updated"} member ${values.email} (${res.id}) in ${url}`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    db.$client.close();
  }
}
