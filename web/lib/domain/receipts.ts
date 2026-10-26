// DESIGN §4.5 — the one `applyReceipt()` path every receipt (digital, paper, manual) goes through.
//
// `applyReceipt` reads through a small repository interface (implemented with Drizzle in M4) and
// returns the *effects* to persist — rows to insert and patches to apply — plus telemetry. It
// never writes, so M4 can commit everything in one transaction and tests need no database.
import type { Config } from "../config";
import {
  receiptClosesCycle,
  receiptMatchesCycleOrder,
  type CycleOrder,
  type CyclePatch,
} from "./cycle";
import {
  checkOverbuy,
  estimateItem,
  type InventoryItem,
  type InventoryState,
  type Overbuy,
} from "./inventory";
import {
  confirmedAlias,
  deriveItemName,
  matchDigitalLine,
  matchPaperLine,
  parseUnitQuantity,
  toBaseUnits,
  type Alias,
  type AsinProduct,
  type CanonicalItem,
} from "./matching";
import {
  learnFromOverride,
  NEW_PRODUCT_STANCE,
  pickPreferred,
  recordPurchase,
  type PreferenceEvent,
  type ProductCandidate,
  type ProductPatch,
} from "./productChoice";
import { newReview, type ImpactFlags } from "./review";
import { localDate, type AwayPeriod } from "./time";
import {
  placeAcquisition,
  shouldPromoteToVelocity,
  updateVelocity,
  type Acquisition,
  type VelocityState,
  type VelocityTelemetry,
} from "./velocity";

// --- input --------------------------------------------------------------------------------------

export interface ReceiptLineInput {
  rawText: string;
  asin: string | null;
  /** Product title (digital receipts) — names auto-created items. */
  title?: string | null;
  /**
   * The item, when the caller already knows it (a text purchase like "bought milk" resolved by
   * the agent): matched as `manual` and confirmed. `productId` must be a product of that item.
   */
  itemId?: string | null;
  productId?: string | null;
  /** Purchase units. */
  qty: number;
  unitPriceCents: number | null;
  lineTotalCents: number | null;
}

export interface ReceiptInput {
  source: "digital" | "paper" | "manual";
  vendor: string;
  accountMemberId: string | null;
  externalOrderId: string | null;
  fulfillment: "delivery" | "pickup" | "in_store" | "unknown";
  orderedAt: string | null;
  acquiredAt: string;
  subtotalCents: number | null;
  totalCents: number | null;
  /** Paper: discount/coupon lines read but not posted (positive cents; the totals check adds them). */
  discountCents?: number | null;
  /** Required for `manual` receipts (dedupe key). */
  idempotencyKey?: string | null;
  lines: readonly ReceiptLineInput[];
}

/** `item` columns `applyReceipt` reads. */
export interface ItemRecord extends InventoryItem, VelocityState {
  id: string;
  canonicalName: string;
  switchThreshold: number;
}

export interface ProductRecord extends ProductCandidate {
  itemId: string;
  asin: string | null;
}

/** The last built cycle's cart, for implicit swaps and closure. */
export interface CycleCart extends CycleOrder {
  cycleId: string;
  lines: readonly { itemId: string; productId: string | null }[];
  /** Items on the cycle's please-check list (review impact). */
  pleaseCheckItemIds?: readonly string[];
}

/** Reads `applyReceipt` needs. M4 implements it over Drizzle; tests use an in-memory fake. */
export interface ReceiptRepository {
  aliases(vendor: string): Promise<Alias[]>;
  /** Active (unmerged) items for fuzzy matching on canonical names. */
  canonicalItems(): Promise<CanonicalItem[]>;
  productsByAsin(vendor: string, asins: readonly string[]): Promise<AsinProduct[]>;
  item(itemId: string): Promise<ItemRecord>;
  products(itemId: string): Promise<ProductRecord[]>;
  inventory(itemId: string): Promise<InventoryState[]>;
  /** Non-expired `acquired` events of the item (base units), any order. */
  acquisitions(itemId: string): Promise<Acquisition[]>;
  awayPeriods(): Promise<AwayPeriod[]>;
  /** The most recently built cycle (status `ready` or later), if any. */
  lastBuiltCycle(): Promise<CycleCart | null>;
}

