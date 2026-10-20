import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { recordPriceQuotes } from "@/lib/services/cycles";

export const POST = handle(ROUTES.priceQuotes, async ({ app, body, now, config, actor }) =>
  recordPriceQuotes(app.db, body, { now, config, actor: await actor(null) }),
);
