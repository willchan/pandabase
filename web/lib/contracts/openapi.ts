// OpenAPI 3.1 document from the contract registry and the route table. Deterministic: schemas
// and paths are emitted in sorted order so `pnpm contracts:gen` is stable.
import { z } from "zod";
import { ErrorResponse } from "./common";
import { registry } from "./registry";
import { ROUTES, type RouteDef } from "./routes";

const REF = (id: string) => `#/components/schemas/${id}`;

const idOf = (schema: z.ZodType | undefined): string => {
  const id = schema ? registry.get(schema)?.id : undefined;
  if (!id) throw new Error("every route body/query/response schema must be registered (named)");
  return id;
};

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
        )
      : v;

/**
 * Normalize Zod's JSON Schema for codegen: `anyOf: [X, {type: null}]` with an inline X becomes
 * `type: [X.type, "null"]` (Pydantic gets `str | None`, not a wrapper model), and the regex Zod
 * adds next to `format: date | date-time` is dropped (the format says it; Pydantic rejects
 * `pattern` on dates).
 */
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v === null || typeof v !== "object") return v;
  const o = Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normalize(x)]),
  ) as Record<string, unknown>;
  if (o.format === "date" || o.format === "date-time") delete o.pattern;
  const any = o.anyOf as Record<string, unknown>[] | undefined;
  if (any?.length === 2) {
    const nul = any.findIndex((x) => x.type === "null" && Object.keys(x).length === 1);
    const other = any[1 - nul];
    if (nul !== -1 && other && typeof other.type === "string" && !("$ref" in other)) {
      delete o.anyOf;
      return { ...other, ...o, type: [other.type, "null"] };
    }
  }
  return o;
}

const SECURITY: Record<string, { type: string; scheme: string; description: string }> = {
  agent: { type: "http", scheme: "bearer", description: "AGENT_API_TOKEN" },
  worker: { type: "http", scheme: "bearer", description: "WORKER_API_TOKEN" },
  cron: { type: "http", scheme: "bearer", description: "CRON_SECRET (Vercel Cron)" },
};

function operation(r: RouteDef) {
  const params: unknown[] = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  if (r.query) {
    const json = z.toJSONSchema(r.query, { io: "input" }) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    for (const [name, schema] of Object.entries(json.properties ?? {})) {
      params.push({ name, in: "query", required: json.required?.includes(name) ?? false, schema });
    }
  }
  if (r.idempotent) {
    params.push({
      name: "Idempotency-Key",
      in: "header",
      required: false,
      description: "Replays the stored response for 24h (same key + route + scope).",
      schema: { type: "string", maxLength: 200 },
    });
  }
  const error = (description: string) => ({
    description,
    content: { "application/json": { schema: { $ref: REF("ErrorResponse") } } },
  });
  return {
    operationId: r.operationId,
    summary: r.summary,
    "x-scopes": [...r.scopes],
    security: r.scopes.filter((s) => s in SECURITY).map((s) => ({ [s]: [] })),
    ...(params.length ? { parameters: params } : {}),
    ...(r.body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: REF(idOf(r.body)) } } },
          },
        }
      : {}),
    responses: {
      "200": {
        description: "OK",
        content: { "application/json": { schema: { $ref: REF(idOf(r.response)) } } },
      },
      "400": error("Invalid request"),
      "401": error("Missing or invalid credentials"),
      "403": error("Wrong scope, or unknown actor_discord_id"),
      "404": error("Not found"),
      "409": error("Conflict (e.g. invalid cycle transition, stale job attempt)"),
    },
  };
}

export function buildOpenApi(): Record<string, unknown> {
  idOf(ErrorResponse);
  const { schemas } = z.toJSONSchema(registry, { uri: REF, io: "input" }) as unknown as {
    schemas: Record<string, Record<string, unknown>>;
  };
  // Drop per-schema `$schema`/`$id` noise; OpenAPI 3.1 components are plain JSON Schema.
  for (const s of Object.values(schemas)) {
    delete s.$schema;
    delete s.$id;
    delete s.id;
  }
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of Object.values(ROUTES) as RouteDef[]) {
    (paths[r.path] ??= {})[r.method.toLowerCase()] = operation(r);
  }
  return sortKeys(
    normalize({
      openapi: "3.1.0",
      info: {
        title: "PandaBase State Engine API",
        version: "1",
        description:
          "Generated from web/lib/contracts by `pnpm contracts:gen` — do not edit. See docs/DESIGN.md §3.",
      },
      components: { schemas, securitySchemes: SECURITY },
      paths,
    }),
  ) as Record<string, unknown>;
}
