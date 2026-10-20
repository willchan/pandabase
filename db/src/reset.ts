// `pnpm db:reset`: delete the local database file and re-apply all migrations. Local files only.
import { rmSync } from "node:fs";
import { createDb, migrateDb } from "./client";
import { databaseUrlFromEnv } from "./env";

const url = databaseUrlFromEnv();
if (!url.startsWith("file:")) {
  console.error(`Refusing to reset non-local database ${url}.`);
  process.exit(1);
}
const file = url.slice("file:".length);
for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(file + suffix, { force: true });

const db = createDb({ url });
await migrateDb(db);
console.log(`reset ${url}`);
db.$client.close();
