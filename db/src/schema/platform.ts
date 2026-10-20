// DESIGN §2.7 — Platform: telemetry and API idempotency.
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id, jsonCheck } from "./common";

/** Append-only; no `updated_at`. Retained 180 days. */
export const systemTelemetry = sqliteTable(
  "system_telemetry",
  {
    id: id(),
    source: text("source").notNull(),
    metricType: text("metric_type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    jsonCheck("system_telemetry", t.payload),
    index("system_telemetry_created_at_idx").on(t.createdAt),
    index("system_telemetry_metric_idx").on(t.source, t.metricType, t.createdAt),
  ],
);

/** Stored API responses for replay. Retained 24h; no `id`/`updated_at`. */
export const idempotencyKey = sqliteTable(
  "idempotency_key",
  {
    key: text("key").notNull(),
    scope: text("scope").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.scope] }),
    jsonCheck("idempotency_key", t.responseBody),
    index("idempotency_key_created_at_idx").on(t.createdAt),
  ],
);