export interface ApplyContext {
  config: Config;
  /** ULID factory (deterministic counter in tests). */
  newId: () => string;
  /** Ingest time: review `created_at` / expiry base. */
  now: string;
}

// --- output -------------------------------------------------------------------------------------

export interface ResolvedLine extends ReceiptLineInput {
  itemId: string | null;
  productId: string | null;
  matchMethod: "asin" | "alias_exact" | "fuzzy" | "manual" | "none";
  matchScore: number | null;
  trust: "confirmed" | "unverified";
  ignored: boolean;
  /** Unmatched: waits in the receipt review; dropped if it expires. */
  pending: boolean;
  /** Base units applied to inventory (0 for ignored / pending lines). */
  baseQty: number;
  /** Normalized text for paper lines (alias key). */
  normalized: string | null;
}

export interface NewItem {
  id: string;
  canonicalName: string;
  category: string;
  defaultLocation: string;
  trackingType: "static";
  baseUnit: string;
  trust: "unverified";
}

export interface NewProduct {
  id: string;
  itemId: string;
  vendor: string;
  asin: string;
  title: string;
  unitQuantity: number;
  unitQuantityTrust: "confirmed" | "unverified";
  stance: typeof NEW_PRODUCT_STANCE;
}

export interface AcquiredEvent {
  itemId: string;
  location: string;
  kind: "acquired";
  quantity: number;
  occurredAt: string;
  source: "digital_receipt" | "paper_receipt" | "manual";
  trust: "confirmed" | "provisional";
}

export type ReceiptTelemetry =
  | (VelocityTelemetry & { itemId: string })
  | (Overbuy & { itemId: string })
  | { metric: "ema_skipped"; itemId: string; reason: "same_day" | "out_of_order" | "no_previous" }
  | { metric: "promoted_to_velocity"; itemId: string }
  | {
      metric: "receipt_line_match";
      method: ResolvedLine["matchMethod"];
      score: number | null;
      pending: boolean;
      ignored: boolean;
    }
  | (PreferenceEvent & { metric: "preference_event"; itemId: string });

export interface ReviewEffect {
  kind: "receipt" | "new_product";
  itemId: string | null;
  payload: Record<string, unknown>;
  status: "pending";
  defaultAction: ReturnType<typeof newReview>["defaultAction"];
  expiresAt: string | null;
  impactScore: number;
  urgency: "this_week" | "cleanup";
}

export interface ReceiptEffects {
  receipt: {
    dedupeKey: string;
    totalsCheck: "pass" | "fail" | "n/a";
    status: "applied" | "pending_review" | "partial";
  };
  lines: ResolvedLine[];
  newItems: NewItem[];
  newProducts: NewProduct[];
  inventoryEvents: AcquiredEvent[];
  itemPatches: {
    id: string;
    patch: Partial<VelocityState & { trackingType: "velocity"; switchThreshold: number }>;
  }[];
  productPatches: ProductPatch[];
  preferenceEvents: (PreferenceEvent & { itemId: string; cycleId: string | null })[];
  reviews: ReviewEffect[];
  cycle: { cycleId: string; patch: CyclePatch } | null;
  telemetry: ReceiptTelemetry[];
}

// --- helpers ------------------------------------------------------------------------------------

/** `receipt.dedupe_key` (DESIGN §2.4). */
export function receiptDedupeKey(r: ReceiptInput, tz: string): string {
  switch (r.source) {
    case "digital":
      if (!r.externalOrderId) throw new Error("digital receipt needs external_order_id");
      return `digital:${r.accountMemberId ?? "-"}:${r.externalOrderId}`;
    case "paper":
      return `paper:${r.vendor}:${localDate(r.acquiredAt, tz)}:${r.totalCents ?? "-"}`;
    case "manual":
      if (!r.idempotencyKey) throw new Error("manual receipt needs an idempotency key");
      return `manual:${r.idempotencyKey}`;
  }
}

/**
 * Line totals (fee lines included, unposted discounts subtracted) vs the subtotal, to the cent;
 * n/a when any total is missing.
 */
export function totalsCheck(
  r: Pick<ReceiptInput, "subtotalCents" | "lines" | "discountCents">,
): "pass" | "fail" | "n/a" {
  if (r.subtotalCents === null || r.lines.some((l) => l.lineTotalCents === null)) return "n/a";
  const sum = r.lines.reduce((s, l) => s + l.lineTotalCents!, 0) - (r.discountCents ?? 0);
  return sum === r.subtotalCents ? "pass" : "fail";
}

