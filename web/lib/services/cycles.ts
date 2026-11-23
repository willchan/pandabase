// Grocery cycle orchestration (DESIGN §4.3, §4.4, §4.7): open, overrides, status, check-in,
// predictions, price quotes, final cart, cart result.
import {
  costcoTrip,
  groceryCycle,
  groceryCycleOverride,
  item,
  preferenceEvent,
  priceQuote,
  product,
  reviewItem,
  type Db,
} from "@pandabase/db";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type {
  CartResponse,
  CartResultRequest,
  CheckinItem,
  CheckinResponse,
  CycleOverrideRequest,
  CycleOverride as CycleOverrideContract,
  CycleStatusRequest,
  CycleT,
  PlanLine,
  PredictionsResponse,
  PriceQuotesRequest,
  ProductRef,
  PlanStore,
  CostcoWaitingLine,
  SubscribedLine,
} from "../contracts";
import type { CartResultT } from "../contracts/cycle";
import {
  isActive,
  transition,
  weekLabelToOpen,
  weekLabelToOpenAtOnce,
  type CycleEvent,
} from "../domain/cycle";
import {
  planCart,
  pleaseCheckList,
  pleaseCheckReason,
  type CartLine,
  type CartPlan,
  type CycleOverride,
  type PlanItemInput,
  type StoreNote,
} from "../domain/predictions";
import { ITEM_REVIEW_KINDS, reprioritize } from "../domain/review";
import type { ItemSubscription } from "../domain/subscriptions";
import {
  candidatesFor,
  learnFromOverride,
  pickPreferred,
  switchEvent,
} from "../domain/productChoice";
import { badRequest, conflict } from "../http";
import { getItem, productsByItem, toCandidate, type ProductRow } from "../repo/catalog";
import { activeCycle, getCycle, toCycle, type CycleRow } from "../repo/cycles";
import type { Q } from "../repo/db";
import { awayPeriods, loadEstimates, pausePeriods, type ItemEstimate } from "../repo/inventory";
import { emitTelemetry } from "../telemetry";
import { freezerAging, toItemEstimate } from "./inventory";
import { newId } from "./receipts";
import { subscribedItemsFor } from "./subscriptions";
import { isoUtc, type ServiceCtx } from "./types";

type ReadCtx = Pick<ServiceCtx, "now" | "config">;

// --- open / current / status --------------------------------------------------------------------

export async function currentCycle(q: Q): Promise<CycleT | null> {
  const c = await activeCycle(q);
  return c ? toCycle(c) : null;
}

export type OpenedBy = "agent" | "cron" | "session" | "engine";

/**
 * Open the next cycle (§4.7). Idempotent: while a cycle is active it is returned unchanged (its
 * Discord thread is filled in if the engine or cron opened it without one).
 */
export async function openCycle(
  db: Db,
  discordThreadId: string | null,
  ctx: ServiceCtx,
  openedBy: OpenedBy = "agent",
): Promise<{ cycle: CycleT; created: boolean }> {
  return db.transaction((tx) => openCycleIn(tx, discordThreadId, ctx, openedBy));
}

/** `openCycle` within the caller's transaction. */
export async function openCycleIn(
  tx: Q,
  discordThreadId: string | null,
  ctx: Pick<ServiceCtx, "now" | "config">,
  openedBy: OpenedBy,
): Promise<{ cycle: CycleT; created: boolean }> {
  const active = await activeCycle(tx);
  if (active) {
    if (discordThreadId && !active.discordThreadId) {
      await tx
        .update(groceryCycle)
        .set({ discordThreadId, updatedAt: ctx.now })
        .where(eq(groceryCycle.id, active.id));
      active.discordThreadId = discordThreadId;
    }
    return { cycle: toCycle(active), created: false };
  }
  const cycles = await tx
    .select({ weekLabel: groceryCycle.weekLabel, status: groceryCycle.status })
    .from(groceryCycle);
  const weekLabel = weekLabelToOpen(cycles, ctx.now, ctx.config)!;
  const row = {
    id: newId(),
    createdAt: ctx.now,
    updatedAt: ctx.now,
    weekLabel,
    discordThreadId,
    status: "open" as const,
    openedAt: ctx.now,
  };
  await tx.insert(groceryCycle).values(row);
  await emitTelemetry(
    tx,
    "state_engine",
    [{ metric: "cycle_opened", weekLabel, openedBy }],
    ctx.now,
  );
  return { cycle: toCycle(await getCycle(tx, row.id)), created: true };
}

