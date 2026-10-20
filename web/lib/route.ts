// Build a Next route handler from a contract route definition: `withAuth` + Zod validation of
// query/body. Handlers return the response object (validated against the contract's type).
import type { z } from "zod";
import type { RouteDef } from "./contracts/routes";
import { badRequest } from "./http";
import { withAuth, type AuthedContext } from "./auth/withAuth";
import type { Config } from "./config";
import { loadConfig } from "./repo/settings";
import { emitTelemetry } from "./telemetry";

type Out<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface RouteContext<D extends RouteDef, P> extends AuthedContext<P> {
  body: Out<D["body"]>;
  query: Out<D["query"]>;
  config: Config;
  /** Request time (one value per request). */
  now: string;
  /** The request's `Idempotency-Key`, if any. */
  idempotencyKey: string | null;
}

let lastRejected = "";

export function handle<D extends RouteDef, P = Record<string, string>>(
  def: D,
  fn: (ctx: RouteContext<D, P>) => Promise<z.input<D["response"]>>,
) {
  return withAuth<P>(
    def.scopes,
    async (ctx) => {
      const url = new URL(ctx.req.url);
      const query = def.query
        ? parse(def.query, Object.fromEntries(url.searchParams), "query")
        : undefined;
      let body: unknown = undefined;
      if (def.body) {
        const raw = await ctx.req.text();
        let json: unknown;
        try {
          json = raw.trim() === "" ? {} : JSON.parse(raw);
        } catch {
          throw badRequest("body is not valid JSON");
        }
        body = parse(def.body, json, "body");
      }
      const { config, rejected } = await loadConfig(ctx.app.db);
      // Log rejected `setting` rows once per distinct set (not on every request).
      const sig = rejected.join(",");
      if (sig && sig !== lastRejected) {
        lastRejected = sig;
        await emitTelemetry(
          ctx.app.db,
          "state_engine",
          [{ metric: "settings_rejected", keys: rejected }],
          ctx.app.now(),
        );
      }
      const now = ctx.app.now();
      const idempotencyKey = ctx.req.headers.get("idempotency-key")?.trim() || null;
      const out = await fn({ ...ctx, body, query, config, now, idempotencyKey } as RouteContext<
        D,
        P
      >);
      return Response.json(out);
    },
    { route: `${def.method} ${def.path}`, idempotent: def.idempotent },
  );
}

function parse(schema: z.ZodType, value: unknown, where: string): unknown {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw badRequest(
      `invalid ${where}`,
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}
