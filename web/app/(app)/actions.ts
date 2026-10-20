"use server";
// This Week (and shared item) server actions. Each calls a service in `web/lib/services/*` — the
// same code the agent's routes use — never an HTTP route.
import { item } from "@pandabase/db";
import { and, isNull, sql } from "drizzle-orm";
import { runAction, str, num, type ActionResult } from "@/lib/actions";
import { badRequest } from "@/lib/http";
import { activeCycle } from "@/lib/repo/cycles";
import { addOverride, openCycle, setCycleStatus } from "@/lib/services/cycles";
import { markItem } from "@/lib/services/inventory";
import type { Q } from "@/lib/repo/db";

async function requireCycle(q: Q, cycleId: string | null) {
  const c = await activeCycle(q);
  if (!c || (cycleId && c.id !== cycleId)) {
    throw badRequest("This week's list changed — refresh and try again.");
  }
  return c;
}

const need = (v: string | null, what: string): string => {
  if (!v) throw badRequest(`${what} is required`);
  return v;
};

export async function openCycleAction(): Promise<ActionResult> {
  return runAction("open_cycle", async ({ db, ctx }) => {
    await openCycle(db, null, ctx, "session");
    return "This week's list is open.";
  });
}

/** Add an item (exact name match) or a one-off free-text line. */
export async function addToListAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("add_to_list", async ({ db, ctx }) => {
    const text = need(str(f, "text"), "What to add");
    const quantity = num(f, "quantity");
    if (quantity !== null && !(quantity > 0)) throw badRequest("Quantity must be more than 0");
    const cycle = await requireCycle(db, str(f, "cycleId"));
    const [match] = await db
      .select({ id: item.id, name: item.canonicalName })
      .from(item)
      .where(
        and(isNull(item.mergedIntoItemId), sql`lower(${item.canonicalName}) = ${text.toLowerCase()}`),
      )
      .limit(1);
    await addOverride(
      db,
      cycle.id,
      match
        ? { kind: "add", item_id: match.id, quantity }
        : { kind: "add", free_text: text.slice(0, 200), quantity: quantity ?? 1 },
      ctx,
    );
    return `Added ${match?.name ?? text}.`;
  });
}

export async function skipItemAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("skip_item", async ({ db, ctx }) => {
    const cycle = await requireCycle(db, str(f, "cycleId"));
    await addOverride(db, cycle.id, { kind: "skip", item_id: need(str(f, "itemId"), "Item") }, ctx);
  });
}

export async function unskipItemAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("unskip_item", async ({ db, ctx }) => {
    const cycle = await requireCycle(db, str(f, "cycleId"));
    await addOverride(db, cycle.id, { kind: "add", item_id: need(str(f, "itemId"), "Item") }, ctx);
  });
}

export async function setQuantityAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("set_quantity", async ({ db, ctx }) => {
    const cycle = await requireCycle(db, str(f, "cycleId"));
    const quantity = num(f, "quantity");
    if (quantity === null || !(quantity > 0)) throw badRequest("Quantity must be more than 0");
    await addOverride(
      db,
      cycle.id,
      { kind: "qty", item_id: need(str(f, "itemId"), "Item"), quantity },
      ctx,
    );
    return "Saved.";
  });
}

export async function setProductAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("set_product", async ({ db, ctx }) => {
    const cycle = await requireCycle(db, str(f, "cycleId"));
    await addOverride(
      db,
      cycle.id,
      {
        kind: "product",
        item_id: need(str(f, "itemId"), "Item"),
        product_id: need(str(f, "productId"), "Product"),
      },
      ctx,
    );
    return "Saved — we'll remember the preference.";
  });
}

const CLOSES = { skipped: "skip_week", other_store: "other_store", closed: "close_cycle" } as const;

export async function cycleStatusAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  const status = str(f, "status") as keyof typeof CLOSES | null;
  return runAction(status ? CLOSES[status] : "cycle_status", async ({ db, ctx }) => {
    if (!status || !(status in CLOSES)) throw badRequest("Unknown status");
    const cycle = await requireCycle(db, str(f, "cycleId"));
    const reason = { skipped: "skipped from the web", other_store: "shopping elsewhere", closed: "done" }[
      status
    ];
    await setCycleStatus(db, cycle.id, { status, reason }, ctx);
  });
}

/** "We're out", "running low" or a count — This Week's please-check list and Pantry. */
export async function markItemAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  const kind = str(f, "mark");
  return runAction(`mark_${kind ?? "?"}`, async ({ db, ctx }) => {
    const itemId = need(str(f, "itemId"), "Item");
    if (kind === "out") {
      await markItem(db, itemId, { kind: "out" }, ctx);
      return "Marked as out — it'll be on the list.";
    }
    if (kind === "low") {
      await markItem(db, itemId, { kind: "low" }, ctx);
      return "Flagged as running low.";
    }
    if (kind === "count") {
      const quantity = num(f, "quantity");
      if (quantity === null || !(quantity >= 0)) throw badRequest("Enter how many you have");
      await markItem(db, itemId, { kind: "count", quantity }, ctx);
      return "Count saved.";
    }
    throw badRequest("Unknown action");
  });
}
