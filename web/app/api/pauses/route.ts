import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { createPause } from "@/lib/services/pauses";

export const POST = handle(ROUTES.pauses, async ({ app, body, now, config, actor }) =>
  createPause(
    app.db,
    { startsOn: body.starts_on, endsOn: body.ends_on, note: body.note ?? null },
    { now, config, actor: await actor(body.actor_discord_id, { required: true }) },
  ),
);
