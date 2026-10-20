import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { recordCartResult } from "@/lib/services/cycles";

export const POST = handle<typeof ROUTES.cycleCartResult, { id: string }>(
  ROUTES.cycleCartResult,
  async ({ app, body, params, now, config, actor }) =>
    recordCartResult(app.db, params.id, body, { now, config, actor: await actor(null) }),
);
