// DESIGN §4.8 — which store an item comes from (Costco vs the weekly Whole Foods/Amazon cart), the
// Costco trip list and how store overrides teach the household's Costco threshold.
import type { Config } from "../config";
import type { Estimate, InventoryItem } from "./inventory";
import { isLapsed } from "./predictions";
import {
  candidatesFor,
  chooseProduct,
  pickPreferred,
  unitPrice,
  type Choice,
  type ProductCandidate,
} from "./productChoice";
import { addDays, daysBetween, localDate } from "./time";

export type Store = "costco" | "regular";

/** Why `chooseStore` picked its store (telemetry `store_choice`, weekly report). */
export type StoreWhy =
  | "pinned"
  | "no_costco_product"
  | "costco_only"
  | "no_price"
  | "not_cheaper_enough"
  | "spoils_first"
  | "cheaper";

export interface StoreChoiceInput {
  item: InventoryItem;
  baseUnit: string;
  products: readonly ProductCandidate[];
  /** Current prices posted this cycle (product id → cents); Costco prices come from receipts. */
  quotes?: Readonly<Record<string, number>>;
  /** The item's product `switch_threshold` (§4.4), for the regular-store product choice. */
  switchThreshold: number;
  /** `item.store_pin`: a person said "get X at Costco / Whole Foods". */
  pin: Store | null;
  /** The household freezes part of this item's bulk packs (learned from post-trip moves). */
  freezesBulk: boolean;
  config: Config;
}

export interface StoreChoice {
  store: Store;
  /** The Costco product the trip list would buy (null when the item has none). */
  costco: ProductCandidate | null;
  /** §4.4 choice among the weekly cart's vendors (used whenever the store is `regular`). */
  regular: Choice;
  /** `(regular − costco) / regular` per base unit, when both prices are known. */
  savingsRatio: number | null;
  why: StoreWhy;
  reason: string;
}

const VENDOR_LABELS: Readonly<Record<string, string>> = {
  wholefoods: "Whole Foods",
  amazon: "Amazon",
  costco: "Costco",
};
export const vendorLabel = (vendor: string): string => VENDOR_LABELS[vendor] ?? vendor;

const pct = (r: number) => `${Math.round(r * 100)}%`;

/**
 * §4.8 store choice. A pin wins (a Costco pin needs a Costco product). Otherwise Costco only when
 * its usual product is more than `costco.switchThreshold` cheaper per base unit than the weekly
 * cart's choice and one pack is used up within the item's shelf life (unless it's a freezer item
 * or the household freezes part of the pack). An item never bought at Costco stays regular.
 */
export function chooseStore(input: StoreChoiceInput): StoreChoice {
  const { item, baseUnit, products, config, pin } = input;
  const quotes = input.quotes ?? {};
  const regular = chooseProduct({
    products,
    vendors: config.cartVendors,
    quotes,
    switchThreshold: input.switchThreshold,
    baseUnit,
  });
  const costco = pickPreferred(candidatesFor(products, [config.costco.vendor]));
  const result = (
    store: Store,
    why: StoreWhy,
    reason: string,
    savingsRatio: number | null = null,
  ) => ({ store, costco, regular, savingsRatio, why, reason }) satisfies StoreChoice;

  if (costco === null) {
    return result("regular", "no_costco_product", "Never bought at Costco");
  }
  const regularLabel = regular.product ? vendorLabel(regular.product.vendor) : "the weekly cart";
  if (pin === "costco") return result("costco", "pinned", "You get this at Costco");
  if (pin === "regular") return result("regular", "pinned", `You get this at ${regularLabel}`);
  if (regular.product === null) {
    return result("costco", "costco_only", `Only bought at Costco (${costco.title})`);
  }

  const cu = unitPrice(costco, quotes);
  const ru = unitPrice(regular.product, quotes);
  if (cu === null || ru === null || ru <= 0) {
    return result("regular", "no_price", `No price to compare with Costco's ${costco.title}`);
  }
  const savingsRatio = (ru - cu) / ru;
  if (savingsRatio <= config.costco.switchThreshold) {
    return result(
      "regular",
      "not_cheaper_enough",
      savingsRatio > 0
        ? `Costco is only ${pct(savingsRatio)} cheaper per ${baseUnit}`
        : `Costco isn't cheaper per ${baseUnit}`,
      savingsRatio,
    );
  }
  const packDays = packLastsDays(item, costco);
  if (
    packDays !== null &&
    item.shelfLifeDays !== null &&
    item.defaultLocation !== "freezer" &&
    !input.freezesBulk &&
    packDays > item.shelfLifeDays
  ) {
    return result(
      "regular",
      "spoils_first",
      `Costco's pack lasts ~${Math.round(packDays)} days but keeps ${item.shelfLifeDays}`,
      savingsRatio,
    );
  }
  return result(
    "costco",
    "cheaper",
    `Costco: ${pct(savingsRatio)} cheaper per ${baseUnit} than ${regular.product.title}`,
    savingsRatio,
  );
}

/** Days one purchase unit of `product` lasts at the item's EMA (null without one). */
export function packLastsDays(item: InventoryItem, product: ProductCandidate): number | null {
  if (item.trackingType !== "velocity" || item.emaDays === null || item.emaDays <= 0) return null;
  return product.unitQuantity * item.emaDays;
}