const NEW_ITEM_DEFAULTS = {
  category: "Uncategorized",
  defaultLocation: "pantry",
  baseUnit: "count",
} as const;

/**
 * Base units a line adds: `qty × unit_quantity` of the line's product, else of the item's
 * preferred product for this vendor (12- vs 18-packs normalize to eggs), else `qty`.
 */
export function lineBaseUnits(
  line: { qty: number; productId: string | null },
  products: readonly ProductCandidate[],
  vendor: string,
): number {
  const fallback =
    pickPreferred(products.filter((p) => p.vendor === vendor)) ?? pickPreferred(products);
  const unit =
    products.find((p) => p.id === line.productId)?.unitQuantity ?? fallback?.unitQuantity ?? 1;
  return toBaseUnits(line.qty, unit);
}

export const eventSource = (s: ReceiptInput["source"]): AcquiredEvent["source"] =>
  s === "digital" ? "digital_receipt" : s === "paper" ? "paper_receipt" : "manual";

// --- applyReceipt -------------------------------------------------------------------------------

export async function applyReceipt(
  input: ReceiptInput,
  repo: ReceiptRepository,
  ctx: ApplyContext,
): Promise<ReceiptEffects> {
  const { config } = ctx;
  const tz = config.householdTz;
  const fx: ReceiptEffects = {
    receipt: {
      dedupeKey: receiptDedupeKey(input, tz),
      totalsCheck: totalsCheck(input),
      status: "applied",
    },
    lines: [],
    newItems: [],
    newProducts: [],
    inventoryEvents: [],
    itemPatches: [],
    productPatches: [],
    preferenceEvents: [],
    reviews: [],
    cycle: null,
    telemetry: [],
  };

  // 1. Resolve lines to items/products.
  const aliases = await repo.aliases(input.vendor);
  const asins = input.lines.map((l) => l.asin).filter((a): a is string => !!a);
  const asinProducts = asins.length ? await repo.productsByAsin(input.vendor, asins) : [];
  let canonical: CanonicalItem[] | null = null;
  const createdByAsin = new Map<
    string,
    { itemId: string; productId: string; unitQuantity: number }
  >();

  for (const line of input.lines) {
    const base: ResolvedLine = {
      ...line,
      itemId: null,
      productId: null,
      matchMethod: "none",
      matchScore: null,
      trust: "unverified",
      ignored: false,
      pending: false,
      baseQty: 0,
      normalized: null,
    };
    if (line.itemId) {
      fx.lines.push({
        ...base,
        itemId: line.itemId,
        productId: line.productId ?? null,
        matchMethod: "manual",
        matchScore: 1,
        trust: "confirmed",
      });
      continue;
    }
    if (line.asin) {
      const m = matchDigitalLine({
        asin: line.asin,
        vendor: input.vendor,
        aliases,
        products: asinProducts,
      });
      if (m.kind === "ignored") {
        fx.lines.push({ ...base, matchMethod: "asin", ignored: true, trust: "confirmed" });
      } else if (m.kind === "known") {
        fx.lines.push({
          ...base,
          itemId: m.itemId,
          productId: m.productId,
          matchMethod: "asin",
          matchScore: 1,
          trust: "confirmed",
        });
      } else {
        const key = line.asin.trim().toUpperCase();
        let created = createdByAsin.get(key);
        if (!created) {
          const title = line.title?.trim() || line.rawText;
          const parsed = parseUnitQuantity(title);
          created = { itemId: ctx.newId(), productId: ctx.newId(), unitQuantity: parsed ?? 1 };
          createdByAsin.set(key, created);
          fx.newItems.push({
            id: created.itemId,
            canonicalName: deriveItemName(title),
            ...NEW_ITEM_DEFAULTS,
            trackingType: "static",
            trust: "unverified",
          });
          fx.newProducts.push({
            id: created.productId,
            itemId: created.itemId,
            vendor: input.vendor,
            asin: key,
            title,
            unitQuantity: created.unitQuantity,
            // Catalog trust has no "provisional": parsed or defaulted, it's machine-made.
            unitQuantityTrust: "unverified",
            stance: NEW_PRODUCT_STANCE,
          });
          fx.reviews.push(
            review("new_product", created.itemId, {
              asin: key,
              title,
              unitQuantityParsed: parsed !== null,
            }),
          );
        }
        fx.lines.push({
          ...base,
          itemId: created.itemId,
          productId: created.productId,
          matchMethod: "asin",
          matchScore: 1,
          trust: "confirmed",
          baseQty: toBaseUnits(line.qty, created.unitQuantity),
        });
      }
      continue;
    }
    canonical ??= await repo.canonicalItems();
    const m = matchPaperLine({
      rawText: line.rawText,
      vendor: input.vendor,
      aliases,
      items: canonical,
      config,
    });
    if (m.kind === "ignored") {
      fx.lines.push({
        ...base,
        normalized: m.normalized,
        matchMethod: "alias_exact",
        matchScore: 1,
        ignored: true,
        trust: "confirmed",
      });
    } else if (m.kind === "none") {
      fx.lines.push({ ...base, normalized: m.normalized, matchScore: m.bestScore, pending: true });
    } else {
      fx.lines.push({
        ...base,
        normalized: m.normalized,
        itemId: m.itemId,
        productId: m.productId,
        matchMethod: m.matchMethod,
        matchScore: m.score,
        trust: m.trust === "confirmed" ? "confirmed" : "unverified",
      });
    }
  }

  // 2. Per item: inventory, overbuy, EMA, product stats, implicit swaps.
  const away = await repo.awayPeriods();
  const cycle = await repo.lastBuiltCycle();
  /** Implicit swaps compare against the cart only if this receipt is that cart's order. */
  const orderCycle = cycle && receiptMatchesCycleOrder(cycle, input) ? cycle : null;
  const newItemIds = new Set(fx.newItems.map((i) => i.id));
  const applied = fx.lines.filter((l) => l.itemId !== null && !l.ignored && !l.pending);
  const itemIds = [...new Set(applied.map((l) => l.itemId!))];

  for (const itemId of itemIds) {
    const lines = applied.filter((l) => l.itemId === itemId);
    const isNew = newItemIds.has(itemId);
    const item: ItemRecord = isNew
      ? newItemRecord(
          fx.newItems.find((i) => i.id === itemId)!,
          config,
        )
      : await repo.item(itemId);
    const products: ProductRecord[] = isNew
      ? fx.newProducts.filter((p) => p.itemId === itemId).map(newProductRecord)
      : await repo.products(itemId);

    for (const l of lines) {
      if (l.baseQty > 0) continue;
      l.baseQty = lineBaseUnits(l, products, input.vendor);
    }
    const qty = lines.reduce((s, l) => s + l.baseQty, 0);
    const provisional = lines.some((l) => l.trust !== "confirmed");
    fx.inventoryEvents.push({
      itemId,
      location: item.defaultLocation,
      kind: "acquired",
      quantity: qty,
      occurredAt: input.acquiredAt,
      source: eventSource(input.source),
      trust: provisional ? "provisional" : "confirmed",
    });

    const history = isNew ? [] : await repo.acquisitions(itemId);
    if (!isNew) {
      const states = await repo.inventory(itemId);
      const before = estimateItem(item, states, input.acquiredAt, { away, config }).onHand;
      const overbuy = checkOverbuy(item, before, qty, config);
      if (overbuy) fx.telemetry.push({ ...overbuy, itemId });
    }

    // EMA (§4.1). Static one-offs promote on a second purchase within the window.
    const placed = placeAcquisition(history, input.acquiredAt, tz);
    let tracking = item.trackingType;
    const patch: ReceiptEffects["itemPatches"][number]["patch"] = {};
    if (
      tracking === "static" &&
      shouldPromoteToVelocity(
        item,
        placed.position === "next" ? (placed.prev?.at ?? null) : null,
        input.acquiredAt,
        config,
      )
    ) {
      tracking = "velocity";
      patch.trackingType = "velocity";
      fx.telemetry.push({ metric: "promoted_to_velocity", itemId });
    }
    if (tracking === "velocity") {
      if (placed.position !== "next") {
        fx.telemetry.push({ metric: "ema_skipped", itemId, reason: placed.position });
      } else {
        const step = updateVelocity(
          item,
          placed.prev,
          { at: input.acquiredAt, qty },
          { away, config },
        );
        if (step.outcome === "first_acquisition") {
          fx.telemetry.push({ metric: "ema_skipped", itemId, reason: "no_previous" });
        }
        if (step.telemetry) fx.telemetry.push({ ...step.telemetry, itemId });
        Object.assign(patch, diffVelocity(item, step.state));
      }
    }

    // Product stats and preference learning: confirmed lines with a known product only.
    let threshold = item.switchThreshold;
    let current = products;
    const applyLearning = (
      patches: ProductPatch[],
      events: PreferenceEvent[],
      cycleId: string | null,
    ) => {
      fx.productPatches.push(...patches);
      current = current.map((p) => {
        const mine = patches.filter((x) => x.id === p.id);
        return mine.length ? Object.assign({ ...p }, ...mine) : p;
      });
      for (const e of events) {
        fx.preferenceEvents.push({ ...e, itemId, cycleId });
        fx.telemetry.push({ ...e, metric: "preference_event", itemId });
      }
    };
    const boughtIds = [
      ...new Set(
        lines.filter((l) => l.trust === "confirmed" && l.productId).map((l) => l.productId!),
      ),
    ];
    for (const boughtId of boughtIds) {
      if (!current.some((p) => p.id === boughtId)) continue;
      const priced = lines.find((l) => l.productId === boughtId && l.unitPriceCents !== null);
      const learned = recordPurchase({
        products: current,
        boughtId,
        at: input.acquiredAt,
        unitPriceCents: priced?.unitPriceCents ?? null,
        switchThreshold: threshold,
        config,
      });
      applyLearning(learned.productPatches, learned.events, null);
    }
    const cartProductId = orderCycle?.lines.find((l) => l.itemId === itemId)?.productId;
    const cartProduct = cartProductId ? current.find((p) => p.id === cartProductId) : undefined;
    if (orderCycle && cartProduct && boughtIds.length > 0 && !boughtIds.includes(cartProduct.id)) {
      const chosen = current.find((p) => p.id === boughtIds[0])!;
      const learned = learnFromOverride({
        switchThreshold: threshold,
        cart: cartProduct,
        chosen,
        preferred: pickPreferred(current.filter((p) => p.stance !== "rejected")),
        implicit: true,
        config,
      });
      threshold = learned.switchThreshold;
      patch.switchThreshold = threshold;
      applyLearning(learned.productPatches, learned.events, orderCycle.cycleId);
    }
    if (Object.keys(patch).length > 0) fx.itemPatches.push({ id: itemId, patch });
  }

  // 3. Line telemetry, receipt review, status, cycle closure.
  for (const l of fx.lines) {
    fx.telemetry.push({
      metric: "receipt_line_match",
      method: l.matchMethod,
      score: l.matchScore,
      pending: l.pending,
      ignored: l.ignored,
    });
  }
  const pending = fx.lines.filter((l) => l.pending);
  const provisional = fx.lines.filter(
    (l) => !l.pending && !l.ignored && l.trust === "unverified" && l.matchMethod === "fuzzy",
  );
  if (pending.length > 0 || provisional.length > 0) {
    const cartItems = new Set(cycle?.lines.map((l) => l.itemId) ?? []);
    const pleaseCheck = new Set(cycle?.pleaseCheckItemIds ?? []);
    const flags: ImpactFlags = {
      inCartPlan: provisional.some((l) => cartItems.has(l.itemId!)),
      inPleaseCheck: provisional.some((l) => pleaseCheck.has(l.itemId!)),
    };
    fx.reviews.push(
      review(
        "receipt",
        null,
        {
          pendingLines: fx.lines.flatMap((l, i) => (l.pending ? [i] : [])),
          provisionalLines: fx.lines.flatMap((l, i) => (provisional.includes(l) ? [i] : [])),
        },
        flags,
      ),
    );
  }
  if (pending.length > 0) fx.receipt.status = applied.length > 0 ? "partial" : "pending_review";
  if (cycle && receiptClosesCycle(cycle, input)) {
    fx.cycle = {
      cycleId: cycle.cycleId,
      patch: { status: "closed", closedAt: input.acquiredAt, closeReason: "order_ingested" },
    };
  }
  return fx;

  function review(
    kind: "receipt" | "new_product",
    itemId: string | null,
    payload: Record<string, unknown>,
    flags: ImpactFlags = { inCartPlan: false, inPleaseCheck: false },
  ): ReviewEffect {
    return { ...newReview(kind, ctx.now, flags, config), kind, itemId, payload };
  }
}

