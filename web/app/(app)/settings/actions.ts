"use server";
// Settings server actions → `web/lib/services/settings.ts` / `inventory.ts`.
import { signOut } from "@/auth";
import { num, runAction, str, type ActionResult } from "@/lib/actions";
import { badRequest } from "@/lib/http";
import { createAwayPeriod } from "@/lib/services/inventory";
import {
  deleteAwayPeriod,
  setCartAccount,
  updateMember,
  updateSettings,
} from "@/lib/services/settings";
import { TUNABLES } from "@/lib/tunables";

const need = (v: string | null, what: string): string => {
  if (!v) throw badRequest(`${what} is required`);
  return v;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function addAwayAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("add_away_period", async ({ db, ctx }) => {
    const startsOn = need(str(f, "startsOn"), "Start date");
    const endsOn = str(f, "endsOn") ?? startsOn;
    if (!DATE.test(startsOn) || !DATE.test(endsOn)) throw badRequest("Dates must be YYYY-MM-DD");
    await createAwayPeriod(db, { startsOn, endsOn, note: str(f, "note") }, ctx);
    return "Away period saved — those days won't count as eating.";
  });
}

export async function deleteAwayAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("delete_away_period", async ({ db, ctx }) => {
    await deleteAwayPeriod(db, need(str(f, "id"), "Away period"), ctx);
  });
}

export async function updateMemberAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("update_member", async ({ db, ctx }) => {
    const sweep = str(f, "amazonSweep") ?? "off";
    if (sweep !== "daily" && sweep !== "weekly" && sweep !== "off")
      throw badRequest("Unknown sweep");
    await updateMember(
      db,
      need(str(f, "memberId"), "Member"),
      {
        displayName: need(str(f, "displayName"), "Name"),
        discordUserId: str(f, "discordUserId"),
        amazonSweep: sweep,
      },
      ctx,
    );
    return "Saved.";
  });
}

export async function cartAccountAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("set_cart_account", async ({ db, ctx }) => {
    await setCartAccount(db, need(str(f, "memberId"), "Member"), ctx);
    return "Cart account updated.";
  });
}

export async function updateTunablesAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("update_settings", async ({ db, ctx }) => {
    const values: Record<string, number | null> = {};
    for (const t of TUNABLES) {
      const v = num(f, t.key);
      if (v !== null && Number.isNaN(v)) throw badRequest(`${t.label} must be a number`);
      // Blank or unchanged → leave alone.
      if (v !== null && v !== t.get(ctx.config)) values[t.key] = v;
    }
    await updateSettings(db, values, ctx);
    return "Saved.";
  });
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/sign-in" });
}
