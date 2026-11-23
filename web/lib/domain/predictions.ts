// DESIGN §4.3 — restock flags and the weekly cart plan.
import type { Config } from "../config";
import type { Estimate, InventoryItem } from "./inventory";
import { chooseProduct, type Choice, type ProductCandidate } from "./productChoice";
import {
  chooseStore,
  costcoTiming,
  type CostcoTiming,
  type Store,
  type StoreWhy,
} from "./storeChoice";
import type { ItemSubscription } from "./subscriptions";
import { addDays, localDate } from "./time";

export type RestockReason = "runout" | "critical" | "consumed" | "static_threshold";

/** Ran out more than `lapsedAfterDays` ago and never bought again (DESIGN §4.3). */
export function isLapsed(runoutAt: string, now: string, config: Config): boolean {
  const tz = config.householdTz;
  return localDate(runoutAt, tz) < addDays(localDate(now, tz), -config.lapsedAfterDays);
}

/** Why an item belongs in the cart plan, or null. */
export function restockReason(
  item: InventoryItem,
  estimate: Pick<Estimate, "onHand" | "runoutAt" | "status">,
  now: string,
  config: Config,
): RestockReason | null {
  if (estimate.status === "critical" || estimate.status === "consumed") return estimate.status;
  if (item.trackingType === "velocity") {
    if (estimate.runoutAt === null || isLapsed(estimate.runoutAt, now, config)) return null;
    const horizon = addDays(localDate(now, config.householdTz), config.lowWithinDays);
    return localDate(estimate.runoutAt, config.householdTz) <= horizon ? "runout" : null;
  }
  return item.reorderThreshold !== null && estimate.onHand <= item.reorderThreshold
    ? "static_threshold"
    : null;
}

export type PleaseCheckReason = "near_runout" | "audit_hint";

/**
 * PRD §4.1 Friday nudge "please check": an item not already in the plan that runs out soon after
 * the plan's horizon, or has an audit hint ("count the eggs") and hasn't been counted lately.
 */
export function pleaseCheckReason(input: {
  item: InventoryItem & { auditHint: string | null };
  estimate: Pick<Estimate, "runoutAt" | "status">;
  lastVerifiedAt: string | null;
  inPlan: boolean;
  now: string;
  config: Config;
}): PleaseCheckReason | null {
  const { item, estimate, lastVerifiedAt, inPlan, now, config } = input;
  if (inPlan) return null;
  const tz = config.householdTz;
  if (
    item.trackingType === "velocity" &&
    estimate.runoutAt !== null &&
    !isLapsed(estimate.runoutAt, now, config)
  ) {
    const horizon = addDays(
      localDate(now, tz),
      config.lowWithinDays + config.checkin.pleaseCheckMarginDays,
    );
    if (localDate(estimate.runoutAt, tz) <= horizon) return "near_runout";
  }
  if (item.auditHint) {
    const stale =
      lastVerifiedAt === null ||
      localDate(lastVerifiedAt, tz) <
        addDays(localDate(now, tz), -config.checkin.staleVerifiedDays);
    if (stale) return "audit_hint";
  }
  return null;
}

/** Near-runout first (soonest first), then audit hints; capped at `checkin.pleaseCheckMax`. */
export function pleaseCheckList<T extends { reason: PleaseCheckReason; runoutAt: string | null }>(
  candidates: readonly T[],
  config: Config,
): T[] {
  const rank = (c: T) => (c.reason === "near_runout" ? 0 : 1);
  return [...candidates]
    .sort((a, b) => rank(a) - rank(b) || (a.runoutAt ?? "9999").localeCompare(b.runoutAt ?? "9999"))
    .slice(0, config.checkin.pleaseCheckMax);
}

/**
 * Purchase units to add. Velocity: enough to cover `cartCoverDays` of EMA-based need beyond what's
 * on hand (min 1). Static, or velocity without an EMA yet: `staticCartUnits`.
 */
export function cartQuantity(
  item: InventoryItem,
  onHand: number,
  unitQuantity: number,
  config: Config,
): number {
  if (item.trackingType !== "velocity" || item.emaDays === null || item.emaDays <= 0) {
    return config.staticCartUnits;
  }
  const needBase = Math.max(0, config.cartCoverDays / item.emaDays - onHand);
  // Tolerate float noise so 12 / 12 doesn't become 2 purchase units.
  return Math.max(1, Math.ceil(needBase / unitQuantity - 1e-9));
}

export interface PlanItemInput {
  itemId: string;
  item: InventoryItem;
  baseUnit: string;
  switchThreshold: number;
  estimate: Pick<Estimate, "onHand" | "runoutAt" | "status">;
  products: readonly ProductCandidate[];
  /** `item.store_pin` (§4.8). */
  storePin?: Store | null;
  /** An active Subscribe & Save subscription covers it (§4.9, `subscribedItems`). */
  subscription?: ItemSubscription | null;
}