function newItemRecord(n: NewItem, config: Config): ItemRecord {
  return {
    id: n.id,
    canonicalName: n.canonicalName,
    trackingType: n.trackingType,
    defaultLocation: n.defaultLocation,
    emaDays: null,
    defaultEmaDays: null,
    outlierStreak: 0,
    outlierDirection: null,
    reorderThreshold: null,
    shelfLifeDays: null,
    switchThreshold: config.product.defaultSwitchThreshold,
  };
}

function newProductRecord(p: NewProduct): ProductRecord {
  return {
    id: p.id,
    itemId: p.itemId,
    vendor: p.vendor,
    asin: p.asin,
    title: p.title,
    unitQuantity: p.unitQuantity,
    stance: p.stance,
    preferenceScore: 0,
    timesBought: 0,
    consecutiveBuys: 0,
    lastPriceCents: null,
  };
}

function diffVelocity(before: VelocityState, after: VelocityState): Partial<VelocityState> {
  const out: Partial<VelocityState> = {};
  if (after.emaDays !== before.emaDays) out.emaDays = after.emaDays;
  if (after.outlierStreak !== before.outlierStreak) out.outlierStreak = after.outlierStreak;
  if (after.outlierDirection !== before.outlierDirection)
    out.outlierDirection = after.outlierDirection;
  return out;
}

