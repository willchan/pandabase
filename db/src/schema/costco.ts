// DESIGN §4.8 — Costco trips: the household's in-store runs, planned on demand.
import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { baseColumns, col, enumCheck, enumText, jsonCheck, sqlList } from "./common";
import { receipt } from "./receipts";

export const COSTCO_TRIP_STATUSES = ["planned", "done", "cancelled"] as const;

export const costcoTrip = sqliteTable(
  "costco_trip",
  {
    ...baseColumns(),
    /** Household-local date of the trip (`YYYY-MM-DD`). */
    plannedFor: text("planned_for").notNull(),
    status: enumText("status", COSTCO_TRIP_STATUSES).notNull().default("planned"),
    /** The `#pandabase` message or thread the list was posted in. */
    discordThreadId: text("discord_thread_id"),
    /** The list as last posted (`CostcoListLine[]` contract), refreshed when the trip moves. */
    list: text("list", { mode: "json" }).notNull(),
    /** The Costco receipt that closed the trip (M10.3). */
    receiptId: text("receipt_id").references(() => receipt.id),
    closedAt: text("closed_at"),
    /** `back_from_costco`, `cancelled`, `expired` (cron default, §4.8), `receipt` (M10.3). */
    closeReason: text("close_reason"),
  },
  (t) => [
    enumCheck("costco_trip", t.status, COSTCO_TRIP_STATUSES),
    jsonCheck("costco_trip", t.list),
    check(
      "costco_trip_closed_check",
      sql`(${col(t.status)} = 'planned') = (${col(t.closedAt)} IS NULL)`,
    ),
    // At most one planned trip: every planned row indexes the same constant.
    uniqueIndex("costco_trip_one_planned")
      .on(sql`(1)`)
      .where(sql`${col(t.status)} IN (${sqlList(["planned"])})`),
    index("costco_trip_planned_for_idx").on(t.plannedFor),
  ],
);
