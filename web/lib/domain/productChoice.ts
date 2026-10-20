// DESIGN §4.4 — product choice and preference learning.
import type { Config } from "../config";

export type Stance = "preferred" | "acceptable" | "rejected";

/** The `product` columns product choice reads. */
export interface ProductCandidate {
  id: string;
  vendor: string;
  title: string;
  /** Base units per purchase unit. */
  unitQuantity: number;
  stance: Stance;
  preferenceScore: number;
  timesBought: number;
  consecutiveBuys: number;
  lastPriceCents: number | null;
}

export interface ChoiceInput {
  products: readonly ProductCandidate[];
  /** Vendors the cart can be filled from. */
  vendors: readonly string[];
  /** Current prices posted by the agent this cycle (product id → cents). */
  quotes?: Readonly<Record<string, number>>;
  switchThreshold: number;
  /** Item base unit for the reason string ("egg"). */
  baseUnit: string;
}

export interface Choice {
  /** Null when every product is rejected or off-vendor. */
  product: ProductCandidate | null;
  preferred: ProductCandidate | null;
  cheapest: ProductCandidate | null;
  /** Several candidates: the agent should post price quotes before the build. */
  needsPriceCheck: boolean;
  /** True when the cheaper product was chosen over the preferred one. */
  switched: boolean;
  /** `(preferred − cheapest) / preferred` per base unit, when both prices are known. */
  savingsRatio: number | null;
  reason: string;
}

/** Price per base unit: quote, else `last_price_cents`, else null. */
export function unitPrice(
  p: ProductCandidate,
  quotes: Readonly<Record<string, number>> = {},
): number | null {
  const cents = Object.hasOwn(quotes, p.id) ? quotes[p.id]! : p.lastPriceCents;
  return cents === null ? null : cents / p.unitQuantity;
}

/** Step 3: stance preferred, else highest preference score, else most bought (then id). */
export function pickPreferred(products: readonly ProductCandidate[]): ProductCandidate | null {
  const rank = (p: ProductCandidate) => (p.stance === "preferred" ? 1 : 0);
  return (
    [...products].sort(
      (a, b) =>
        rank(b) - rank(a) ||
        b.preferenceScore - a.preferenceScore ||
        b.timesBought - a.timesBought ||
        a.id.localeCompare(b.id),
    )[0] ?? null
  );
}

export const candidatesFor = (
  products: readonly ProductCandidate[],
  vendors: readonly string[],
): ProductCandidate[] =>
  products.filter((p) => p.stance !== "rejected" && vendors.includes(p.vendor));

const pct = (r: number) => `${Math.round(r * 100)}%`;

export function chooseProduct(input: ChoiceInput): Choice {
  const quotes = input.quotes ?? {};
  const candidates = candidatesFor(input.products, input.vendors);
  const none: Choice = {
    product: null,
    preferred: null,
    cheapest: null,
    needsPriceCheck: false,
    switched: false,
    savingsRatio: null,
    reason: "No acceptable product from the cart's vendors",
  };
  if (candidates.length === 0) return none;
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return {
      ...none,
      product: only,
      preferred: only,
      cheapest: only,
      reason: `Only option: ${only.title}`,
    };
  }

  const preferred = pickPreferred(candidates)!;
  const priced = candidates
    .map((p) => ({ p, u: unitPrice(p, quotes) }))
    .filter((x): x is { p: ProductCandidate; u: number } => x.u !== null)
    .sort((a, b) => a.u - b.u || a.p.id.localeCompare(b.p.id));
  const cheapest = priced[0]?.p ?? null;
  const pu = unitPrice(preferred, quotes);
  const cu = cheapest ? unitPrice(cheapest, quotes) : null;
  const base = { ...none, preferred, cheapest, needsPriceCheck: true };

  if (pu === null || cu === null || cheapest === null || cheapest.id === preferred.id) {
    return {
      ...base,
      product: preferred,
      reason:
        pu === null
          ? `Your usual ${preferred.title} (no price to compare)`
          : `Your usual ${preferred.title}`,
    };
  }
  const savingsRatio = pu > 0 ? (pu - cu) / pu : 0;
  if (pu - cu > input.switchThreshold * pu) {
    return {
      ...base,
      product: cheapest,
      switched: true,
      savingsRatio,
      reason: `${pct(savingsRatio)} cheaper per ${input.baseUnit} than your usual ${preferred.title}`,
    };
  }
  return {
    ...base,
    product: preferred,
    savingsRatio,
    reason: `Your usual ${preferred.title} (${cheapest.title} is only ${pct(savingsRatio)} cheaper per ${input.baseUnit})`,
  };
}

// --- learning -----------------------------------------------------------------------------------

export type PreferenceEventKind =
  | "switch"
  | "override_to_preferred"
  | "override_to_cheaper"
  | "implicit_swap"
  | "reject"
  | "auto_promote";

/** A `preference_event` row (also the telemetry payload for preference learning). */
export interface PreferenceEvent {
  kind: PreferenceEventKind;
  fromProductId: string | null;
  toProductId: string | null;
  thresholdBefore: number | null;
  thresholdAfter: number | null;
}

