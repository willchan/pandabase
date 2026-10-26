// Scope enforcement on every route (agent / worker / session / cron / none), actor resolution,
// idempotent replay, validation errors, and the API latency middleware.
import { idempotencyKey, systemTelemetry, auditJob } from "@pandabase/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES, type RouteName, type Scope } from "@/lib/contracts";
import { ALEX, setup, type Auth, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(() => h.close());

const handlerOf = (name: RouteName) => HANDLERS[name][ROUTES[name].method]!;
const pathOf = (name: RouteName) => ROUTES[name].path.replace("{id}", "x");
const call = (name: RouteName, auth: Auth, body?: unknown) =>
  h.call(handlerOf(name), pathOf(name), {
    auth,
    params: { id: "x" },
    body: ROUTES[name].method === "POST" ? (body ?? {}) : undefined,
  });

const names = Object.keys(ROUTES) as RouteName[];
const machine: Exclude<Scope, "session">[] = ["agent", "worker", "cron"];

describe("scope enforcement — every route", () => {
  it.each(names)("%s: no credentials → 401, bad token → 401", async (name) => {
    expect((await call(name, "none")).status).toBe(401);
    expect((await call(name, { bearer: "nope" })).status).toBe(401);
  });

  it.each(names)("%s: only its scopes pass", async (name) => {
    const scopes: readonly Scope[] = ROUTES[name].scopes;
    for (const scope of machine) {
      const { status } = await call(name, scope);
      if (scopes.includes(scope)) expect(status, `${scope} on ${name}`).not.toBeOneOf([401, 403]);
      else expect(status, `${scope} on ${name}`).toBe(403);
    }
  });

  it.each(names)("%s: a session has every scope but cron's", async (name) => {
    const { status } = await call(name, "session");
    if (ROUTES[name].scopes.includes("cron")) expect(status).toBe(403);
    else expect(status).not.toBeOneOf([401, 403]);
  });

  it("every route handler exists for its contract method", () => {
    for (const name of names) expect(typeof handlerOf(name), name).toBe("function");
  });
});

describe("session auth", () => {
  it("rejects emails outside ALLOWED_EMAILS", async () => {
    h.session.email = "stranger@example.com";
    expect((await call("cycleCurrent", "session")).status).toBe(403);
  });

  // Security review (tier A PR): pages already send an allowed email without a member row to
  // NotAMember, but the API let it act with every non-cron scope, attributed to nobody.
  it("an allowed email without a member row may not call the API", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "alex@example.com,sam@example.com,new@example.com");
    h.session.email = "new@example.com";
    const res = await call("cycleCurrent", "session");
    expect(res).toMatchObject({ status: 403, body: { error: "not a household member" } });
  });

  it("DEV_AUTH_BYPASS works only in development", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect((await call("cycleCurrent", "none")).status).toBe(401);
    vi.stubEnv("NODE_ENV", "development");
    expect((await call("cycleCurrent", "none")).status).toBe(200);
  });

  it("acts as the signed-in member", async () => {
    h.session.email = "sam@example.com";
    const res = await h.call(HANDLERS.awayPeriods.POST, "/api/away-periods", {
      auth: "session",
      body: { actor_discord_id: "ignored", starts_on: "2026-11-01", ends_on: "2026-11-03" },
    });
    expect(res.status).toBe(200);
  });
});

describe("actor resolution", () => {
  const writes: [RouteName, Record<string, unknown>][] = [
    ["inventoryEvents", { events: [{ item_id: "x", kind: "consumed" }] }],
    ["cycleOverrides", { kind: "add", free_text: "candles" }],
    [
      "receiptsIngest",
      { source: "digital", vendor: "amazon", acquired_at: "2026-10-20T16:00:00Z", lines: [] },
    ],
    ["jobsCreate", { job_type: "trash_cam", media_r2_key: "media/x.jpg" }],
    ["awayPeriods", { starts_on: "2026-11-01", ends_on: "2026-11-02" }],
    ["productReject", {}],
  ];
  it.each(writes)("%s: unknown actor_discord_id → 403, missing → 400", async (name, body) => {
    const unknown = await call(name, "agent", { ...body, actor_discord_id: "999" });
    expect(unknown.status).toBe(403);
    expect(unknown.body).toMatchObject({ error: "unknown actor_discord_id 999" });
    const missing = await call(name, "agent", body);
    expect(missing.status).toBe(400);
  });
});

