// `make prod-copy` (docs/TESTING.md "Prod copy"): copy the production Turso database into a
// gitignored local SQLite file (`.scratch/prod-copy.db`) with a READ-ONLY token, so changes can be
// checked against real data without touching prod. Only `SELECT`s ever reach the source: the
// client is wrapped so any other statement throws before it is sent. Prints row counts per table —
// never row contents, never the token or the URL's credentials.
//
// Env: PROD_RO_TURSO_URL + PROD_RO_TURSO_TOKEN (a `turso db tokens create <db> --read-only`
// token). When unset they are read from PROD_RO_ENV_FILE (default
// ~/.config/pandabase/prod-ro.env, outside the repo); in a cloud session they are env secrets.
import { createClient, type Client, type InValue } from "@libsql/client";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packagePath } from "./env";
import { isLocalUrl } from "./preview-db";

export const PROD_COPY_FILE = packagePath("../../.scratch/prod-copy.db");
export const DEFAULT_ENV_FILE = path.join(homedir(), ".config", "pandabase", "prod-ro.env");

/** Throws unless `sql` is a single plain `SELECT` (no `;`-chained second statement). */
export function assertSelectOnly(sql: string): void {
  const s = sql.trim();
  if (!/^select\b/i.test(s) || s.replace(/;\s*$/, "").includes(";"))
    throw new Error(`prod-copy only reads; refused a non-SELECT statement: ${s.slice(0, 40)}`);
}

/** What the copy may ask of the source: one SELECT at a time. */
export interface ReadOnlySource {
  select(sql: string): Promise<Record<string, unknown>[]>;
}

export function readOnly(client: Pick<Client, "execute">): ReadOnlySource {
  return {
    async select(sql) {
      assertSelectOnly(sql);
      const res = await client.execute(sql);
      return res.rows as unknown as Record<string, unknown>[];
    },
  };
}

const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** sqlite / libSQL / Turso internals that are created by the engine, not by our migrations. */
const isInternal = (name: string) => /^(sqlite_|libsql_|_litestream|_cf_)/.test(name);

/**
 * Copy every user table (schema, rows), then indexes, triggers and views, from `src` into the
 * empty `dest`. Returns row counts by table. Foreign keys are off while loading, so table order
 * doesn't matter.
 */
export async function copyDatabase(
  src: ReadOnlySource,
  dest: Client,
): Promise<Record<string, number>> {
  const objects = (await src.select(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid",
  )) as { type: string; name: string; tbl_name: string; sql: string }[];
  const keep = objects.filter((o) => !isInternal(o.name) && !isInternal(o.tbl_name));
  await dest.execute("PRAGMA foreign_keys = OFF");
  const counts: Record<string, number> = {};
  for (const t of keep.filter((o) => o.type === "table")) {
    await dest.execute(t.sql);
    const rows = await src.select(`SELECT * FROM ${q(t.name)}`);
    counts[t.name] = rows.length;
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]!);
    const insert = `INSERT INTO ${q(t.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    for (let i = 0; i < rows.length; i += 500) {
      await dest.batch(
        rows.slice(i, i + 500).map((r) => ({
          sql: insert,
          args: cols.map((c) => r[c] as InValue),
        })),
        "write",
      );
    }
  }
  for (const o of keep.filter((o) => o.type !== "table")) await dest.execute(o.sql);
  return counts;
}

/** `KEY=VALUE` lines (optional `export `, quotes, `#` comments) — just enough for the env file. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export interface ProdSource {
  url: string;
  authToken: string;
}

/** The prod URL + read-only token from the env, else from the env file; throws with what's missing. */
export function prodSourceFromEnv(env: NodeJS.ProcessEnv = process.env): ProdSource {
  let url = env.PROD_RO_TURSO_URL;
  let authToken = env.PROD_RO_TURSO_TOKEN;
  const file = env.PROD_RO_ENV_FILE || DEFAULT_ENV_FILE;
  if ((!url || !authToken) && existsSync(file)) {
    const vars = parseEnvFile(readFileSync(file, "utf8"));
    url ||= vars.PROD_RO_TURSO_URL;
    authToken ||= vars.PROD_RO_TURSO_TOKEN;
  }
  if (!url || !authToken)
    throw new Error(
      `PROD_RO_TURSO_URL and PROD_RO_TURSO_TOKEN are not set (env or ${file}). ` +
        "Create a read-only token: turso db tokens create <db> --read-only",
    );
  if (isLocalUrl(url)) throw new Error("PROD_RO_TURSO_URL must be the remote Turso database");
  return { url, authToken };
}

export function formatCounts(counts: Record<string, number>): string {
  const names = Object.keys(counts).sort();
  const width = Math.max(5, ...names.map((n) => n.length));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return [
    ...names.map((n) => `  ${n.padEnd(width)} ${counts[n]}`),
    `  ${"total".padEnd(width)} ${total}`,
  ].join("\n");
}

/** Copy into a temp file next to `target`, then rename, so a failed copy leaves the old one. */
export async function writeProdCopy(src: ReadOnlySource, target: string) {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  for (const f of [tmp, `${tmp}-journal`]) rmSync(f, { force: true });
  const dest = createClient({ url: `file:${tmp}` });
  try {
    const counts = await copyDatabase(src, dest);
    dest.close();
    for (const s of ["-journal", "-wal", "-shm"]) rmSync(target + s, { force: true });
    renameSync(tmp, target);
    return counts;
  } catch (err) {
    dest.close();
    rmSync(tmp, { force: true });
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { url, authToken } = prodSourceFromEnv();
    const client = createClient({ url, authToken });
    // The host names the Turso org: not printed (logs may end up in chat).
    console.log("copying the production database (read-only) …");
    try {
      const counts = await writeProdCopy(readOnly(client), PROD_COPY_FILE);
      console.log(`wrote ${path.relative(process.cwd(), PROD_COPY_FILE)}\n${formatCounts(counts)}`);
    } finally {
      client.close();
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
