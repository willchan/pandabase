// DESIGN §4.10 — what PandaBase learns from receipts, recomputed from its inputs (PLAN M11).
//
// Ingest applies each receipt once, as in-place edits to shared rows (`applyReceipt`). The rebuild
// folds an item's *inputs* in time order instead — its receipts' lines, its non-expired `acquired`
// events, cart pauses and away periods, the human preference events, the cycle carts implicit
// swaps compare with — starting from the item's and products' defaults, and returns the *derived*
// values: product stats and stances, the EMA columns, static → velocity promotion, the switch
// threshold, and the `auto_promote` / `implicit_swap` preference events. It calls the same pure
// learning functions ingest does (`recordPurchase`, `learnFromOverride`, `rejectProduct`,
// `updateVelocity`, `shouldPromoteToVelocity`), so a history that arrived in order rebuilds to the
// values ingest wrote; a late receipt takes its place in the history instead of skipping its step.
import type { Config } from "../config";
import { receiptMatchesCycleOrder, type CycleOrder } from "./cycle";
import {
  learnFromOverride,
  NEW_PRODUCT_STANCE,
  pickPreferred,
  recordPurchase,
  rejectProduct,
  type Learning,
  type PreferenceEvent,
  type ProductCandidate,
  type Stance,
} from "./productChoice";
import type { AwayPeriod, PausePeriod } from "./time";
import {
  mergeSameDay,
  shouldPromoteToVelocity,
  updateVelocity,
  type Acquisition,
  type VelocityOutcome,
  type VelocityState,
} from "./velocity";

// --- inputs -------------------------------------------------------------------------------------

/** The item's own settings the fold reads (never derived). */
export interface LearningItem {
  id: string;
  /** Current value: `velocity` here and never promoted by the replay = velocity from the start. */
  trackingType: "velocity" | "static";
  defaultEmaDays: number | null;
  reorderThreshold: number | null;
}

/** A product of the item (after merges): identity only — every stat is rebuilt. */
export interface LearningProduct {
  id: string;
  vendor: string;
  title: string;
  unitQuantity: number;
}

/** One receipt's lines for this item: applied (item set, not ignored), in line order. */
export interface LearningReceipt {
  id: string;
  source: "digital" | "paper" | "manual";
  vendor: string;
  fulfillment: string;
  externalOrderId: string | null;
  acquiredAt: string;
  /** Ingest time: picks the cart an implicit swap compared with. */
  createdAt: string;
  lines: readonly {
    productId: string | null;
    trust: "confirmed" | "unverified";
    unitPriceCents: number | null;
  }[];
}

/** A human preference decision (kept rows; only their effects are replayed). */
export interface HumanPreferenceEvent {
  id: string;
  kind: "override_to_preferred" | "override_to_cheaper" | "reject";
  fromProductId: string | null;
  toProductId: string | null;
  at: string;
}

/** A built cycle's cart (`grocery_cycle.cart_result`), item ids resolved through merges. */
export interface LearningCycle extends CycleOrder {
  id: string;
  builtAt: string;
  lines: readonly { itemId: string; productId: string | null }[];
}

export interface LearningInput {
  item: LearningItem;
  products: readonly LearningProduct[];
  receipts: readonly LearningReceipt[];
  /** Non-expired `acquired` events (base units), any order. */
  acquisitions: readonly Acquisition[];
  humanEvents: readonly HumanPreferenceEvent[];
  /** Every built cycle, any order. */
  cycles: readonly LearningCycle[];
  away: readonly AwayPeriod[];
  paused: readonly PausePeriod[];
  config: Config;
}

// --- outputs ------------------------------------------------------------------------------------

/** The derived `item` columns. */
export interface LearnedItem {
  currentEmaDays: number | null;
  emaOutlierStreak: number;
  emaOutlierDirection: "high" | "low" | null;
  trackingType: "velocity" | "static";
  switchThreshold: number;
}

/** The derived `product` columns. */
export interface LearnedProduct {
  stance: Stance;
  preferenceScore: number;
  timesBought: number;
  consecutiveBuys: number;
  lastBoughtAt: string | null;
  lastPriceCents: number | null;
  lastPriceAt: string | null;
  lastPriceFulfillment: string | null;
}

