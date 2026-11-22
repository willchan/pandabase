// DESIGN §4.9 — Subscribe & Save: items a member's Amazon account already delivers on a schedule
// stay out of the weekly cart (a one-time buy of them is redundant).
import type { Config } from "../config";
import { addDays, localDate } from "./time";

export interface SubscriptionRow {
  id: string;
  asin: string;
  lastSeenAt: string;
  endedAt: string | null;
  nextDeliveryOn: string | null;
}

/** Still delivering: not ended, and listed by a sync within `subscriptions.staleAfterDays`. */
export function isActiveSubscription(
  row: Pick<SubscriptionRow, "lastSeenAt" | "endedAt">,
  now: string,
  config: Config,
): boolean {
  if (row.endedAt !== null) return false;
  const tz = config.householdTz;
  return (
    localDate(row.lastSeenAt, tz) >=
    addDays(localDate(now, tz), -config.subscriptions.staleAfterDays)
  );
}

export interface SeenSubscription {
  asin: string;
  title: string | null;
  nextDeliveryOn: string | null;
  schedule: string | null;
}

export interface SyncDiff {
  /** ASINs not seen before for this member. */
  added: SeenSubscription[];
  /** Rows listed again (refreshed; an ended one is reopened). */
  seen: { id: string; sub: SeenSubscription; reopened: boolean }[];
  /** Open rows this sync no longer lists: cancelled on Amazon. */
  ended: string[];
}

/**
 * One sync replaces the member's list: what it lists is current, an open row it doesn't list has
 * ended. Duplicate ASINs in `incoming` keep the first.
 */
export function diffSubscriptions(
  existing: readonly Pick<SubscriptionRow, "id" | "asin" | "endedAt">[],
  incoming: readonly SeenSubscription[],
): SyncDiff {
  const byAsin = new Map(existing.map((r) => [r.asin, r]));
  const listed = new Set<string>();
  const diff: SyncDiff = { added: [], seen: [], ended: [] };
  for (const sub of incoming) {
    if (listed.has(sub.asin)) continue;
    listed.add(sub.asin);
    const row = byAsin.get(sub.asin);
    if (row) diff.seen.push({ id: row.id, sub, reopened: row.endedAt !== null });
    else diff.added.push(sub);
  }
  for (const r of existing) if (r.endedAt === null && !listed.has(r.asin)) diff.ended.push(r.id);
  return diff;
}

export interface ItemSubscription {
  asin: string;
  /** Soonest next delivery among the item's active subscriptions, if the page showed one. */
  nextDeliveryOn: string | null;
}

/**
 * Items covered by an active subscription: one of the item's products carries a subscribed ASIN
 * (any vendor's product: the ASIN is what Amazon delivers). `active` must already be filtered with
 * `isActiveSubscription`.
 */
export function subscribedItems(
  productsByItem: ReadonlyMap<string, readonly { asin: string | null }[]>,
  active: readonly Pick<SubscriptionRow, "asin" | "nextDeliveryOn">[],
): Map<string, ItemSubscription> {
  const byAsin = new Map<string, Pick<SubscriptionRow, "asin" | "nextDeliveryOn">[]>();
  for (const s of active) byAsin.set(s.asin, [...(byAsin.get(s.asin) ?? []), s]);
  const out = new Map<string, ItemSubscription>();
  for (const [itemId, products] of productsByItem) {
    const subs = products.flatMap((p) => (p.asin ? (byAsin.get(p.asin) ?? []) : []));
    if (!subs.length) continue;
    const dated = subs
      .filter((s) => s.nextDeliveryOn !== null)
      .sort((a, b) => a.nextDeliveryOn!.localeCompare(b.nextDeliveryOn!));
    const first = dated[0] ?? subs[0]!;
    out.set(itemId, { asin: first.asin, nextDeliveryOn: first.nextDeliveryOn });
  }
  return out;
}
