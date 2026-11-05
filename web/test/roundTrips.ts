// Counts database round trips: every libSQL `execute`/`batch`/`executeMultiple` call on the client
// or on a transaction it opens, plus each `commit`/`rollback`. Against remote Turso each of these is
// one network request (a transaction's BEGIN rides along with its first statement), so the count is
// what a server action's latency scales with.
import type { Client, Transaction } from "@libsql/client";
import type { Db } from "@pandabase/db";

const COUNTED = ["execute", "batch", "executeMultiple", "commit", "rollback"] as const;

export interface RoundTrips {
  /** Round trips since the counter started (or was last reset). */
  count(): number;
  reset(): void;
  restore(): void;
}

export function countRoundTrips(db: Db): RoundTrips {
  const client: Client = db.$client;
  let n = 0;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv) as unknown;
        if (typeof v !== "function") return v;
        if ((COUNTED as readonly (string | symbol)[]).includes(prop)) {
          return (...args: unknown[]) => {
            n++;
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        return (v as (...a: unknown[]) => unknown).bind(t);
      },
    });
  const original = {
    execute: client.execute,
    batch: client.batch,
    transaction: client.transaction,
  };
  const c = client as unknown as Record<string, unknown>;
  c.execute = (...a: unknown[]) => (
    n++,
    (original.execute as (...x: unknown[]) => unknown).apply(client, a)
  );
  c.batch = (...a: unknown[]) => (
    n++,
    (original.batch as (...x: unknown[]) => unknown).apply(client, a)
  );
  c.transaction = async (...a: unknown[]) =>
    wrap(
      await (original.transaction as (...x: unknown[]) => Promise<Transaction>).apply(client, a),
    );
  return {
    count: () => n,
    reset: () => void (n = 0),
    restore: () => void Object.assign(c, original),
  };
}