/**
 * §4.7: right after a cycle ends, open the next one if its build is the upcoming one, so no week
 * waits on the agent; otherwise the Monday fallback opens it.
 */
export async function openNextCycleIn(tx: Q, ctx: Pick<ServiceCtx, "now" | "config">) {
  const cycles = await tx
    .select({ weekLabel: groceryCycle.weekLabel, status: groceryCycle.status })
    .from(groceryCycle);
  if (weekLabelToOpenAtOnce(cycles, ctx.now, ctx.config) === null) return null;
  return openCycleIn(tx, null, ctx, "engine");
}

const STATUS_EVENTS: Record<z.infer<typeof CycleStatusRequest>["status"], CycleEvent["type"]> = {
  nudged: "nudge",
  building: "build",
  ready: "built",
  skipped: "skip",
  other_store: "other_store",
  closed: "done",
};

/** Apply a §4.7 transition; invalid ones are 409s. */
export async function setCycleStatus(
  db: Db,
  cycleId: string,
  input: { status: keyof typeof STATUS_EVENTS; reason: string | null },
  ctx: ServiceCtx,
): Promise<{ cycle: CycleT; changed: boolean }> {
  return db.transaction(async (tx) => {
    const c = await getCycle(tx, cycleId);
    const res = transition(c, { type: STATUS_EVENTS[input.status] }, ctx.now, {
      away: await awayPeriods(tx),
      paused: await pausePeriods(tx),
      config: ctx.config,
    });
    if (!res.ok) throw conflict(res.error);
    if (!res.noop) {
      const patch = { ...res.patch };
      // A build skipped for an away period / pause keeps that reason (`away` / `paused`).
      if (patch.closeReason && input.reason && input.status !== "building")
        patch.closeReason = input.reason;
      await tx
        .update(groceryCycle)
        .set({ ...patch, updatedAt: ctx.now })
        .where(eq(groceryCycle.id, cycleId));
      await emitTelemetry(
        tx,
        "state_engine",
        [
          {
            metric: "cycle_transition",
            cycleId,
            from: res.from,
            to: res.to,
            event: STATUS_EVENTS[input.status],
          },
        ],
        ctx.now,
      );
      if (res.to === "building") {
        // Once per cycle, at build time: what the lapsed rule (§4.3) left out of this cart.
        const { plan } = await planFor(tx, await getCycle(tx, cycleId), ctx);
        await emitTelemetry(
          tx,
          "state_engine",
          [
            ...plan.lapsed.map((x) => ({ metric: "item_lapsed", cycleId, ...x })),
            // §4.9: flagged items left out because Subscribe & Save delivers them.
            ...plan.subscribed.map((x) => ({ metric: "subscription_left_out", cycleId, ...x })),
            // §4.8, once per planned item per build: where it comes from and why.
            ...plan.storeChoices.map((c) => ({
              metric: "store_choice",
              cycleId,
              itemId: c.itemId,
              store: c.store,
              why: c.why,
              savingsRatio: c.savingsRatio,
              timing: c.timing,
              bridgeCause: c.bridgeCause,
            })),
          ],
          ctx.now,
        );
      }
      if (!isActive(res.to)) await openNextCycleIn(tx, ctx);
    }
    return { cycle: toCycle(await getCycle(tx, cycleId)), changed: !res.noop };
  });
}

// --- plan ---------------------------------------------------------------------------------------

interface PlanState {
  plan: CartPlan;
  estimates: Map<string, ItemEstimate>;
  products: Map<string, ProductRow[]>;
  quotes: Record<string, number>;
  /** The planned Costco trip's local date, or null (§4.8). */
  costcoTripDate: string | null;
}

/** The planned Costco trip (at most one, §2.6 partial unique index), or null. */
export async function plannedTrip(q: Q) {
  const [row] = await q.select().from(costcoTrip).where(eq(costcoTrip.status, "planned"));
  return row ?? null;
}

/** `planCart` / `costcoTripList` inputs from read-time estimates and products (and, for the
 * weekly cart, the items Subscribe & Save delivers, §4.9). */
