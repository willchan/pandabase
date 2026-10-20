import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { claimJob } from "@/lib/services/jobs";

export const POST = handle(ROUTES.jobsClaim, async ({ app, body, now, config }) => ({
  job: await claimJob(app.db, app.r2, body.job_types, { now, config }),
}));