/** A regenerated `preference_event` (kinds the rebuild owns). */
export interface LearnedPreferenceEvent extends PreferenceEvent {
  kind: "auto_promote" | "implicit_swap";
  cycleId: string | null;
  /** The receipt's ingest time (what ingest stamped `created_at` with). */
  at: string;
}

export interface LearningResult {
  item: LearnedItem;
  products: Map<string, LearnedProduct>;
  events: LearnedPreferenceEvent[];
  /** EMA step outcomes, for the summary. */
  outcomes: Partial<Record<VelocityOutcome, number>>;
  /** The replay promoted the item from `static`. */
  promoted: boolean;
}

/** Event kinds the rebuild regenerates (the rest are inputs or cart logs, kept as they are). */
export const REBUILT_EVENT_KINDS = ["auto_promote", "implicit_swap"] as const;

// --- the fold -----------------------------------------------------------------------------------

const initialVelocity = (item: LearningItem): VelocityState => ({
  emaDays: null,
  defaultEmaDays: item.defaultEmaDays,
  outlierStreak: 0,
  outlierDirection: null,
});

/**
 * §4.1 replay: same-day-merged acquisitions in time order. Every item a receipt creates starts
 * `static` and learns no EMA until a second purchase within the window promotes it; an item that
 * is `velocity` now but that the replay never promotes was created as `velocity` (seeded) and
 * learns from its first acquisition.
 */
function foldVelocity(input: LearningInput) {
  const { item, config } = input;
  const ctx = { away: input.away, paused: input.paused, config };
  const merged = mergeSameDay(input.acquisitions, config.householdTz);
  const run = (startVelocity: boolean) => {
    let tracking: "velocity" | "static" = startVelocity ? "velocity" : "static";
    let promoted = false;
    let state = initialVelocity(item);
    const outcomes: Partial<Record<VelocityOutcome, number>> = {};
    let prev: Acquisition | null = null;
    for (const a of merged) {
      if (
        tracking === "static" &&
        shouldPromoteToVelocity(
          { trackingType: tracking, reorderThreshold: item.reorderThreshold },
          prev?.at ?? null,
          a.at,
          config,
        )
      ) {
        tracking = "velocity";
        promoted = true;
      }
      if (tracking === "velocity") {
        const step = updateVelocity(state, prev, a, ctx);
        state = step.state;
        outcomes[step.outcome] = (outcomes[step.outcome] ?? 0) + 1;
      }
      prev = a;
    }
    return { tracking, promoted, state, outcomes };
  };
  const fromStatic = run(false);
  return item.trackingType === "velocity" && fromStatic.tracking === "static"
    ? run(true)
    : fromStatic;
}

const defaultProduct = (): LearnedProduct => ({
  stance: NEW_PRODUCT_STANCE,
  preferenceScore: 0,
  timesBought: 0,
  consecutiveBuys: 0,
  lastBoughtAt: null,
  lastPriceCents: null,
  lastPriceAt: null,
  lastPriceFulfillment: null,
});

type Entry =
  | { at: string; order: 0; tie: string; receipt: LearningReceipt }
  | { at: string; order: 1; tie: string; human: HumanPreferenceEvent };

/** The cart a receipt ingested at `createdAt` compared with: the last cycle built by then. */
function cartAtIngest(cycles: readonly LearningCycle[], r: LearningReceipt): LearningCycle | null {
  let best: LearningCycle | null = null;
  for (const c of cycles) {
    if (c.builtAt > r.createdAt) continue;
    if (!best || c.builtAt > best.builtAt) best = c;
  }
  return best && receiptMatchesCycleOrder(best, r) ? best : null;
}

/**
 * Product stats, stances, the switch threshold and the regenerated preference events: receipts
 * (by `acquired_at`) and human preference events (by `created_at`) in one timeline — the same
 * steps `applyReceipt`, `learnFromProductOverride` and `rejectProductById` take.
 */