export const planItems = (
  estimates: Map<string, ItemEstimate>,
  products: Map<string, ProductRow[]>,
  subscribed: ReadonlyMap<string, ItemSubscription> = new Map(),
): PlanItemInput[] =>
  [...estimates.values()].map((e) => ({
    itemId: e.item.id,
    item: e.inv,
    baseUnit: e.item.baseUnit,
    switchThreshold: e.item.switchThreshold,
    estimate: e.estimate,
    products: (products.get(e.item.id) ?? []).map(toCandidate),
    storePin: e.item.storePin ?? null,
    subscription: subscribed.get(e.item.id) ?? null,
  }));

async function overridesOf(q: Q, cycleId: string) {
  return q
    .select()
    .from(groceryCycleOverride)
    .where(eq(groceryCycleOverride.cycleId, cycleId))
    .orderBy(asc(groceryCycleOverride.createdAt), asc(groceryCycleOverride.id));
}

/** Latest quote per product for the cycle. */
async function quotesOf(q: Q, cycleId: string): Promise<Record<string, number>> {
  const rows = await q
    .select()
    .from(priceQuote)
    .where(eq(priceQuote.cycleId, cycleId))
    .orderBy(asc(priceQuote.observedAt), asc(priceQuote.id));
  return Object.fromEntries(rows.map((r) => [r.productId, r.priceCents]));
}

/** §4.3 cart plan for `cycle` (its overrides and quotes), or a plain plan when null. */
export async function planFor(q: Q, cycle: CycleRow | null, ctx: ReadCtx): Promise<PlanState> {
  const estimates = await loadEstimates(q, ctx.now, ctx.config);
  const products = await productsByItem(q, [...estimates.keys()]);
  const overrides: CycleOverride[] = cycle
    ? (await overridesOf(q, cycle.id)).map((o) => ({
        kind: o.kind,
        itemId: o.itemId,
        freeText: o.freeText,
        quantity: o.quantity,
        productId: o.productId,
      }))
    : [];
  const quotes = cycle ? await quotesOf(q, cycle.id) : {};
  const costcoTripDate = (await plannedTrip(q))?.plannedFor ?? null;
  const subscribed = await subscribedItemsFor(q, products, ctx);
  const plan = planCart({
    items: planItems(estimates, products, subscribed),
    overrides,
    vendors: ctx.config.cartVendors,
    quotes,
    costcoTripDate,
    now: ctx.now,
    config: ctx.config,
  });
  return { plan, estimates, products, quotes, costcoTripDate };
}

export const productRef = (
  p: ProductRow,
  quotes: Record<string, number>,
): z.input<typeof ProductRef> => ({
  id: p.id,
  vendor: p.vendor,
  asin: p.asin,
  title: p.title,
  unit_quantity: p.unitQuantity,
  stance: p.stance,
  last_price_cents: p.lastPriceCents,
  quote_cents: quotes[p.id] ?? null,
});

const lineName = (l: CartLine, s: PlanState) =>
  l.freeText ?? (l.itemId ? (s.estimates.get(l.itemId)?.item.canonicalName ?? l.itemId) : "?");

const rowOf = (s: PlanState, l: CartLine): ProductRow | null =>
  l.product && l.itemId
    ? ((s.products.get(l.itemId) ?? []).find((p) => p.id === l.product!.id) ?? null)
    : null;

export async function predictions(
  q: Q,
  cycleId: string | null,
  ctx: ReadCtx,
): Promise<z.input<typeof PredictionsResponse>> {
  const cycle = cycleId ? await getCycle(q, cycleId) : await activeCycle(q);
  const s = await planFor(q, cycle, ctx);
  const lines: z.input<typeof PlanLine>[] = s.plan.lines.map((l) => {
    const rows = l.itemId ? (s.products.get(l.itemId) ?? []) : [];
    const candidates = candidatesFor(rows.map(toCandidate), ctx.config.cartVendors);
    const row = rowOf(s, l);
    return {
      item_id: l.itemId,
      name: lineName(l, s),
      free_text: l.freeText,
      base_unit: l.itemId ? (s.estimates.get(l.itemId)?.item.baseUnit ?? null) : null,
      quantity: l.quantity,
      reason: l.reason,
      overrides: l.overrides,
      product: row ? productRef(row, s.quotes) : null,
      candidates: candidates.map((c) =>
        productRef(
          rows.find((r) => r.id === c.id)!,
          s.quotes,
        ),
      ),
      needs_price_check: l.choice?.needsPriceCheck ?? false,
      choice_reason: l.choice?.reason ?? null,
      store: l.store ? planStore(l.store) : null,
    };
  });
  return {
    cycle_id: cycle?.id ?? null,
    generated_at: ctx.now,
    lines,
    skipped_item_ids: s.plan.skippedItemIds,
    needs_price_check_item_ids: s.plan.needsPriceCheckItemIds,
    costco_trip_date: s.costcoTripDate,
    costco_waiting: costcoWaiting(s),
    subscribed: subscribedLines(s),
  };
}

