// Costco trips, the trip list and store pins (DESIGN §3.2, §4.8). Mutations follow §8 *Database
// round trips*: read in one batch, decide with the pure domain functions, write in one batch.
import { costcoTrip, groceryCycle, item, setting, type Db } from "@pandabase/db";
import { eq, isNotNull } from "drizzle-orm";
import type { z } from "zod";
import type {
  CostcoListLine as CostcoListLineContract,
  CostcoTripPlanResponse,
  CostcoTripResponse,
  CostcoTripStatusResponse,
  StorePinResponse,
} from "../contracts";
import type { CostcoListLineT, CostcoTripT } from "../contracts/costco";
import type { Config } from "../config";
import { costcoTripList, isTripExpired, tripDateProblem } from "../domain/costcoTrip";
import {
  chooseStore,
  learnStoreOverride,
  type Store,
  type StoreChoice,
} from "../domain/storeChoice";
import { badRequest, conflict, notFound } from "../http";
import { productsByItem, toCandidate, type ProductRow } from "../repo/catalog";
import { parseCartResult } from "../repo/cycles";
import { batchThen, batchTransaction, type Q } from "../repo/db";
import { loadEstimates, type ItemEstimate } from "../repo/inventory";
import { telemetryWrites } from "../telemetry";
import { planItems, plannedTrip, productRef } from "./cycles";
import { toItemEstimate } from "./inventory";
import { newId } from "./receipts";
import type { ServiceCtx } from "./types";

type ReadCtx = Pick<ServiceCtx, "now" | "config">;
type TripRow = typeof costcoTrip.$inferSelect;

/** Household setting key the store pins teach (§4.8 learning). */
export const COSTCO_THRESHOLD_KEY = "costco.switchThreshold";

const toTrip = (t: TripRow): CostcoTripT => ({
  id: t.id,
  planned_for: t.plannedFor,
  status: t.status,
  discord_thread_id: t.discordThreadId,
  list: Array.isArray(t.list) ? (t.list as CostcoListLineT[]) : [],
  receipt_id: t.receiptId,
  closed_at: t.closedAt,
  close_reason: t.closeReason,
  created_at: t.createdAt,
});

/** The live list for a trip on `tripDate` (§4.8 `costcoListLine` over the catalog). */
export async function costcoListFor(
  q: Q,
  tripDate: string,
  ctx: ReadCtx,
): Promise<z.input<typeof CostcoListLineContract>[]> {
  const estimates = await loadEstimates(q, ctx.now, ctx.config);
  const products = await productsByItem(q, [...estimates.keys()]);
  const list = costcoTripList({
    items: planItems(estimates, products),
    tripDate,
    now: ctx.now,
    config: ctx.config,
  });
  return list.map((l) => {
    const e = estimates.get(l.itemId)!;
    const row = products.get(l.itemId)!.find((p) => p.id === l.product.id)!;
    return {
      item_id: l.itemId,
      name: e.item.canonicalName,
      base_unit: e.item.baseUnit,
      product: productRef(row, {}),
      quantity: l.quantity,
      reason: l.reason,
      on_hand: toItemEstimate(e).on_hand,
      runout_at: e.estimate.runoutAt,
      store_reason: l.choice.reason,
      savings_ratio: l.choice.savingsRatio,
    };
  });
}

/** `GET /api/costco/trip`: the planned trip with its live list. */
export async function currentCostcoTrip(
  q: Q,
  ctx: ReadCtx,
): Promise<z.input<typeof CostcoTripResponse>> {
  const trip = await plannedTrip(q);
  if (!trip) return { trip: null, lines: [] };
  return { trip: toTrip(trip), lines: await costcoListFor(q, trip.plannedFor, ctx) };
}

/**
 * "Going to Costco Saturday": plan a trip on `plannedFor`, or move the planned one there (and
 * fill in its Discord message). The list is snapshotted as posted.
 */
