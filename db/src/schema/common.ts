// Shared column builders and constraint helpers for every table (DESIGN §2).
import { sql, type SQL } from "drizzle-orm";
import { check, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { ulid } from "ulid";

/** Current UTC time as ISO-8601 with milliseconds — the format every timestamp column uses. */
export const nowIso = (): string => new Date().toISOString();

/** SQL default producing the same format as `nowIso()` (for rows inserted outside Drizzle). */
const sqlNowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => ulid());

export const createdAt = () => text("created_at").notNull().default(sqlNowIso).$defaultFn(nowIso);

export const updatedAt = () =>
  text("updated_at").notNull().default(sqlNowIso).$defaultFn(nowIso).$onUpdateFn(nowIso);

/** `id`, `created_at`, `updated_at` — the default trio for every table. */
export const baseColumns = () => ({ id: id(), createdAt: createdAt(), updatedAt: updatedAt() });

/** Text column constrained to `values` (CHECK added separately via `enumCheck`). */
export const enumText = <const T extends readonly [string, ...string[]]>(name: string, values: T) =>
  text(name, { enum: values });

/**
 * Unqualified column reference for CHECK / partial-index expressions. Drizzle would otherwise emit
 * `"table"."col"`, which breaks when drizzle-kit rebuilds a SQLite table under a temporary name.
 */
export const col = (column: AnySQLiteColumn): SQL => sql`${sql.identifier(column.name)}`;

export const sqlList = (values: readonly (string | number)[]): SQL =>
  sql.raw(
    values
      .map((v) => (typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`))
      .join(", "),
  );

/** CHECK (`col` IN (...)). NULLs pass, so nullable enums stay nullable. */
export const enumCheck = (table: string, column: AnySQLiteColumn, values: readonly string[]) =>
  check(`${table}_${column.name}_check`, sql`${col(column)} IN (${sqlList(values)})`);

/** CHECK (`col` IN (0, 1)) for integer-backed booleans. */
export const boolCheck = (table: string, column: AnySQLiteColumn) =>
  check(`${table}_${column.name}_check`, sql`${col(column)} IN (${sqlList([0, 1])})`);

/** CHECK (json_valid(`col`)). NULLs pass. */
export const jsonCheck = (table: string, column: AnySQLiteColumn) =>
  check(`${table}_${column.name}_json_check`, sql`json_valid(${col(column)})`);

// Enum value sets shared across tables.
export const LOCATIONS = [
  "fridge",
  "freezer",
  "pantry",
  "bathroom",
  "utility",
  "garden",
  "garage",
] as const;
/** Trust for catalog/receipt rows: human-confirmed or machine-created. */
export const CATALOG_TRUST = ["confirmed", "unverified"] as const;
