import { ROUTES } from "@/lib/contracts";
import { lastCompleteWeek, renderWeekly } from "@/lib/diagnostics/weekly";
import { handle } from "@/lib/route";

export const GET = handle(ROUTES.diagnosticsWeekly, async ({ app, query, now, config }) =>
  renderWeekly(app.db, query.week ?? lastCompleteWeek(now, config.householdTz), { now, config }),
);
