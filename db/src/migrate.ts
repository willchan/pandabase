// `pnpm db:migrate` (local / TURSO_DATABASE_URL) and `pnpm db:migrate:prod` (Turso only).
import { createDb, migrateDb } from "./client";
import { databaseUrlFromEnv } from "./env";

const prod = process.argv.includes("--prod");
const url = databaseUrlFromEnv();
if (prod && (url.startsWith("file:") || !process.env.TURSO_AUTH_TOKEN)) {
  console.error("db:migrate:prod needs TURSO_DATABASE_URL (libsql://…) and TURSO_AUTH_TOKEN.");
  process.exit(1);
}
const db = createDb({ url });
await migrateDb(db);
console.log(`migrated ${url}`);
db.$client.close();