// --- review resolution --------------------------------------------------------------------------

export type LineDecision =
  | { kind: "confirm" }
  | { kind: "correct"; itemId: string; productId: string | null }
  | { kind: "ignore" };

export interface ReviewedLine {
  lineId: string;
  /** Normalized paper text (alias key); null for digital lines. */
  normalized: string | null;
  /** What the system matched (null for pending lines). */
  itemId: string | null;
  productId: string | null;
  matchScore: number | null;
  /** The line's provisional `acquired` event, if one was written. */
  eventId: string | null;
  decision: LineDecision;
}

export interface ReviewResolution {
  /** Trust updates on existing events (`expired` reverses an event). */
  eventTrust: { eventId: string; trust: "confirmed" | "expired" }[];
  /** Lines that now need a confirmed `acquired` event for `itemId` (corrected / resolved pending). */
  applyLines: { lineId: string; itemId: string; productId: string | null }[];
  lineUpdates: {
    lineId: string;
    itemId: string | null;
    productId: string | null;
    trust: "confirmed";
    ignored: boolean;
    matchMethod?: "manual";
  }[];
  aliases: (Alias & { trust: "confirmed" })[];
  /** `labeled_observation` rows (source_kind `receipt_line`); written only for human answers. */
  labels: {
    lineId: string;
    modelOutput: Record<string, unknown>;
    humanLabel: Record<string, unknown>;
  }[];
}

