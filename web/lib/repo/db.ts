// Query-capable handle: the database or a transaction (repositories accept either).
import type { Client, ResultSet } from "@libsql/client";
import { schema, type Db, type Schema } from "@pandabase/db";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

export type Q = BaseSQLiteDatabase<"async", ResultSet, Schema>;

/** A `Q` inside a write transaction that can also send several statements in one round trip. */
export type BatchQ = LibSQLDatabase<Schema>;
export type Stmt = BatchItem<"sqlite">;

/**
 * Like `db.transaction`, but the handle can `batch` inside the transaction: Drizzle's own
 * transaction handle can't, so every statement would be its own round trip. Against remote Turso
 * a batch is one request (BEGIN rides along with the first), so a service can read what it needs,
 * decide in memory, and write in a constant number of round trips while holding the write lock
 * (DESIGN §8 *Database round trips*).
 */
export async function batchTransaction<T>(db: Db, fn: (q: BatchQ) => Promise<T>): Promise<T> {
  const tx = await db.$client.transaction("write");
  // A libSQL transaction has the client's statement API, so Drizzle can drive it directly.
  const q = drizzle(tx as unknown as Client, { schema });
  try {
    const out = await fn(q);
    await tx.commit();
    return out;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/**
 * Run `writes` then `reads` in one round trip (in order, so the reads see the writes) and return
 * the reads' results. Either list may be empty.
 */
export async function batchThen<T extends readonly Stmt[]>(
  q: BatchQ,
  writes: readonly Stmt[],
  reads: T,
): Promise<BatchResponse<T>> {
  const all = [...writes, ...reads];
  if (all.length === 0) return [] as unknown as BatchResponse<T>;
  const res = await q.batch(all as unknown as [Stmt, ...Stmt[]]);
  return res.slice(writes.length) as unknown as BatchResponse<T>;
}

/** JSON columns come back as `unknown`; narrow plain objects. */
export const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