const planStore = (n: StoreNote): z.input<typeof PlanStore> => ({
  store: n.store,
  why: n.why,
  reason: n.reason,
  savings_ratio: n.savingsRatio,
  costco: n.timing ? { timing: n.timing, bridge_cause: n.bridgeCause } : null,
});

const costcoWaiting = (s: PlanState): z.input<typeof CostcoWaitingLine>[] =>
  s.plan.costcoWaiting.map((w) => ({
    item_id: w.itemId,
    name: s.estimates.get(w.itemId)?.item.canonicalName ?? w.itemId,
    runout_at: w.runoutAt,
    reason: w.store.reason,
  }));

const subscribedLines = (s: PlanState): z.input<typeof SubscribedLine>[] =>
  s.plan.subscribed.map((x) => ({
    item_id: x.itemId,
    name: s.estimates.get(x.itemId)?.item.canonicalName ?? x.itemId,
    asin: x.asin,
    runout_at: x.runoutAt,
    next_delivery_on: x.nextDeliveryOn,
  }));

const shortDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** §4.8 reason text for a Costco item the weekly cart buys anyway. */
export function bridgeText(n: StoreNote, tripDate: string | null): string | null {
  if (n.timing !== "bridge") return null;
  switch (n.bridgeCause) {
    case "no_trip":
      return "Bridging to Costco: no trip planned";
    case "needed_now":
      return "Bridging to Costco: needed now";
    case "trip_after_runout":
      return `Bridging to Costco: runs out before the ${tripDate ? shortDate(tripDate) : ""} trip`;
    default:
      return "Bridging to Costco";
  }
}

/** Final cart (§4.4): chosen product and a reason per line, after quotes. */
export async function cart(
  q: Q,
  cycleId: string,
  ctx: ReadCtx,
): Promise<z.input<typeof CartResponse>> {
  const cycle = await getCycle(q, cycleId);
  const s = await planFor(q, cycle, ctx);
  return {
    cycle_id: cycle.id,
    costco_trip_date: s.costcoTripDate,
    costco_waiting: costcoWaiting(s),
    subscribed: subscribedLines(s),
    lines: s.plan.lines.map((l) => {
      const row = rowOf(s, l);
      const picked = l.overrides.includes("product");
      const bridge = l.store ? bridgeText(l.store, s.costcoTripDate) : null;
      const why = l.freeText
        ? "One-off add"
        : picked && row
          ? `Your pick: ${row.title}`
          : row
            ? (l.choice?.reason ?? row.title)
            : "No product from the cart's vendors — add by hand";
      return {
        item_id: l.itemId,
        name: lineName(l, s),
        free_text: l.freeText,
        product: row ? productRef(row, s.quotes) : null,
        quantity: l.quantity,
        reason_text: bridge ? `${bridge} · ${why}` : why,
        switched: !picked && (l.choice?.switched ?? false),
        bridging_to_costco: bridge !== null,
      };
    }),
  };
}

// --- check-in -----------------------------------------------------------------------------------

const checkinItem = (
  e: ItemEstimate,
  reason: z.input<typeof CheckinItem>["reason"],
): z.input<typeof CheckinItem> => ({
  item_id: e.item.id,
  name: e.item.canonicalName,
  base_unit: e.item.baseUnit,
  on_hand: toItemEstimate(e).on_hand,
  status: e.estimate.status,
  runout_at: e.estimate.runoutAt,
  reason,
  audit_hint: e.item.auditHint,
});

/** Please-check item ids for a plan (PRD §4.1). */
function pleaseCheck(s: PlanState, ctx: ReadCtx) {
  const planned = new Set([
    ...s.plan.lines.map((l) => l.itemId).filter((x): x is string => x !== null),
    ...s.plan.skippedItemIds,
    // Waiting for the Costco trip (§4.8): planned, just not in this cart.
    ...s.plan.costcoWaiting.map((w) => w.itemId),
    // Subscribe & Save delivers it (§4.9): nothing for the household to check.
    ...s.plan.subscribed.map((x) => x.itemId),
  ]);
  const candidates = [...s.estimates.values()].flatMap((e) => {
    const reason = pleaseCheckReason({
      item: { ...e.inv, auditHint: e.item.auditHint },
      estimate: e.estimate,
      lastVerifiedAt: e.lastVerifiedAt,
      inPlan: planned.has(e.item.id),
      now: ctx.now,
      config: ctx.config,
    });
    return reason ? [{ e, reason, runoutAt: e.estimate.runoutAt }] : [];
  });
  return pleaseCheckList(candidates, ctx.config);
}