/**
 * A human answered a receipt review (§4.5): confirmed lines become confirmed and strengthen their
 * alias to 1.0; corrected lines reverse the provisional event and apply the corrected item;
 * ignored lines become an ignored alias. Every answer is a label.
 */
export function resolveReceiptReview(input: {
  vendor: string;
  lines: readonly ReviewedLine[];
  existingAliases: readonly Alias[];
}): ReviewResolution {
  const out: ReviewResolution = {
    eventTrust: [],
    applyLines: [],
    lineUpdates: [],
    aliases: [],
    labels: [],
  };
  const existing = (normalized: string) =>
    input.existingAliases.find(
      (a) =>
        a.vendor === input.vendor && a.kind === "receipt_text" && a.vendorString === normalized,
    ) ?? null;
  for (const l of input.lines) {
    const d = l.decision;
    const modelOutput = { itemId: l.itemId, productId: l.productId, matchScore: l.matchScore };
    if (d.kind === "confirm") {
      if (l.itemId === null) continue; // nothing to confirm on a pending line
      if (l.eventId) out.eventTrust.push({ eventId: l.eventId, trust: "confirmed" });
      out.lineUpdates.push({
        lineId: l.lineId,
        itemId: l.itemId,
        productId: l.productId,
        trust: "confirmed",
        ignored: false,
      });
      if (l.normalized) {
        out.aliases.push(
          confirmedAlias({
            vendor: input.vendor,
            normalized: l.normalized,
            itemId: l.itemId,
            productId: l.productId,
            existing: existing(l.normalized),
          }),
        );
      }
      out.labels.push({
        lineId: l.lineId,
        modelOutput,
        humanLabel: { itemId: l.itemId, productId: l.productId },
      });
    } else if (d.kind === "correct") {
      if (l.eventId) out.eventTrust.push({ eventId: l.eventId, trust: "expired" });
      out.applyLines.push({ lineId: l.lineId, itemId: d.itemId, productId: d.productId });
      out.lineUpdates.push({
        lineId: l.lineId,
        itemId: d.itemId,
        productId: d.productId,
        trust: "confirmed",
        ignored: false,
        matchMethod: "manual",
      });
      if (l.normalized) {
        out.aliases.push(
          confirmedAlias({
            vendor: input.vendor,
            normalized: l.normalized,
            itemId: d.itemId,
            productId: d.productId,
            existing: existing(l.normalized),
          }),
        );
      }
      out.labels.push({
        lineId: l.lineId,
        modelOutput,
        humanLabel: { itemId: d.itemId, productId: d.productId },
      });
    } else {
      if (l.eventId) out.eventTrust.push({ eventId: l.eventId, trust: "expired" });
      out.lineUpdates.push({
        lineId: l.lineId,
        itemId: null,
        productId: null,
        trust: "confirmed",
        ignored: true,
      });
      if (l.normalized) {
        out.aliases.push({
          vendor: input.vendor,
          kind: "receipt_text",
          vendorString: l.normalized,
          itemId: null,
          productId: null,
          confidenceScore: 1,
          ignored: true,
          trust: "confirmed",
        });
      }
      out.labels.push({ lineId: l.lineId, modelOutput, humanLabel: { ignored: true } });
    }
  }
  return out;
}

