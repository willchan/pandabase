import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { predictions } from "@/lib/services/cycles";

export const GET = handle(ROUTES.predictions, async ({ app, query, now, config }) =>
  predictions(app.db, query.cycle_id ?? null, { now, config }),
);
