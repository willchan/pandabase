import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { markNotified } from "@/lib/services/jobs";

export const POST = handle<typeof ROUTES.jobsNotified, { id: string }>(
  ROUTES.jobsNotified,
  async ({ app, params, now }) => ({ job: await markNotified(app.db, params.id, { now }) }),
);
