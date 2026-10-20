// Deterministic synthetic seed (PLAN M2): two members, ~40 items, ~6 months of receipts, an away
// period, an open cycle and a few pending reviews. Same `seed` + `now` → identical database.
//
// The seed writes rows and events directly — no domain logic. `inventory_state` is filled by the
// §4.2 projection in `rebuild-state.ts`.
import { pathToFileURL } from "node:url";
import { ulid } from "ulid";
import { createDb, type Db } from "./client";
import { databaseUrlFromEnv } from "./env";
import { rebuildInventoryState } from "./rebuild-state";
import * as s from "./schema/index";
import {
  IGNORED_ALIASES,
  ITEMS,
  MEMBERS,
  NEW_ITEM,
  type ItemSpec,
  type ProductSpec,
} from "./seed-data";

export interface SeedOptions {
  /** RNG seed. */
  seed?: number;
  /** "Now" for the seeded household (UTC ISO). Defaults to a fixed instant for determinism. */
  now?: string;
  /** Household time zone for local dates (DESIGN §8). */
  tz?: string;
}

export const DEFAULT_SEED = 20261020;
/** Tuesday 2026-10-20 09:00 America/Los_Angeles. */
export const DEFAULT_SEED_NOW = "2026-10-20T16:00:00.000Z";

const DAY = 86_400_000;
const WEEKS = 26;
const AWAY_WEEK = 15;
const OTHER_STORE_WEEK = 9;
/** Whole Foods is weekly; Amazon orders are rarer and bigger. */
const HORIZON = {
  wholefoods: { triggerDays: 10, coverDays: 10 },
  amazon: { triggerDays: 7, coverDays: 24 },
} as const;

/** mulberry32 — small, fast, deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ISO-8601 week label, e.g. `2026-W43`. */
export function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

type Rows = {
  member: (typeof s.member.$inferInsert)[];
  awayPeriod: (typeof s.awayPeriod.$inferInsert)[];
  item: (typeof s.item.$inferInsert)[];
  product: (typeof s.product.$inferInsert)[];
  vendorAlias: (typeof s.vendorAlias.$inferInsert)[];
  groceryCycle: (typeof s.groceryCycle.$inferInsert)[];
  auditJob: (typeof s.auditJob.$inferInsert)[];
  receipt: (typeof s.receipt.$inferInsert)[];
  receiptLine: (typeof s.receiptLine.$inferInsert)[];
  inventoryEvent: (typeof s.inventoryEvent.$inferInsert)[];
  reviewItem: (typeof s.reviewItem.$inferInsert)[];
  labeledObservation: (typeof s.labeledObservation.$inferInsert)[];
  groceryCycleOverride: (typeof s.groceryCycleOverride.$inferInsert)[];
  priceQuote: (typeof s.priceQuote.$inferInsert)[];
  preferenceEvent: (typeof s.preferenceEvent.$inferInsert)[];
  systemTelemetry: (typeof s.systemTelemetry.$inferInsert)[];
};

/** Insertion order respects foreign keys. */
const TABLES: { [K in keyof Rows]: (typeof s)[K] } = {
  member: s.member,
  awayPeriod: s.awayPeriod,
  item: s.item,
  product: s.product,
  vendorAlias: s.vendorAlias,
  groceryCycle: s.groceryCycle,
  auditJob: s.auditJob,
  receipt: s.receipt,
  receiptLine: s.receiptLine,
  inventoryEvent: s.inventoryEvent,
  reviewItem: s.reviewItem,
  labeledObservation: s.labeledObservation,
  groceryCycleOverride: s.groceryCycleOverride,
  priceQuote: s.priceQuote,
  preferenceEvent: s.preferenceEvent,
  systemTelemetry: s.systemTelemetry,
};

/** Normalized receipt text for a store product (what the paper/digital receipt prints). */
const receiptText = (title: string) =>
  title
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28);

interface Purchase {
  item: ItemSpec;
  product: ProductSpec;
  qty: number;
  unitPriceCents: number;
}

