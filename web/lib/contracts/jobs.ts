// Media upload, audit jobs, worker leases and results (DESIGN §3.2, §5).
import { z } from "zod";
import { MERGE_SUGGEST_ITEMS } from "../config";
import { ActorDiscordId, Cents, Id, LocalDate, Timestamp } from "./common";
import { named } from "./registry";

export const UploadUrlRequest = named(
  "UploadUrlRequest",
  z.object({
    content_type: z.string().regex(/^(image|video)\/[\w.+-]+$/),
    ext: z.enum(["jpg", "jpeg", "png", "webp", "heic", "mp4", "mov"]),
  }),
);
export const UploadUrlResponse = named(
  "UploadUrlResponse",
  z.object({
    key: z.string(),
    url: z.url(),
    method: z.literal("PUT"),
    /** Send these headers with the PUT. */
    headers: z.record(z.string(), z.string()),
    expires_at: Timestamp,
  }),
);

export const JobType = named("JobType", z.enum(["paper_receipt", "trash_cam", "merge_suggest"]));
export const JobStatus = named("JobStatus", z.enum(["queued", "claimed", "completed", "failed"]));

export const JobCreateRequest = named(
  "JobCreateRequest",
  z.object({
    actor_discord_id: ActorDiscordId,
    job_type: JobType,
    media_r2_key: z.string().max(200).nullable().optional(),
    discord_channel_id: z.string().max(32).nullable().optional(),
    discord_message_id: z.string().max(32).nullable().optional(),
    cycle_id: Id.nullable().optional(),
    input: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
);
export const Job = named(
  "Job",
  z.object({
    id: Id,
    job_type: z.enum(["paper_receipt", "trash_cam", "merge_suggest", "storage_audit"]),
    status: JobStatus,
    media_r2_key: z.string().nullable(),
    attempts: z.number().int(),
    error: z.string().nullable(),
    cycle_id: Id.nullable(),
    discord_channel_id: z.string().nullable(),
    discord_message_id: z.string().nullable(),
    created_at: Timestamp,
    completed_at: Timestamp.nullable(),
    notified_at: Timestamp.nullable(),
  }),
);
export const JobResponse = named("JobResponse", z.object({ job: Job }));

export const JobClaimRequest = named(
  "JobClaimRequest",
  z.object({ job_types: z.array(JobType).optional() }),
);
export const ClaimedJob = named(
  "ClaimedJob",
  z.object({
    id: Id,
    job_type: JobType,
    /** Echo it in `/api/jobs/complete`; a stale attempt (lease expired, re-claimed) is rejected. */
    attempt: z.number().int(),
    lease_expires_at: Timestamp,
    media_r2_key: z.string().nullable(),
    /** Presigned GET for the media. */
    media_url: z.url().nullable(),
    input: z.record(z.string(), z.unknown()).nullable(),
    expected_state_snapshot: z.unknown().nullable(),
    /** Presigned PUTs for `keyframes/{job_id}/{n}.jpg`. */
    keyframe_uploads: z.array(z.object({ key: z.string(), url: z.url() })),
  }),
);
export const JobClaimResponse = named("JobClaimResponse", z.object({ job: ClaimedJob.nullable() }));

export const PaperReceiptResult = named(
  "PaperReceiptResult",
  z.object({
    store: z.string().min(1),
    date: LocalDate,
    lines: z
      .array(
        z.object({
          raw_text: z.string().min(1),
          qty: z.number().positive().nullable(),
          unit_price_cents: Cents.nullable(),
          line_total_cents: Cents.nullable(),
        }),
      )
      .max(300),
    subtotal_cents: Cents.nullable(),
    tax_cents: Cents.nullable(),
    total_cents: Cents.nullable(),
    /** Worker's check: |Σ line_total − subtotal| ≤ 2¢. */
    totals_check: z.enum(["pass", "fail", "n/a"]),
  }),
  "`result` of a completed paper_receipt job (transcription only).",
);
export const TrashCamResult = named(
  "TrashCamResult",
  z.object({
    detections: z.array(
      z.object({
        name: z.string().min(1),
        confidence: z.number().min(0).max(1),
        bbox: z.array(z.number()).length(4).nullable().optional(),
      }),
    ),
  }),
  "`result` of a completed trash_cam job.",
);
export const MergeSuggestItem = named(
  "MergeSuggestItem",
  z.object({
    item_id: Id,
    name: z.string().min(1).max(200),
    /** Other names it went by: product titles and receipt texts. */
    aliases: z.array(z.string()).max(20).optional(),
  }),
);
export const MergeSuggestInput = named(
  "MergeSuggestInput",
  z.object({
    items: z.array(MergeSuggestItem).min(MERGE_SUGGEST_ITEMS.min).max(MERGE_SUGGEST_ITEMS.max),
  }),
  "`input` of a merge_suggest job (set by the State Engine; the worker never reads the catalog).",
);
export const MergeSuggestResult = named(
  "MergeSuggestResult",
  z.object({
    suggestions: z.array(
      z.object({
        item_id: Id,
        merge_into_item_id: Id,
        confidence: z.number().min(0).max(1),
        reason: z.string().nullable().optional(),
      }),
    ),
  }),
  "`result` of a completed merge_suggest job.",
);

export const MergeSuggestRunRequest = named(
  "MergeSuggestRunRequest",
  z.object({
    /** The member whose backfill finished (recorded on the jobs); optional. */
    actor_discord_id: ActorDiscordId.optional(),
  }),
);
export const MergeSuggestRunResponse = named(
  "MergeSuggestRunResponse",
  z.object({
    /** Queued merge_suggest jobs: the new ones, or the ones already waiting. */
    jobs: z.array(Job),
    /** False when nothing new was queued (see `skipped`). */
    created: z.boolean(),
    skipped: z.enum(["already_queued", "no_candidates"]).nullable(),
    /** Unverified, unmerged items sent for suggestions. */
    candidates: z.number().int(),
  }),
);

export const JobCompleteRequest = named(
  "JobCompleteRequest",
  z.object({
    job_id: Id,
    attempt: z.number().int().min(1),
    status: z.enum(["completed", "failed"]),
    /** PaperReceiptResult | TrashCamResult | MergeSuggestResult, per job type. */
    result: z.record(z.string(), z.unknown()).nullable().optional(),
    raw_model_response: z.unknown().optional(),
    model: z.string().max(100).nullable().optional(),
    prompt_version: z.string().max(100).nullable().optional(),
    keyframe_r2_keys: z.array(z.string()).max(32).optional(),
    error: z.string().max(2000).nullable().optional(),
  }),
);
export const JobCompleteResponse = named(
  "JobCompleteResponse",
  z.object({
    job: Job,
    /**
     * applied: result applied to inventory/receipts. review: needs a human (review item created).
     * retry: failure, re-queued. failed: gave up (failed_job review).
     */
    outcome: z.enum(["applied", "review", "retry", "failed"]),
    receipt_id: Id.nullable(),
    review_ids: z.array(z.string()),
  }),
);

export const JobNotification = named(
  "JobNotification",
  z.object({
    job: Job,
    /** One-line reply for the Discord thread. */
    summary: z.string(),
    receipt_id: Id.nullable(),
    review_ids: z.array(z.string()),
  }),
);
export const JobNotificationsResponse = named(
  "JobNotificationsResponse",
  z.object({ notifications: z.array(JobNotification) }),
);

export type JobT = z.infer<typeof Job>;
