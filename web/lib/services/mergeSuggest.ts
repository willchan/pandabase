// Suggested merges (DESIGN §4.5, §4.6): queue `merge_suggest` jobs over the unverified catalog — at
// the end of a receipt backfill (`POST /api/catalog/merge-suggestions/run`) or from the daily cron
// — and turn a completed job's suggestions into `merge_suggestion` reviews.
import { auditJob, item, product, reviewItem, vendorAlias, type Db } from "@pandabase/db";
import { and, asc, eq, gt, inArray, isNull, max, sql } from "drizzle-orm";
import type { z } from "zod";
import type { JobT, MergeSuggestResult, MergeSuggestRunResponse } from "../contracts";
import {
  mergeSuggestionReviews,
  planMergeSuggestBatches,
  scheduledMergeSuggestRun,
  type MergeCatalogItem,
  type ScheduleDecision,
} from "../domain/mergeSuggest";
import { asRecord, type Q } from "../repo/db";
import { emitTelemetry } from "../telemetry";
import { toJob } from "./jobs";
import { newId } from "./receipts";
import type { ServiceCtx } from "./types";

export type MergeSuggestTrigger = "backfill" | "cron";

const OPEN = ["queued", "claimed"] as const;

/** Unmerged catalog items with their product titles and receipt texts as aliases. */
async function mergeCatalog(q: Q): Promise<MergeCatalogItem[]> {
  const items = await q
    .select()
    .from(item)
    .where(isNull(item.mergedIntoItemId))
    .orderBy(asc(item.id));
  const titles = await q
    .select({ itemId: product.itemId, text: product.title })
    .from(product)
    .orderBy(asc(product.id));
  const texts = await q
    .select({ itemId: vendorAlias.itemId, text: vendorAlias.vendorString })
    .from(vendorAlias)
    .where(and(eq(vendorAlias.kind, "receipt_text"), eq(vendorAlias.ignored, false)))
    .orderBy(asc(vendorAlias.id));
  const aliases = new Map<string, string[]>();
  for (const a of [...titles, ...texts]) {
    if (a.itemId) aliases.set(a.itemId, [...(aliases.get(a.itemId) ?? []), a.text]);
  }
  return items.map((i) => ({
    id: i.id,
    name: i.canonicalName,
    category: i.category,
    trust: i.trust,
    mergedIntoItemId: i.mergedIntoItemId,
    aliases: aliases.get(i.id) ?? [],
  }));
}

const openJobs = (q: Q) =>
  q
    .select()
    .from(auditJob)
    .where(and(eq(auditJob.jobType, "merge_suggest"), inArray(auditJob.status, OPEN)))
    .orderBy(asc(auditJob.createdAt), asc(auditJob.id));

/**
 * Queue merge_suggest jobs for every unverified item (§4.5). Idempotent: while one is still queued
 * or running, nothing new is queued and the waiting jobs are returned.
 */
