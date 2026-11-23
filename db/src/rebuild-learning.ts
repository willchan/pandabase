// `pnpm db:rebuild-learning [--items ID,…] [--apply]`: recompute what PandaBase learned from
// receipts — product stats and stances, the item EMA columns, static → velocity promotion, the
// switch threshold and the `auto_promote` / `implicit_swap` preference events — from the inputs
// they came from (DESIGN §4.10, PLAN M11), with the fold in `web/lib/domain/learning.ts`. Imported
// by relative path, like `rebuild-state.ts`: `@pandabase/db` can't depend on `web`.
//
// Without --apply it only counts: per derived column, how many rows would change, and for the
// items that would change, which known causes their history shows (a late receipt, lines or
// events edited after ingest, expired acquisitions, merges, human preference events, an EMA step
// across a cart pause, a Costco receipt). An item with none of them is counted as unexplained.
// With --apply it writes the rebuilt values in one batch and emits one `learning_rebuilt`
// telemetry row. Output is counts only: the repo and its Actions logs are public.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { ulid } from "ulid";
import { DEFAULT_CONFIG, type Config } from "../../web/lib/config";
import { CartResult } from "../../web/lib/contracts/cycle";
import {
  changedColumns,
  eventsDiffer,
  ITEM_COLUMNS,
  PRODUCT_COLUMNS,
  REBUILT_EVENT_KINDS,
  rebuildItemLearning,
  type HumanPreferenceEvent,
  type LearnedItem,
  type LearnedPreferenceEvent,
  type LearnedProduct,
  type LearningCycle,
  type LearningReceipt,
} from "../../web/lib/domain/learning";
import { localDate } from "../../web/lib/domain/time";
import type { Acquisition, VelocityOutcome } from "../../web/lib/domain/velocity";
import { createDb, type Db } from "./client";
import { databaseUrlFromEnv } from "./env";
import { nowIso } from "./schema/common";
import {
  awayPeriod,
  groceryCycle,
  inventoryEvent,
  item,
  pausePeriod,
  preferenceEvent,
  product,
  receipt,
  receiptLine,
  systemTelemetry,
} from "./schema/index";

type ItemColumn = (typeof ITEM_COLUMNS)[number];
type ProductColumn = (typeof PRODUCT_COLUMNS)[number];
type RebuiltKind = (typeof REBUILT_EVENT_KINDS)[number];

/** Known reasons a stored value differs from the rebuild (an item can have several). */
export const CAUSES = {
  late_receipt: "a receipt ingested after one acquired later (its EMA step was skipped)",
  edited_after_ingest: "receipt lines or acquired events changed after ingest (review answers)",
  expired_acquisition: "an acquired event that expired after it was learned from",
  merged: "items merged into it (their history is folded as one item)",
  human_events: "product overrides or rejections",
  paused_step: "an EMA step across a cart pause",
  costco: "a Costco receipt (warehouse / delivery prices, §4.8)",
} as const;
export type Cause = keyof typeof CAUSES;

export interface ItemChange {
  itemId: string;
  item: Partial<LearnedItem> | null;
  products: { id: string; patch: Partial<LearnedProduct> }[];
  /** Stored events of the rebuilt kinds to replace, or null when they already match. */
  events: { deleteIds: string[]; insert: LearnedPreferenceEvent[] } | null;
  causes: Cause[];
}

export interface LearningRebuildPlan {
  /** Active (unmerged) items looked at. */
  items: number;
  products: number;
  itemsChanged: number;
  itemColumns: Record<ItemColumn, number>;
  productsChanged: number;
  productColumns: Record<ProductColumn, number>;
  events: {
    items: number;
    deleted: Record<RebuiltKind, number>;
    inserted: Record<RebuiltKind, number>;
  };
  /** Changed items per cause; `unexplained` = changed items with none. */
  causes: Record<Cause | "unexplained", number>;
  /** EMA step outcomes of the replay, summed over the items. */
  outcomes: Partial<Record<VelocityOutcome, number>>;
  changes: ItemChange[];
}

const zero = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

const HUMAN_KINDS = ["override_to_preferred", "override_to_cheaper", "reject"] as const;

function groupBy<T>(rows: readonly T[], key: (r: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    list.push(r);
  }
  return out;
}

export function configFromEnv(tz?: string): Config {
  return {
    ...DEFAULT_CONFIG,
    householdTz: tz ?? process.env.HOUSEHOLD_TZ ?? DEFAULT_CONFIG.householdTz,
  };
}

