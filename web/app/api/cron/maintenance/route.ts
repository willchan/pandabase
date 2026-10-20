import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { runMaintenance } from "@/lib/services/maintenance";

export const GET = handle(ROUTES.cronMaintenance, async ({ app, now, config }) =>
  runMaintenance(app.db, { now, config }),
);
