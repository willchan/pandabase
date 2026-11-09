// `pnpm db:reset-imports [--apply]`: undo the digital (Amazon / Whole Foods) receipt import so it can
// be re-run with a fixed parser (DESIGN §4.5 "Resetting the digital import"). Ingest dedupes on the
// order id, so re-importing alone can't correct rows a buggy parser wrote.
//
// Deletes what the import created: digital receipts and their lines, the items and products they
// created, those items' inventory events / state / preference events / price quotes / vendor
// aliases, the reviews about them (Cleanup's receipt, new-product, unverified-item and merge
// reviews), the merge_suggest jobs, and the stored replies to `receipt:` ingest keys (else a
// re-import within the 24 h idempotency window would replay the old responses). Keeps members,
// settings, away periods, grocery cycles and telemetry.
//
// Refuses — deleting nothing — if any of that is tied to human-entered or human-confirmed data
// (answered reviews, labeled observations, inventory events from people, cycle overrides, product
// rejections, paper/manual receipt lines, merges, item settings, items that predate the import).
// Without --apply it only counts. Output is counts only: the repo and its Actions logs are public.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { and, eq, inArray, like, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { createDb, type Db } from "./client";
import { databaseUrlFromEnv } from "./env";
import { rebuildInventoryState } from "./rebuild-state";
import {
  auditJob,
  groceryCycle,
  groceryCycleOverride,
  idempotencyKey,
  inventoryEvent,
  inventoryState,
  item,
  labeledObservation,
  preferenceEvent,
  priceQuote,
  product,
  receipt,
  receiptLine,
  reviewItem,
  vendorAlias,
} from "./schema/index";

type Q = Pick<Db, "select" | "update" | "delete">;

/** Rows deleted, in deletion order (children before parents). */
export const RESET_TABLES = [
  "review_item",
  "audit_job",
  "price_quote",
  "preference_event",
  "vendor_alias",
  "inventory_state",
  "inventory_event",
  "receipt_line",
  "receipt",
  "product",
  "item",
  "idempotency_key",
] as const;
export type ResetTable = (typeof RESET_TABLES)[number];

/** Human data that makes the reset refuse. Any non-zero count blocks `--apply`. */
export const BLOCKERS = {
  answered_reviews: "reviews someone confirmed, corrected or dismissed",
  labeled_observations: "labeled observations about imported receipts, items or merge jobs",
  human_inventory_events: "inventory events on imported items not from a digital receipt",
  cycle_overrides: "grocery-cycle overrides naming an imported item or product",
  human_preference_events: "product overrides or rejections on imported items",
  other_receipt_lines: "paper or manual receipt lines naming an imported item or product",
  merges: "item merges between an imported item and another item",
  item_settings: "imported items with an audit hint, shelf life or reorder threshold set",
  items_predating_import: "items a digital receipt matched but did not create",
} as const;
export type Blocker = keyof typeof BLOCKERS;

const HUMAN_REVIEW_STATUSES = ["confirmed", "corrected", "dismissed"] as const;
/** Preference events that only a person's action creates (cart override, "never buy"). */
const HUMAN_PREFERENCE_KINDS = ["override_to_preferred", "override_to_cheaper", "reject"] as const;
/** Inventory event sources the import (or the shelf-life cron acting on it) writes. */
const IMPORT_EVENT_SOURCES = ["digital_receipt", "system"] as const;
const INGEST_KEY_PREFIX = "receipt:";
const INGEST_SCOPE_SUFFIX = ":POST /api/receipts/ingest";

export interface ImportResetPlan {
  counts: Record<ResetTable, number>;
  blockers: Record<Blocker, number>;
  /** Context for the before/after summary; never deleted. */
  info: {
    linesByVendor: Record<string, number>;
    reviewsByKind: Record<string, number>;
    cyclesClosedByImport: number;
  };
}

interface Scope {
  receipts: string[];
  lines: string[];
  items: string[];
  products: string[];
  reviews: string[];
  jobs: string[];
  aliases: string[];
  events: string[];
  preferenceEvents: string[];
  priceQuotes: string[];
  idempotencyKeys: { key: string; scope: string }[];
}

const CHUNK = 400;
function* chunks<T>(xs: readonly T[]): Generator<T[]> {
  for (let i = 0; i < xs.length; i += CHUNK) yield xs.slice(i, i + CHUNK);
}

