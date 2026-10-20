// Inventory writes and reads behind the agent's inventory routes (and M5's server actions):
// counts / flags / consumed / discarded / moved, text purchases, lookup, freezer aging, away
// periods, "never buy X".
import {
  awayPeriod,
  inventoryEvent,
  inventoryState,
  item,
  preferenceEvent,
  product,
  type Db,
} from "@pandabase/db";
import { toInventoryItem } from "@pandabase/db/rebuild-state";
import { and, asc, eq, ne } from "drizzle-orm";
import type { z } from "zod";
import type {
  AwayPeriodResponse,
  FreezerItem,
  InventoryEventInputT,
  InventoryEventsResponse,
  ItemEstimate as ItemEstimateContract,
  LookupResponse,
  ProductRejectResponse,
} from "../contracts";
import { projectInventory } from "../domain/inventory";
import { lookupAnswer, searchItems } from "../domain/lookup";
import { rejectProduct } from "../domain/productChoice";
import { badRequest } from "../http";
import { canonicalItems, getItem, getProduct, toCandidate } from "../repo/catalog";
import type { Q } from "../repo/db";
import {
  awayPeriods,
  loadEstimates,
  refreshInventoryState,
  type ItemEstimate,
} from "../repo/inventory";
import { emitTelemetry } from "../telemetry";
import { ingestReceiptIn, newId } from "./receipts";
import { isoUtc, type ServiceCtx } from "./types";

type EventInsert = typeof inventoryEvent.$inferInsert;
type Location = EventInsert["location"];

export const toItemEstimate = (e: ItemEstimate): z.input<typeof ItemEstimateContract> => ({
  item_id: e.item.id,
  on_hand: round(e.estimate.onHand),
  status: e.estimate.status,
  runout_at: e.estimate.runoutAt,
});

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Record inventory events in one transaction. `acquired` events become a manual receipt per vendor
 * (so the EMA, overbuy and product stats run, DESIGN §4.5); the rest are written directly. Every
 * count logs `estimate_vs_observed` (§4.2).
 */
export async function recordInventoryEvents(
  db: Db,
  events: readonly InventoryEventInputT[],
  ctx: ServiceCtx & { idempotencyKey: string | null },
): Promise<z.input<typeof InventoryEventsResponse>> {
  return db.transaction(async (tx) => {
    const eventIds: string[] = [];
    const touched = new Set<string>();
    const observed: { itemId: string; location: string; at: string }[] = [];
    const purchases = new Map<string, InventoryEventInputT[]>();

    for (const e of events) {
      const it = await getItem(tx, e.item_id);
      if (it.mergedIntoItemId)
        throw badRequest(`item ${it.id} was merged into ${it.mergedIntoItemId}`);
      if (e.kind === "acquired") {
        const vendor = e.vendor ?? "other";
        purchases.set(vendor, [...(purchases.get(vendor) ?? []), e]);
        continue;
      }
      const location = (e.location ?? it.defaultLocation) as Location;
      const occurredAt = isoUtc(e.occurred_at ?? ctx.now);
      const row: EventInsert = {
        id: newId(),
        createdAt: ctx.now,
        updatedAt: ctx.now,
        itemId: it.id,
        location,
        kind: "observed",
        quantity: null,
        occurredAt,
        source: e.source ?? "manual",
        actorMemberId: ctx.actor.memberId,
        actorSystem: ctx.actor.system,
        trust: "confirmed",
      };
      const qty = () => {
        if (e.quantity === null || e.quantity === undefined) {
          throw badRequest(`${e.kind} needs a quantity`);
        }
        return e.quantity;
      };
      switch (e.kind) {
        case "observed":
          Object.assign(row, { kind: "observed", quantity: qty() });
          observed.push({ itemId: it.id, location, at: occurredAt });
          break;
        case "critical":
          Object.assign(row, { kind: "observed", quantity: null, statusOverride: "critical" });
          break;
        case "consumed":
          Object.assign(row, { kind: "consumed", quantity: 0, statusOverride: "consumed" });
          break;
        case "discarded":
          Object.assign(row, { kind: "discarded", quantity: qty() });
          break;
        case "moved":
          if (!e.to_location || e.to_location === location) {
            throw badRequest("moved needs a to_location different from location");
          }
          Object.assign(row, { kind: "moved", quantity: qty(), toLocation: e.to_location });
          break;
      }
      await tx.insert(inventoryEvent).values(row);
      eventIds.push(row.id!);
      touched.add(it.id);
    }

    let receiptId: string | null = null;
    for (const [vendor, buys] of purchases) {
      const res = await ingestReceiptIn(
        tx,
        {
          source: "manual",
          vendor,
          accountMemberId: ctx.actor.memberId,
          externalOrderId: null,
          fulfillment: "unknown",
          orderedAt: null,
          acquiredAt: isoUtc(buys[0]!.occurred_at ?? ctx.now),
          subtotalCents: null,
          totalCents: null,
          idempotencyKey: `${ctx.idempotencyKey ?? newId()}:${vendor}`,
          lines: await Promise.all(
            buys.map(async (b) => ({
              rawText: (await getItem(tx, b.item_id)).canonicalName,
              asin: null,
              itemId: b.item_id,
              productId: b.product_id ?? null,
              qty: b.quantity ?? 1,
              unitPriceCents: null,
              lineTotalCents: null,
            })),
          ),
        },
        ctx,
      );
      receiptId ??= res.receipt_id;
      for (const b of buys) touched.add(b.item_id);
    }

    await refreshInventoryState(tx, [...touched], ctx.now, ctx.config);
    await emitEstimateVsObserved(tx, observed, ctx);
    const estimates = await loadEstimates(tx, ctx.now, ctx.config, [...touched]);
    return {
      event_ids: eventIds,
      receipt_id: receiptId,
      estimates: [...estimates.values()].map(toItemEstimate),
    };
  });
}