export type CostcoTiming = "wait" | "bridge";

/**
 * §4.8 A Costco item in this week's plan: `wait` (leave it out of the weekly cart) when a trip is
 * planned on or before its runout; otherwise `bridge` (buy the weekly cart's product this week,
 * for the usual `cartCoverDays`). Critical / consumed items, or no planned trip, always bridge.
 */
export function costcoTiming(input: {
  estimate: Pick<Estimate, "runoutAt" | "status">;
  /** The planned trip's local date (YYYY-MM-DD), or null. */
  tripDate: string | null;
  config: Config;
}): CostcoTiming {
  const { estimate, tripDate, config } = input;
  if (tripDate === null || estimate.status === "critical" || estimate.status === "consumed") {
    return "bridge";
  }
  if (estimate.runoutAt === null) return "wait";
  return tripDate <= localDate(estimate.runoutAt, config.householdTz) ? "wait" : "bridge";
}

export type CostcoListReason = "runout" | "critical" | "consumed" | "static_threshold";

export interface CostcoListLine {
  reason: CostcoListReason;
  /** Purchase units of the Costco product. */
  quantity: number;
}

/**
 * §4.8 Costco trip list. An item assigned to Costco goes on the list for a trip on `tripDate` when
 * it would run out before the trip after (`tripDate + costco.tripGapDays`), is flagged critical /
 * consumed, or (static) is at its reorder threshold. Lapsed items stay off (§4.3). Quantity covers
 * until the following trip, capped at the shelf life for perishables nobody freezes (min 1 pack).
 */
export function costcoListLine(input: {
  item: InventoryItem;
  estimate: Pick<Estimate, "onHand" | "runoutAt" | "status">;
  product: ProductCandidate;
  tripDate: string;
  freezesBulk: boolean;
  now: string;
  config: Config;
}): CostcoListLine | null {
  const { item, estimate, product, tripDate, freezesBulk, now, config } = input;
  const tz = config.householdTz;
  const gap = config.costco.tripGapDays;
  let reason: CostcoListReason | null = null;
  if (estimate.status === "critical" || estimate.status === "consumed") reason = estimate.status;
  else if (item.trackingType === "velocity") {
    if (estimate.runoutAt !== null && !isLapsed(estimate.runoutAt, now, config)) {
      if (localDate(estimate.runoutAt, tz) <= addDays(tripDate, gap)) reason = "runout";
    }
  } else if (item.reorderThreshold !== null && estimate.onHand <= item.reorderThreshold) {
    reason = "static_threshold";
  }
  if (reason === null) return null;

  if (item.trackingType !== "velocity" || item.emaDays === null || item.emaDays <= 0) {
    return { reason, quantity: config.staticCartUnits };
  }
  const today = localDate(now, tz);
  const daysToTrip = Math.max(0, daysBetween(`${today}T00:00:00Z`, `${tripDate}T00:00:00Z`));
  const keeps =
    item.shelfLifeDays !== null && item.defaultLocation !== "freezer" && !freezesBulk
      ? item.shelfLifeDays
      : Infinity;
  const coverAfterTrip = Math.min(gap, keeps);
  // What's left at the trip is `onHand − daysToTrip / ema` (never below 0).
  const leftAtTrip = Math.max(0, estimate.onHand - daysToTrip / item.emaDays);
  const needBase = Math.max(0, coverAfterTrip / item.emaDays - leftAtTrip);
  // Tolerate float noise so 24 / 24 doesn't become 2 packs.
  return {
    reason,
    quantity: Math.max(1, Math.ceil(needBase / product.unitQuantity - 1e-9)),
  };
}

// --- learning -----------------------------------------------------------------------------------

export type StoreOverrideKind = "store_override_to_regular" | "store_override_to_costco";

export interface StoreLearning {
  /** New `item.store_pin`. */
  pin: Store;
  /** New household `costco.switchThreshold` (a `setting` row). */
  switchThreshold: number;
  event: {
    kind: StoreOverrideKind;
    thresholdBefore: number;
    thresholdAfter: number;
  } | null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * "Get X at Whole Foods" / "get X at Costco". The item is pinned to that store. When the override
 * contradicts a price-based choice (`cheaper` / `not_cheaper_enough`), the household threshold
 * moves too: away from Costco → up by `thresholdStepUp`; toward it → down by `thresholdStepDown`.
 * Choices made for other reasons (spoilage, no price, a pin) only move the pin.
 */
export function learnStoreOverride(input: {
  choice: Pick<StoreChoice, "store" | "why">;
  to: Store;
  switchThreshold: number;
  config: Config;
}): StoreLearning {
  const { choice, to, switchThreshold: before, config } = input;
  const c = config.costco;
  const priceBased = choice.why === "cheaper" || choice.why === "not_cheaper_enough";
  if (choice.store === to || !priceBased) {
    return { pin: to, switchThreshold: before, event: null };
  }
  const after =
    to === "regular"
      ? round2(clamp(before + c.thresholdStepUp, c.thresholdFloor, c.thresholdCap))
      : round2(clamp(before - c.thresholdStepDown, c.thresholdFloor, c.thresholdCap));
  return {
    pin: to,
    switchThreshold: after,
    event: {
      kind: to === "regular" ? "store_override_to_regular" : "store_override_to_costco",
      thresholdBefore: before,
      thresholdAfter: after,
    },
  };
}