/**
 * §4.6: re-score pending item reviews (new product, unverified, merge suggestion) against plan `s`
 * — by default the active cycle's — so the ones touching this week's cart surface in This Week.
 * Run daily and when a cart is recorded; an import creates its reviews before any plan exists.
 * Returns how many reviews changed.
 */
export async function reprioritizeReviews(
  q: Q,
  ctx: ReadCtx,
  trigger: "maintenance" | "cart_result",
  s?: PlanState,
): Promise<number> {
  const state = s ?? (await planFor(q, await activeCycle(q), ctx));
  const cart = new Set(
    state.plan.lines.map((l) => l.itemId).filter((x): x is string => x !== null),
  );
  const please = new Set(pleaseCheck(state, ctx).map((c) => c.e.item.id));
  const pending = await q
    .select({
      id: reviewItem.id,
      kind: reviewItem.kind,
      itemId: reviewItem.itemId,
      impactScore: reviewItem.impactScore,
      urgency: reviewItem.urgency,
    })
    .from(reviewItem)
    .where(and(eq(reviewItem.status, "pending"), inArray(reviewItem.kind, [...ITEM_REVIEW_KINDS])));
  const changes = reprioritize(pending, { cart, pleaseCheck: please }, ctx.config);
  // One UPDATE per (score, urgency), in chunks: a backfill can leave hundreds of reviews.
  const groups = new Map<
    string,
    { impactScore: number; urgency: "this_week" | "cleanup"; ids: string[] }
  >();
  for (const c of changes) {
    const key = `${c.impactScore}:${c.urgency}`;
    const g = groups.get(key) ?? { impactScore: c.impactScore, urgency: c.urgency, ids: [] };
    g.ids.push(c.id);
    groups.set(key, g);
  }
  for (const g of groups.values())
    for (let i = 0; i < g.ids.length; i += ctx.config.impact.updateChunk)
      await q
        .update(reviewItem)
        .set({ impactScore: g.impactScore, urgency: g.urgency, updatedAt: ctx.now })
        .where(inArray(reviewItem.id, g.ids.slice(i, i + ctx.config.impact.updateChunk)));
  if (changes.length > 0) {
    const raised = changes.filter((c) => c.urgency === "this_week").length;
    await emitTelemetry(
      q,
      "state_engine",
      [{ metric: "review_reprioritized", trigger, raised, lowered: changes.length - raised }],
      ctx.now,
    );
  }
  return changes.length;
}

export async function checkin(q: Q, ctx: ReadCtx): Promise<z.input<typeof CheckinResponse>> {
  const cycle = await activeCycle(q);
  const s = await planFor(q, cycle, ctx);
  const likely = s.plan.lines.flatMap((l) => {
    const e = l.itemId ? s.estimates.get(l.itemId) : undefined;
    return e && l.reason ? [checkinItem(e, l.reason)] : [];
  });
  const [pending] = await q
    .select({ n: count() })
    .from(reviewItem)
    .where(eq(reviewItem.status, "pending"));
  return {
    cycle_id: cycle?.id ?? null,
    likely_needed: likely,
    please_check: pleaseCheck(s, ctx).map((c) => checkinItem(c.e, c.reason)),
    freezer: await freezerAging(q, ctx.config.checkin.freezerOldest, ctx),
    pending_review_count: pending?.n ?? 0,
  };
}

// --- overrides & quotes -------------------------------------------------------------------------

const activeOr409 = (c: CycleRow) => {
  if (!["open", "building", "ready"].includes(c.status)) {
    throw conflict(`cycle ${c.id} is ${c.status}`);
  }
};

/**
 * Record a list edit. A `product` override that differs from the plan's choice teaches the item's
 * switch threshold (§4.4 learning table) and logs a preference event.
 */
