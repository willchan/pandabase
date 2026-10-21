// Media jobs (DESIGN §5): create, lease (claim), complete/fail with retries, apply results,
// Discord notifications.
import { auditJob, inventoryEvent, receipt, reviewItem, type Db } from "@pandabase/db";
import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { z } from "zod";
import {
  MergeSuggestInput,
  MergeSuggestResult,
  PaperReceiptResult,
  TrashCamResult,
  type ClaimedJob,
  type JobCompleteRequest,
  type JobCompleteResponse,
  type JobCreateRequest,
  type JobNotification,
  type JobT,
  type UploadUrlRequest,
  type UploadUrlResponse,
} from "../contracts";
import {
  failureOutcome,
  isLeaseExpired,
  leaseExpiresAt,
  paperReceiptInput,
  resolveTrashCam,
} from "../domain/jobs";
import { newReview } from "../domain/review";
import { addDaysToInstant } from "../domain/time";
import { badRequest, conflict, notFound } from "../http";
import { keyframeKey, mediaKey, type Presigner } from "../r2";
import { canonicalItems, getItem } from "../repo/catalog";
import { getCycle } from "../repo/cycles";
import { asRecord, type Q } from "../repo/db";
import { refreshInventoryState } from "../repo/inventory";
import { emitTelemetry } from "../telemetry";
import { applyMergeSuggestions } from "./mergeSuggest";
import { ingestReceiptIn, newId } from "./receipts";
import type { ServiceCtx } from "./types";

export type JobRow = typeof auditJob.$inferSelect;

export const toJob = (j: JobRow): JobT => ({
  id: j.id,
  job_type: j.jobType,
  status: j.status,
  media_r2_key: j.mediaR2Key,
  attempts: j.attempts,
  error: j.error,
  cycle_id: j.cycleId,
  discord_channel_id: j.discordChannelId,
  discord_message_id: j.discordMessageId,
  created_at: j.createdAt,
  completed_at: j.completedAt,
  notified_at: j.notifiedAt,
});

async function getJob(q: Q, id: string): Promise<JobRow> {
  const [j] = await q.select().from(auditJob).where(eq(auditJob.id, id));
  if (!j) throw notFound(`job ${id}`);
  return j;
}

const NO_IMPACT = { inCartPlan: false, inPleaseCheck: false };

/** R2 presigned PUT for a new media object (§5 step 2). */
export async function createUploadUrl(
  r2: Presigner,
  input: z.infer<typeof UploadUrlRequest>,
  ctx: Pick<ServiceCtx, "now" | "config">,
): Promise<z.input<typeof UploadUrlResponse>> {
  const key = mediaKey(ctx.now, newId(), input.ext === "jpeg" ? "jpg" : input.ext);
  const expiresIn = ctx.config.jobs.presignSeconds;
  return {
    key,
    url: await r2.presign("PUT", key, expiresIn),
    method: "PUT",
    headers: { "content-type": input.content_type },
    expires_at: addDaysToInstant(ctx.now, expiresIn / 86_400),
  };
}

