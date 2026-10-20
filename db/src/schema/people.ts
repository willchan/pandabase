// DESIGN §2.1 — People & settings.
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import {
  baseColumns,
  boolCheck,
  col,
  createdAt,
  enumCheck,
  enumText,
  jsonCheck,
  updatedAt,
} from "./common";

export const AMAZON_SWEEPS = ["daily", "weekly", "off"] as const;

export const member = sqliteTable(
  "member",
  {
    ...baseColumns(),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    discordUserId: text("discord_user_id").unique(),
    chromiumProfile: text("chromium_profile"),
    amazonSweep: enumText("amazon_sweep", AMAZON_SWEEPS).notNull().default("off"),
    isCartAccount: integer("is_cart_account", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    enumCheck("member", t.amazonSweep, AMAZON_SWEEPS),
    boolCheck("member", t.isCartAccount),
    // "Exactly one true": the schema enforces at most one; the app ensures at least one.
    uniqueIndex("member_one_cart_account")
      .on(t.isCartAccount)
      .where(sql`${col(t.isCartAccount)} = 1`),
  ],
);

export const setting = sqliteTable(
  "setting",
  {
    key: text("key").primaryKey(),
    value: text("value", { mode: "json" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [jsonCheck("setting", t.value)],
);

export const awayPeriod = sqliteTable(
  "away_period",
  {
    ...baseColumns(),
    /** Household-TZ date, `YYYY-MM-DD`, inclusive. */
    startsOn: text("starts_on").notNull(),
    /** Household-TZ date, `YYYY-MM-DD`, inclusive. */
    endsOn: text("ends_on").notNull(),
    note: text("note"),
    createdByMemberId: text("created_by_member_id").references(() => member.id),
  },
  (t) => [check("away_period_range_check", sql`${col(t.endsOn)} >= ${col(t.startsOn)}`)],
);
