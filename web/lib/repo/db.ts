// Query-capable handle: the database or a transaction (repositories accept either).
import type { ResultSet } from "@libsql/client";
import type { Schema } from "@pandabase/db";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

export type Q = BaseSQLiteDatabase<"async", ResultSet, Schema>;

/** JSON columns come back as `unknown`; narrow plain objects. */
export const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
