import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { currentCycle } from "@/lib/services/cycles";
import { relevantPause, toPause } from "@/lib/services/pauses";

export const GET = handle(ROUTES.cycleCurrent, async ({ app, now, config }) => {
  const cycle = await currentCycle(app.db);
  const pause = await relevantPause(app.db, { now, config }, cycle?.week_label ?? null);
  return { cycle, pause: pause ? toPause(pause) : null };
});
