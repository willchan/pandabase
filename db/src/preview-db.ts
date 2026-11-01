// Resetting and seeding a *remote* database (the preview end-to-end tests, docs/TESTING.md tier
// A′). Only the shared Turso preview DB may be wiped: the caller must opt in with
// PANDABASE_ALLOW_REMOTE_SEED=preview *and* the URL's database name must say `preview`. Anything
// else — production above all — is refused. Local files (`file:`) need neither.
import type { Db } from "./client";

export const ALLOW_REMOTE_SEED = "PANDABASE_ALLOW_REMOTE_SEED";

const REMOTE_PROTOCOLS = new Set(["libsql:", "https:", "http:", "wss:", "ws:"]);

export const isLocalUrl = (url: string): boolean => url.startsWith("file:") || url === ":memory:";

/**
 * Why `url` may not be reset or seeded, or `null` when it may. Two independent signals are
 * required for a remote URL, so neither a stray env var nor a mislabelled secret is enough.
 * Turso hostnames are `<db>-<org>.<region>.turso.io`; the first label must contain `preview` as a
 * whole dash-separated word (`pandabase-preview-<org>` passes, `pandabase-<org>` doesn't).
 */
export function remoteWriteRefusal(url: string, env: NodeJS.ProcessEnv): string | null {
  if (isLocalUrl(url)) return null;
  if (env[ALLOW_REMOTE_SEED] !== "preview")
    return `${ALLOW_REMOTE_SEED}=preview is not set; remote databases are never reset or seeded otherwise`;
  let host: string;
  try {
    const parsed = new URL(url);
    if (!REMOTE_PROTOCOLS.has(parsed.protocol))
      return `unsupported database URL scheme ${parsed.protocol}`;
    host = parsed.hostname.toLowerCase();
  } catch {
    return "the database URL doesn't parse";
  }
  const name = host.split(".")[0] ?? "";
  if (!/(^|-)preview(-|$)/.test(name))
    return `database host ${host} isn't a preview database (its name must contain "preview")`;
  return null;
}

/** Throws (with the reason) unless `remoteWriteRefusal` allows `url`. */
export function assertResettable(url: string, env: NodeJS.ProcessEnv = process.env): void {
  const refusal = remoteWriteRefusal(url, env);
  if (refusal) throw new Error(`Refusing to reset or seed ${redact(url)}: ${refusal}.`);
}

/** The URL without credentials or query (Turso tokens can ride in `?authToken=`). */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return "<unparseable url>";
  }
}

/**
 * Delete every row of every table, keeping the schema and the migration journal (other open
 * PRs' additive migrations stay applied). One write batch with foreign keys deferred to commit,
 * so the delete order doesn't matter.
 */
export async function wipeRows(db: Db): Promise<string[]> {
  const res = await db.$client.execute(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'" +
      " and name not like '\\_\\_%' escape '\\' and name not like 'libsql_%' order by name",
  );
  const tables = res.rows.map((r) => String(r.name));
  await db.$client.batch(
    [
      "PRAGMA defer_foreign_keys = ON",
      ...tables.map((t) => `DELETE FROM "${t.replaceAll('"', '""')}"`),
    ],
    "write",
  );
  return tables;
}