/** `col IN ids`, OR-ed in chunks (empty `ids` matches nothing). */
const inIds = (c: SQLiteColumn, ids: readonly string[]): SQL =>
  ids.length === 0 ? sql`0` : or(...[...chunks(ids)].map((ch) => inArray(c, ch)))!;

const tally = (xs: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of [...xs].sort()) out[x] = (out[x] ?? 0) + 1;
  return out;
};

async function scope(q: Q): Promise<{ s: Scope; plan: ImportResetPlan }> {
  const receipts = await q
    .select({ id: receipt.id, createdAt: receipt.createdAt, vendor: receipt.vendor })
    .from(receipt)
    .where(eq(receipt.source, "digital"));
  const receiptIds = receipts.map((r) => r.id);
  const receiptById = new Map(receipts.map((r) => [r.id, r]));

  const lines = await q
    .select({
      id: receiptLine.id,
      receiptId: receiptLine.receiptId,
      itemId: receiptLine.itemId,
      productId: receiptLine.productId,
    })
    .from(receiptLine)
    .where(inIds(receiptLine.receiptId, receiptIds));

  // Items the import touched, with the creation stamps of the receipts that touched them: ingest
  // stamps a new item with its receipt's `created_at`, so a matching stamp means "created by it".
  const lineProductIds = [...new Set(lines.flatMap((l) => (l.productId ? [l.productId] : [])))];
  const lineProducts = await q
    .select({ id: product.id, itemId: product.itemId })
    .from(product)
    .where(inIds(product.id, lineProductIds));
  const productItem = new Map(lineProducts.map((p) => [p.id, p.itemId]));
  const stampsByItem = new Map<string, Set<string>>();
  for (const l of lines) {
    const stamp = receiptById.get(l.receiptId)!.createdAt;
    for (const itemId of [l.itemId, l.productId ? productItem.get(l.productId) : undefined]) {
      if (!itemId) continue;
      let set = stampsByItem.get(itemId);
      if (!set) stampsByItem.set(itemId, (set = new Set()));
      set.add(stamp);
    }
  }
  const itemIds = [...stampsByItem.keys()].sort();
  const items = await q.select().from(item).where(inIds(item.id, itemIds));
  const itemSet = new Set(itemIds);

  const products = await q
    .select({ id: product.id })
    .from(product)
    .where(inIds(product.itemId, itemIds));
  const productIds = products.map((p) => p.id);

  const jobs = await q
    .select({ id: auditJob.id })
    .from(auditJob)
    .where(eq(auditJob.jobType, "merge_suggest"));
  const jobIds = jobs.map((j) => j.id);

  const reviews = await q
    .select({
      id: reviewItem.id,
      kind: reviewItem.kind,
      status: reviewItem.status,
      reviewedBy: reviewItem.reviewedByMemberId,
    })
    .from(reviewItem)
    .where(
      or(
        inIds(reviewItem.receiptId, receiptIds),
        inIds(reviewItem.itemId, itemIds),
        inIds(reviewItem.jobId, jobIds),
      ),
    );

  const events = await q
    .select({ id: inventoryEvent.id, source: inventoryEvent.source })
    .from(inventoryEvent)
    .where(inIds(inventoryEvent.itemId, itemIds));

  const prefs = await q
    .select({ id: preferenceEvent.id, kind: preferenceEvent.kind })
    .from(preferenceEvent)
    .where(
      or(
        inIds(preferenceEvent.itemId, itemIds),
        inIds(preferenceEvent.fromProductId, productIds),
        inIds(preferenceEvent.toProductId, productIds),
      ),
    );

  const quotes = await q
    .select({ id: priceQuote.id })
    .from(priceQuote)
    .where(inIds(priceQuote.productId, productIds));

  const aliases = await q
    .select({ id: vendorAlias.id })
    .from(vendorAlias)
    .where(or(inIds(vendorAlias.itemId, itemIds), inIds(vendorAlias.productId, productIds)));

  const states = await q
    .select({ itemId: inventoryState.itemId })
    .from(inventoryState)
    .where(inIds(inventoryState.itemId, itemIds));

  const keys = await q
    .select({ key: idempotencyKey.key, scope: idempotencyKey.scope })
    .from(idempotencyKey)
    .where(
      and(
        like(idempotencyKey.key, `${INGEST_KEY_PREFIX}%`),
        like(idempotencyKey.scope, `%${INGEST_SCOPE_SUFFIX}`),
      ),
    );

  // --- Human data (blockers) ---
  const overrides = await q
    .select({ id: groceryCycleOverride.id })
    .from(groceryCycleOverride)
    .where(
      or(
        inIds(groceryCycleOverride.itemId, itemIds),
        inIds(groceryCycleOverride.productId, productIds),
      ),
    );
  const otherLines = await q
    .select({ id: receiptLine.id })
    .from(receiptLine)
    .innerJoin(receipt, eq(receipt.id, receiptLine.receiptId))
    .where(
      and(
        ne(receipt.source, "digital"),
        or(inIds(receiptLine.itemId, itemIds), inIds(receiptLine.productId, productIds)),
      ),
    );
  const mergedIntoImported = await q
    .select({ id: item.id })
    .from(item)
    .where(
      itemIds.length === 0
        ? sql`0`
        : and(
            inIds(item.mergedIntoItemId, itemIds),
            ...[...chunks(itemIds)].map((ch) => notInArray(item.id, ch)),
          ),
    );
  // Labels are few; match their JSON against every imported id rather than trusting one column.
  const labels = await q.select().from(labeledObservation);
  const importedIds = new Set([...receiptIds, ...lines.map((l) => l.id), ...itemIds]);
  const jobSet = new Set(jobIds);
  const labelBlocks = labels.filter((o) => {
    if (o.sourceKind === "receipt_line" || (o.jobId && jobSet.has(o.jobId))) return true;
    const text = JSON.stringify([o.humanLabel, o.modelOutput]);
    return [...text.matchAll(/[0-9A-HJKMNP-TV-Z]{26}/g)].some((m) => importedIds.has(m[0]));
  });

  const blockers: Record<Blocker, number> = {
    answered_reviews: reviews.filter(
      (r) =>
        r.reviewedBy !== null || (HUMAN_REVIEW_STATUSES as readonly string[]).includes(r.status),
    ).length,
    labeled_observations: labelBlocks.length,
    human_inventory_events: events.filter(
      (e) => !(IMPORT_EVENT_SOURCES as readonly string[]).includes(e.source),
    ).length,
    cycle_overrides: overrides.length,
    human_preference_events: prefs.filter((p) =>
      (HUMAN_PREFERENCE_KINDS as readonly string[]).includes(p.kind),
    ).length,
    other_receipt_lines: otherLines.length,
    merges:
      mergedIntoImported.length +
      items.filter((i) => i.mergedIntoItemId && !itemSet.has(i.mergedIntoItemId)).length,
    item_settings: items.filter(
      (i) => i.auditHint !== null || i.shelfLifeDays !== null || i.reorderThreshold !== null,
    ).length,
    items_predating_import: items.filter((i) => !stampsByItem.get(i.id)!.has(i.createdAt)).length,
  };

  const [closed] = await q
    .select({ n: sql<number>`count(*)` })
    .from(groceryCycle)
    .where(eq(groceryCycle.closeReason, "order_ingested"));

  const s: Scope = {
    receipts: receiptIds,
    lines: lines.map((l) => l.id),
    items: itemIds,
    products: productIds,
    reviews: reviews.map((r) => r.id),
    jobs: jobIds,
    aliases: aliases.map((a) => a.id),
    events: events.map((e) => e.id),
    preferenceEvents: prefs.map((p) => p.id),
    priceQuotes: quotes.map((p) => p.id),
    idempotencyKeys: keys,
  };
  const plan: ImportResetPlan = {
    counts: {
      review_item: s.reviews.length,
      audit_job: s.jobs.length,
      price_quote: s.priceQuotes.length,
      preference_event: s.preferenceEvents.length,
      vendor_alias: s.aliases.length,
      inventory_state: states.length,
      inventory_event: s.events.length,
      receipt_line: s.lines.length,
      receipt: s.receipts.length,
      product: s.products.length,
      item: s.items.length,
      idempotency_key: s.idempotencyKeys.length,
    },
    blockers,
    info: {
      linesByVendor: tally(lines.map((l) => receiptById.get(l.receiptId)!.vendor)),
      reviewsByKind: tally(reviews.map((r) => r.kind)),
      cyclesClosedByImport: Number(closed?.n ?? 0),
    },
  };
  return { s, plan };
}

