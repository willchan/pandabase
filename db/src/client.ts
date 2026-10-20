// libSQL client + Drizzle instance. Local default is `db/dev.db`; Turso via TURSO_DATABASE_URL.
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { databaseUrlFromEnv, packagePath } from "./env";
import * as schema from "./schema/index";

export type Schema = typeof schema;
export type Db = LibSQLDatabase<Schema> & { $client: Client };

export const MIGRATIONS_FOLDER = packagePath("../migrations");

export interface DbOptions {
  url?: string;
  authToken?: string;
}

/** Open a database. Defaults come from `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`. */
export function createDb(opts: DbOptions = {}): Db {
  const client = createClient({
    url: opts.url ?? databaseUrlFromEnv(),
    authToken: opts.authToken ?? (process.env.TURSO_AUTH_TOKEN || undefined),
  });
  return drizzle(client, { schema });
}

/** Apply pending migrations from `db/migrations`. */
export async function migrateDb(db: Db): Promise<void> {
  // SQLite enforces foreign keys per connection; libSQL local files need it switched on.
  await db.$client.execute("PRAGMA foreign_keys = ON");
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * Fresh, fully migrated in-memory database for tests. Each call is isolated.
 * Close it with `db.$client.close()` when done.
 */
export async function createTestDb(): Promise<Db> {
  const db = createDb({ url: ":memory:" });
  await migrateDb(db);
  return db;
}
