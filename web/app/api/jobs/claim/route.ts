import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { claimJob } from "@/lib/services/jobs";

export const POST = handle(ROUTES.jobsClaim, async ({ app, body, now, config, skipTelemetry }) => {
  const job = await claimJob(app.db, app.r2, body.job_types, { now, config });
  // An empty claim is the worker's idle poll: no `api_request` row (DESIGN §10 #93).
  if (!job) skipTelemetry();
  return { job };
});