export async function planCostcoTrip(
  db: Db,
  input: { plannedFor: string; discordThreadId: string | null },
  ctx: ServiceCtx,
): Promise<z.input<typeof CostcoTripPlanResponse>> {
  const problem = tripDateProblem(input.plannedFor, ctx.now, ctx.config);
  if (problem) throw badRequest(`planned_for: ${problem}`);
  // The list reads the whole catalog; it's computed before the write lock is taken.
  const lines = await costcoListFor(db, input.plannedFor, ctx);
  return batchTransaction(db, async (tx) => {
    const [[existing]] = await tx.batch([
      tx.select().from(costcoTrip).where(eq(costcoTrip.status, "planned")),
    ]);
    const id = existing?.id ?? newId();
    const movedFrom =
      existing && existing.plannedFor !== input.plannedFor ? existing.plannedFor : null;
    const write = existing
      ? tx
          .update(costcoTrip)
          .set({
            plannedFor: input.plannedFor,
            discordThreadId: input.discordThreadId ?? existing.discordThreadId,
            list: lines,
            updatedAt: ctx.now,
          })
          .where(eq(costcoTrip.id, existing.id))
      : tx.insert(costcoTrip).values({
          id,
          createdAt: ctx.now,
          updatedAt: ctx.now,
          plannedFor: input.plannedFor,
          status: "planned",
          discordThreadId: input.discordThreadId,
          list: lines,
        });
    const [[row]] = await batchThen(
      tx,
      [
        write,
        ...telemetryWrites(
          tx,
          "state_engine",
          [
            {
              metric: "costco_trip_planned",
              tripId: id,
              plannedFor: input.plannedFor,
              movedFrom,
              created: !existing,
              listLines: lines.length,
            },
          ],
          ctx.now,
        ),
      ],
      [tx.select().from(costcoTrip).where(eq(costcoTrip.id, id))] as const,
    );
    return { trip: toTrip(row!), lines, created: !existing, moved_from: movedFrom };
  });
}

/** Built cycles' carts (a household has one a week, so this stays small). */
const builtCycles = (q: Q) =>
  q
    .select({ cartResult: groceryCycle.cartResult, builtAt: groceryCycle.builtAt })
    .from(groceryCycle)
    .where(isNotNull(groceryCycle.builtAt));

/** Distinct Costco items these weekly carts bridged (`cart_result`, §4.8). */
function bridgedSince(rows: { cartResult: unknown }[]): number {
  const ids = new Set<string>();
  for (const r of rows)
    for (const id of parseCartResult(r.cartResult)?.costco_bridged_item_ids ?? []) ids.add(id);
  return ids.size;
}

const closeTelemetry = (trip: TripRow, outcome: string, bridged: number) => ({
  metric: "costco_trip",
  tripId: trip.id,
  plannedFor: trip.plannedFor,
  outcome,
  listLines: Array.isArray(trip.list) ? trip.list.length : 0,
  bridged,
  // M10.3 adds `bought` and `savings` from the trip's receipt.
  receiptId: trip.receiptId,
});

/**
 * "Back from Costco" (`done`) or "not going" (`cancelled`). Repeating the trip's status is a
 * no-op; changing a closed trip is a 409. TODO(M10.3): a Costco receipt sweep follows "back from
 * Costco" and links the receipt (`receipt_id`) — until then `done` closes it without one.
 */
export async function setCostcoTripStatus(
  db: Db,
  tripId: string,
  input: { status: "done" | "cancelled"; reason: string | null },
  ctx: ServiceCtx,
): Promise<z.input<typeof CostcoTripStatusResponse>> {
  return batchTransaction(db, async (tx) => {
    const [[trip], built] = await tx.batch([
      tx.select().from(costcoTrip).where(eq(costcoTrip.id, tripId)),
      builtCycles(tx),
    ]);
    if (!trip) throw notFound(`costco trip ${tripId}`);
    if (trip.status === input.status) return { trip: toTrip(trip), changed: false };
    if (trip.status !== "planned") throw conflict(`costco trip ${tripId} is ${trip.status}`);
    const cycles = built.filter((c) => c.builtAt! >= trip.createdAt);
    const closeReason =
      input.reason ?? (input.status === "done" ? "back_from_costco" : "cancelled");
    const [[row]] = await batchThen(
      tx,
      [
        tx
          .update(costcoTrip)
          .set({ status: input.status, closedAt: ctx.now, closeReason, updatedAt: ctx.now })
          .where(eq(costcoTrip.id, tripId)),
        ...telemetryWrites(
          tx,
          "state_engine",
          [closeTelemetry(trip, input.status, bridgedSince(cycles))],
          ctx.now,
        ),
      ],
      [tx.select().from(costcoTrip).where(eq(costcoTrip.id, tripId))] as const,
    );
    return { trip: toTrip(row!), changed: true };
  });
}

/**
 * Daily cron (§4.8 default outcome): a planned trip `costco.tripExpireAfterDays` past its date
 * with no receipt is closed as `cancelled` (reason `expired`), so the weekly cart stops waiting
 * for it. Returns how many trips it closed (0 or 1).
 */
