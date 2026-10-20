import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { createJob } from "@/lib/services/jobs";

export const POST = handle(ROUTES.jobsCreate, async ({ app, body, now, config, actor }) => ({
  job: await createJob(app.db, body, {
    now,
    config,
    actor: await actor(body.actor_discord_id, { required: true }),
  }),
}));
