// `pnpm db:reset`: a fresh database. Local files are deleted and re-migrated. A remote database is
// accepted only when `remoteWriteRefusal` allows it (the Turso preview DB, PANDABASE_ALLOW_REMOTE_SEED
// =preview): it is migrated, then every row is deleted (the schema stays).
import { rmSync } from "node:fs";
import { createDb, migrateDb } from "./client";
import { databaseUrlFromEnv } from "./env";
import { assertResettable, isLocalUrl, redact, wipeRows } from "./preview-db";

const url = databaseUrlFromEnv();
if (isLocalUrl(url)) {
  const file = url.slice("file:".length);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
  const db = createDb({ url });
  await migrateDb(db);
  console.log(`reset ${url}`);
  db.$client.close();
} else {
  try {
    assertResettable(url);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const db = createDb({ url });
  await migrateDb(db);
  const tables = await wipeRows(db);
  console.log(`reset ${redact(url)}: migrated, emptied ${tables.length} tables`);
  db.$client.close();
}