export async function requestMergeSuggestions(
  db: Db,
  trigger: MergeSuggestTrigger,
  ctx: ServiceCtx,
): Promise<z.input<typeof MergeSuggestRunResponse>> {
  return db.transaction(async (tx) => {
    const waiting = await openJobs(tx);
    const catalog = await mergeCatalog(tx);
    const candidates = catalog.filter((i) => i.trust === "unverified").length;
    if (waiting.length > 0) {
      return { jobs: waiting.map(toJob), created: false, skipped: "already_queued", candidates };
    }
    const batches = planMergeSuggestBatches(catalog, ctx.config);
    if (batches.length === 0) {
      return { jobs: [], created: false, skipped: "no_candidates", candidates };
    }
    const rows = batches.map((b) => ({
      id: newId(),
      createdAt: ctx.now,
      updatedAt: ctx.now,
      jobType: "merge_suggest" as const,
      status: "queued" as const,
      input: b.input,
      actorMemberId: ctx.actor.memberId,
    }));
    await tx.insert(auditJob).values(rows);
    await emitTelemetry(
      tx,
      "state_engine",
      [
        ...rows.map((r) => ({ metric: "job_created", jobId: r.id, jobType: r.jobType })),
        {
          metric: "merge_suggest_requested",
          trigger,
          jobIds: rows.map((r) => r.id),
          candidates,
          items: batches.reduce((n, b) => n + b.input.items.length, 0),
        },
      ],
      ctx.now,
    );
    const jobs = await tx
      .select()
      .from(auditJob)
      .where(
        inArray(
          auditJob.id,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(auditJob.id));
    return { jobs: jobs.map(toJob), created: true, skipped: null, candidates };
  });
}

/**
 * The daily cron's run (§4.6): at most every `mergeSuggest.cadenceDays`, when at least
 * `mergeSuggest.minNewItems` unverified items arrived since the last merge_suggest job.
 */
export async function scheduledMergeSuggestions(
  db: Db,
  ctx: Pick<ServiceCtx, "now" | "config">,
): Promise<{ decision: ScheduleDecision; jobs: JobT[] }> {
  const [last] = await db
    .select({ at: max(auditJob.createdAt) })
    .from(auditJob)
    .where(eq(auditJob.jobType, "merge_suggest"));
  const lastRunAt = last?.at ?? null;
  const [fresh] = await db
    .select({ n: sql<number>`count(*)` })
    .from(item)
    .where(
      and(
        eq(item.trust, "unverified"),
        isNull(item.mergedIntoItemId),
        lastRunAt ? gt(item.createdAt, lastRunAt) : undefined,
      ),
    );
  const decision = scheduledMergeSuggestRun(
    {
      lastRunAt,
      newUnverifiedItems: Number(fresh?.n ?? 0),
      openJobs: (await openJobs(db)).length,
      now: ctx.now,
    },
    ctx.config,
  );
  if (!decision.run) return { decision, jobs: [] };
  const res = await requestMergeSuggestions(db, "cron", {
    ...ctx,
    actor: { memberId: null, system: "cron" },
  });
  return { decision, jobs: res.created ? res.jobs : [] };
}

/** §5 step 5: a completed merge_suggest job → `merge_suggestion` reviews (deduped, never stale). */
export async function applyMergeSuggestions(
  tx: Q,
  jobId: string,
  result: z.output<typeof MergeSuggestResult>,
  ctx: Pick<ServiceCtx, "now" | "config">,
): Promise<{ reviewIds: string[]; telemetry: Record<string, unknown> }> {
  const ids = [...new Set(result.suggestions.flatMap((s) => [s.item_id, s.merge_into_item_id]))];
  // Merged targets are followed, so load the whole (small) catalog rather than just these ids.
  const items = new Map(
    (
      await tx
        .select({ id: item.id, trust: item.trust, mergedIntoItemId: item.mergedIntoItemId })
        .from(item)
    ).map((i) => [i.id, i]),
  );
  const existing = (
    await tx
      .select()
      .from(reviewItem)
      .where(
        and(
          eq(reviewItem.kind, "merge_suggestion"),
          inArray(reviewItem.status, ["pending", "dismissed"]),
        ),
      )
  ).map((r) => {
    const into = asRecord(r.payload).merge_into_item_id;
    return {
      itemId: r.itemId,
      mergeIntoItemId: typeof into === "string" ? into : null,
      status: r.status,
    };
  });
  const out = mergeSuggestionReviews(
    { suggestions: result.suggestions, items, existing, now: ctx.now },
    ctx.config,
  );
  const rows = out.reviews.map((r) => ({
    ...r,
    id: newId(),
    createdAt: ctx.now,
    updatedAt: ctx.now,
    jobId,
  }));
  if (rows.length > 0) await tx.insert(reviewItem).values(rows);
  const telemetry = {
    suggestions: result.suggestions.length,
    created: rows.length,
    ...out.dropped,
  };
  await emitTelemetry(
    tx,
    "state_engine",
    [{ metric: "merge_suggestions_created", jobId, items: ids.length, ...telemetry }],
    ctx.now,
  );
  return { reviewIds: rows.map((r) => r.id), telemetry };
}
