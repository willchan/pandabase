// DESIGN §4.9 — Subscribe & Save: the agent's sweep syncs each member's subscriptions; the cart
// plan leaves the items they deliver out of the weekly cart.
import { subscription, type Db } from "@pandabase/db";
import { and, eq, isNull, inArray } from "drizzle-orm";
import {
  diffSubscriptions,
  isActiveSubscription,
  subscribedItems,
  type ItemSubscription,
  type SeenSubscription,
} from "../domain/subscriptions";
import type { ProductRow } from "../repo/catalog";
import type { Q } from "../repo/db";
import { emitTelemetry } from "../telemetry";
import { newId } from "./receipts";
import type { ServiceCtx } from "./types";

type ReadCtx = Pick<ServiceCtx, "now" | "config">;

export interface SyncResult {
  active: number;
  added: number;
  ended: number;
  reopened: number;
}

/**
 * Replace `memberId`'s `vendor` subscriptions with what the page listed (`diffSubscriptions`):
 * new ASINs are added, listed ones refreshed (`last_seen_at`, next delivery, schedule) and
 * reopened if they had ended, open ones it doesn't list are ended.
 */
export async function syncSubscriptions(
  db: Db,
  input: { memberId: string; vendor: string; subscriptions: SeenSubscription[] },
  ctx: ReadCtx,
): Promise<SyncResult> {
  return db.transaction(async (tx) => {
    const mine = and(
      eq(subscription.memberId, input.memberId),
      eq(subscription.vendor, input.vendor),
    );
    const existing = await tx.select().from(subscription).where(mine);
    const diff = diffSubscriptions(existing, input.subscriptions);
    const fields = (s: SeenSubscription) => ({
      title: s.title,
      nextDeliveryOn: s.nextDeliveryOn,
      schedule: s.schedule,
      lastSeenAt: ctx.now,
      updatedAt: ctx.now,
    });
    if (diff.added.length) {
      await tx.insert(subscription).values(
        diff.added.map((s) => ({
          id: newId(),
          memberId: input.memberId,
          vendor: input.vendor,
          asin: s.asin,
          firstSeenAt: ctx.now,
          endedAt: null,
          ...fields(s),
        })),
      );
    }
    for (const { id, sub } of diff.seen) {
      await tx
        .update(subscription)
        .set({ ...fields(sub), endedAt: null })
        .where(eq(subscription.id, id));
    }
    if (diff.ended.length) {
      await tx
        .update(subscription)
        .set({ endedAt: ctx.now, updatedAt: ctx.now })
        .where(and(inArray(subscription.id, diff.ended), isNull(subscription.endedAt)));
    }
    const result: SyncResult = {
      active: diff.added.length + diff.seen.length,
      added: diff.added.length,
      ended: diff.ended.length,
      reopened: diff.seen.filter((s) => s.reopened).length,
    };
    await emitTelemetry(
      tx,
      "state_engine",
      [{ metric: "subscription_sync", memberId: input.memberId, vendor: input.vendor, ...result }],
      ctx.now,
    );
    return result;
  });
}

/** Items an active subscription (any member's) delivers, keyed by item id. */
export async function subscribedItemsFor(
  q: Q,
  products: ReadonlyMap<string, readonly ProductRow[]>,
  ctx: ReadCtx,
): Promise<Map<string, ItemSubscription>> {
  const open = await q.select().from(subscription).where(isNull(subscription.endedAt));
  return subscribedItems(
    products,
    open.filter((r) => isActiveSubscription(r, ctx.now, ctx.config)),
  );
}