/** Why a Costco item stays in the weekly cart (`bridge`, §4.8). */
export type BridgeCause = "no_trip" | "needed_now" | "trip_after_runout";

/** §4.8 store choice for a planned item, and for a Costco item what the weekly cart does. */
export interface StoreNote {
  store: Store;
  why: StoreWhy;
  /** `chooseStore`'s reason ("Costco: 20% cheaper per egg than 365 Large Brown Eggs 12ct"). */
  reason: string;
  savingsRatio: number | null;
  /** Costco items only: `wait` (left out until the trip) or `bridge` (bought this week). */
  timing: CostcoTiming | null;
  bridgeCause: BridgeCause | null;
}

/** A `grocery_cycle_override` row. */
export interface CycleOverride {
  kind: "add" | "skip" | "qty" | "product";
  itemId: string | null;
  freeText: string | null;
  quantity: number | null;
  productId: string | null;
}

export interface CartLine {
  itemId: string | null;
  /** One-off add with no catalog item. */
  freeText: string | null;
  product: ProductCandidate | null;
  /** Purchase units of `product` (base units when there's no product). */
  quantity: number;
  /** Null when the line exists only because of an `add` / `qty` override. */
  reason: RestockReason | null;
  choice: Choice | null;
  overrides: CycleOverride["kind"][];
  /** §4.8, for lines the restock rule planned (null for override-only lines and free text). */
  store: StoreNote | null;
}

export interface CartPlan {
  lines: CartLine[];
  /** Items flagged for restock but removed by a `skip` override. */
  skippedItemIds: string[];
  /** Velocity items left out as lapsed (`isLapsed`) and not added back by an override. */
  lapsed: { itemId: string; runoutAt: string }[];
  /** Items with several candidate products: the agent should post price quotes. */
  needsPriceCheckItemIds: string[];
  /**
   * Restock-flagged items whose store is Costco and a planned trip comes before they run out
   * (§4.8 `wait`): left out of the weekly cart (and off *please check*) until the trip.
   */
  costcoWaiting: { itemId: string; runoutAt: string | null; store: StoreNote }[];
  /** The store choice of every restock-flagged item (telemetry `store_choice`). */
  storeChoices: ({ itemId: string } & StoreNote)[];
  /**
   * Restock-flagged items an active Subscribe & Save subscription delivers (§4.9): left out of
   * the cart (and off *please check*) unless an override adds them back this week.
   */
  subscribed: ({ itemId: string; runoutAt: string | null } & ItemSubscription)[];
}

/** §4.8 for one restock-flagged item: its store, and for a Costco item the weekly cart's timing. */
export function storeNote(
  i: PlanItemInput,
  tripDate: string | null,
  quotes: Readonly<Record<string, number>> | undefined,
  config: Config,
): StoreNote {
  const c = chooseStore({
    item: i.item,
    baseUnit: i.baseUnit,
    products: i.products,
    quotes,
    switchThreshold: i.switchThreshold,
    pin: i.storePin ?? null,
    // Learned from post-trip freezer answers in M10.4; until then nobody freezes bulk.
    freezesBulk: false,
    config,
  });
  const base = { store: c.store, why: c.why, reason: c.reason, savingsRatio: c.savingsRatio };
  if (c.store !== "costco") return { ...base, timing: null, bridgeCause: null };
  const timing = costcoTiming({ estimate: i.estimate, tripDate, config });
  const urgent = i.estimate.status === "critical" || i.estimate.status === "consumed";
  const bridgeCause: BridgeCause | null =
    timing === "wait"
      ? null
      : tripDate === null
        ? "no_trip"
        : urgent
          ? "needed_now"
          : "trip_after_runout";
  return { ...base, timing, bridgeCause };
}

/**
 * §4.3: flag items, choose products (§4.4), size quantities, then apply the cycle's overrides in
 * order (skip removes, qty replaces, add inserts incl. free text, product replaces the product).
 * §4.8: a flagged item whose store is Costco waits for a planned trip that comes before it runs
 * out (left out); otherwise it stays, bridging to Costco. An override on a waiting item puts it
 * back in the weekly cart (a human asked for it this week).
 * §4.9: a flagged item an active Subscribe & Save subscription delivers is left out the same way
 * (before store choice: Amazon brings it whatever the store), and an override puts it back too.
 */
