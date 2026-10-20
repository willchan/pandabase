import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { setCycleStatus } from "@/lib/services/cycles";

export const POST = handle<typeof ROUTES.cycleStatus, { id: string }>(
  ROUTES.cycleStatus,
  async ({ app, body, params, now, config, actor }) =>
    setCycleStatus(
      app.db,
      params.id,
      { status: body.status, reason: body.reason ?? null },
      { now, config, actor: await actor(body.actor_discord_id) },
    ),
);
