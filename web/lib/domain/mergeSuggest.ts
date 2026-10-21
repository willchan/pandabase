// Suggested merges (DESIGN §4.5, §4.6): after a backfill the catalog holds one `unverified` item per
// product. `merge_suggest` jobs ask the local text model which of them are an existing item (or
// each other) under another name; each answer becomes a `merge_suggestion` review that does
// nothing unless a human confirms it.
import { MERGE_SUGGEST_ITEMS, type Config } from "../config";
import { normalizeReceiptText, tokenSetRatio } from "./matching";
import { newReview, type ReviewStatus } from "./review";
import { daysBetween } from "./time";

export interface MergeCatalogItem {
  id: string;
  name: string;
  category: string;
  trust: "confirmed" | "unverified";
  mergedIntoItemId: string | null;
  /** Product titles and receipt texts, most useful first. */
  aliases: readonly string[];
}

/** One `MergeSuggestInput.items` entry (wire shape). */
export interface MergeSuggestItem {
  item_id: string;
  name: string;
  aliases?: string[];
}

export interface MergeSuggestBatch {
  input: { items: MergeSuggestItem[] };
  /** Unverified items in this batch (the ones suggestions are about). */
  candidateIds: string[];
}

/** Auto-created items have no category yet (§4.5), so it is no grouping hint. */
const UNCATEGORIZED = "uncategorized";
const MAX_TEXT = 200;

const byName = (a: MergeCatalogItem, b: MergeCatalogItem) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const knownCategory = (i: MergeCatalogItem): string | null =>
  i.category.trim().toLowerCase() === UNCATEGORIZED || !i.category.trim()
    ? null
    : i.category.trim().toLowerCase();

const toWire = (i: MergeCatalogItem, aliasesPerItem: number): MergeSuggestItem => {
  const name = i.name.trim().slice(0, MAX_TEXT) || i.id;
  const aliases = [
    ...new Set(i.aliases.map((a) => a.trim().slice(0, MAX_TEXT)).filter((a) => a && a !== name)),
  ].slice(0, Math.max(0, aliasesPerItem));
  return aliases.length ? { item_id: i.id, name, aliases } : { item_id: i.id, name };
};

/** The `k` confirmed items whose names are closest to `c` (token-set ratio), best first. */
function nearest(
  c: MergeCatalogItem,
  targets: readonly MergeCatalogItem[],
  k: number,
): MergeCatalogItem[] {
  const names = [c.name, ...c.aliases].map(normalizeReceiptText);
  const cat = knownCategory(c);
  return targets
    .map((t) => {
      const tn = normalizeReceiptText(t.name);
      return {
        t,
        score: Math.max(...names.map((n) => tokenSetRatio(n, tn))),
        same: cat !== null && knownCategory(t) === cat,
      };
    })
    .sort((a, b) => b.score - a.score || Number(b.same) - Number(a.same) || byName(a.t, b.t))
    .slice(0, k)
    .map((x) => x.t);
}

/**
 * The `merge_suggest` jobs to queue: every unverified, unmerged item is a candidate; confirmed
 * items are what they may turn out to be. If everything fits one job (`mergeSuggest.batchSize`,
 * at most `MERGE_SUGGEST_ITEMS.max`), one job gets it all. Otherwise each candidate travels with
 * its `targetsPerItem` closest confirmed items, and candidates are grouped by category (their own
 * if known, else their closest target's) and closest target, so look-alike new items land in the
 * same job. A batch needs two items; a lone item with nothing to compare is left out.
 */
export function planMergeSuggestBatches(
  catalog: readonly MergeCatalogItem[],
  config: Config,
): MergeSuggestBatch[] {
  const { batchSize, targetsPerItem, aliasesPerItem } = config.mergeSuggest;
  const size = Math.min(
    Math.max(Math.floor(batchSize), MERGE_SUGGEST_ITEMS.min),
    MERGE_SUGGEST_ITEMS.max,
  );
  const live = catalog.filter((i) => i.mergedIntoItemId === null);
  const candidates = live.filter((i) => i.trust === "unverified").sort(byName);
  if (candidates.length === 0) return [];
  const targets = live.filter((i) => i.trust === "confirmed").sort(byName);
  const batch = (items: MergeCatalogItem[]): MergeSuggestBatch => ({
    input: { items: items.map((i) => toWire(i, aliasesPerItem)) },
    candidateIds: items.filter((i) => i.trust === "unverified").map((i) => i.id),
  });

  if (candidates.length + targets.length <= size) {
    const all = [...candidates, ...targets];
    return all.length >= MERGE_SUGGEST_ITEMS.min ? [batch(all)] : [];
  }

  const k = Math.min(Math.max(0, Math.floor(targetsPerItem)), size - 1);
  const ranked = candidates
    .map((c) => {
      const near = nearest(c, targets, k);
      const group = knownCategory(c) ?? (near[0] ? knownCategory(near[0]) : null) ?? "~";
      return { c, near, key: [group, near[0]?.name ?? "~", c.name, c.id] };
    })
    .sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) {
        const d = a.key[i]!.localeCompare(b.key[i]!);
        if (d) return d;
      }
      return 0;
    });

  const out: MergeSuggestBatch[] = [];
  let current = new Map<string, MergeCatalogItem>();
  const flush = () => {
    if (current.size >= MERGE_SUGGEST_ITEMS.min) out.push(batch([...current.values()]));
    current = new Map();
  };
  const missing = (rows: readonly MergeCatalogItem[]) =>
    new Set(rows.filter((i) => !current.has(i.id)).map((i) => i.id)).size;
  // Pack whole groups when they fit (starting a fresh job if needed); split only a group that is
  // bigger than a job, in closest-target order.
  for (const group of groupBy(ranked, (r) => r.key[0]!)) {
    const all = group.flatMap((r) => [r.c, ...r.near]);
    if (current.size + missing(all) > size && new Set(all.map((i) => i.id)).size <= size) flush();
    for (const { c, near } of group) {
      if (current.size + missing([c, ...near]) > size) flush();
      for (const i of [c, ...near]) current.set(i.id, i);
    }
  }
  flush();
  return out;
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return [...groups.values()];
}