export async function createJob(
  db: Db,
  input: z.infer<typeof JobCreateRequest>,
  ctx: ServiceCtx,
): Promise<JobT> {
  if (input.job_type !== "merge_suggest" && !input.media_r2_key) {
    throw badRequest(`${input.job_type} needs media_r2_key`);
  }
  if (input.job_type === "merge_suggest") {
    const parsed = MergeSuggestInput.safeParse(input.input);
    if (!parsed.success) {
      throw badRequest(
        "merge_suggest input must be a MergeSuggestInput",
        parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
  }
  if (input.cycle_id) await getCycle(db, input.cycle_id);
  const row = {
    id: newId(),
    createdAt: ctx.now,
    updatedAt: ctx.now,
    jobType: input.job_type,
    status: "queued" as const,
    mediaR2Key: input.media_r2_key ?? null,
    input: input.input ?? null,
    actorMemberId: ctx.actor.memberId,
    cycleId: input.cycle_id ?? null,
    discordChannelId: input.discord_channel_id ?? null,
    discordMessageId: input.discord_message_id ?? null,
  };
  await db.insert(auditJob).values(row);
  await emitTelemetry(
    db,
    "state_engine",
    [{ metric: "job_created", jobId: row.id, jobType: row.jobType }],
    ctx.now,
  );
  return toJob(await getJob(db, row.id));
}

/** Fail a job for good: status `failed` + a `failed_job` review (§5 step 4, §4.6). */
async function failJob(q: Q, j: JobRow, error: string, ctx: Pick<ServiceCtx, "now" | "config">) {
  await q
    .update(auditJob)
    .set({
      status: "failed",
      error,
      completedAt: ctx.now,
      leaseExpiresAt: null,
      updatedAt: ctx.now,
    })
    .where(eq(auditJob.id, j.id));
  const id = newId();
  await q.insert(reviewItem).values({
    ...newReview("failed_job", ctx.now, NO_IMPACT, ctx.config),
    id,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    jobId: j.id,
    itemId: null,
    payload: { error, job_type: j.jobType, attempts: j.attempts },
  });
  return id;
}

/**
 * Expired leases go back to `queued`; a job whose lease expired on its last attempt fails
 * (otherwise a crashing job would be re-leased forever).
 */
export async function releaseExpiredLeases(
  q: Q,
  ctx: Pick<ServiceCtx, "now" | "config">,
): Promise<{ released: number; failed: number }> {
  const claimed = await q
    .select()
    .from(auditJob)
    .where(and(eq(auditJob.status, "claimed"), lte(auditJob.leaseExpiresAt, ctx.now)));
  let released = 0;
  let failed = 0;
  for (const j of claimed.filter((x) => isLeaseExpired(x, ctx.now))) {
    if (failureOutcome(j.attempts, ctx.config) === "failed") {
      await failJob(q, j, j.error ?? "lease expired on the last attempt", ctx);
      failed++;
    } else {
      await q
        .update(auditJob)
        .set({ status: "queued", claimedAt: null, leaseExpiresAt: null, updatedAt: ctx.now })
        .where(eq(auditJob.id, j.id));
      released++;
    }
    await emitTelemetry(
      q,
      "state_engine",
      [{ metric: "job_lease_expired", jobId: j.id, jobType: j.jobType, attempts: j.attempts }],
      ctx.now,
    );
  }
  return { released, failed };
}

/** Lease the oldest queued job (5 min, `attempts += 1`) with presigned URLs; null if none. */
export async function claimJob(
  db: Db,
  r2: Presigner,
  jobTypes: readonly string[] | undefined,
  ctx: Pick<ServiceCtx, "now" | "config">,
): Promise<z.input<typeof ClaimedJob> | null> {
  const claimed = await db.transaction(async (tx) => {
    await releaseExpiredLeases(tx, ctx);
    const queued = await tx
      .select()
      .from(auditJob)
      .where(eq(auditJob.status, "queued"))
      .orderBy(asc(auditJob.createdAt), asc(auditJob.id));
    const next = queued.find(
      (j) => j.jobType !== "storage_audit" && (!jobTypes || jobTypes.includes(j.jobType)),
    );
    if (!next) return null;
    const lease = leaseExpiresAt(ctx.now, ctx.config);
    await tx
      .update(auditJob)
      .set({
        status: "claimed",
        attempts: next.attempts + 1,
        claimedAt: ctx.now,
        leaseExpiresAt: lease,
        updatedAt: ctx.now,
      })
      .where(and(eq(auditJob.id, next.id), eq(auditJob.status, "queued")));
    return { ...next, attempts: next.attempts + 1, leaseExpiresAt: lease };
  });
  if (!claimed) return null;
  const ttl = ctx.config.jobs.presignSeconds;
  const keyframes = Array.from({ length: ctx.config.jobs.maxKeyframes }, (_, n) =>
    keyframeKey(claimed.id, n),
  );
  return {
    id: claimed.id,
    job_type: claimed.jobType as z.input<typeof ClaimedJob>["job_type"],
    attempt: claimed.attempts,
    lease_expires_at: claimed.leaseExpiresAt,
    media_r2_key: claimed.mediaR2Key,
    media_url: claimed.mediaR2Key ? await r2.presign("GET", claimed.mediaR2Key, ttl) : null,
    input: claimed.input === null ? null : asRecord(claimed.input),
    expected_state_snapshot: claimed.expectedStateSnapshot ?? null,
    keyframe_uploads: await Promise.all(
      keyframes.map(async (key) => ({ key, url: await r2.presign("PUT", key, ttl) })),
    ),
  };
}

/**
 * Finish the current attempt of a claimed job. A stale attempt (the lease expired and the job
 * was re-claimed, or it already finished) is a 409. Failures retry until `jobs.maxAttempts`.
 */
export async function completeJob(
  db: Db,
  input: z.infer<typeof JobCompleteRequest>,
  ctx: ServiceCtx,
): Promise<z.input<typeof JobCompleteResponse>> {
  return db.transaction(async (tx) => {
    const j = await getJob(tx, input.job_id);
    if (j.status !== "claimed" || j.attempts !== input.attempt) {
      throw conflict(`job ${j.id} attempt ${input.attempt} is not the current lease`, {
        status: j.status,
        attempts: j.attempts,
      });
    }
    const meta = {
      model: input.model ?? null,
      promptVersion: input.prompt_version ?? null,
      rawModelResponse: input.raw_model_response ?? null,
      keyframeR2Keys: input.keyframe_r2_keys ?? j.keyframeR2Keys ?? null,
      updatedAt: ctx.now,
    };
    await tx.update(auditJob).set(meta).where(eq(auditJob.id, j.id));
    const telemetry = (outcome: string, extra: Record<string, unknown> = {}) =>
      emitTelemetry(
        tx,
        "state_engine",
        [
          {
            metric: "job_finished",
            jobId: j.id,
            jobType: j.jobType,
            outcome,
            attempts: j.attempts,
            model: meta.model,
            promptVersion: meta.promptVersion,
            ...extra,
          },
        ],
        ctx.now,
      );

    let failure: string | null = input.status === "failed" ? (input.error ?? "failed") : null;
    let applied: Applied | null = null;
    if (!failure) {
      try {
        applied = await applyResult(tx, j, input.result ?? {}, ctx);
      } catch (err) {
        if (!(err instanceof InvalidResult)) throw err;
        failure = err.message;
      }
    }

    if (failure !== null) {
      if (failureOutcome(j.attempts, ctx.config) === "retry") {
        await tx
          .update(auditJob)
          .set({ status: "queued", error: failure, claimedAt: null, leaseExpiresAt: null })
          .where(eq(auditJob.id, j.id));
        await telemetry("retry", { error: failure });
        return {
          job: toJob(await getJob(tx, j.id)),
          outcome: "retry",
          receipt_id: null,
          review_ids: [],
        };
      }
      const reviewId = await failJob(tx, { ...j, ...meta }, failure, ctx);
      await telemetry("failed", { error: failure });
      return {
        job: toJob(await getJob(tx, j.id)),
        outcome: "failed",
        receipt_id: null,
        review_ids: [reviewId],
      };
    }

    await tx
      .update(auditJob)
      .set({
        status: "completed",
        result: input.result ?? null,
        error: null,
        completedAt: ctx.now,
        leaseExpiresAt: null,
      })
      .where(eq(auditJob.id, j.id));
    await telemetry(applied!.outcome, applied!.telemetry);
    return {
      job: toJob(await getJob(tx, j.id)),
      outcome: applied!.outcome,
      receipt_id: applied!.receiptId,
      review_ids: applied!.reviewIds,
    };
  });
}

class InvalidResult extends Error {}

interface Applied {
  outcome: "applied" | "review";
  receiptId: string | null;
  reviewIds: string[];
  telemetry: Record<string, unknown>;
}

function parseResult<T extends z.ZodType>(schema: T, result: unknown): z.output<T> {
  const r = schema.safeParse(result);
  if (!r.success) {
    throw new InvalidResult(
      `invalid result: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  return r.data;
}

/** §5 step 5: apply a job's result. */
async function applyResult(
  tx: Q,
  j: JobRow,
  result: Record<string, unknown>,
  ctx: ServiceCtx,
): Promise<Applied> {
  const actor = { memberId: j.actorMemberId, system: "worker" as const };
  switch (j.jobType) {
    case "paper_receipt": {
      const r = parseResult(PaperReceiptResult, result);
      const input = paperReceiptInput(
        {
          store: r.store,
          date: r.date,
          lines: r.lines.map((l) => ({
            rawText: l.raw_text,
            qty: l.qty,
            unitPriceCents: l.unit_price_cents,
            lineTotalCents: l.line_total_cents,
          })),
          subtotalCents: r.subtotal_cents,
          totalCents: r.total_cents,
        },
        ctx.config.householdTz,
      );
      const res = await ingestReceiptIn(tx, { ...input, jobId: j.id }, { ...ctx, actor });
      return {
        outcome: res.status === "applied" ? "applied" : "review",
        receiptId: res.receipt_id,
        reviewIds: res.review_ids,
        telemetry: {
          receiptId: res.receipt_id,
          duplicate: res.duplicate,
          workerTotalsCheck: r.totals_check,
          lines: res.lines.length,
          pendingLines: res.lines.filter((l) => l.pending).length,
        },
      };
    }
    case "trash_cam": {
      const r = parseResult(TrashCamResult, result);
      const out = resolveTrashCam(r.detections, await canonicalItems(tx), ctx.config);
      const telemetry = {
        action: out.action,
        confidence: out.detection?.confidence ?? null,
        score: out.score,
      };
      if (out.action === "consume") {
        const it = await getItem(tx, out.itemId);
        await tx.insert(inventoryEvent).values({
          id: newId(),
          createdAt: ctx.now,
          updatedAt: ctx.now,
          itemId: it.id,
          location: it.defaultLocation,
          kind: "consumed",
          quantity: 0,
          statusOverride: "consumed",
          occurredAt: j.createdAt,
          source: "trash_cam",
          sourceRef: j.id,
          actorMemberId: actor.memberId,
          actorSystem: "worker",
          trust: "provisional",
        });
        await refreshInventoryState(tx, [it.id], ctx.now, ctx.config);
        return { outcome: "applied", receiptId: null, reviewIds: [], telemetry };
      }
      const id = newId();
      await tx.insert(reviewItem).values({
        ...newReview("trash_cam", ctx.now, NO_IMPACT, ctx.config),
        id,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        jobId: j.id,
        itemId: out.itemId,
        payload: {
          detected_name: out.detection?.name ?? null,
          confidence: out.detection?.confidence ?? null,
          match_score: out.score,
          suggestions: out.itemId ? [out.itemId] : [],
        },
      });
      return { outcome: "review", receiptId: null, reviewIds: [id], telemetry };
    }
    case "merge_suggest": {
      const r = parseResult(MergeSuggestResult, result);
      const { reviewIds, telemetry } = await applyMergeSuggestions(tx, j.id, r, ctx);
      return {
        outcome: reviewIds.length ? "review" : "applied",
        receiptId: null,
        reviewIds,
        telemetry,
      };
    }
    default:
      throw new InvalidResult(`unsupported job type ${j.jobType}`);
  }
}

/** Completed/failed jobs from Discord not yet replied to, oldest first, with a one-line reply. */
export async function jobNotifications(q: Q): Promise<z.input<typeof JobNotification>[]> {
  const jobs = await q
    .select()
    .from(auditJob)
    .where(
      and(
        inArray(auditJob.status, ["completed", "failed"]),
        isNull(auditJob.notifiedAt),
        isNotNull(auditJob.discordMessageId),
      ),
    )
    .orderBy(asc(auditJob.completedAt), asc(auditJob.id));
  const out: z.input<typeof JobNotification>[] = [];
  for (const j of jobs) {
    const [r] = await q.select().from(receipt).where(eq(receipt.jobId, j.id));
    const reviews = await q
      .select({ id: reviewItem.id })
      .from(reviewItem)
      .where(eq(reviewItem.jobId, j.id))
      .orderBy(asc(reviewItem.id));
    const [consumed] = await q
      .select({ itemId: inventoryEvent.itemId })
      .from(inventoryEvent)
      .where(eq(inventoryEvent.sourceRef, j.id));
    out.push({
      job: toJob(j),
      summary: await summary(q, j, r ?? null, reviews.length, consumed?.itemId ?? null),
      receipt_id: r?.id ?? null,
      review_ids: reviews.map((x) => x.id),
    });
  }
  return out;
}

async function summary(
  q: Q,
  j: JobRow,
  r: typeof receipt.$inferSelect | null,
  reviews: number,
  consumedItemId: string | null,
): Promise<string> {
  if (j.status === "failed") return `⚠️ Couldn't process this (${j.error ?? "unknown error"}).`;
  if (j.jobType === "paper_receipt" && r) {
    const status = {
      applied: "✅ Receipt applied",
      partial: "✅ Receipt applied; some lines need a look in Cleanup",
      pending_review: "❓ Couldn't match this receipt's lines — waiting in Cleanup",
    }[r.status];
    return `${status} (${r.vendor}).`;
  }
  if (j.jobType === "trash_cam") {
    if (consumedItemId) {
      return `✅ Marked ${(await getItem(q, consumedItemId)).canonicalName} as finished.`;
    }
    return "❓ Not sure what that was — it's in Cleanup.";
  }
  return reviews ? `❓ ${reviews} suggestion(s) waiting in Cleanup.` : "✅ Done.";
}

export async function markNotified(
  db: Db,
  id: string,
  ctx: Pick<ServiceCtx, "now">,
): Promise<JobT> {
  const j = await getJob(db, id);
  if (j.status !== "completed" && j.status !== "failed") throw conflict(`job ${id} is ${j.status}`);
  if (!j.notifiedAt) {
    await db
      .update(auditJob)
      .set({ notifiedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(auditJob.id, id));
  }
  return toJob(await getJob(db, id));
}