/** §4.2 / §7: the projection's estimate just before each new count, vs the count. */
async function emitEstimateVsObserved(
  q: Q,
  counts: readonly { itemId: string; location: string; at: string }[],
  ctx: ServiceCtx,
): Promise<void> {
  const away = await awayPeriods(q);
  for (const itemId of new Set(counts.map((c) => c.itemId))) {
    const it = await getItem(q, itemId);
    const events = await q
      .select()
      .from(inventoryEvent)
      .where(and(eq(inventoryEvent.itemId, itemId), ne(inventoryEvent.trust, "expired")))
      .orderBy(asc(inventoryEvent.occurredAt), asc(inventoryEvent.id));
    const { estimateVsObserved } = projectInventory(toInventoryItem(it), events, {
      away,
      config: ctx.config,
    });
    const mine = estimateVsObserved.filter((x) =>
      counts.some((c) => c.itemId === itemId && c.location === x.location && c.at === x.at),
    );
    await emitTelemetry(
      q,
      "state_engine",
      mine.map((x) => ({
        metric: "estimate_vs_observed",
        itemId,
        item: it.canonicalName,
        location: x.location,
        estimated: round(x.estimated),
        observed: x.observed,
        error: round(x.estimated - x.observed),
      })),
      ctx.now,
    );
  }
}

/** "Do we have X?" (PRD §4.4). */
export async function lookupItems(
  q: Q,
  query: string,
  ctx: Pick<ServiceCtx, "now" | "config">,
): Promise<z.input<typeof LookupResponse>> {
  const hits = searchItems(query, await canonicalItems(q), ctx.config);
  const estimates = await loadEstimates(
    q,
    ctx.now,
    ctx.config,
    hits.map((h) => h.id),
  );
  return {
    query,
    matches: hits.flatMap((h) => {
      const e = estimates.get(h.id);
      if (!e) return [];
      const answer = lookupAnswer({
        name: e.item.canonicalName,
        estimate: e.estimate,
        lastAcquired: e.lastAcquired,
        lastVerifiedAt: e.lastVerifiedAt,
        now: ctx.now,
        config: ctx.config,
      });
      return [
        {
          item_id: h.id,
          name: e.item.canonicalName,
          score: round(h.score),
          base_unit: e.item.baseUnit,
          on_hand: round(e.estimate.onHand),
          status: e.estimate.status,
          runout_at: e.estimate.runoutAt,
          confidence: answer.confidence,
          text: answer.text,
          by_location: e.estimate.byLocation.map((l) => ({
            location: l.location as Location,
            on_hand: round(l.onHand),
          })),
        },
      ];
    }),
  };
}

