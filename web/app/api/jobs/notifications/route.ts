import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { jobNotifications } from "@/lib/services/jobs";

export const GET = handle(ROUTES.jobsNotifications, async ({ app }) => ({
  notifications: await jobNotifications(app.db),
}));
