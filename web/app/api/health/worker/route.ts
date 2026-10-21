import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { workerHealth } from "@/lib/services/maintenance";

export const GET = handle(ROUTES.workerHealth, async ({ app }) => workerHealth(app.db));
