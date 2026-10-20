// Writes `system_telemetry` rows (DESIGN §7). Domain functions return `{ metric, ...payload }`
// entries; services and the API middleware emit them here.
import { systemTelemetry } from "@pandabase/db";
import { ulid } from "ulid";
import type { Q } from "./repo/db";

/** Who produced the metric: the State Engine's domain/services, the API middleware, or a client. */
export type TelemetrySource = "state_engine" | "api" | "cron" | "agent" | "worker" | "session";

/** `{ metric, ...payload }` — the shape domain functions return. */
export type TelemetryEntry = { metric: string } & object;

/** Insert one row per entry: `metric_type` = `metric`, `payload` = the other fields + `extra`. */
export async function emitTelemetry<T extends TelemetryEntry>(
  q: Q,
  source: TelemetrySource,
  entries: readonly T[],
  at: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map(({ metric, ...payload }: TelemetryEntry) => ({
    id: ulid(Date.parse(at)),
    source,
    metricType: metric,
    payload: { ...payload, ...extra },
    createdAt: at,
  }));
  for (let i = 0; i < rows.length; i += 100) {
    await q.insert(systemTelemetry).values(rows.slice(i, i + 100));
  }
}

/** API latency middleware row; never fails the request. */
export async function recordApiRequest(
  q: Q,
  at: string,
  payload: {
    route: string;
    method: string;
    status: number;
    latencyMs: number;
    scope: string | null;
  },
): Promise<void> {
  try {
    await emitTelemetry(q, "api", [{ metric: "api_request", ...payload }], at);
  } catch (err) {
    console.error("telemetry: api_request not recorded", err);
  }
}
