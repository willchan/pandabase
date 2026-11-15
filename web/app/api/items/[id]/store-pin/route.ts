import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { setStorePin } from "@/lib/services/costco";

export const POST = handle<typeof ROUTES.itemStorePin, { id: string }>(
  ROUTES.itemStorePin,
  async ({ app, body, params, now, config, actor }) =>
    setStorePin(app.db, params.id, body.store, {
      now,
      config,
      actor: await actor(body.actor_discord_id, { required: true }),
    }),
);