/** Build every seed row in memory. Pure: depends only on `opts`. */
export function buildSeed(opts: SeedOptions = {}): Rows {
  const rand = mulberry32(opts.seed ?? DEFAULT_SEED);
  const nowMs = Date.parse(opts.now ?? DEFAULT_SEED_NOW);
  const tz = opts.tz ?? "America/Los_Angeles";
  const localDate = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short" }).format(ms);
  const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const chance = (p: number) => rand() < p;
  const iso = (ms: number) => new Date(Math.round(ms)).toISOString();
  const newId = (ms: number) => ulid(Math.round(ms), rand);
  const stamp = (ms: number) => ({ id: newId(ms), createdAt: iso(ms), updatedAt: iso(ms) });

  const rows: Rows = {
    member: [],
    awayPeriod: [],
    item: [],
    product: [],
    vendorAlias: [],
    groceryCycle: [],
    auditJob: [],
    receipt: [],
    receiptLine: [],
    inventoryEvent: [],
    reviewItem: [],
    labeledObservation: [],
    groceryCycleOverride: [],
    priceQuote: [],
    preferenceEvent: [],
    systemTelemetry: [],
  };

  // The last shop is the Saturday before `now`; weeks run back from there.
  const nowDow = new Date(nowMs).getUTCDay();
  const lastShopDay = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate() - ((nowDow + 1) % 7 || 7),
  );
  const firstShopDay = lastShopDay - (WEEKS - 1) * 7 * DAY;
  const startMs = firstShopDay - 14 * DAY;

  // --- members --------------------------------------------------------------------------------
  const members = MEMBERS.map((m) => {
    const row = { ...stamp(startMs), ...m };
    rows.member.push(row);
    return row;
  });
  const [alex, sam] = members as [(typeof members)[0], (typeof members)[0]];

  // --- away period ----------------------------------------------------------------------------
  const awayStartMs = firstShopDay + AWAY_WEEK * 7 * DAY - 3 * DAY;
  const awayEndMs = awayStartMs + 7 * DAY;
  rows.awayPeriod.push({
    ...stamp(awayStartMs - 10 * DAY),
    startsOn: localDate(awayStartMs),
    endsOn: localDate(awayEndMs),
    note: "Summer trip",
    createdByMemberId: sam.id,
  });
  const awayDaysBetween = (a: number, b: number) =>
    Math.max(0, (Math.min(b, awayEndMs + DAY) - Math.max(a, awayStartMs)) / DAY);

  // --- catalog --------------------------------------------------------------------------------
  type ItemRow = typeof s.item.$inferInsert & { id: string };
  type ProductRow = typeof s.product.$inferInsert & { id: string };
  const itemRows = new Map<ItemSpec, ItemRow>();
  const productRows = new Map<ProductSpec, ProductRow>();

  const addItem = (spec: ItemSpec, ms: number, trust: "confirmed" | "unverified") => {
    const row: ItemRow = {
      ...stamp(ms),
      canonicalName: spec.name,
      category: spec.category,
      defaultLocation: spec.location,
      trackingType: spec.tracking,
      baseUnit: spec.baseUnit,
      defaultEmaDays: spec.defaultEma ? spec.days : null,
      reorderThreshold: spec.reorderThreshold ?? null,
      shelfLifeDays: spec.shelfLifeDays ?? null,
      auditHint: spec.auditHint ?? null,
      trust,
    };
    rows.item.push(row);
    itemRows.set(spec, row);
    for (const p of spec.products) {
      const prow: ProductRow = {
        ...stamp(ms),
        itemId: row.id,
        vendor: p.vendor,
        asin: p.asin ?? null,
        title: p.title,
        unitQuantity: p.unit,
        unitQuantityTrust: trust,
        stance: p.rejected ? "rejected" : "acceptable",
        preferenceScore: p.rejected ? -1 : 0,
      };
      rows.product.push(prow);
      productRows.set(p, prow);
      rows.vendorAlias.push({
        ...stamp(ms),
        vendor: p.vendor,
        kind: p.asin ? "asin" : "receipt_text",
        vendorString: p.asin ?? receiptText(p.title),
        itemId: row.id,
        productId: prow.id,
        confidenceScore: trust === "confirmed" ? 1 : 0.6,
        trust,
      });
    }
    return row;
  };
  for (const spec of ITEMS) addItem(spec, startMs, "confirmed");
  for (const a of IGNORED_ALIASES) {
    rows.vendorAlias.push({
      ...stamp(startMs),
      ...a,
      confidenceScore: 1,
      trust: "confirmed",
      ignored: true,
    });
  }

  const activeProduct = (spec: ItemSpec, week: number): ProductSpec => {
    let chosen = spec.products[0]!;
    for (const p of spec.products) if (!p.rejected && (p.from ?? 0) <= week) chosen = p;
    return chosen;
  };

  // --- simulation -----------------------------------------------------------------------------
  const truth = new Map(ITEMS.map((i) => [i, i.days * between(0.85, 1.15)]));
  const stock = new Map(
    ITEMS.map((i) => [
      i,
      i.tracking === "static"
        ? (i.reorderThreshold ?? 0) + Math.ceil(between(0, 3))
        : (between(0.3, 1.2) * 10) / truth.get(i)!,
    ]),
  );
  let lastSimMs = startMs;
  const consumeUntil = (ms: number) => {
    const days = (ms - lastSimMs) / DAY - awayDaysBetween(lastSimMs, ms);
    for (const i of ITEMS) {
      const used = (days / truth.get(i)!) * between(0.8, 1.2);
      stock.set(i, Math.max(0, stock.get(i)! - used));
    }
    lastSimMs = ms;
  };
  /** What to buy now from `vendor` to last until the next shop plus a buffer. */
  const shoppingList = (vendor: ProductSpec["vendor"], week: number): Purchase[] => {
    const out: Purchase[] = [];
    for (const i of ITEMS) {
      const product = activeProduct(i, week);
      if (product.vendor !== vendor) continue;
      const have = stock.get(i)!;
      let units: number;
      if (i.tracking === "static") {
        if (have > (i.reorderThreshold ?? 0)) continue;
        units = (i.reorderThreshold ?? 0) + 2 - have;
      } else {
        // Buy when it would run out before the next order (+ buffer); cover until well past it.
        const { triggerDays, coverDays } = HORIZON[vendor];
        if (have * truth.get(i)! > triggerDays || chance(0.08)) continue; // occasionally forgotten
        units = coverDays / truth.get(i)! - have;
      }
      let qty = Math.max(1, Math.ceil(units / product.unit));
      if (chance(0.05)) qty *= 2; // stock-up
      const unitPriceCents = Math.round(product.priceCents * between(0.92, 1.1));
      out.push({ item: i, product, qty, unitPriceCents });
    }
    return out;
  };

  const productStats = new Map<ProductSpec, { times: number; lastMs: number; lastPrice: number }>();
  const lastBoughtProduct = new Map<ItemSpec, { product: ProductSpec; streak: number }>();
  const recordPurchase = (p: Purchase, ms: number) => {
    stock.set(p.item, stock.get(p.item)! + p.qty * p.product.unit);
    const st = productStats.get(p.product) ?? { times: 0, lastMs: 0, lastPrice: 0 };
    productStats.set(p.product, { times: st.times + 1, lastMs: ms, lastPrice: p.unitPriceCents });
    const prev = lastBoughtProduct.get(p.item);
    lastBoughtProduct.set(p.item, {
      product: p.product,
      streak: prev?.product === p.product ? prev.streak + 1 : 1,
    });
  };

  let paperSeq = 0;
  let orderSeq = 0;
  type ReceiptRow = typeof s.receipt.$inferInsert & { id: string };
  type PendingLine = { rawText: string; item: ItemRow; product: ProductRow };
  const addReceipt = (
    vendor: "wholefoods" | "amazon",
    fulfillment: "pickup" | "delivery" | "in_store",
    acquiredMs: number,
    purchases: Purchase[],
    account: (typeof members)[0],
    cycleId: string | null,
    opts: { pendingLine?: PendingLine | undefined } = {},
  ): ReceiptRow => {
    const paper = fulfillment === "in_store";
    const orderedMs = paper ? acquiredMs : acquiredMs - between(0.5, 1.5) * DAY;
    const receiptId = newId(acquiredMs);
    let jobId: string | null = null;
    if (paper) {
      paperSeq += 1;
      jobId = newId(acquiredMs + 60_000);
      rows.auditJob.push({
        id: jobId,
        createdAt: iso(acquiredMs + 60_000),
        updatedAt: iso(acquiredMs + 180_000),
        jobType: "paper_receipt",
        status: "completed",
        mediaR2Key: `seed/paper-receipts/${paperSeq}.jpg`,
        input: { vendor },
        result: { receipt_id: receiptId, lines: purchases.length },
        rawModelResponse: { seeded: true },
        model: "seed-vlm",
        promptVersion: "paper_receipt.v1",
        attempts: 1,
        claimedAt: iso(acquiredMs + 90_000),
        leaseExpiresAt: iso(acquiredMs + 390_000),
        actorMemberId: account.id,
        cycleId,
        discordChannelId: "200000000000000001",
        discordMessageId: String(300000000000000000 + paperSeq),
        notifiedAt: iso(acquiredMs + 200_000),
        completedAt: iso(acquiredMs + 180_000),
      });
    }
    const lines: (typeof s.receiptLine.$inferInsert)[] = purchases.map((p) => {
      const prow = productRows.get(p.product)!;
      return {
        ...stamp(acquiredMs),
        receiptId,
        rawText: p.product.vendor === "amazon" ? p.product.title : receiptText(p.product.title),
        asin: p.product.asin ?? null,
        productId: prow.id,
        itemId: prow.itemId,
        qty: p.qty,
        unitPriceCents: p.unitPriceCents,
        lineTotalCents: p.unitPriceCents * p.qty,
        matchMethod: p.product.asin ? "asin" : "alias_exact",
        matchScore: 1,
        trust: "confirmed",
      };
    });
    if (paper) {
      lines.push({
        ...stamp(acquiredMs),
        receiptId,
        rawText: "BAG FEE",
        qty: 1,
        unitPriceCents: 10,
        lineTotalCents: 10,
        matchMethod: "alias_exact",
        matchScore: 1,
        trust: "confirmed",
        ignored: true,
      });
    }
    if (opts.pendingLine) {
      const { rawText, item: irow, product: prow } = opts.pendingLine;
      lines.push({
        ...stamp(acquiredMs),
        receiptId,
        rawText,
        productId: prow.id,
        itemId: irow.id,
        qty: 2,
        unitPriceCents: 399,
        lineTotalCents: 798,
        matchMethod: "fuzzy",
        matchScore: 0.62,
        trust: "unverified",
      });
    }
    rows.receiptLine.push(...lines);
    const subtotal = lines.reduce((sum, l) => sum + (l.lineTotalCents ?? 0), 0);
    const total = subtotal + Math.round(subtotal * 0.0125);
    const externalOrderId = paper
      ? null
      : `${vendor === "amazon" ? "114" : "WF"}-SEED-${++orderSeq}`;
    const row: ReceiptRow = {
      id: receiptId,
      createdAt: iso(acquiredMs + 300_000),
      updatedAt: iso(acquiredMs + 300_000),
      source: paper ? "paper" : "digital",
      vendor,
      accountMemberId: account.id,
      externalOrderId,
      dedupeKey: paper
        ? `paper:${vendor}:${localDate(acquiredMs)}:${total}`
        : `digital:${account.id}:${externalOrderId}`,
      fulfillment,
      orderedAt: iso(orderedMs),
      acquiredAt: iso(acquiredMs),
      subtotalCents: subtotal,
      totalCents: total,
      totalsCheck: "pass",
      jobId,
      status: opts.pendingLine ? "partial" : "applied",
    };
    rows.receipt.push(row);
    for (const p of purchases) {
      const irow = itemRows.get(p.item)!;
      rows.inventoryEvent.push({
        ...stamp(acquiredMs),
        itemId: irow.id,
        location: p.item.location,
        kind: "acquired",
        quantity: p.qty * p.product.unit,
        occurredAt: iso(acquiredMs),
        source: paper ? "paper_receipt" : "digital_receipt",
        sourceRef: receiptId,
        actorMemberId: account.id,
        actorSystem: paper ? "worker" : "agent",
        trust: "confirmed",
      });
      recordPurchase(p, acquiredMs);
    }
    return row;
  };

  let lastReceipt: ReceiptRow | undefined;
  for (let w = 0; w < WEEKS; w++) {
    const shopDay = firstShopDay + w * 7 * DAY;
    const shopMs = shopDay + 18 * 3_600_000 + between(0, 3) * 3_600_000; // ~11:00–14:00 PT
    const monday = shopDay - 5 * DAY + 16 * 3_600_000;
    const cycleId = newId(monday);
    const away = w === AWAY_WEEK;
    const otherStore = w === OTHER_STORE_WEEK;
    const status = away ? "skipped" : otherStore ? "other_store" : "closed";
    rows.groceryCycle.push({
      id: cycleId,
      createdAt: iso(monday),
      updatedAt: iso(shopMs),
      weekLabel: isoWeekLabel(new Date(shopDay)),
      discordThreadId: String(400000000000000000 + w),
      status,
      openedAt: iso(monday),
      nudgeSentAt: away ? null : iso(shopDay - DAY + 25 * 3_600_000),
      builtAt: away || otherStore ? null : iso(shopDay + 17 * 3_600_000),
      closedAt: iso(shopMs + 3_600_000),
      closeReason: away ? "away" : otherStore ? "other_store" : "order_ingested",
      cartResult: null,
    });

    consumeUntil(shopMs);
    // Brand switches take effect this week: log them against the cycle.
    for (const i of ITEMS) {
      const cur = activeProduct(i, w);
      const before = w > 0 ? activeProduct(i, w - 1) : cur;
      if (cur !== before) {
        rows.preferenceEvent.push({
          ...stamp(shopMs - 2 * 3_600_000),
          itemId: itemRows.get(i)!.id,
          kind: cur.vendor !== before.vendor ? "override_to_cheaper" : "switch",
          fromProductId: productRows.get(before)!.id,
          toProductId: productRows.get(cur)!.id,
          thresholdBefore: 0.15,
          thresholdAfter: 0.15,
          cycleId,
        });
      }
    }
    if (away || otherStore) continue;

    const list = shoppingList("wholefoods", w);
    const last = w === WEEKS - 1;
    const r = rand();
    const fulfillment = last ? "in_store" : r < 0.6 ? "pickup" : r < 0.85 ? "in_store" : "delivery";
    const account = chance(0.85) ? alex : sam;
    let pendingLine: PendingLine | undefined;
    if (last) {
      // An unfamiliar line on the newest paper receipt auto-created an unverified item/product.
      const irow = addItem(NEW_ITEM, shopMs, "unverified");
      pendingLine = {
        rawText: "BRGHTBRW GNGR KMBCHA 16",
        item: irow,
        product: productRows.get(NEW_ITEM.products[0]!)!,
      };
    }
    const receipt = addReceipt("wholefoods", fulfillment, shopMs, list, account, cycleId, {
      pendingLine,
    });
    rows.groceryCycle.at(-1)!.cartResult = {
      vendor: "wholefoods",
      lines: list.length,
      added: list.length,
      unavailable: chance(0.3) ? 1 : 0,
    };
    lastReceipt = receipt;

    // Amazon orders arrive a couple of days later when something there is running low.
    const amzMs = shopMs + between(1.5, 3) * DAY;
    if (amzMs < nowMs) {
      consumeUntil(amzMs);
      const amzList = shoppingList("amazon", w);
      if (amzList.length > 0)
        addReceipt("amazon", "delivery", amzMs, amzList, chance(0.5) ? alex : sam, null);
    }
  }
  consumeUntil(nowMs);

  // --- product stats & stances ----------------------------------------------------------------
  for (const [spec, irow] of itemRows) {
    const current = lastBoughtProduct.get(spec);
    for (const p of spec.products) {
      const prow = productRows.get(p)!;
      const st = productStats.get(p);
      if (st) {
        prow.timesBought = st.times;
        prow.lastBoughtAt = iso(st.lastMs);
        prow.lastPriceCents = st.lastPrice;
        prow.lastPriceAt = iso(st.lastMs);
      }
      if (current?.product === p) {
        prow.consecutiveBuys = current.streak;
        if (irow.trust === "confirmed") {
          prow.stance = "preferred";
          prow.preferenceScore = 1;
        }
      }
    }
    // Synthetic "learned" EMA for velocity items with history (M3 will recompute from events).
    if (spec.tracking === "velocity" && current) {
      irow.currentEmaDays = Math.round(truth.get(spec)! * between(0.9, 1.1) * 1000) / 1000;
    }
  }
  const oatRejected = ITEMS.find((i) => i.name === "Oat Milk")!.products.find((p) => p.rejected)!;
  rows.preferenceEvent.push({
    ...stamp(firstShopDay + 4 * 7 * DAY),
    itemId: productRows.get(oatRejected)!.itemId,
    kind: "reject",
    fromProductId: productRows.get(oatRejected)!.id,
    thresholdBefore: 0.15,
    thresholdAfter: 0.15,
  });

  // --- non-receipt inventory events -----------------------------------------------------------
  const ev = (spec: ItemSpec, ms: number, e: Partial<typeof s.inventoryEvent.$inferInsert>) =>
    rows.inventoryEvent.push({
      ...stamp(ms),
      itemId: itemRows.get(spec)!.id,
      location: spec.location,
      kind: "observed",
      quantity: 0,
      occurredAt: iso(ms),
      source: "checkin",
      trust: "confirmed",
      ...e,
    });
  const byName = (n: string) => ITEMS.find((i) => i.name === n)!;
  const checkinMs = nowMs - 4 * DAY;
  ev(byName("Eggs"), checkinMs, { quantity: 4, actorMemberId: alex.id, actorSystem: "agent" });
  ev(byName("Toilet Paper"), checkinMs, {
    quantity: 9,
    actorMemberId: sam.id,
    actorSystem: "agent",
  });
  ev(byName("Olive Oil"), checkinMs, { quantity: 1, actorMemberId: alex.id, actorSystem: "agent" });
  ev(byName("Oat Milk"), nowMs - 1.5 * DAY, {
    kind: "consumed",
    statusOverride: "consumed",
    source: "manual",
    actorMemberId: sam.id,
  });
  ev(byName("Chicken Thighs"), lastShopDay + 20 * 3_600_000 + DAY, {
    kind: "moved",
    quantity: 1.5,
    toLocation: "freezer",
    source: "manual",
    actorMemberId: alex.id,
  });
  ev(byName("Baby Spinach"), nowMs - 6 * 3_600_000, {
    kind: "presumed_discarded",
    quantity: 2,
    source: "system",
    actorSystem: "cron",
    trust: "provisional",
  });

  // --- jobs, reviews, labels ------------------------------------------------------------------
  const job = (
    ms: number,
    j: Omit<typeof s.auditJob.$inferInsert, "id" | "createdAt" | "updatedAt">,
  ) => {
    const row = { ...stamp(ms), ...j };
    rows.auditJob.push(row);
    return row;
  };
  const review = (
    ms: number,
    r: Omit<typeof s.reviewItem.$inferInsert, "id" | "createdAt" | "updatedAt">,
  ) => rows.reviewItem.push({ ...stamp(ms), ...r });

  // Trash Cam: one completed discard, one low-confidence result awaiting review, one queued.
  const trashMs = nowMs - 2 * DAY;
  const trashDone = job(trashMs, {
    jobType: "trash_cam",
    status: "completed",
    mediaR2Key: "seed/trash-cam/1.mp4",
    keyframeR2Keys: ["seed/trash-cam/1-k0.jpg", "seed/trash-cam/1-k1.jpg"],
    model: "seed-vlm",
    promptVersion: "trash_cam.v1",
    result: { detections: [{ name: "strawberries", confidence: 0.91 }] },
    attempts: 1,
    actorMemberId: sam.id,
    completedAt: iso(trashMs + 120_000),
  });
  ev(byName("Strawberries"), trashMs, {
    kind: "discarded",
    quantity: 8,
    source: "trash_cam",
    sourceRef: trashDone.id,
    actorSystem: "worker",
  });
  const trashLow = job(nowMs - DAY, {
    jobType: "trash_cam",
    status: "completed",
    mediaR2Key: "seed/trash-cam/2.mp4",
    keyframeR2Keys: ["seed/trash-cam/2-k0.jpg"],
    model: "seed-vlm",
    promptVersion: "trash_cam.v1",
    result: { detections: [{ name: "yogurt?", confidence: 0.41 }] },
    attempts: 1,
    actorMemberId: alex.id,
    completedAt: iso(nowMs - DAY + 90_000),
  });
  review(nowMs - DAY + 90_000, {
    kind: "trash_cam",
    jobId: trashLow.id,
    itemId: itemRows.get(byName("Greek Yogurt"))!.id,
    payload: { detected_name: "yogurt?", confidence: 0.41, suggestions: ["Greek Yogurt"] },
    urgency: "cleanup",
    impactScore: 1,
    defaultAction: { action: "none" },
    expiresAt: iso(nowMs - DAY + 7 * DAY),
  });
  job(nowMs - 20 * 60_000, {
    jobType: "trash_cam",
    status: "queued",
    mediaR2Key: "seed/trash-cam/3.mp4",
    actorMemberId: sam.id,
  });

  // A paper receipt job that failed twice.
  const failed = job(nowMs - 3 * DAY, {
    jobType: "paper_receipt",
    status: "failed",
    mediaR2Key: "seed/paper-receipts/blurry.jpg",
    model: "seed-vlm",
    promptVersion: "paper_receipt.v1",
    attempts: 2,
    error: "could not read totals (image too blurry)",
    actorMemberId: alex.id,
  });
  review(nowMs - 3 * DAY + 600_000, {
    kind: "failed_job",
    jobId: failed.id,
    payload: { error: failed.error },
    urgency: "cleanup",
    impactScore: 1,
    defaultAction: { action: "dismiss" },
    expiresAt: iso(nowMs - 3 * DAY + 14 * DAY),
  });

  // The newest paper receipt has a pending fuzzy line → receipt + new_product + unverified_item.
  if (lastReceipt) {
    const created = Date.parse(lastReceipt.createdAt!);
    const kombucha = itemRows.get(NEW_ITEM)!;
    review(created, {
      kind: "receipt",
      receiptId: lastReceipt.id,
      jobId: lastReceipt.jobId ?? null,
      payload: { pending_lines: 1, detected_name: "BRGHTBRW GNGR KMBCHA 16" },
      urgency: "this_week",
      impactScore: 10,
      defaultAction: { action: "drop_pending_lines" },
      expiresAt: iso(created + 14 * DAY),
    });
    review(created, {
      kind: "new_product",
      receiptId: lastReceipt.id,
      itemId: kombucha.id,
      payload: { detected_name: "BRGHTBRW GNGR KMBCHA 16", suggestions: ["Kombucha"] },
      urgency: "cleanup",
      impactScore: 1,
      defaultAction: { action: "keep" },
      expiresAt: iso(created + 30 * DAY),
    });
    review(created, {
      kind: "unverified_item",
      itemId: kombucha.id,
      payload: { name: kombucha.canonicalName },
      urgency: "cleanup",
      impactScore: 1,
      defaultAction: { action: "keep_unverified" },
      expiresAt: null,
    });
  }

  // Two past corrections by a human → resolved reviews + labeled observations.
  const paperJobs = rows.auditJob.filter(
    (j) => j.jobType === "paper_receipt" && j.status === "completed",
  );
  for (const [n, j] of paperJobs.slice(0, 2).entries()) {
    const ms = Date.parse(j.completedAt!) + 3_600_000;
    const target = ITEMS[n * 5]!;
    rows.reviewItem.push({
      ...stamp(ms),
      kind: "receipt",
      jobId: j.id,
      payload: { pending_lines: 1 },
      urgency: "cleanup",
      impactScore: 1,
      status: "corrected",
      defaultAction: { action: "drop_pending_lines" },
      expiresAt: iso(ms + 14 * DAY),
      reviewedByMemberId: alex.id,
      reviewedAt: iso(ms + DAY),
    });
    rows.labeledObservation.push({
      ...stamp(ms + DAY),
      sourceKind: "receipt_line",
      jobId: j.id,
      modelOutput: { raw_text: receiptText(target.products[0]!.title).slice(0, 12), guess: null },
      humanLabel: {
        item_id: itemRows.get(target)!.id,
        product_id: productRows.get(target.products[0]!)!.id,
      },
      model: j.model ?? null,
      promptVersion: j.promptVersion ?? null,
      memberId: alex.id,
    });
  }

  // --- the open cycle -------------------------------------------------------------------------
  const openMs = lastShopDay + 2 * DAY + 16 * 3_600_000; // Monday 09:00 PT
  const openCycle = {
    ...stamp(openMs),
    weekLabel: isoWeekLabel(new Date(nowMs)),
    discordThreadId: "400000000000000999",
    status: "open" as const,
    openedAt: iso(openMs),
  };
  rows.groceryCycle.push(openCycle);
  rows.groceryCycleOverride.push(
    {
      ...stamp(openMs + 3_600_000),
      cycleId: openCycle.id,
      kind: "add",
      freeText: "birthday candles",
      quantity: 1,
      actorMemberId: sam.id,
    },
    {
      ...stamp(openMs + 7_200_000),
      cycleId: openCycle.id,
      kind: "skip",
      itemId: itemRows.get(byName("Ice Cream"))!.id,
      actorMemberId: alex.id,
    },
    {
      ...stamp(openMs + 9_000_000),
      cycleId: openCycle.id,
      kind: "qty",
      itemId: itemRows.get(byName("Bananas"))!.id,
      quantity: 2,
      actorMemberId: alex.id,
    },
  );
  for (const name of ["Coffee Beans", "Toilet Paper", "Sparkling Water"]) {
    const p = activeProduct(byName(name), WEEKS);
    rows.priceQuote.push({
      ...stamp(openMs + 4 * 3_600_000),
      cycleId: openCycle.id,
      productId: productRows.get(p)!.id,
      priceCents: Math.round(p.priceCents * between(0.9, 1.1)),
      observedAt: iso(openMs + 4 * 3_600_000),
      source: "agent",
    });
  }

  // --- telemetry ------------------------------------------------------------------------------
  rows.systemTelemetry.push(
    {
      id: newId(nowMs - 9 * DAY),
      createdAt: iso(nowMs - 9 * DAY),
      source: "state_engine",
      metricType: "ema_outlier_rejected",
      payload: { item: "Coffee Beans", observed: 3.1, ema: 0.85 },
    },
    {
      id: newId(nowMs - 3 * DAY),
      createdAt: iso(nowMs - 3 * DAY),
      source: "state_engine",
      metricType: "overbuy",
      payload: { item: "Spaghetti", days_of_stock: 21 },
    },
    {
      id: newId(nowMs - 4 * DAY),
      createdAt: iso(nowMs - 4 * DAY),
      source: "state_engine",
      metricType: "estimate_vs_observed",
      payload: { item: "Eggs", estimated: 5.2, observed: 4 },
    },
  );

  return rows;
}

/** Insert the seed into an empty, migrated database and project `inventory_state`. */
export async function seed(db: Db, opts: SeedOptions = {}): Promise<Rows> {
  const rows = buildSeed(opts);
  await db.transaction(async (tx) => {
    for (const key of Object.keys(TABLES) as (keyof Rows)[]) {
      const table = TABLES[key];
      const values = rows[key];
      for (let i = 0; i < values.length; i += 100) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are typed per table above
        await tx.insert(table).values(values.slice(i, i + 100) as any);
      }
    }
  });
  await rebuildInventoryState(db, opts.now ?? DEFAULT_SEED_NOW, { tz: opts.tz });
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = databaseUrlFromEnv();
  if (!url.startsWith("file:") && !process.argv.includes("--force")) {
    console.error(`Refusing to seed non-local database ${url} (pass --force to override).`);
    process.exit(1);
  }
  const db = createDb({ url });
  const rows = await seed(db);
  const counts = Object.entries(rows)
    .map(([k, v]) => `${k}=${v.length}`)
    .join(" ");
  console.log(`seeded ${url}: ${counts}`);
  db.$client.close();
}
