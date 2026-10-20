import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { addOverride } from "@/lib/services/cycles";

export const POST = handle<typeof ROUTES.cycleOverrides, { id: string }>(
  ROUTES.cycleOverrides,
  async ({ app, body, params, now, config, actor }) => ({
    override: await addOverride(app.db, params.id, body, {
      now,
      config,
      actor: await actor(body.actor_discord_id, { required: true }),
    }),
  }),
);
