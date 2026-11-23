// DESIGN §4.9 — Subscribe & Save: what each member's Amazon account already delivers on a schedule.
import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { baseColumns, col } from "./common";
import { member } from "./people";

/**
 * One row per (member, vendor, ASIN) the agent's sweep has seen on the member's Subscribe & Save
 * page. A sync that no longer lists it sets `ended_at`; listing it again clears it. The cart plan
 * leaves an item out while one of its products' ASINs has a row that isn't ended and was last seen
 * within `subscriptions.staleAfterDays` (a broken sync can't hide an item for ever).
 */
export const subscription = sqliteTable(
  "subscription",
  {
    ...baseColumns(),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id),
    vendor: text("vendor").notNull(),
    asin: text("asin").notNull(),
    title: text("title"),
    /** Household-local date of the next scheduled delivery (`YYYY-MM-DD`), as the page showed it. */
    nextDeliveryOn: text("next_delivery_on"),
    /** The page's schedule text ("3 units every 3 weeks"). */
    schedule: text("schedule"),
    firstSeenAt: text("first_seen_at").notNull(),
    /** The last sync that listed it. */
    lastSeenAt: text("last_seen_at").notNull(),
    /** A later sync no longer listed it (cancelled on Amazon). */
    endedAt: text("ended_at"),
  },
  (t) => [
    uniqueIndex("subscription_member_asin_unique").on(t.memberId, t.vendor, t.asin),
    index("subscription_asin_idx").on(t.asin),
    check(
      "subscription_ended_check",
      sql`${col(t.endedAt)} IS NULL OR ${col(t.endedAt)} >= ${col(t.lastSeenAt)}`,
    ),
  ],
);