/** Oldest freezer stock first (by `frozen_at`, else when it was anchored). */
export async function freezerAging(
  q: Q,
  limit: number,
  ctx: Pick<ServiceCtx, "now" | "config">,
): Promise<z.input<typeof FreezerItem>[]> {
  const rows = await q
    .select({ itemId: inventoryState.itemId })
    .from(inventoryState)
    .where(eq(inventoryState.location, "freezer"));
  const estimates = await loadEstimates(
    q,
    ctx.now,
    ctx.config,
    rows.map((r) => r.itemId),
  );
  const out: (z.input<typeof FreezerItem> & { since: string })[] = [];
  for (const e of estimates.values()) {
    if (e.item.mergedIntoItemId) continue;
    const loc = e.estimate.byLocation.find((l) => l.location === "freezer");
    const state = e.states.find((s) => s.location === "freezer");
    if (!loc || loc.onHand <= 0 || !state) continue;
    out.push({
      item_id: e.item.id,
      name: e.item.canonicalName,
      base_unit: e.item.baseUnit,
      quantity: round(loc.onHand),
      frozen_at: state.frozenAt,
      since: state.frozenAt ?? state.anchorAt ?? ctx.now,
    });
  }
  return out
    .sort((a, b) => a.since.localeCompare(b.since) || a.item_id.localeCompare(b.item_id))
    .slice(0, limit)
    .map((x) => ({
      item_id: x.item_id,
      name: x.name,
      base_unit: x.base_unit,
      quantity: x.quantity,
      frozen_at: x.frozen_at,
    }));
}

/** Away periods change decay between events, so the whole projection is refreshed. */
export async function createAwayPeriod(
  db: Db,
  input: { startsOn: string; endsOn: string; note: string | null },
  ctx: ServiceCtx,
): Promise<z.input<typeof AwayPeriodResponse>> {
  if (input.endsOn < input.startsOn) throw badRequest("ends_on is before starts_on");
  return db.transaction(async (tx) => {
    const id = newId();
    await tx.insert(awayPeriod).values({
      id,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      note: input.note,
      createdByMemberId: ctx.actor.memberId,
    });
    const items = await tx.select({ id: item.id }).from(item);
    await refreshInventoryState(
      tx,
      items.map((i) => i.id),
      ctx.now,
      ctx.config,
    );
    return {
      away_period: { id, starts_on: input.startsOn, ends_on: input.endsOn, note: input.note },
    };
  });
}

/** "Never buy X" (§4.4): stance `rejected` + a `reject` preference event. */
export async function rejectProductById(
  db: Db,
  productId: string,
  ctx: ServiceCtx,
): Promise<z.input<typeof ProductRejectResponse>> {
  return db.transaction(async (tx) => {
    const p = await getProduct(tx, productId);
    const it = await getItem(tx, p.itemId);
    const learned = rejectProduct(toCandidate(p), it.switchThreshold);
    for (const { id, ...patch } of learned.productPatches) {
      await tx
        .update(product)
        .set({ ...patch, updatedAt: ctx.now })
        .where(eq(product.id, id));
    }
    for (const e of learned.events) {
      await tx
        .insert(preferenceEvent)
        .values({ id: newId(), createdAt: ctx.now, updatedAt: ctx.now, itemId: it.id, ...e });
    }
    await emitTelemetry(
      tx,
      "state_engine",
      learned.events.map((e) => ({ ...e, metric: "preference_event", itemId: it.id })),
      ctx.now,
    );
    return {
      product_id: p.id,
      item_id: it.id,
      stance: "rejected",
      changed: learned.events.length > 0,
    };
  });
}
