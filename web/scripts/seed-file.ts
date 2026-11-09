// A fresh local database file, migrated and seeded relative to *now* (the seeded open cycle,
// pending reviews and expiries are current whenever it runs). Used by the e2e suite and the
// `dev-seeded` server. Synthetic data only.
import { createDb, migrateDb } from "@pandabase/db";
import { seed } from "@pandabase/db/seed";
import { rmSync } from "node:fs";

export async function seedFreshFile(file: string): Promise<void> {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
  const db = createDb({ url: `file:${file}` });
  try {
    await migrateDb(db);
    await seed(db, { now: new Date().toISOString() });
  } finally {
    db.$client.close();
  }
}
