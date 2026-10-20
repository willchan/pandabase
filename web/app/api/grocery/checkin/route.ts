import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { checkin } from "@/lib/services/cycles";

export const GET = handle(ROUTES.checkin, async ({ app, now, config }) =>
  checkin(app.db, { now, config }),
);
