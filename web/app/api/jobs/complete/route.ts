import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { completeJob } from "@/lib/services/jobs";

export const POST = handle(ROUTES.jobsComplete, async ({ app, body, now, config, actor }) =>
  completeJob(app.db, body, { now, config, actor: await actor(null) }),
);
