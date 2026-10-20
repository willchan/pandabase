import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { openCycle } from "@/lib/services/cycles";

export const POST = handle(ROUTES.cycleOpen, async ({ app, body, now, config, actor }) =>
  openCycle(app.db, body.discord_thread_id, { now, config, actor: await actor(null) }),
);
