import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { recordInventoryEvents } from "@/lib/services/inventory";

export const POST = handle(
  ROUTES.inventoryEvents,
  async ({ app, body, now, config, actor, idempotencyKey }) =>
    recordInventoryEvents(app.db, body.events, {
      now,
      config,
      actor: await actor(body.actor_discord_id, { required: true }),
      idempotencyKey,
    }),
);
