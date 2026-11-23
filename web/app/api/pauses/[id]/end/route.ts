import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { endPause } from "@/lib/services/pauses";

export const POST = handle<typeof ROUTES.pauseEnd, { id: string }>(
  ROUTES.pauseEnd,
  async ({ app, body, params, now, config, actor }) => {
    await actor(body.actor_discord_id, { required: true });
    return endPause(app.db, params.id, { now, config });
  },
);
