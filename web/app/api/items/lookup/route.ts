import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { lookupItems } from "@/lib/services/inventory";

export const GET = handle(ROUTES.itemsLookup, async ({ app, query, now, config }) =>
  lookupItems(app.db, query.q, { now, config }),
);
