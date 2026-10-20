// Receipt ingest and cursor (DESIGN §3.2, §4.5).
import { z } from "zod";
import { ActorDiscordId, Cents, Id, Timestamp } from "./common";
import { named } from "./registry";

export const ReceiptLineIn = named(
  "ReceiptLineIn",
  z.object({
    raw_text: z.string().min(1).max(300),
    asin: z.string().max(20).nullable().optional(),
    /** Product title (digital) — names auto-created items. */
    title: z.string().max(300).nullable().optional(),
    /** Purchase units. */
    qty: z.number().positive(),
    unit_price_cents: Cents.nullable().optional(),
    line_total_cents: Cents.nullable().optional(),
    /** Known item (manual receipts): skips matching. */
    item_id: Id.nullable().optional(),
    product_id: Id.nullable().optional(),
  }),
);

export const ReceiptIngestRequest = named(
  "ReceiptIngestRequest",
  z.object({
    actor_discord_id: ActorDiscordId,
    /** `manual` receipts need an `Idempotency-Key` header (it is their dedupe key). */
    source: z.enum(["digital", "manual"]),
    vendor: z.string().min(1).max(40),
    /** Member whose account placed the order: member id or Discord user id. */
    account: z.string().nullable().optional(),
    /** Required for digital receipts. */
    external_order_id: z.string().max(100).nullable().optional(),
    fulfillment: z.enum(["delivery", "pickup", "in_store", "unknown"]).optional(),
    ordered_at: Timestamp.nullable().optional(),
    acquired_at: Timestamp,
    subtotal_cents: Cents.nullable().optional(),
    total_cents: Cents.nullable().optional(),
    lines: z.array(ReceiptLineIn).max(300),
  }),
);

export const MatchMethod = named(
  "MatchMethod",
  z.enum(["asin", "alias_exact", "fuzzy", "manual", "none"]),
);
export const ReceiptLineOut = named(
  "ReceiptLineOut",
  z.object({
    id: Id,
    raw_text: z.string(),
    item_id: Id.nullable(),
    product_id: Id.nullable(),
    match_method: MatchMethod,
    match_score: z.number().nullable(),
    trust: z.enum(["confirmed", "unverified"]),
    pending: z.boolean(),
    ignored: z.boolean(),
  }),
);
export const ReceiptIngestResponse = named(
  "ReceiptIngestResponse",
  z.object({
    receipt_id: Id,
    /** The receipt was already ingested (same dedupe key); nothing changed. */
    duplicate: z.boolean(),
    status: z.enum(["applied", "pending_review", "partial"]),
    totals_check: z.enum(["pass", "fail", "n/a"]),
    lines: z.array(ReceiptLineOut),
    new_item_ids: z.array(z.string()),
    review_ids: z.array(z.string()),
    /** The receipt was the ready cycle's order and closed it. */
    closed_cycle_id: Id.nullable(),
  }),
);

export const ReceiptCursorQuery = named(
  "ReceiptCursorQuery",
  z.object({ account: z.string().min(1) }),
);
export const ReceiptCursorResponse = named(
  "ReceiptCursorResponse",
  z.object({
    account_member_id: Id,
    /** Newest ingested digital order for the account (null if none). */
    external_order_id: z.string().nullable(),
    acquired_at: Timestamp.nullable(),
    ordered_at: Timestamp.nullable(),
  }),
);

export type ReceiptIngestRequestT = z.infer<typeof ReceiptIngestRequest>;
export type ReceiptIngestResponseT = z.infer<typeof ReceiptIngestResponse>;
