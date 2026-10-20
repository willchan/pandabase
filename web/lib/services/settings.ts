// Household settings (PRD §4.6 Settings): members ↔ Discord ids, the cart account, away periods
// and tunable defaults (`setting` rows over `web/lib/config.ts`).
import { awayPeriod, item, member, setting, type Db } from "@pandabase/db";
import { eq, ne } from "drizzle-orm";
import { withSettings } from "../config";
import { badRequest, notFound } from "../http";
import { refreshInventoryState } from "../repo/inventory";
import { emitTelemetry } from "../telemetry";
import type { ServiceCtx } from "./types";

type Sweep = (typeof member.$inferSelect)["amazonSweep"];

export async function updateMember(
  db: Db,
  memberId: string,
  input: { displayName: string; discordUserId: string | null; amazonSweep: Sweep },
  ctx: Pick<ServiceCtx, "now">,
): Promise<void> {
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 60) throw badRequest("name must be 1–60 characters");
  const discord = input.discordUserId?.trim() || null;
  if (discord && !/^\d{5,25}$/.test(discord)) throw badRequest("a Discord user id is digits only");
  await db.transaction(async (tx) => {
    const [m] = await tx.select().from(member).where(eq(member.id, memberId));
    if (!m) throw notFound(`member ${memberId}`);
    if (discord) {
      const [other] = await tx.select().from(member).where(eq(member.discordUserId, discord));
      if (other && other.id !== memberId) throw badRequest("that Discord id belongs to someone else");
    }
    await tx
      .update(member)
      .set({
        displayName,
        discordUserId: discord,
        amazonSweep: input.amazonSweep,
        updatedAt: ctx.now,
      })
      .where(eq(member.id, memberId));
  });
}

/** Exactly one cart account (DESIGN §2.1): clear the others, then set this one. */
export async function setCartAccount(
  db: Db,
  memberId: string,
  ctx: Pick<ServiceCtx, "now">,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [m] = await tx.select().from(member).where(eq(member.id, memberId));
    if (!m) throw notFound(`member ${memberId}`);
    await tx
      .update(member)
      .set({ isCartAccount: false, updatedAt: ctx.now })
      .where(ne(member.id, memberId));
    await tx
      .update(member)
      .set({ isCartAccount: true, updatedAt: ctx.now })
      .where(eq(member.id, memberId));
  });
}

/** Remove an away period; decay between events changes, so every item is re-projected. */
export async function deleteAwayPeriod(
  db: Db,
  id: string,
  ctx: Pick<ServiceCtx, "now" | "config">,
): Promise<void> {
  await db.transaction(async (tx) => {
    const deleted = await tx.delete(awayPeriod).where(eq(awayPeriod.id, id)).returning();
    if (deleted.length === 0) throw notFound(`away period ${id}`);
    const items = await tx.select({ id: item.id }).from(item);
    await refreshInventoryState(
      tx,
      items.map((i) => i.id),
      ctx.now,
      ctx.config,
    );
  });
}

/**
 * Save tunables as `setting` rows (dotted config paths). A `null` value resets the key to its code
 * default. Keys or values `withSettings` would reject are refused, so a bad edit can't reach the
 * domain logic.
 */
export async function updateSettings(
  db: Db,
  values: Readonly<Record<string, number | null>>,
  ctx: Pick<ServiceCtx, "now">,
): Promise<void> {
  const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
  const { rejected } = withSettings(set);
  const invalid = Object.entries(set).filter(([, v]) => typeof v !== "number" || !(v >= 0));
  const bad = [...new Set([...rejected, ...invalid.map(([k]) => k)])];
  if (bad.length > 0) throw badRequest(`invalid settings: ${bad.join(", ")}`, bad);
  const keys = Object.keys(values);
  if (keys.length === 0) return;
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) {
        await tx.delete(setting).where(eq(setting.key, key));
      } else {
        await tx
          .insert(setting)
          .values({ key, value, createdAt: ctx.now, updatedAt: ctx.now })
          .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: ctx.now } });
      }
    }
    await emitTelemetry(tx, "state_engine", [{ metric: "settings_changed", keys }], ctx.now);
  });
}
