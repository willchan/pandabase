import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { rejectProductById } from "@/lib/services/inventory";

export const POST = handle<typeof ROUTES.productReject, { id: string }>(
  ROUTES.productReject,
  async ({ app, body, params, now, config, actor }) =>
    rejectProductById(app.db, params.id, {
      now,
      config,
      actor: await actor(body.actor_discord_id, { required: true }),
    }),
);
