// DESIGN §2.6 — Grocery cycle & preferences.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { item, product } from "./catalog";
import { baseColumns, col, enumCheck, enumText, jsonCheck, sqlList } from "./common";
import { member } from "./people";

export const CYCLE_STATUSES = [
  "open",
  "building",
  "ready",
  "closed",
  "skipped",
  "other_store",
] as const;
/** Statuses of a cycle still in progress; `closed`, `skipped`, `other_store` are terminal (§4.7). */
export const ACTIVE_CYCLE_STATUSES = ["open", "building", "ready"] as const;
export const OVERRIDE_KINDS = ["add", "skip", "qty", "product"] as const;
export const PRICE_QUOTE_SOURCES = ["agent"] as const;
export const PREFERENCE_EVENT_KINDS = [
  "switch",
  "override_to_preferred",
  "override_to_cheaper",
  "implicit_swap",
  "reject",
  "auto_promote",
] as const;

export const groceryCycle = sqliteTable(
  "grocery_cycle",
  {
    ...baseColumns(),
    /** ISO week, e.g. `2026-W43`. Opening is idempotent per week. */
    weekLabel: text("week_label").notNull().unique(),
    discordThreadId: text("discord_thread_id"),
    status: enumText("status", CYCLE_STATUSES).notNull().default("open"),
    openedAt: text("opened_at").notNull(),
    nudgeSentAt: text("nudge_sent_at"),
    builtAt: text("built_at"),
    closedAt: text("closed_at"),
    closeReason: text("close_reason"),
    cartResult: text("cart_result", { mode: "json" }),
  },
  (t) => [
    enumCheck("grocery_cycle", t.status, CYCLE_STATUSES),
    jsonCheck("grocery_cycle", t.cartResult),
    // At most one active cycle: every active row indexes the same constant.
    uniqueIndex("grocery_cycle_one_active")
      .on(sql`(1)`)
      .where(sql`${col(t.status)} IN (${sqlList(ACTIVE_CYCLE_STATUSES)})`),
  ],
);

export const groceryCycleOverride = sqliteTable(
  "grocery_cycle_override",
  {
    ...baseColumns(),
    cycleId: text("cycle_id")
      .notNull()
      .references(() => groceryCycle.id, { onDelete: "cascade" }),
    kind: enumText("kind", OVERRIDE_KINDS).notNull(),
    itemId: text("item_id").references(() => item.id),
    /** One-off adds with no catalog item. */
    freeText: text("free_text"),
    quantity: real("quantity"),
    productId: text("product_id").references(() => product.id),
    actorMemberId: text("actor_member_id").references(() => member.id),
  },
  (t) => [
    enumCheck("grocery_cycle_override", t.kind, OVERRIDE_KINDS),
    check(
      "grocery_cycle_override_target_check",
      sql`${col(t.itemId)} IS NOT NULL OR (${col(t.kind)} = 'add' AND ${col(t.freeText)} IS NOT NULL)`,
    ),
    index("grocery_cycle_override_cycle_idx").on(t.cycleId),
  ],
);

export const priceQuote = sqliteTable(
  "price_quote",
  {
    ...baseColumns(),
    cycleId: text("cycle_id").references(() => groceryCycle.id),
    productId: text("product_id")
      .notNull()
      .references(() => product.id),
    priceCents: integer("price_cents").notNull(),
    observedAt: text("observed_at").notNull(),
    source: enumText("source", PRICE_QUOTE_SOURCES).notNull().default("agent"),
  },
  (t) => [
    enumCheck("price_quote", t.source, PRICE_QUOTE_SOURCES),
    check("price_quote_price_check", sql`${col(t.priceCents)} >= 0`),
    index("price_quote_product_idx").on(t.productId, t.observedAt),
  ],
);

export const preferenceEvent = sqliteTable(
  "preference_event",
  {
    ...baseColumns(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id),
    kind: enumText("kind", PREFERENCE_EVENT_KINDS).notNull(),
    fromProductId: text("from_product_id").references(() => product.id),
    toProductId: text("to_product_id").references(() => product.id),
    thresholdBefore: real("threshold_before"),
    thresholdAfter: real("threshold_after"),
    cycleId: text("cycle_id").references(() => groceryCycle.id),
  },
  (t) => [
    enumCheck("preference_event", t.kind, PREFERENCE_EVENT_KINDS),
    index("preference_event_item_idx").on(t.itemId, t.createdAt),
  ],
);