/** Plan the rebuild: read every input, fold each item, compare with what is stored. */
export async function planLearningRebuild(
  db: Pick<Db, "select">,
  opts: { items?: readonly string[]; config?: Config } = {},
): Promise<LearningRebuildPlan> {
  const config = opts.config ?? configFromEnv();
  const tz = config.householdTz;
  const [items, products, receipts, lines, acquired, prefs, cycles, away, paused] =
    await Promise.all([
      db.select().from(item),
      db.select().from(product),
      db.select().from(receipt),
      db.select().from(receiptLine).where(isNotNull(receiptLine.itemId)),
      db.select().from(inventoryEvent).where(eq(inventoryEvent.kind, "acquired")),
      db.select().from(preferenceEvent),
      db.select().from(groceryCycle).where(isNotNull(groceryCycle.builtAt)),
      db.select({ startsOn: awayPeriod.startsOn, endsOn: awayPeriod.endsOn }).from(awayPeriod),
      db.select({ startsOn: pausePeriod.startsOn, endsOn: pausePeriod.endsOn }).from(pausePeriod),
    ]);

  // Merges: an item's history is its own plus that of every item merged into it.
  const mergedInto = new Map(items.map((i) => [i.id, i.mergedIntoItemId]));
  const canonical = (id: string | null): string | null => {
    let cur = id;
    for (let n = 0; cur !== null && n < 64; n++) {
      const next = mergedInto.get(cur) ?? null;
      if (next === null) return cur;
      cur = next;
    }
    return cur;
  };
  const productItem = new Map(products.map((p) => [p.id, p.itemId]));

  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  const linesByItem = groupBy(
    lines.filter((l) => !l.ignored && receiptById.has(l.receiptId)),
    (l) => canonical(l.itemId),
  );
  const eventsByItem = groupBy(acquired, (e) => canonical(e.itemId));
  const productsByItem = groupBy(products, (p) => p.itemId);
  const humanByItem = groupBy(
    prefs.filter((e) => (HUMAN_KINDS as readonly string[]).includes(e.kind)),
    (e) => {
      const ref = e.kind === "reject" ? e.fromProductId : e.toProductId;
      return ref ? (productItem.get(ref) ?? null) : canonical(e.itemId);
    },
  );
  const storedByItem = groupBy(
    prefs.filter((e) => (REBUILT_EVENT_KINDS as readonly string[]).includes(e.kind)),
    (e) => canonical(e.itemId),
  );
  const mergedSources = groupBy(
    items.filter((i) => i.mergedIntoItemId !== null),
    (i) => canonical(i.id),
  );

  // As ingest reads it (`lastBuiltCycle`): a cart that doesn't parse has no vendors and no lines.
  const learningCycles: LearningCycle[] = cycles.map((c) => {
    const parsed = CartResult.safeParse(c.cartResult);
    const cart = parsed.success ? parsed.data : null;
    return {
      id: c.id,
      status: c.status,
      builtAt: c.builtAt!,
      cartVendors: cart?.vendors ?? [],
      orderIds: cart?.order_ids ?? [],
      lines: (cart?.lines ?? [])
        .filter((l) => l.outcome !== "failed" && l.item_id !== null)
        .map((l) => ({ itemId: canonical(l.item_id)!, productId: l.product_id })),
    };
  });

  const only = opts.items ? new Set(opts.items) : null;
  const active = items
    .filter((i) => i.mergedIntoItemId === null && (!only || only.has(i.id)))
    .sort((a, b) => a.id.localeCompare(b.id));

  const plan: LearningRebuildPlan = {
    items: active.length,
    products: 0,
    itemsChanged: 0,
    itemColumns: zero(ITEM_COLUMNS),
    productsChanged: 0,
    productColumns: zero(PRODUCT_COLUMNS),
    events: { items: 0, deleted: zero(REBUILT_EVENT_KINDS), inserted: zero(REBUILT_EVENT_KINDS) },
    causes: zero([...(Object.keys(CAUSES) as Cause[]), "unexplained"]),
    outcomes: {},
    changes: [],
  };

  for (const it of active) {
    const myLines = (linesByItem.get(it.id) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    const myReceipts: LearningReceipt[] = [...groupBy(myLines, (l) => l.receiptId)].map(
      ([rid, ls]) => {
        const r = receiptById.get(rid)!;
        return {
          id: r.id,
          source: r.source,
          vendor: r.vendor,
          fulfillment: r.fulfillment,
          externalOrderId: r.externalOrderId,
          acquiredAt: r.acquiredAt,
          createdAt: r.createdAt,
          lines: ls.map((l) => ({
            productId: l.productId,
            trust: l.trust,
            unitPriceCents: l.unitPriceCents,
          })),
        };
      },
    );
    const myEvents = eventsByItem.get(it.id) ?? [];
    const acquisitions: Acquisition[] = myEvents
      .filter((e) => e.trust !== "expired")
      .map((e) => ({ at: e.occurredAt, qty: e.quantity ?? 0 }));
    const humanEvents: HumanPreferenceEvent[] = (humanByItem.get(it.id) ?? []).map((e) => ({
      id: e.id,
      kind: e.kind as HumanPreferenceEvent["kind"],
      fromProductId: e.fromProductId,
      toProductId: e.toProductId,
      at: e.createdAt,
    }));
    const myProducts = (productsByItem.get(it.id) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    plan.products += myProducts.length;

    const res = rebuildItemLearning({
      item: {
        id: it.id,
        trackingType: it.trackingType,
        defaultEmaDays: it.defaultEmaDays,
        reorderThreshold: it.reorderThreshold,
      },
      products: myProducts.map((p) => ({
        id: p.id,
        vendor: p.vendor,
        title: p.title,
        unitQuantity: p.unitQuantity,
      })),
      receipts: myReceipts,
      acquisitions,
      humanEvents,
      cycles: learningCycles,
      away,
      paused,
      config,
    });
    for (const [k, n] of Object.entries(res.outcomes) as [VelocityOutcome, number][]) {
      plan.outcomes[k] = (plan.outcomes[k] ?? 0) + n;
    }

    const storedItem: LearnedItem = {
      currentEmaDays: it.currentEmaDays,
      emaOutlierStreak: it.emaOutlierStreak,
      emaOutlierDirection: it.emaOutlierDirection,
      trackingType: it.trackingType,
      switchThreshold: it.switchThreshold,
    };
    const itemCols = changedColumns(storedItem, res.item, ITEM_COLUMNS);
    const productChanges: ItemChange["products"] = [];
    for (const p of myProducts) {
      const stored: LearnedProduct = {
        stance: p.stance,
        preferenceScore: p.preferenceScore,
        timesBought: p.timesBought,
        consecutiveBuys: p.consecutiveBuys,
        lastBoughtAt: p.lastBoughtAt,
        lastPriceCents: p.lastPriceCents,
        lastPriceAt: p.lastPriceAt,
        lastPriceFulfillment: p.lastPriceFulfillment,
      };
      const rebuilt = res.products.get(p.id)!;
      const cols = changedColumns(stored, rebuilt, PRODUCT_COLUMNS);
      if (cols.length === 0) continue;
      for (const c of cols) plan.productColumns[c]++;
      productChanges.push({
        id: p.id,
        patch: Object.fromEntries(cols.map((c) => [c, rebuilt[c]])),
      });
    }
    const stored = storedByItem.get(it.id) ?? [];
    const eventChange = eventsDiffer(stored, res.events)
      ? { deleteIds: stored.map((e) => e.id), insert: res.events }
      : null;
    if (itemCols.length === 0 && productChanges.length === 0 && !eventChange) continue;

    for (const c of itemCols) plan.itemColumns[c]++;
    if (itemCols.length > 0) plan.itemsChanged++;
    plan.productsChanged += productChanges.length;
    if (eventChange) {
      plan.events.items++;
      for (const e of stored) plan.events.deleted[e.kind as RebuiltKind]++;
      for (const e of res.events) plan.events.inserted[e.kind]++;
    }

    // Which known causes this item's history shows.
    const causes: Cause[] = [];
    let latestDay = "";
    let late = false;
    for (const r of [...myReceipts].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )) {
      const day = localDate(r.acquiredAt, tz);
      if (day < latestDay) late = true;
      if (day > latestDay) latestDay = day;
    }
    if (late) causes.push("late_receipt");
    if (
      myLines.some((l) => l.updatedAt > l.createdAt) ||
      myEvents.some((e) => e.updatedAt > e.createdAt)
    ) {
      causes.push("edited_after_ingest");
    }
    if (myEvents.some((e) => e.trust === "expired")) causes.push("expired_acquisition");
    if (mergedSources.has(it.id)) causes.push("merged");
    if (humanEvents.length > 0) causes.push("human_events");
    if ((res.outcomes.paused ?? 0) > 0) causes.push("paused_step");
    if (myReceipts.some((r) => r.vendor === config.costco.vendor)) causes.push("costco");
    for (const c of causes) plan.causes[c]++;
    if (causes.length === 0) plan.causes.unexplained++;

    plan.changes.push({
      itemId: it.id,
      item: itemCols.length ? Object.fromEntries(itemCols.map((c) => [c, res.item[c]])) : null,
      products: productChanges,
      events: eventChange,
      causes,
    });
  }
  return plan;
}

/** Plan, then write every change in one batch (atomic) and emit `learning_rebuilt`. */
export async function applyLearningRebuild(
  db: Db,
  opts: { items?: readonly string[]; config?: Config; now?: string } = {},
): Promise<LearningRebuildPlan> {
  const now = opts.now ?? nowIso();
  const plan = await planLearningRebuild(db, opts);
  const writes = [];
  for (const c of plan.changes) {
    if (c.item) {
      writes.push(
        db
          .update(item)
          .set({ ...c.item, updatedAt: now })
          .where(eq(item.id, c.itemId)),
      );
    }
    for (const p of c.products) {
      writes.push(
        db
          .update(product)
          .set({ ...p.patch, updatedAt: now })
          .where(eq(product.id, p.id)),
      );
    }
    if (c.events) {
      if (c.events.deleteIds.length > 0) {
        writes.push(
          db
            .delete(preferenceEvent)
            .where(
              and(
                inArray(preferenceEvent.id, c.events.deleteIds),
                inArray(preferenceEvent.kind, [...REBUILT_EVENT_KINDS]),
              ),
            ),
        );
      }
      if (c.events.insert.length > 0) {
        writes.push(
          db.insert(preferenceEvent).values(
            c.events.insert.map(({ at, ...e }) => ({
              id: ulid(Date.parse(at)),
              createdAt: at,
              updatedAt: now,
              itemId: c.itemId,
              ...e,
            })),
          ),
        );
      }
    }
  }
  writes.push(
    db.insert(systemTelemetry).values({
      id: ulid(Date.parse(now)),
      source: "state_engine",
      metricType: "learning_rebuilt",
      payload: summaryPayload(plan, opts.items ? "items" : "all"),
      createdAt: now,
    }),
  );
  const [first, ...rest] = writes;
  await db.batch([first!, ...rest]);
  return plan;
}

/** The `learning_rebuilt` telemetry payload: counts only. */
export function summaryPayload(plan: LearningRebuildPlan, scope: "all" | "items") {
  return {
    scope,
    items: plan.items,
    itemsChanged: plan.itemsChanged,
    itemColumns: plan.itemColumns,
    productsChanged: plan.productsChanged,
    productColumns: plan.productColumns,
    eventItems: plan.events.items,
    eventsDeleted: plan.events.deleted,
    eventsInserted: plan.events.inserted,
    causes: plan.causes,
  };
}

const COLUMN_NAMES: Record<ItemColumn | ProductColumn, string> = {
  currentEmaDays: "current_ema_days",
  emaOutlierStreak: "ema_outlier_streak",
  emaOutlierDirection: "ema_outlier_direction",
  trackingType: "tracking_type",
  switchThreshold: "switch_threshold",
  timesBought: "times_bought",
  consecutiveBuys: "consecutive_buys",
  lastBoughtAt: "last_bought_at",
  lastPriceCents: "last_price_cents",
  lastPriceAt: "last_price_at",
  lastPriceFulfillment: "last_price_fulfillment",
  stance: "stance",
  preferenceScore: "preference_score",
};

export function formatLearningPlan(plan: LearningRebuildPlan, applied: boolean): string {
  const row = (label: string, n: number | string) => `  ${label.padEnd(46)}${n}`;
  const verb = applied ? "changed" : "would change";
  const out = [
    `Learning rebuild — ${applied ? "APPLIED" : "dry run"}`,
    row("items checked", plan.items),
    row("products checked", plan.products),
    row(`items ${verb}`, plan.itemsChanged),
    ...ITEM_COLUMNS.map((c) => row(`  item.${COLUMN_NAMES[c]}`, plan.itemColumns[c])),
    row(`products ${verb}`, plan.productsChanged),
    ...PRODUCT_COLUMNS.map((c) => row(`  product.${COLUMN_NAMES[c]}`, plan.productColumns[c])),
    row(`items whose preference events ${verb}`, plan.events.items),
    ...REBUILT_EVENT_KINDS.map((k) =>
      row(`  ${k}: removed / added`, `${plan.events.deleted[k]} / ${plan.events.inserted[k]}`),
    ),
    `  changed items by cause (an item can have several)`,
    ...(Object.keys(CAUSES) as Cause[]).map((c) => row(`  ${c}`, plan.causes[c])),
    row("  unexplained", plan.causes.unexplained),
    `  EMA replay steps`,
    ...Object.entries(plan.outcomes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => row(`  ${k}`, n)),
  ];
  return out.join("\n");
}

const ID_LIST = /^[0-9A-Za-z]+(,[0-9A-Za-z]+)*$/;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({
    options: { apply: { type: "boolean", default: false }, items: { type: "string" } },
  });
  if (values.items !== undefined && !ID_LIST.test(values.items)) {
    console.error("--items: comma-separated item ids");
    process.exit(2);
  }
  const opts = values.items === undefined ? {} : { items: values.items.split(",") };
  const db = createDb({ url: databaseUrlFromEnv() });
  try {
    const plan = values.apply
      ? await applyLearningRebuild(db, opts)
      : await planLearningRebuild(db, opts);
    const text = formatLearningPlan(plan, values.apply);
    console.log(text);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, `\n\`\`\`\n${text}\n\`\`\`\n`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    db.$client.close();
  }
}
