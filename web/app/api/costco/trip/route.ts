import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { currentCostcoTrip, planCostcoTrip } from "@/lib/services/costco";

export const GET = handle(ROUTES.costcoTripCurrent, async ({ app, now, config }) =>
  currentCostcoTrip(app.db, { now, config }),
);

export const POST = handle(ROUTES.costcoTripPlan, async ({ app, body, now, config, actor }) =>
  planCostcoTrip(
    app.db,
    { plannedFor: body.planned_for, discordThreadId: body.discord_thread_id ?? null },
    { now, config, actor: await actor(body.actor_discord_id) },
  ),
);