function foldProducts(input: LearningInput) {
  const { config } = input;
  const ids = new Set(input.products.map((p) => p.id));
  const stats = new Map(input.products.map((p) => [p.id, defaultProduct()]));
  const candidates = (): ProductCandidate[] =>
    input.products.map((p) => {
      const s = stats.get(p.id)!;
      return {
        id: p.id,
        vendor: p.vendor,
        title: p.title,
        unitQuantity: p.unitQuantity,
        stance: s.stance,
        preferenceScore: s.preferenceScore,
        timesBought: s.timesBought,
        consecutiveBuys: s.consecutiveBuys,
        lastPriceCents: s.lastPriceCents,
      };
    });
  let threshold = config.product.defaultSwitchThreshold;
  const events: LearnedPreferenceEvent[] = [];
  const apply = (learned: Learning) => {
    threshold = learned.switchThreshold;
    for (const { id, ...patch } of learned.productPatches) {
      const s = stats.get(id)!;
      Object.assign(s, patch);
    }
  };

  const entries: Entry[] = [
    ...input.receipts.map((receipt): Entry => ({
      at: receipt.acquiredAt,
      order: 0,
      tie: `${receipt.createdAt} ${receipt.id}`,
      receipt,
    })),
    ...input.humanEvents.map((human): Entry => ({ at: human.at, order: 1, tie: human.id, human })),
  ].sort(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) || a.order - b.order || a.tie.localeCompare(b.tie),
  );

  for (const e of entries) {
    if (e.order === 1) {
      const h = e.human;
      if (h.kind === "reject") {
        if (!h.fromProductId || !ids.has(h.fromProductId)) continue;
        const p = candidates().find((c) => c.id === h.fromProductId)!;
        apply(rejectProduct(p, threshold));
        continue;
      }
      if (!h.fromProductId || !h.toProductId || !ids.has(h.fromProductId)) continue;
      if (!ids.has(h.toProductId)) continue;
      const all = candidates();
      const cart = all.find((c) => c.id === h.fromProductId)!;
      const chosen = all.find((c) => c.id === h.toProductId)!;
      // The recorded kind is the human's choice: replay its direction, not today's preferred.
      apply(
        learnFromOverride({
          switchThreshold: threshold,
          cart,
          chosen,
          preferred: h.kind === "override_to_preferred" ? chosen : null,
          config,
        }),
      );
      continue;
    }

    const r = e.receipt;
    const boughtIds = [
      ...new Set(
        r.lines.filter((l) => l.trust === "confirmed" && l.productId).map((l) => l.productId!),
      ),
    ].filter((id) => ids.has(id));
    for (const boughtId of boughtIds) {
      const priced = r.lines.find((l) => l.productId === boughtId && l.unitPriceCents !== null);
      // §4.8 Price by channel: a Costco delivery price never replaces a warehouse one.
      const keepWarehousePrice =
        r.vendor === config.costco.vendor &&
        r.fulfillment !== "in_store" &&
        stats.get(boughtId)!.lastPriceFulfillment === "in_store";
      const price = keepWarehousePrice ? null : (priced?.unitPriceCents ?? null);
      const learned = recordPurchase({
        products: candidates(),
        boughtId,
        at: r.acquiredAt,
        unitPriceCents: price,
        switchThreshold: threshold,
        config,
      });
      apply(learned);
      if (price !== null && r.vendor === config.costco.vendor) {
        stats.get(boughtId)!.lastPriceFulfillment = r.fulfillment;
      }
      for (const ev of learned.events) {
        events.push({ ...ev, kind: "auto_promote", cycleId: null, at: r.createdAt });
      }
    }

    const cycle = cartAtIngest(input.cycles, r);
    const cartProductId = cycle?.lines.find((l) => l.itemId === input.item.id)?.productId;
    if (!cycle || !cartProductId || !ids.has(cartProductId) || boughtIds.length === 0) continue;
    if (boughtIds.includes(cartProductId)) continue;
    const all = candidates();
    const learned = learnFromOverride({
      switchThreshold: threshold,
      cart: all.find((c) => c.id === cartProductId)!,
      chosen: all.find((c) => c.id === boughtIds[0])!,
      preferred: pickPreferred(all.filter((p) => p.stance !== "rejected")),
      implicit: true,
      config,
    });
    apply(learned);
    for (const ev of learned.events) {
      events.push({ ...ev, kind: "implicit_swap", cycleId: cycle.id, at: r.createdAt });
    }
  }
  return { stats, threshold, events };
}

