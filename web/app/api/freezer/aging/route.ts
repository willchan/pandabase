import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { freezerAging } from "@/lib/services/inventory";

export const GET = handle(ROUTES.freezerAging, async ({ app, query, now, config }) => ({
  items: await freezerAging(app.db, query.limit ?? config.checkin.freezerOldest, { now, config }),
}));