export async function addOverride(
  db: Db,
  cycleId: string,
  input: Omit<z.infer<typeof CycleOverrideRequest>, "actor_discord_id">,
  ctx: ServiceCtx,
): Promise<z.input<typeof CycleOverrideContract>> {
  const itemId = input.item_id ?? null;
  const freeText = input.free_text ?? null;
  if (!itemId && !(input.kind === "add" && freeText)) {
    throw badRequest("item_id is required unless kind is add with free_text");
  }
  if (input.kind === "qty" && input.quantity == null) throw badRequest("qty needs a quantity");
  if (input.kind === "product" && !input.product_id) throw badRequest("product needs a product_id");
  return db.transaction(async (tx) => {
    const cycle = await getCycle(tx, cycleId);
    activeOr409(cycle);
    if (itemId) await getItem(tx, itemId);
    if (input.kind === "product") {
      const [p] = await tx.select().from(product).where(eq(product.id, input.product_id!));
      if (!p || p.itemId !== itemId) throw badRequest("product_id is not a product of item_id");
      await learnFromProductOverride(tx, cycle, itemId!, p, ctx);
    }
    const row = {
      id: newId(),
      createdAt: ctx.now,
      updatedAt: ctx.now,
      cycleId,
      kind: input.kind,
      itemId,
      freeText,
      quantity: input.quantity ?? null,
      productId: input.product_id ?? null,
      actorMemberId: ctx.actor.memberId,
    };
    await tx.insert(groceryCycleOverride).values(row);
    return {
      id: row.id,
      cycle_id: cycleId,
      kind: row.kind,
      item_id: row.itemId,
      free_text: row.freeText,
      quantity: row.quantity,
      product_id: row.productId,
      actor_member_id: row.actorMemberId,
      created_at: row.createdAt,
    };
  });
}

async function learnFromProductOverride(
  tx: Q,
  cycle: CycleRow,
  itemId: string,
  chosenRow: ProductRow,
  ctx: ServiceCtx,
): Promise<void> {
  const s = await planFor(tx, cycle, ctx);
  const cartProduct = s.plan.lines.find((l) => l.itemId === itemId)?.product ?? null;
  if (!cartProduct || cartProduct.id === chosenRow.id) return;
  const it = await getItem(tx, itemId);
  const candidates = (s.products.get(itemId) ?? []).map(toCandidate);
  const learned = learnFromOverride({
    switchThreshold: it.switchThreshold,
    cart: cartProduct,
    chosen: toCandidate(chosenRow),
    preferred: pickPreferred(candidates.filter((p) => p.stance !== "rejected")),
    config: ctx.config,
  });
  await tx
    .update(item)
    .set({ switchThreshold: learned.switchThreshold, updatedAt: ctx.now })
    .where(eq(item.id, itemId));
  for (const { id, ...patch } of learned.productPatches) {
    await tx
      .update(product)
      .set({ ...patch, updatedAt: ctx.now })
      .where(eq(product.id, id));
  }
  for (const e of learned.events) {
    await tx.insert(preferenceEvent).values({
      id: newId(),
      createdAt: ctx.now,
      updatedAt: ctx.now,
      itemId,
      cycleId: cycle.id,
      ...e,
    });
  }
  await emitTelemetry(
    tx,
    "state_engine",
    learned.events.map((e) => ({ ...e, metric: "preference_event", itemId, cycleId: cycle.id })),
    ctx.now,
  );
}

export async function recordPriceQuotes(
  db: Db,
  input: z.infer<typeof PriceQuotesRequest>,
  ctx: ServiceCtx,
): Promise<{ accepted: number }> {
  return db.transaction(async (tx) => {
    const cycle = await getCycle(tx, input.cycle_id);
    activeOr409(cycle);
    const ids = [...new Set(input.quotes.map((x) => x.product_id))];
    const known = await tx.select({ id: product.id }).from(product).where(inArray(product.id, ids));
    const missing = ids.filter((id) => !known.some((k) => k.id === id));
    if (missing.length) throw badRequest(`unknown product_id: ${missing.join(", ")}`);
    await tx.insert(priceQuote).values(
      input.quotes.map((x) => ({
        id: newId(),
        createdAt: ctx.now,
        updatedAt: ctx.now,
        cycleId: cycle.id,
        productId: x.product_id,
        priceCents: x.price_cents,
        observedAt: isoUtc(x.observed_at ?? ctx.now),
        source: "agent" as const,
      })),
    );
    return { accepted: input.quotes.length };
  });
}