export type ScheduleDecision =
  { run: true } | { run: false; reason: "already_queued" | "too_soon" | "too_few_new_items" };

/**
 * The daily cron's gate (§4.6 cadence): queue a run at most every `cadenceDays`, only when at least
 * `minNewItems` unverified items arrived since the last run (ever, if there was none), and never
 * while a merge_suggest job is still queued or running.
 */
export function scheduledMergeSuggestRun(
  input: { lastRunAt: string | null; newUnverifiedItems: number; openJobs: number; now: string },
  config: Config,
): ScheduleDecision {
  const { cadenceDays, minNewItems } = config.mergeSuggest;
  if (input.openJobs > 0) return { run: false, reason: "already_queued" };
  if (input.lastRunAt !== null && daysBetween(input.lastRunAt, input.now) < cadenceDays) {
    return { run: false, reason: "too_soon" };
  }
  if (input.newUnverifiedItems < Math.max(1, minNewItems)) {
    return { run: false, reason: "too_few_new_items" };
  }
  return { run: true };
}

export interface MergeSuggestion {
  item_id: string;
  merge_into_item_id: string;
  confidence: number;
  reason?: string | null;
}

export interface ExistingSuggestion {
  itemId: string | null;
  mergeIntoItemId: string | null;
  status: ReviewStatus;
}

export type DropReason =
  "self" | "unknown" | "merged" | "both_confirmed" | "low_confidence" | "duplicate";

export interface SuggestionReviews {
  reviews: (ReturnType<typeof newReview> & {
    itemId: string;
    payload: { merge_into_item_id: string; confidence: number; reason: string | null };
  })[];
  dropped: Record<DropReason, number>;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * A completed job's suggestions → `merge_suggestion` review rows (30-day expiry, default: do
 * nothing). Dropped: a pair naming an unknown item or one item twice, a source that was merged
 * meanwhile (a merged target is followed to the item it went into), two confirmed items (a human
 * already said they're different), confidence under `minConfidence`, and any pair (either way
 * round) that already has a pending or dismissed suggestion, or appeared earlier in this result.
 * The unverified side is the one merged away, and each item gets at most one suggestion (the most
 * confident).
 */
export function mergeSuggestionReviews(
  input: {
    suggestions: readonly MergeSuggestion[];
    items: ReadonlyMap<
      string,
      { trust: "confirmed" | "unverified"; mergedIntoItemId: string | null }
    >;
    existing: readonly ExistingSuggestion[];
    now: string;
  },
  config: Config,
): SuggestionReviews {
  const dropped: Record<DropReason, number> = {
    self: 0,
    unknown: 0,
    merged: 0,
    both_confirmed: 0,
    low_confidence: 0,
    duplicate: 0,
  };
  const root = (id: string): string | null => {
    const seen = new Set<string>();
    let cur = id;
    for (;;) {
      const it = input.items.get(cur);
      if (!it || seen.has(cur)) return null;
      if (it.mergedIntoItemId === null) return cur;
      seen.add(cur);
      cur = it.mergedIntoItemId;
    }
  };
  const taken = new Set(
    input.existing
      .filter(
        (e) =>
          (e.status === "pending" || e.status === "dismissed") && e.itemId && e.mergeIntoItemId,
      )
      .map((e) => pairKey(e.itemId!, e.mergeIntoItemId!)),
  );
  const sourced = new Set<string>();
  const reviews: SuggestionReviews["reviews"] = [];
  const ordered = [...input.suggestions].sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.item_id.localeCompare(b.item_id) ||
      a.merge_into_item_id.localeCompare(b.merge_into_item_id),
  );
  for (const s of ordered) {
    if (s.item_id === s.merge_into_item_id) {
      dropped.self++;
      continue;
    }
    const src = input.items.get(s.item_id);
    const dst = input.items.get(s.merge_into_item_id);
    if (!src || !dst) {
      dropped.unknown++;
      continue;
    }
    const into = root(s.merge_into_item_id);
    if (src.mergedIntoItemId !== null || into === null) {
      dropped.merged++;
      continue;
    }
    if (into === s.item_id) {
      dropped.self++;
      continue;
    }
    const target = input.items.get(into)!;
    if (src.trust === "confirmed" && target.trust === "confirmed") {
      dropped.both_confirmed++;
      continue;
    }
    if (s.confidence < config.mergeSuggest.minConfidence) {
      dropped.low_confidence++;
      continue;
    }
    // Keep the confirmed item; the unverified one folds into it.
    const [from, to] = src.trust === "confirmed" ? [into, s.item_id] : [s.item_id, into];
    const key = pairKey(from, to);
    if (taken.has(key) || sourced.has(from)) {
      dropped.duplicate++;
      continue;
    }
    taken.add(key);
    sourced.add(from);
    reviews.push({
      ...newReview(
        "merge_suggestion",
        input.now,
        { inCartPlan: false, inPleaseCheck: false },
        config,
      ),
      itemId: from,
      payload: {
        merge_into_item_id: to,
        confidence: Math.min(Math.max(s.confidence, 0), 1),
        reason: s.reason?.trim() || null,
      },
    });
  }
  return { reviews, dropped };
}
