import { ROUTES } from "@/lib/contracts";
import { handle } from "@/lib/route";
import { ingestTelemetry } from "@/lib/services/maintenance";

export const POST = handle(ROUTES.telemetry, async ({ app, body, now, principal }) => ({
  accepted: await ingestTelemetry(
    app.db,
    principal.scope === "worker" ? "worker" : principal.scope === "agent" ? "agent" : "session",
    body.events,
    { now },
  ),
}));