/** Rebuild one item's learning from its inputs (pure). */
export function rebuildItemLearning(input: LearningInput): LearningResult {
  const v = foldVelocity(input);
  const p = foldProducts(input);
  return {
    item: {
      currentEmaDays: v.state.emaDays,
      emaOutlierStreak: v.state.outlierStreak,
      emaOutlierDirection: v.state.outlierDirection,
      trackingType: v.tracking,
      switchThreshold: p.threshold,
    },
    products: p.stats,
    events: p.events,
    outcomes: v.outcomes,
    promoted: v.promoted,
  };
}

// --- comparing with what is stored ----------------------------------------------------------------

export const ITEM_COLUMNS = [
  "currentEmaDays",
  "emaOutlierStreak",
  "emaOutlierDirection",
  "trackingType",
  "switchThreshold",
] as const satisfies readonly (keyof LearnedItem)[];

export const PRODUCT_COLUMNS = [
  "timesBought",
  "consecutiveBuys",
  "lastBoughtAt",
  "lastPriceCents",
  "lastPriceAt",
  "lastPriceFulfillment",
  "stance",
  "preferenceScore",
] as const satisfies readonly (keyof LearnedProduct)[];

/** Reals compare within a relative 1e-9 (an EMA recomputed in another order of float ops). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return a === b;
}

/** Columns of `stored` the rebuild would change. */
export function changedColumns<T extends object, K extends keyof T>(
  stored: T,
  rebuilt: T,
  columns: readonly K[],
): K[] {
  return columns.filter((c) => !sameValue(stored[c], rebuilt[c]));
}

/** A preference event's identity for comparison (ids and timestamps aside). */
export const eventKey = (e: {
  kind: string;
  fromProductId: string | null;
  toProductId: string | null;
  thresholdBefore: number | null;
  thresholdAfter: number | null;
  cycleId: string | null;
}): string =>
  [
    e.kind,
    e.fromProductId ?? "",
    e.toProductId ?? "",
    e.thresholdBefore === null ? "" : Math.round(e.thresholdBefore * 1e6),
    e.thresholdAfter === null ? "" : Math.round(e.thresholdAfter * 1e6),
    e.cycleId ?? "",
  ].join("|");

/** Do the stored and rebuilt events differ as multisets? */
export function eventsDiffer(
  stored: readonly Parameters<typeof eventKey>[0][],
  rebuilt: readonly Parameters<typeof eventKey>[0][],
): boolean {
  if (stored.length !== rebuilt.length) return true;
  const a = stored.map(eventKey).sort();
  const b = rebuilt.map(eventKey).sort();
  return a.some((k, i) => k !== b[i]);
}

/**
 * The multiset difference between stored and rebuilt events: stored rows with no rebuilt match to
 * delete, rebuilt events with no stored match to insert (matching ones keep their rows, ids and
 * timestamps). Null when they match.
 */
export function diffEvents<
  S extends Parameters<typeof eventKey>[0] & { id: string },
  R extends Parameters<typeof eventKey>[0],
>(stored: readonly S[], rebuilt: readonly R[]): { deleteIds: string[]; insert: R[] } | null {
  const left = new Map<string, string[]>();
  for (const e of stored) {
    const k = eventKey(e);
    left.set(k, [...(left.get(k) ?? []), e.id]);
  }
  const insert: R[] = [];
  for (const e of rebuilt) {
    const ids = left.get(eventKey(e));
    if (ids?.length) ids.shift();
    else insert.push(e);
  }
  const deleteIds = [...left.values()].flat();
  return deleteIds.length === 0 && insert.length === 0 ? null : { deleteIds, insert };
}
