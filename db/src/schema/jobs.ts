// DESIGN §2.5 — Jobs, review, labels.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { item } from "./catalog";
import { baseColumns, col, enumCheck, enumText, jsonCheck } from "./common";
import { groceryCycle } from "./cycle";
import { member } from "./people";
import { receipt } from "./receipts";

/** `storage_audit` is reserved for v1.1 (allowed by the CHECK so it needs no migration). */
export const JOB_TYPES = ["paper_receipt", "trash_cam", "merge_suggest", "storage_audit"] as const;
export const JOB_STATUSES = ["queued", "claimed", "completed", "failed"] as const;
export const REVIEW_KINDS = [
  "receipt",
  "new_product",
  "merge_suggestion",
  "unverified_item",
  "failed_job",
  "trash_cam",
] as const;
export const REVIEW_URGENCIES = ["this_week", "cleanup"] as const;
export const REVIEW_STATUSES = [
  "pending",
  "confirmed",
  "corrected",
  "dismissed",
  "expired",
] as const;
export const LABEL_SOURCE_KINDS = ["receipt_line", "trash_cam", "checkin"] as const;

export const auditJob = sqliteTable(
  "audit_job",
  {
    ...baseColumns(),
    jobType: enumText("job_type", JOB_TYPES).notNull(),
    status: enumText("status", JOB_STATUSES).notNull().default("queued"),
    mediaR2Key: text("media_r2_key"),
    keyframeR2Keys: text("keyframe_r2_keys", { mode: "json" }).$type<string[]>(),
    expectedStateSnapshot: text("expected_state_snapshot", { mode: "json" }),
    input: text("input", { mode: "json" }),
    rawModelResponse: text("raw_model_response", { mode: "json" }),
    result: text("result", { mode: "json" }),
    model: text("model"),
    promptVersion: text("prompt_version"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: text("claimed_at"),
    leaseExpiresAt: text("lease_expires_at"),
    error: text("error"),
    actorMemberId: text("actor_member_id").references(() => member.id),
    cycleId: text("cycle_id").references((): AnySQLiteColumn => groceryCycle.id),
    discordChannelId: text("discord_channel_id"),
    discordMessageId: text("discord_message_id"),
    notifiedAt: text("notified_at"),
    completedAt: text("completed_at"),
  },
  (t) => [
    enumCheck("audit_job", t.jobType, JOB_TYPES),
    enumCheck("audit_job", t.status, JOB_STATUSES),
    jsonCheck("audit_job", t.keyframeR2Keys),
    jsonCheck("audit_job", t.expectedStateSnapshot),
    jsonCheck("audit_job", t.input),
    jsonCheck("audit_job", t.rawModelResponse),
    jsonCheck("audit_job", t.result),
    check("audit_job_attempts_check", sql`${col(t.attempts)} >= 0`),
    index("audit_job_status_idx").on(t.status, t.createdAt),
  ],
);

export const reviewItem = sqliteTable(
  "review_item",
  {
    ...baseColumns(),
    kind: enumText("kind", REVIEW_KINDS).notNull(),
    jobId: text("job_id").references(() => auditJob.id),
    receiptId: text("receipt_id").references((): AnySQLiteColumn => receipt.id),
    itemId: text("item_id").references(() => item.id),
    /** Detected name, suggestions, delta. */
    payload: text("payload", { mode: "json" }).notNull(),
    urgency: enumText("urgency", REVIEW_URGENCIES).notNull().default("cleanup"),
    /** Higher = affects this week's cart (DESIGN §4.6). */
    impactScore: real("impact_score").notNull().default(0),
    status: enumText("status", REVIEW_STATUSES).notNull().default("pending"),
    /** What happens on expiry. */
    defaultAction: text("default_action", { mode: "json" }).notNull(),
    /** Null only for kinds that never expire (`unverified_item`, DESIGN §4.6). */
    expiresAt: text("expires_at"),
    reviewedByMemberId: text("reviewed_by_member_id").references(() => member.id),
    reviewedAt: text("reviewed_at"),
  },
  (t) => [
    enumCheck("review_item", t.kind, REVIEW_KINDS),
    enumCheck("review_item", t.urgency, REVIEW_URGENCIES),
    enumCheck("review_item", t.status, REVIEW_STATUSES),
    jsonCheck("review_item", t.payload),
    jsonCheck("review_item", t.defaultAction),
    check(
      "review_item_expires_at_check",
      sql`${col(t.expiresAt)} IS NOT NULL OR ${col(t.kind)} = 'unverified_item'`,
    ),
    index("review_item_status_idx").on(t.status, t.urgency, t.impactScore),
    index("review_item_expires_at_idx").on(t.expiresAt),
  ],
);

/** Created only from human confirmation/correction — hence `human_label` and `member_id` required. */
export const labeledObservation = sqliteTable(
  "labeled_observation",
  {
    ...baseColumns(),
    sourceKind: enumText("source_kind", LABEL_SOURCE_KINDS).notNull(),
    jobId: text("job_id").references(() => auditJob.id),
    keyframeR2Key: text("keyframe_r2_key"),
    bbox: text("bbox", { mode: "json" }),
    modelOutput: text("model_output", { mode: "json" }),
    humanLabel: text("human_label", { mode: "json" }).notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id),
  },
  (t) => [
    enumCheck("labeled_observation", t.sourceKind, LABEL_SOURCE_KINDS),
    jsonCheck("labeled_observation", t.bbox),
    jsonCheck("labeled_observation", t.modelOutput),
    jsonCheck("labeled_observation", t.humanLabel),
  ],
);
