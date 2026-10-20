// Fresh e2e database (`E2E_DB`): migrated and seeded relative to *now*, so the seeded open cycle,
// pending reviews and expiries are current whenever the suite runs.
import { createDb, migrateDb } from "@pandabase/db";
import { seed } from "@pandabase/db/seed";
import { rmSync } from "node:fs";

const file = process.env.E2E_DB;
if (!file) throw new Error("E2E_DB is not set");
for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
const db = createDb({ url: `file:${file}` });
await migrateDb(db);
await seed(db, { now: new Date().toISOString() });
db.$client.close();
console.log(`e2e database ready: ${file}`);
