// Cart pauses (PRD §4.1 "Paused weeks", DESIGN §4.1/§4.7): weekly cart builds inside one are
// skipped, and EMA steps across one don't learn. Unlike an away period, days still count as eating,
// so nothing in the inventory projection changes and no re-projection is needed.
import { pausePeriod, type Db } from "@pandabase/db";
import { desc, eq } from "drizzle-orm";
import { cycleSchedule } from "../domain/cycle";
import { addDays, localDate, periodOn } from "../domain/time";
import { badRequest, conflict, notFound } from "../http";
import type { Q } from "../repo/db";
import { emitTelemetry } from "../telemetry";
import { newId } from "./receipts";
import type { ServiceCtx } from "./types";

export type PauseRow = typeof pausePeriod.$inferSelect;

export interface CartPauseT {
  id: string;
  starts_on: string;
  ends_on: string;
  note: string | null;
}

export const toPause = (p: PauseRow): CartPauseT => ({
  id: p.id,
  starts_on: p.startsOn,
  ends_on: p.endsOn,
  note: p.note,
});

/** Every pause, newest first. */
export const listPauses = (q: Q): Promise<PauseRow[]> =>
  q.select().from(pausePeriod).orderBy(desc(pausePeriod.startsOn));

/**
 * The pause that matters now: the one covering today, else the one covering the build date of
 * week `weekLabel` (a pause that starts later this week already skips this week's cart).
 */
export async function relevantPause(
  q: Q,
  ctx: Pick<ServiceCtx, "now" | "config">,
  weekLabel: string | null,
): Promise<PauseRow | null> {
  const rows = await listPauses(q);
  const today = localDate(ctx.now, ctx.config.householdTz);
  const build = weekLabel ? cycleSchedule(weekLabel, ctx.config).buildDate : null;
  return periodOn(today, rows) ?? (build ? periodOn(build, rows) : null);
}

export async function createPause(
  db: Db,
  input: { startsOn: string; endsOn: string; note: string | null },
  ctx: ServiceCtx,
): Promise<{ pause: CartPauseT }> {
  if (input.endsOn < input.startsOn) throw badRequest("ends_on is before starts_on");
  const today = localDate(ctx.now, ctx.config.householdTz);
  if (input.endsOn < today) throw badRequest("that pause would already be over");
  const note = input.note?.trim() || null;
  return db.transaction(async (tx) => {
    const id = newId();
    const [row] = await tx
      .insert(pausePeriod)
      .values({
        id,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        note,
        createdByMemberId: ctx.actor.memberId,
      })
      .returning();
    await emitTelemetry(
      tx,
      "state_engine",
      [
        {
          metric: "cart_pause_changed",
          action: "created",
          pauseId: id,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
        },
      ],
      ctx.now,
    );
    return { pause: toPause(row!) };
  });
}

/**
 * Resume carts. A pause that has started ends yesterday (so today's build, if any, goes ahead and
 * the history it froze stays frozen); one that hasn't started — or started today — is removed.
 * `pause: null` in the result means it was removed.
 */
export async function endPause(
  db: Db,
  id: string,
  ctx: Pick<ServiceCtx, "now" | "config">,
): Promise<{ pause: CartPauseT | null }> {
  const today = localDate(ctx.now, ctx.config.householdTz);
  const yesterday = addDays(today, -1);
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(pausePeriod).where(eq(pausePeriod.id, id));
    if (!p) throw notFound(`pause ${id}`);
    if (p.endsOn < today) throw conflict("that pause is already over");
    let out: PauseRow | undefined;
    if (p.startsOn > yesterday) {
      await tx.delete(pausePeriod).where(eq(pausePeriod.id, id));
    } else {
      [out] = await tx
        .update(pausePeriod)
        .set({ endsOn: yesterday, updatedAt: ctx.now })
        .where(eq(pausePeriod.id, id))
        .returning();
    }
    await emitTelemetry(
      tx,
      "state_engine",
      [
        {
          metric: "cart_pause_changed",
          action: out ? "ended" : "removed",
          pauseId: id,
          startsOn: p.startsOn,
          endsOn: out?.endsOn ?? null,
          plannedEndsOn: p.endsOn,
        },
      ],
      ctx.now,
    );
    return { pause: out ? toPause(out) : null };
  });
}
