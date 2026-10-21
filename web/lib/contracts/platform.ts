// Telemetry ingest, weekly diagnostics, daily maintenance (DESIGN §3.2, §7).
import { z } from "zod";
import { Timestamp } from "./common";
import { named } from "./registry";

export const TelemetryEvent = named(
  "TelemetryEvent",
  z.object({
    /** e.g. `vlm_inference`, `cart_tier1_line`, `selector_error`, `clarifying_question`. */
    metric_type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    payload: z.record(z.string(), z.unknown()),
    /** When it happened (defaults to receipt time). */
    occurred_at: Timestamp.optional(),
  }),
);
export const TelemetryRequest = named(
  "TelemetryRequest",
  z.object({ events: z.array(TelemetryEvent).min(1).max(500) }),
);
export const TelemetryResponse = named(
  "TelemetryResponse",
  z.object({ accepted: z.number().int() }),
);

/** The worker's latest `worker_heartbeat` (DESIGN §7), read by the Mac Mini deploy health check. */
export const WorkerHealthResponse = named(
  "WorkerHealthResponse",
  z.object({
    heartbeat: z
      .object({
        /** When the worker sent it (the worker's clock, i.e. the Mac Mini's). */
        at: Timestamp,
        version: z.string().nullable(),
        /** Git sha the worker image was built from (`PANDABASE_BUILD_SHA`); null for local builds. */
        sha: z.string().nullable(),
        vlm_model: z.string().nullable(),
        text_model: z.string().nullable(),
        /** null until the worker has checked Ollama once. */
        ollama_ok: z.boolean().nullable(),
      })
      .nullable(),
  }),
);

export const DiagnosticsQuery = named(
  "DiagnosticsQuery",
  z.object({
    /** ISO week (`2026-W43`); defaults to the last complete week. */
    week: z
      .string()
      .regex(/^\d{4}-W\d{2}$/)
      .optional(),
  }),
);
export const DiagnosticsResponse = named(
  "DiagnosticsResponse",
  z.object({
    week: z.string(),
    /** Write to `/diagnostics/{week}.md`. */
    markdown: z.string(),
    /** Write each to `/diagnostics/{week}/{name}`. */
    extracts: z.array(z.object({ name: z.string(), jsonl: z.string() })),
  }),
);

export const MaintenanceResponse = named(
  "MaintenanceResponse",
  z.object({
    expired_reviews: z.number().int(),
    released_leases: z.number().int(),
    failed_jobs: z.number().int(),
    presumed_discards: z.number().int(),
    purged_idempotency_keys: z.number().int(),
    purged_telemetry: z.number().int(),
    opened_cycle_id: z.string().nullable(),
    /** merge_suggest jobs queued by this run (at most weekly, §4.6). */
    merge_suggest_jobs: z.number().int(),
  }),
);
