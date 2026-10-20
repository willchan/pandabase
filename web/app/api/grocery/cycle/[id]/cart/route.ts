import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { cart } from "@/lib/services/cycles";

export const GET = handle<typeof ROUTES.cycleCart, { id: string }>(
  ROUTES.cycleCart,
  async ({ app, params, now, config }) => cart(app.db, params.id, { now, config }),
);
