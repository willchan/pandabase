import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { requestMergeSuggestions } from "@/lib/services/mergeSuggest";

export const POST = handle(ROUTES.mergeSuggestionsRun, async ({ app, body, now, config, actor }) =>
  requestMergeSuggestions(app.db, "backfill", {
    now,
    config,
    actor: await actor(body.actor_discord_id),
  }),
);