export const isBlocked = (plan: ImportResetPlan): boolean =>
  Object.values(plan.blockers).some((n) => n > 0);

/** Count what a reset would delete and what would block it. Read-only. */
export async function planImportReset(db: Db): Promise<ImportResetPlan> {
  return (await scope(db)).plan;
}

export class ImportResetBlocked extends Error {
  constructor(readonly plan: ImportResetPlan) {
    const found = Object.entries(plan.blockers)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    super(`refusing to reset: human data found (${found}); nothing was deleted`);
  }
}

/**
 * Delete the digital import in one transaction (re-planned inside it, so the blocker check and the
 * deletes see the same rows), then rebuild `inventory_state`. Throws `ImportResetBlocked`, having
 * deleted nothing, when the plan has blockers.
 */
export async function applyImportReset(db: Db): Promise<ImportResetPlan> {
  const plan = await db.transaction(async (tx) => {
    const { s, plan } = await scope(tx);
    if (isBlocked(plan)) throw new ImportResetBlocked(plan);
    const del = async (table: Parameters<Q["delete"]>[0], c: SQLiteColumn, ids: string[]) => {
      for (const ch of chunks(ids)) await tx.delete(table).where(inArray(c, ch));
    };
    await del(reviewItem, reviewItem.id, s.reviews);
    await del(auditJob, auditJob.id, s.jobs);
    await del(priceQuote, priceQuote.id, s.priceQuotes);
    await del(preferenceEvent, preferenceEvent.id, s.preferenceEvents);
    await del(vendorAlias, vendorAlias.id, s.aliases);
    await del(inventoryState, inventoryState.itemId, s.items);
    await del(inventoryEvent, inventoryEvent.id, s.events);
    await del(receiptLine, receiptLine.id, s.lines);
    await del(receipt, receipt.id, s.receipts);
    await del(product, product.id, s.products);
    // Merges among imported items point inside the set; clear them so delete order can't matter.
    for (const ch of chunks(s.items)) {
      await tx.update(item).set({ mergedIntoItemId: null }).where(inArray(item.id, ch));
    }
    await del(item, item.id, s.items);
    for (const k of s.idempotencyKeys) {
      await tx
        .delete(idempotencyKey)
        .where(and(eq(idempotencyKey.key, k.key), eq(idempotencyKey.scope, k.scope)));
    }
    return plan;
  });
  await rebuildInventoryState(db);
  return plan;
}