export async function expireCostcoTrips(db: Db, ctx: ReadCtx): Promise<number> {
  return batchTransaction(db, async (tx) => {
    const [[trip], cycles] = await tx.batch([
      tx.select().from(costcoTrip).where(eq(costcoTrip.status, "planned")),
      builtCycles(tx),
    ]);
    if (!trip || trip.receiptId !== null || !isTripExpired(trip.plannedFor, ctx.now, ctx.config))
      return 0;
    const since = cycles.filter((c) => c.builtAt! >= trip.createdAt);
    await batchThen(
      tx,
      [
        tx
          .update(costcoTrip)
          .set({
            status: "cancelled",
            closedAt: ctx.now,
            closeReason: "expired",
            updatedAt: ctx.now,
          })
          .where(eq(costcoTrip.id, trip.id)),
        ...telemetryWrites(
          tx,
          "cron",
          [closeTelemetry(trip, "expired", bridgedSince(since))],
          ctx.now,
        ),
      ],
      [],
    );
    return 1;
  });
}

/** An item's store choice with its pin, and what PandaBase would choose without one (item page). */
export function itemStoreChoice(
  e: Pick<ItemEstimate, "item" | "inv">,
  products: readonly ProductRow[],
  config: Config,
): { choice: StoreChoice; auto: StoreChoice } {
  const choose = (pin: Store | null) =>
    chooseStore({
      item: e.inv,
      baseUnit: e.item.baseUnit,
      products: products.map(toCandidate),
      switchThreshold: e.item.switchThreshold,
      pin,
      freezesBulk: false,
      config,
    });
  return { choice: choose(e.item.storePin ?? null), auto: choose(null) };
}

/**
 * "Get X at Costco / Whole Foods": pin the item (§4.8 `learnStoreOverride`). When the pin goes
 * against a price-based choice, the household `costco.switchThreshold` moves (a `setting` row).
 * `null` clears the pin and teaches nothing.
 */
export async function setStorePin(
  db: Db,
  itemId: string,
  to: Store | null,
  ctx: ServiceCtx,
): Promise<z.input<typeof StorePinResponse>> {
  return batchTransaction(db, async (tx) => {
    const estimates = await loadEstimates(tx, ctx.now, ctx.config, [itemId]);
    const e = estimates.get(itemId);
    if (!e || e.item.mergedIntoItemId) throw notFound(`item ${itemId}`);
    const products = ((await productsByItem(tx, [itemId])).get(itemId) ?? []).map(toCandidate);
    const choose = (pin: Store | null, config: Config) =>
      chooseStore({
        item: e.inv,
        baseUnit: e.item.baseUnit,
        products,
        switchThreshold: e.item.switchThreshold,
        pin,
        freezesBulk: false,
        config,
      });
    const before = ctx.config.costco.switchThreshold;
    // What PandaBase would choose on its own is what the person is agreeing or disagreeing with.
    const learned = to
      ? learnStoreOverride({
          choice: choose(null, ctx.config),
          to,
          switchThreshold: before,
          config: ctx.config,
        })
      : null;
    const after = learned?.switchThreshold ?? before;
    const changed = after !== before;
    const config = { ...ctx.config, costco: { ...ctx.config.costco, switchThreshold: after } };
    const choice = choose(to, config);
    await batchThen(
      tx,
      [
        tx.update(item).set({ storePin: to, updatedAt: ctx.now }).where(eq(item.id, itemId)),
        ...(changed
          ? [
              tx
                .insert(setting)
                .values({
                  key: COSTCO_THRESHOLD_KEY,
                  value: after,
                  createdAt: ctx.now,
                  updatedAt: ctx.now,
                })
                .onConflictDoUpdate({
                  target: setting.key,
                  set: { value: after, updatedAt: ctx.now },
                }),
            ]
          : []),
        ...telemetryWrites(
          tx,
          "state_engine",
          [
            {
              metric: "store_override",
              itemId,
              from: e.item.storePin ?? null,
              to,
              kind: learned?.event?.kind ?? null,
              thresholdBefore: before,
              thresholdAfter: after,
              store: choice.store,
              why: choice.why,
            },
          ],
          ctx.now,
        ),
      ],
      [],
    );
    return {
      item_id: itemId,
      name: e.item.canonicalName,
      store_pin: to,
      choice: {
        store: choice.store,
        why: choice.why,
        reason: choice.reason,
        savings_ratio: choice.savingsRatio,
      },
      switch_threshold: after,
      threshold_changed: changed,
    };
  });
}
