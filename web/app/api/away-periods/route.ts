import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { createAwayPeriod } from "@/lib/services/inventory";

export const POST = handle(ROUTES.awayPeriods, async ({ app, body, now, config, actor }) =>
  createAwayPeriod(
    app.db,
    { startsOn: body.starts_on, endsOn: body.ends_on, note: body.note ?? null },
    { now, config, actor: await actor(body.actor_discord_id, { required: true }) },
  ),
);