// --- cart result --------------------------------------------------------------------------------

/**
 * Store the injection outcome in `cart_result` (vendors, order ids, lines, please-check ids — what
 * receipt matching and review impact read), move an open/building cycle to `ready`, log
 * `cart_line_result` telemetry and a `switch` preference event per line where the build picked the
 * cheaper product (§4.4).
 */
export async function recordCartResult(
  db: Db,
  cycleId: string,
  input: z.infer<typeof CartResultRequest>,
  ctx: ServiceCtx,
): Promise<{ cycle: CycleT }> {
  return db.transaction(async (tx) => {
    let cycle = await getCycle(tx, cycleId);
    activeOr409(cycle);
    const away = await awayPeriods(tx);
    const paused = await pausePeriods(tx);
    const firstBuild = cycle.builtAt === null;
    for (const type of ["build", "built"] as const) {
      if (
        (type === "build" && cycle.status !== "open") ||
        (type === "built" && cycle.status !== "building")
      )
        continue;
      const res = transition(cycle, { type }, ctx.now, { away, paused, config: ctx.config });
      if (!res.ok) throw conflict(res.error);
      if (res.to === "skipped")
        throw conflict(
          res.patch.closeReason === "paused"
            ? "carts are paused on the build date: cycle skipped"
            : "an away period covers the build date: cycle skipped",
        );
      cycle = { ...cycle, ...res.patch };
    }

    const s = await planFor(tx, cycle, ctx);
    const productIds = input.lines.map((l) => l.product_id).filter((x): x is string => !!x);
    const rows = productIds.length
      ? await tx.select().from(product).where(inArray(product.id, productIds))
      : [];
    const vendorOf = (id: string | null) => rows.find((r) => r.id === id)?.vendor ?? null;
    const vendors = input.vendors ?? [...new Set(rows.map((r) => r.vendor))].sort();
    const result: CartResultT = {
      vendors: vendors.length ? vendors : [...ctx.config.cartVendors],
      order_ids: input.order_ids ?? [],
      lines: input.lines,
      please_check_item_ids: pleaseCheck(s, ctx).map((c) => c.e.item.id),
      recorded_at: ctx.now,
      costco_bridged_item_ids: s.plan.lines
        .filter((l) => l.store?.timing === "bridge" && l.itemId)
        .map((l) => l.itemId!),
      costco_waiting_item_ids: s.plan.costcoWaiting.map((w) => w.itemId),
      subscribed_item_ids: s.plan.subscribed.map((x) => x.itemId),
    };
    await tx
      .update(groceryCycle)
      .set({
        status: cycle.status,
        builtAt: cycle.builtAt,
        cartResult: result,
        updatedAt: ctx.now,
      })
      .where(eq(groceryCycle.id, cycleId));

    await emitTelemetry(
      tx,
      "state_engine",
      input.lines.map((l) => ({
        metric: "cart_line_result",
        cycleId,
        itemId: l.item_id,
        productId: l.product_id,
        vendor: vendorOf(l.product_id),
        outcome: l.outcome,
        error: l.error ?? null,
      })),
      ctx.now,
    );
    if (firstBuild) await logSwitches(tx, s, cycleId, input, ctx);
    await reprioritizeReviews(tx, ctx, "cart_result", s);
    return { cycle: toCycle(await getCycle(tx, cycleId)) };
  });
}

async function logSwitches(
  tx: Q,
  s: PlanState,
  cycleId: string,
  input: z.infer<typeof CartResultRequest>,
  ctx: ServiceCtx,
) {
  for (const l of s.plan.lines) {
    if (!l.itemId || !l.choice || l.overrides.includes("product")) continue;
    const added = input.lines.some(
      (x) => x.item_id === l.itemId && x.product_id === l.product?.id && x.outcome !== "failed",
    );
    const threshold =
      s.estimates.get(l.itemId)?.item.switchThreshold ?? ctx.config.product.defaultSwitchThreshold;
    const e = added ? switchEvent(l.choice, threshold) : null;
    if (!e) continue;
    await tx.insert(preferenceEvent).values({
      id: newId(),
      createdAt: ctx.now,
      updatedAt: ctx.now,
      itemId: l.itemId,
      cycleId,
      ...e,
    });
    await emitTelemetry(
      tx,
      "state_engine",
      [{ ...e, metric: "preference_event", itemId: l.itemId, cycleId }],
      ctx.now,
    );
  }
}