/** A receipt line after its review was answered. */
export interface FinalLine {
  itemId: string | null;
  qty: number;
  /** Base units (see `lineBaseUnits`). */
  baseQty: number;
  trust: "confirmed" | "unverified";
  ignored: boolean;
}

/** The receipt's current (non-expired) `acquired` events. */
export interface ReceiptEvent {
  id: string;
  itemId: string;
  quantity: number;
  trust: "confirmed" | "provisional";
}

export interface EventReconciliation {
  /** Same item and quantity: only the trust changes. */
  trust: { eventId: string; trust: "confirmed" | "provisional" }[];
  /** Reversed (wrong item, changed quantity, or every line of the item ignored). */
  expire: string[];
  /** New `acquired` events (corrected or newly matched lines). */
  insert: { itemId: string; quantity: number; trust: "confirmed" | "provisional" }[];
}

/**
 * After a receipt review (§4.5), make the receipt's `acquired` events match its final lines: one
 * event per item (lines of one item sum), `confirmed` unless a line is still unverified. An
 * existing event with the right item and quantity is kept (trust upgraded); anything else is
 * reversed (`expired`) and re-applied, so correcting one of two lines that summed into one event
 * keeps the other line's units.
 */
export function reconcileReceiptEvents(
  lines: readonly FinalLine[],
  events: readonly ReceiptEvent[],
): EventReconciliation {
  const out: EventReconciliation = { trust: [], expire: [], insert: [] };
  const wanted = new Map<string, { quantity: number; trust: "confirmed" | "provisional" }>();
  for (const l of lines) {
    if (l.itemId === null || l.ignored) continue;
    const w = wanted.get(l.itemId) ?? { quantity: 0, trust: "confirmed" as const };
    wanted.set(l.itemId, {
      quantity: w.quantity + l.baseQty,
      trust: w.trust === "provisional" || l.trust !== "confirmed" ? "provisional" : "confirmed",
    });
  }
  const kept = new Set<string>();
  for (const e of events) {
    const w = wanted.get(e.itemId);
    if (w && !kept.has(e.itemId) && Math.abs(w.quantity - e.quantity) < 1e-9) {
      kept.add(e.itemId);
      if (w.trust !== e.trust) out.trust.push({ eventId: e.id, trust: w.trust });
    } else {
      out.expire.push(e.id);
    }
  }
  for (const [itemId, w] of wanted) {
    if (!kept.has(itemId) && w.quantity > 0) out.insert.push({ itemId, ...w });
  }
  return out;
}