export function planCart(input: {
  items: readonly PlanItemInput[];
  overrides: readonly CycleOverride[];
  vendors: readonly string[];
  quotes?: Readonly<Record<string, number>>;
  /** The planned Costco trip's local date, or null (§4.8). */
  costcoTripDate?: string | null;
  now: string;
  config: Config;
}): CartPlan {
  const { items, overrides, vendors, quotes, now, config } = input;
  const tripDate = input.costcoTripDate ?? null;
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const lines = new Map<string, CartLine>();
  const extra: CartLine[] = [];
  const skipped = new Set<string>();
  const humanQuantity = new Set<string>();

  const lineFor = (i: PlanItemInput, reason: RestockReason | null): CartLine => {
    const choice = chooseProduct({
      products: i.products,
      vendors,
      quotes,
      switchThreshold: i.switchThreshold,
      baseUnit: i.baseUnit,
    });
    const unitQuantity = choice.product?.unitQuantity ?? 1;
    return {
      itemId: i.itemId,
      freeText: null,
      product: choice.product,
      quantity: cartQuantity(i.item, i.estimate.onHand, unitQuantity, config),
      reason,
      choice,
      overrides: [],
      store: null,
    };
  };
  const bare = (itemId: string): CartLine => ({
    itemId,
    freeText: null,
    product: null,
    quantity: config.staticCartUnits,
    reason: null,
    choice: null,
    overrides: [],
    store: null,
  });

  const lapsed: CartPlan["lapsed"] = [];
  const waiting = new Map<string, CartPlan["costcoWaiting"][number]>();
  const storeChoices: CartPlan["storeChoices"] = [];
  const subscribed = new Map<string, CartPlan["subscribed"][number]>();
  for (const i of items) {
    const reason = restockReason(i.item, i.estimate, now, config);
    if (reason && i.subscription) {
      subscribed.set(i.itemId, {
        itemId: i.itemId,
        runoutAt: i.estimate.runoutAt,
        ...i.subscription,
      });
    } else if (reason) {
      const store = storeNote(i, tripDate, quotes, config);
      storeChoices.push({ itemId: i.itemId, ...store });
      if (store.timing === "wait") {
        waiting.set(i.itemId, { itemId: i.itemId, runoutAt: i.estimate.runoutAt, store });
      } else {
        lines.set(i.itemId, { ...lineFor(i, reason), store });
      }
    }
    const { runoutAt } = i.estimate;
    if (i.item.trackingType === "velocity" && runoutAt && isLapsed(runoutAt, now, config)) {
      lapsed.push({ itemId: i.itemId, runoutAt });
    }
  }

  for (const o of overrides) {
    if (o.itemId === null) {
      if (o.kind === "add" && o.freeText) {
        extra.push({
          ...bare(""),
          itemId: null,
          freeText: o.freeText,
          quantity: o.quantity ?? 1,
          overrides: ["add"],
        });
      }
      continue;
    }
    const known = byId.get(o.itemId);
    const ensure = () => {
      let line = lines.get(o.itemId!);
      if (!line) {
        const wait = waiting.get(o.itemId!);
        // Flagged but set aside (Costco wait or Subscribe & Save): the restock reason still holds.
        const flagged = wait ?? subscribed.get(o.itemId!);
        line = known
          ? lineFor(
              known,
              flagged ? (restockReason(known.item, known.estimate, now, config) ?? null) : null,
            )
          : bare(o.itemId!);
        // A human asked for a waiting Costco item this week: it bridges after all.
        if (wait) line.store = { ...wait.store, timing: "bridge", bridgeCause: "needed_now" };
        waiting.delete(o.itemId!);
        subscribed.delete(o.itemId!);
        lines.set(o.itemId!, line);
      }
      skipped.delete(o.itemId!);
      return line;
    };
    switch (o.kind) {
      case "skip":
        if (lines.delete(o.itemId)) skipped.add(o.itemId);
        break;
      case "add":
      case "qty": {
        const line = ensure();
        if (o.quantity !== null) {
          line.quantity = o.quantity;
          humanQuantity.add(o.itemId);
        }
        line.overrides.push(o.kind);
        break;
      }
      case "product": {
        const product = known?.products.find((p) => p.id === o.productId);
        const line = ensure();
        if (product) {
          line.product = product;
          // Re-size for the new pack unless a human already set the quantity.
          if (known && !humanQuantity.has(o.itemId)) {
            line.quantity = cartQuantity(
              known.item,
              known.estimate.onHand,
              product.unitQuantity,
              config,
            );
          }
        }
        line.overrides.push("product");
        break;
      }
    }
  }

  const all = [...lines.values(), ...extra];
  return {
    lines: all,
    skippedItemIds: [...skipped],
    lapsed: lapsed.filter((x) => !lines.has(x.itemId)),
    needsPriceCheckItemIds: all.filter((l) => l.choice?.needsPriceCheck).map((l) => l.itemId!),
    costcoWaiting: [...waiting.values()],
    storeChoices,
    subscribed: [...subscribed.values()],
  };
}
