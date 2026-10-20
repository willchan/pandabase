// DESIGN §2.4 — Receipts and their lines.
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { item, product } from "./catalog";
import { baseColumns, boolCheck, CATALOG_TRUST, col, enumCheck, enumText } from "./common";
import { auditJob } from "./jobs";
import { member } from "./people";

export const RECEIPT_SOURCES = ["digital", "paper", "manual"] as const;
export const FULFILLMENTS = ["delivery", "pickup", "in_store", "unknown"] as const;
export const TOTALS_CHECKS = ["pass", "fail", "n/a"] as const;
export const RECEIPT_STATUSES = ["applied", "pending_review", "partial"] as const;
export const MATCH_METHODS = ["asin", "alias_exact", "fuzzy", "manual", "none"] as const;

export const receipt = sqliteTable(
  "receipt",
  {
    ...baseColumns(),
    source: enumText("source", RECEIPT_SOURCES).notNull(),
    vendor: text("vendor").notNull(),
    accountMemberId: text("account_member_id").references(() => member.id),
    externalOrderId: text("external_order_id"),
    /** `digital:{account}:{order_id}` / `paper:{vendor}:{date}:{total}` / `manual:{idempotency key}`. */
    dedupeKey: text("dedupe_key").notNull().unique(),
    fulfillment: enumText("fulfillment", FULFILLMENTS).notNull().default("unknown"),
    orderedAt: text("ordered_at"),
    acquiredAt: text("acquired_at").notNull(),
    subtotalCents: integer("subtotal_cents"),
    totalCents: integer("total_cents"),
    totalsCheck: enumText("totals_check", TOTALS_CHECKS).notNull().default("n/a"),
    jobId: text("job_id").references(() => auditJob.id),
    status: enumText("status", RECEIPT_STATUSES).notNull(),
  },
  (t) => [
    enumCheck("receipt", t.source, RECEIPT_SOURCES),
    enumCheck("receipt", t.fulfillment, FULFILLMENTS),
    enumCheck("receipt", t.totalsCheck, TOTALS_CHECKS),
    enumCheck("receipt", t.status, RECEIPT_STATUSES),
    index("receipt_acquired_at_idx").on(t.acquiredAt),
  ],
);

export const receiptLine = sqliteTable(
  "receipt_line",
  {
    ...baseColumns(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => receipt.id, { onDelete: "cascade" }),
    rawText: text("raw_text").notNull(),
    asin: text("asin"),
    productId: text("product_id").references(() => product.id),
    itemId: text("item_id").references(() => item.id),
    /** Purchase units. */
    qty: real("qty").notNull().default(1),
    unitPriceCents: integer("unit_price_cents"),
    lineTotalCents: integer("line_total_cents"),
    matchMethod: enumText("match_method", MATCH_METHODS).notNull().default("none"),
    matchScore: real("match_score"),
    trust: enumText("trust", CATALOG_TRUST).notNull().default("unverified"),
    ignored: integer("ignored", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    enumCheck("receipt_line", t.matchMethod, MATCH_METHODS),
    enumCheck("receipt_line", t.trust, CATALOG_TRUST),
    boolCheck("receipt_line", t.ignored),
    check("receipt_line_match_score_check", sql`${col(t.matchScore)} BETWEEN 0 AND 1`),
    index("receipt_line_receipt_idx").on(t.receiptId),
    index("receipt_line_item_idx").on(t.itemId),
  ],
);
