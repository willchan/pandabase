import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { setCostcoTripStatus } from "@/lib/services/costco";

export const POST = handle<typeof ROUTES.costcoTripStatus, { id: string }>(
  ROUTES.costcoTripStatus,
  async ({ app, body, params, now, config, actor }) =>
    setCostcoTripStatus(
      app.db,
      params.id,
      { status: body.status, reason: body.reason ?? null },
      { now, config, actor: await actor(body.actor_discord_id) },
    ),
);
