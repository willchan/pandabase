// `withAuth(scopes, handler)` — the one wrapper on every API route (DESIGN §3.1):
// authenticate → check scope → replay idempotent requests → run → store for replay → record
// latency telemetry.
import { idempotencyKey, member } from "@pandabase/db";
import { and, asc, eq } from "drizzle-orm";
import { appContext, type AppContext } from "../context";
import type { Scope } from "../contracts/routes";
import { ApiError, errorResponse, forbidden } from "../http";
import { recordApiRequest } from "../telemetry";
import { devBypassEnabled, isAllowedEmail } from "./allowlist";
import { resolveSession } from "./session";
import { bearerToken, scopeForToken } from "./tokens";

export interface Principal {
  scope: Scope;
  /** Signed-in member (session scope). */
  memberId: string | null;
}

/** Who a write is attributed to: a member, a system, or both (agent acting for a member). */
export interface Actor {
  memberId: string | null;
  system: "agent" | "worker" | "cron" | null;
}

export interface AuthedContext<P> {
  req: Request;
  principal: Principal;
  params: P;
  app: AppContext;
  /**
   * Resolve the actor. Agent writes name the human with `actor_discord_id` (unknown → 403;
   * missing → 400 when `required`). Sessions act as their member; worker/cron as systems.
   */
  actor(discordId: string | null | undefined, opts?: { required?: boolean }): Promise<Actor>;
}

export interface WithAuthOptions {
  /** Route pattern for telemetry and idempotency scoping, e.g. `POST /api/jobs`. */
  route: string;
  /** Honor `Idempotency-Key`. */
  idempotent?: boolean;
}

const MAX_IDEMPOTENCY_KEY = 200;

async function authenticate(req: Request, app: AppContext): Promise<Principal | Response> {
  const token = bearerToken(req);
  if (token !== null) {
    const scope = scopeForToken(token);
    return scope ? { scope, memberId: null } : errorResponse(401, "invalid token");
  }
  if (devBypassEnabled()) {
    const [m] = await app.db.select().from(member).orderBy(asc(member.email)).limit(1);
    return { scope: "session", memberId: m?.id ?? null };
  }
  const session = await resolveSession(req);
  if (!session) return errorResponse(401, "authentication required");
  if (!isAllowedEmail(session.email)) return errorResponse(403, "email not allowed");
  const [m] = await app.db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.email, session.email.toLowerCase()));
  // Like the UI's NotAMember: an allowed email acts only once it has a member row.
  if (!m) return errorResponse(403, "not a household member");
  return { scope: "session", memberId: m.id };
}

/** Sessions have every scope except cron's (DESIGN §3.1). */
export const scopeAllowed = (scopes: readonly Scope[], scope: Scope): boolean =>
  scopes.includes(scope) || (scope === "session" && scopes.some((s) => s !== "cron"));

export function withAuth<P = Record<string, never>>(
  scopes: readonly Scope[],
  handler: (ctx: AuthedContext<P>) => Promise<Response>,
  opts: WithAuthOptions,
): (req: Request, routeCtx?: { params: Promise<P> }) => Promise<Response> {
  return async (req, routeCtx) => {
    const app = appContext();
    // Every API route is request-bound: never prerender (or run) it at build time. Outside the
    // try below so Next's prerender interrupt isn't swallowed as an error.
    await app.requestBoundary();
    const started = performance.now();
    let scope: Scope | null = null;
    let res: Response;
    try {
      res = await run();
    } catch (err) {
      res = toErrorResponse(err);
    }
    await recordApiRequest(app.db, app.now(), {
      route: opts.route,
      method: req.method,
      status: res.status,
      latencyMs: Math.round(performance.now() - started),
      scope,
    });
    return res;

    async function run(): Promise<Response> {
      const principal = await authenticate(req, app);
      if (principal instanceof Response) return principal;
      scope = principal.scope;
      if (!scopeAllowed(scopes, principal.scope)) {
        return errorResponse(403, `scope ${principal.scope} may not call ${opts.route}`);
      }

      const key = opts.idempotent ? req.headers.get("idempotency-key")?.trim() || null : null;
      if (key && key.length > MAX_IDEMPOTENCY_KEY) {
        return errorResponse(400, "Idempotency-Key too long");
      }
      // The concrete path, not the route pattern: a key reused on another cycle/job must not
      // replay the first one's response.
      const keyScope = `${principal.scope}:${req.method} ${new URL(req.url).pathname}`;
      if (key) {
        const [stored] = await app.db
          .select()
          .from(idempotencyKey)
          .where(and(eq(idempotencyKey.key, key), eq(idempotencyKey.scope, keyScope)));
        if (stored) {
          return Response.json(stored.responseBody, {
            status: stored.responseStatus,
            headers: { "idempotent-replayed": "true" },
          });
        }
      }

      const params = ((await routeCtx?.params) ?? {}) as P;
      let res: Response;
      try {
        res = await handler({
          req,
          principal,
          params,
          app,
          actor: (discordId, o) => resolveActor(app, principal, discordId, o?.required ?? false),
        });
      } catch (err) {
        res = toErrorResponse(err);
      }

      // Store successes and client errors for replay; a 5xx may succeed on retry.
      if (key && res.status < 500) {
        const body = await res
          .clone()
          .json()
          .catch(() => null);
        await app.db
          .insert(idempotencyKey)
          .values({
            key,
            scope: keyScope,
            responseStatus: res.status,
            responseBody: body,
            createdAt: app.now(),
          })
          .onConflictDoNothing();
      }
      return res;
    }
  };
}

async function resolveActor(
  app: AppContext,
  principal: Principal,
  discordId: string | null | undefined,
  required: boolean,
): Promise<Actor> {
  if (principal.scope === "session") return { memberId: principal.memberId, system: null };
  if (principal.scope !== "agent") return { memberId: null, system: principal.scope };
  if (!discordId) {
    if (required) throw new ApiError(400, "actor_discord_id is required");
    return { memberId: null, system: "agent" };
  }
  const [m] = await app.db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.discordUserId, discordId));
  if (!m) throw forbidden(`unknown actor_discord_id ${discordId}`);
  return { memberId: m.id, system: "agent" };
}

function toErrorResponse(err: unknown): Response {
  if (err instanceof ApiError) return errorResponse(err.status, err.message, err.details);
  console.error(err);
  return errorResponse(500, "internal error");
}
