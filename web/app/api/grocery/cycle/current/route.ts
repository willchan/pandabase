import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { currentCycle } from "@/lib/services/cycles";

export const GET = handle(ROUTES.cycleCurrent, async ({ app }) => ({
  cycle: await currentCycle(app.db),
}));
