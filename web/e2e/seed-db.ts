// Fresh e2e database (`E2E_DB`): migrated and seeded relative to *now*, so the seeded open cycle,
// pending reviews and expiries are current whenever the suite runs.
import { seedFreshFile } from "../scripts/seed-file";

const file = process.env.E2E_DB;
if (!file) throw new Error("E2E_DB is not set");
await seedFreshFile(file);
console.log(`e2e database ready: ${file}`);
