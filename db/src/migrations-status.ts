// `pnpm db:migrations-status`: do the migrations applied to TURSO_DATABASE_URL match
// `db/migrations`? Read-only (one SELECT on Drizzle's journal table): the post-deploy production
// smoke runs it with the production token (DESIGN §8). Prints a JSON summary; exit 1 on a mismatch.
import { readMigrationFiles } from "drizzle-orm/migrator";
import { pathToFileURL } from "node:url";
import { createDb, MIGRATIONS_FOLDER } from "./client";
import { databaseUrlFromEnv } from "./env";
import { redact } from "./preview-db";

export interface Migration {
  hash: string;
  createdAt: number;
}

export interface MigrationStatus {
  ok: boolean;
  expected: number;
  applied: number;
  /** In `db/migrations` but not applied (a migrate step didn't run or failed). */
  pending: number[];
  /** Applied with a different SQL hash than the file (a migration was edited after it ran). */
  changed: number[];
  /** Applied but not in `db/migrations` (a newer release migrated, or a PR's migration leaked). */
  unknown: number[];
}

/** Compare by `created_at` (Drizzle's journal `when`), then hash. */
export function compareMigrations(applied: Migration[], expected: Migration[]): MigrationStatus {
  const byTime = new Map(applied.map((m) => [m.createdAt, m.hash]));
  const want = new Set(expected.map((m) => m.createdAt));
  const pending = expected.filter((m) => !byTime.has(m.createdAt)).map((m) => m.createdAt);
  const changed = expected
    .filter((m) => byTime.has(m.createdAt) && byTime.get(m.createdAt) !== m.hash)
    .map((m) => m.createdAt);
  const unknown = applied.filter((m) => !want.has(m.createdAt)).map((m) => m.createdAt);
  return {
    ok: !pending.length && !changed.length && !unknown.length,
    expected: expected.length,
    applied: applied.length,
    pending,
    changed,
    unknown,
  };
}

export function expectedMigrations(folder = MIGRATIONS_FOLDER): Migration[] {
  return readMigrationFiles({ migrationsFolder: folder }).map((m) => ({
    hash: m.hash,
    createdAt: m.folderMillis,
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = databaseUrlFromEnv();
  const db = createDb({ url });
  let applied: Migration[] = [];
  try {
    const res = await db.$client.execute("select hash, created_at from __drizzle_migrations");
    applied = res.rows.map((r) => ({ hash: String(r.hash), createdAt: Number(r.created_at) }));
  } catch (err) {
    console.error(`couldn't read __drizzle_migrations: ${(err as Error).message}`);
  }
  db.$client.close();
  const status = compareMigrations(applied, expectedMigrations());
  console.log(JSON.stringify({ database: redact(url), ...status }));
  process.exit(status.ok ? 0 : 1);
}
