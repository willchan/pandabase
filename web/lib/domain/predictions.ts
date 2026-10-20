// DESIGN §4.3 — restock flags and the weekly cart plan.
import type { Config } from "../config";
import type { Estimate, InventoryItem } from "./inventory";
import { chooseProduct, type Choice, type ProductCandidate } from "./productChoice";
import { addDays, localDate } from "./time";

export type RestockReason = "runout" | "critical" | "consumed" | "static_threshold";

/** Why an item belongs in the cart plan, or null. */
export function restockReason(
  item: InventoryItem,
  estimate: Pick<Estimate, "onHand" | "runoutAt" | "status">,
  now: string,
  config: Config,
): RestockReason | null {
  if (estimate.status === "critical" || estimate.status === "consumed") return estimate.status;
  if (item.trackingType === "velocity") {
    if (estimate.runoutAt === null) return null;
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
  if (item.trackingType === "velocity" && estimate.runoutAt !== null) {
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
}

export interface CartPlan {
  lines: CartLine[];
  /** Items flagged for restock but removed by a `skip` override. */
  skippedItemIds: string[];
  /** Items with several candidate products: the agent should post price quotes. */
  needsPriceCheckItemIds: string[];
}

/**
 * §4.3: flag items, choose products (§4.4), size quantities, then apply the cycle's overrides in
 * order (skip removes, qty replaces, add inserts incl. free text, product replaces the product).
 */
export function planCart(input: {
  items: readonly PlanItemInput[];
  overrides: readonly CycleOverride[];
  vendors: readonly string[];
  quotes?: Readonly<Record<string, number>>;
  now: string;
  config: Config;
}): CartPlan {
  const { items, overrides, vendors, quotes, now, config } = input;
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
  });

  for (const i of items) {
    const reason = restockReason(i.item, i.estimate, now, config);
    if (reason) lines.set(i.itemId, lineFor(i, reason));
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
        line = known ? lineFor(known, null) : bare(o.itemId!);
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
    needsPriceCheckItemIds: all.filter((l) => l.choice?.needsPriceCheck).map((l) => l.itemId!),
  };
}