/** Plain-text report (counts only — safe for public logs). */
export function formatPlan(plan: ImportResetPlan, applied: boolean): string {
  const verb = applied ? "deleted" : "would delete";
  const out = [`Digital receipt import reset — ${applied ? "APPLIED" : "dry run"}`, ""];
  out.push(`Rows ${verb}:`);
  for (const t of RESET_TABLES) out.push(`  ${t.padEnd(18)} ${plan.counts[t]}`);
  out.push("", "Imported lines by store:");
  const vendors = Object.entries(plan.info.linesByVendor);
  if (vendors.length === 0) out.push("  (none)");
  for (const [v, n] of vendors) out.push(`  ${v.padEnd(18)} ${n}`);
  out.push("", "Reviews by kind:");
  const kinds = Object.entries(plan.info.reviewsByKind);
  if (kinds.length === 0) out.push("  (none)");
  for (const [k, n] of kinds) out.push(`  ${k.padEnd(18)} ${n}`);
  out.push(
    "",
    `Kept: grocery cycles closed by an imported order: ${plan.info.cyclesClosedByImport}`,
    "",
    "Human data (any non-zero refuses the reset):",
  );
  for (const [k, label] of Object.entries(BLOCKERS)) {
    out.push(`  ${k.padEnd(24)} ${plan.blockers[k as Blocker]}  ${label}`);
  }
  out.push(
    "",
    isBlocked(plan)
      ? "BLOCKED: human data found. Nothing deleted; resolve it before resetting."
      : applied
        ? "Done. inventory_state rebuilt."
        : "OK to apply: no human data found.",
  );
  return out.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
  const db = createDb({ url: databaseUrlFromEnv() });
  const report = (plan: ImportResetPlan, applied: boolean) => {
    const text = formatPlan(plan, applied);
    console.log(text);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, `\n\`\`\`\n${text}\n\`\`\`\n`);
  };
  try {
    if (values.apply) {
      report(await applyImportReset(db), true);
    } else {
      const plan = await planImportReset(db);
      report(plan, false);
      if (isBlocked(plan)) process.exitCode = 3;
    }
  } catch (err) {
    if (err instanceof ImportResetBlocked) {
      report(err.plan, false);
      console.error(err.message);
      process.exitCode = 3;
    } else {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  } finally {
    db.$client.close();
  }
}
