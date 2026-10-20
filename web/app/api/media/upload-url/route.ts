import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { createUploadUrl } from "@/lib/services/jobs";

export const POST = handle(ROUTES.mediaUploadUrl, async ({ app, body, now, config }) =>
  createUploadUrl(app.r2, body, { now, config }),
);