/** A partial update to one `product` row. */
export interface ProductPatch {
  id: string;
  stance?: Stance;
  preferenceScore?: number;
  timesBought?: number;
  consecutiveBuys?: number;
  lastBoughtAt?: string;
  lastPriceCents?: number;
  lastPriceAt?: string;
}

export interface Learning {
  switchThreshold: number;
  productPatches: ProductPatch[];
  events: PreferenceEvent[];
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** Thresholds are stored as reals; keep them on the 0.01 grid so repeated steps don't drift. */
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * A human overrode the cart's product choice (`cart` → `chosen`). Toward the pricier preferred
 * product: raise the switch threshold. Toward a cheaper / different product: lower it and bump the
 * chosen product's score. `implicit` = the receipt showed a different product than the cart line.
 */
export function learnFromOverride(input: {
  switchThreshold: number;
  cart: ProductCandidate;
  chosen: ProductCandidate;
  /** The preferred product at the time (per `pickPreferred`). */
  preferred: ProductCandidate | null;
  implicit?: boolean;
  config: Config;
}): Learning {
  const { switchThreshold: before, cart, chosen, preferred, config } = input;
  const p = config.product;
  if (cart.id === chosen.id) return { switchThreshold: before, productPatches: [], events: [] };
  const towardPreferred = !input.implicit && preferred !== null && chosen.id === preferred.id;
  const after = towardPreferred
    ? round2(clamp(before + p.thresholdStepUp, p.thresholdFloor, p.thresholdCap))
    : round2(clamp(before - p.thresholdStepDown, p.thresholdFloor, p.thresholdCap));
  return {
    switchThreshold: after,
    productPatches: towardPreferred
      ? []
      : [{ id: chosen.id, preferenceScore: chosen.preferenceScore + p.preferenceScoreStep }],
    events: [
      {
        kind: input.implicit
          ? "implicit_swap"
          : towardPreferred
            ? "override_to_preferred"
            : "override_to_cheaper",
        fromProductId: cart.id,
        toProductId: chosen.id,
        thresholdBefore: before,
        thresholdAfter: after,
      },
    ],
  };
}

/** "Never buy X" → stance `rejected`. */
export function rejectProduct(product: ProductCandidate, switchThreshold: number): Learning {
  return {
    switchThreshold,
    productPatches: product.stance === "rejected" ? [] : [{ id: product.id, stance: "rejected" }],
    events:
      product.stance === "rejected"
        ? []
        : [
            {
              kind: "reject",
              fromProductId: product.id,
              toProductId: null,
              thresholdBefore: switchThreshold,
              thresholdAfter: switchThreshold,
            },
          ],
  };
}

/**
 * Product stats after a confirmed purchase of `boughtId` (one receipt line): times bought, the
 * consecutive-buy streak (other products of the item reset to 0), last price; and auto-promotion
 * to `preferred` after `autoPromoteConsecutiveBuys` in a row (the previous preferred becomes
 * `acceptable`). A rejected product is never auto-promoted — "never buy X" wins.
 */
export function recordPurchase(input: {
  products: readonly ProductCandidate[];
  boughtId: string;
  at: string;
  unitPriceCents: number | null;
  switchThreshold: number;
  config: Config;
}): Learning {
  const { products, boughtId, at, unitPriceCents, switchThreshold, config } = input;
  const bought = products.find((p) => p.id === boughtId);
  if (!bought) throw new Error(`product ${boughtId} is not a product of this item`);
  const consecutiveBuys = bought.consecutiveBuys + 1;
  const patch: ProductPatch = {
    id: bought.id,
    timesBought: bought.timesBought + 1,
    consecutiveBuys,
    lastBoughtAt: at,
    ...(unitPriceCents !== null ? { lastPriceCents: unitPriceCents, lastPriceAt: at } : {}),
  };
  const patches: ProductPatch[] = [patch];
  for (const p of products) {
    if (p.id !== bought.id && p.consecutiveBuys !== 0)
      patches.push({ id: p.id, consecutiveBuys: 0 });
  }
  const events: PreferenceEvent[] = [];
  if (
    consecutiveBuys >= config.product.autoPromoteConsecutiveBuys &&
    bought.stance === "acceptable"
  ) {
    patch.stance = "preferred";
    const previous = products.filter((p) => p.id !== bought.id && p.stance === "preferred");
    for (const p of previous) {
      const existing = patches.find((x) => x.id === p.id);
      if (existing) existing.stance = "acceptable";
      else patches.push({ id: p.id, stance: "acceptable" });
    }
    events.push({
      kind: "auto_promote",
      fromProductId: previous[0]?.id ?? null,
      toProductId: bought.id,
      thresholdBefore: switchThreshold,
      thresholdAfter: switchThreshold,
    });
  }
  return { switchThreshold, productPatches: patches, events };
}

/** Stance for a product auto-created from a new ASIN bought for an item (§4.4). */
export const NEW_PRODUCT_STANCE: Stance = "acceptable";

/** The `switch` preference event to log when a cart build picks the cheaper product (§4.4 step 4). */
export function switchEvent(choice: Choice, switchThreshold: number): PreferenceEvent | null {
  if (!choice.switched || !choice.preferred || !choice.product) return null;
  return {
    kind: "switch",
    fromProductId: choice.preferred.id,
    toProductId: choice.product.id,
    thresholdBefore: switchThreshold,
    thresholdAfter: switchThreshold,
  };
}