describe("validation", () => {
  // Security review (tier A PR): any string ≤ 200 chars was accepted, so the agent token could
  // have the worker fetch (and the app presign) any key in the bucket.
  it.each(["keyframes/01JOB/0.jpg", "media/../keyframes/x.jpg", "media/x.txt", "/media/x.jpg"])(
    "jobs only take an uploaded media/ key (%s → 400)",
    async (key) => {
      const res = await h.call(HANDLERS.jobsCreate.POST, "/api/jobs", {
        body: { actor_discord_id: ALEX, job_type: "trash_cam", media_r2_key: key },
      });
      expect(res.status).toBe(400);
    },
  );

  it("rejects invalid JSON and contract violations with 400 + issue paths", async () => {
    const bad = await h.call(HANDLERS.jobsCreate.POST, "/api/jobs", { body: "{nope" });
    expect(bad).toMatchObject({ status: 400, body: { error: "body is not valid JSON" } });
    const invalid = await h.call(HANDLERS.jobsCreate.POST, "/api/jobs", {
      body: { actor_discord_id: ALEX, job_type: "video" },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: "invalid body", details: [{ path: "job_type" }] });
    const query = await h.call(HANDLERS.itemsLookup.GET, "/api/items/lookup");
    expect(query).toMatchObject({ status: 400, body: { error: "invalid query" } });
  });
});

describe("idempotency", () => {
  const job = {
    actor_discord_id: ALEX,
    job_type: "trash_cam",
    media_r2_key: "media/2026/10/a.jpg",
  };

  it("replays the stored response for the same key and creates nothing new", async () => {
    const headers = { "idempotency-key": "k-1" };
    const first = await h.call(HANDLERS.jobsCreate.POST, "/api/jobs", { body: job, headers });
    h.advance(60_000);
    const second = await h.call(HANDLERS.jobsCreate.POST, "/api/jobs", { body: job, headers });
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    const id = (first.body as { job: { id: string } }).job.id;
    const rows = await h.db
      .select()
      .from(auditJob)
      .where(eq(auditJob.mediaR2Key, job.media_r2_key));
    expect(rows.map((r) => r.id)).toEqual([id]);
  });

  it("keys are scoped per route; client errors are replayed too", async () => {
    const headers = { "idempotency-key": "k-2" };
    const bad = await h.call(HANDLERS.jobsCreate.POST, "/api/jobs", {
      body: { ...job, actor_discord_id: "999" },
      headers,
    });
    expect(bad.status).toBe(403);
    const again = await h.call(HANDLERS.jobsCreate.POST, "/api/jobs", { body: job, headers });
    expect(again.status).toBe(403);
    const other = await h.call(HANDLERS.awayPeriods.POST, "/api/away-periods", {
      body: { actor_discord_id: ALEX, starts_on: "2026-12-01", ends_on: "2026-12-02" },
      headers,
    });
    expect(other.status).toBe(200);
    expect(await h.db.select().from(idempotencyKey)).toHaveLength(2);
  });

  // Security review (tier A PR): keys were scoped to the route *pattern*, so a key reused on
  // another cycle's /overrides replayed the first cycle's answer and wrote nothing.
  it("keys are scoped per path, not per route pattern", async () => {
    const headers = { "idempotency-key": "k-4" };
    const status = (id: string) =>
      h.call(HANDLERS.cycleStatus.POST, `/api/grocery/cycle/${id}/status`, {
        params: { id },
        body: { status: "nudged" },
        headers,
      });
    const first = await status("does-not-exist");
    expect(first.status).toBe(404);
    const cur = await h.call<{ cycle: { id: string } }>(
      HANDLERS.cycleCurrent.GET,
      "/api/grocery/cycle/current",
    );
    const real = await status(cur.body.cycle.id);
    expect(real.status).toBe(200);
    expect(real.headers.get("idempotent-replayed")).toBeNull();
  });

  it("GET routes and the worker claim ignore the header", async () => {
    await h.call(HANDLERS.cycleCurrent.GET, "/api/grocery/cycle/current", {
      headers: { "idempotency-key": "k-3" },
    });
    await h.call(HANDLERS.jobsClaim.POST, "/api/jobs/claim", {
      auth: "worker",
      body: {},
      headers: { "idempotency-key": "k-3" },
    });
    expect(await h.db.select().from(idempotencyKey)).toHaveLength(0);
  });
});

describe("API latency middleware", () => {
  it("records route, method, status, latency and scope for every request", async () => {
    await h.call(HANDLERS.cycleCurrent.GET, "/api/grocery/cycle/current");
    await h.call(HANDLERS.cycleCurrent.GET, "/api/grocery/cycle/current", { auth: "worker" });
    const rows = await h.db
      .select()
      .from(systemTelemetry)
      .where(eq(systemTelemetry.metricType, "api_request"));
    expect(rows.map((r) => r.payload)).toEqual([
      expect.objectContaining({
        route: "GET /api/grocery/cycle/current",
        method: "GET",
        status: 200,
        scope: "agent",
        latencyMs: expect.any(Number),
      }),
      expect.objectContaining({ status: 403, scope: "worker" }),
    ]);
    expect(rows.every((r) => r.source === "api")).toBe(true);
  });
});
