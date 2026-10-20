// Integration-test harness: a fresh migrated in-memory libSQL database (optionally seeded), a
// controllable clock, a fake R2 presigner, stub env tokens and session — then call route
// handlers as Next would, with a `Request`.
import { createTestDb, item, member, product, type Db } from "@pandabase/db";
import { DEFAULT_SEED_NOW, seed } from "@pandabase/db/seed";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { setSessionResolver } from "@/lib/auth/session";
import { setAppContext } from "@/lib/context";
import type { Presigner } from "@/lib/r2";

export const TOKENS = {
  agent: "agent-token",
  worker: "worker-token",
  cron: "cron-secret",
} as const;
export const ALEX = "100000000000000001";
export const SAM = "100000000000000002";
export const SEED_NOW = DEFAULT_SEED_NOW;

export type Auth = keyof typeof TOKENS | "session" | "none" | { bearer: string };

export interface CallOptions {
  auth?: Auth;
  body?: unknown;
  query?: Record<string, string>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

type Handler = (req: Request, ctx: { params: Promise<never> }) => Promise<Response>;

export interface Harness {
  db: Db;
  now(): string;
  setNow(iso: string): void;
  advance(ms: number): void;
  presigned: { method: string; key: string }[];
  /** Email the stub session returns (null = signed out). */
  session: { email: string | null };
  call<T = Record<string, unknown>>(
    handler: unknown,
    path: string,
    opts?: CallOptions,
  ): Promise<{ status: number; body: T; headers: Headers }>;
  itemId(name: string): Promise<string>;
  productId(title: string): Promise<string>;
  memberId(discordId: string): Promise<string>;
  close(): void;
}

export async function setup(opts: { seed?: boolean; now?: string } = {}): Promise<Harness> {
  const db = await createTestDb();
  if (opts.seed !== false) await seed(db);
  let now = opts.now ?? SEED_NOW;
  const presigned: Harness["presigned"] = [];
  const r2: Presigner = {
    presign: async (method, key, expiresIn) => {
      presigned.push({ method, key });
      return `https://r2.test/${key}?method=${method}&expires=${expiresIn}`;
    },
  };
  setAppContext({ db, now: () => now, r2, requestBoundary: async () => {} });
  const session = { email: null as string | null };
  setSessionResolver(async () => (session.email ? { email: session.email } : null));
  vi.stubEnv("AGENT_API_TOKEN", TOKENS.agent);
  vi.stubEnv("WORKER_API_TOKEN", TOKENS.worker);
  vi.stubEnv("CRON_SECRET", TOKENS.cron);
  vi.stubEnv("ALLOWED_EMAILS", "alex@example.com, sam@example.com");
  vi.stubEnv("DEV_AUTH_BYPASS", "");
  vi.stubEnv("HOUSEHOLD_TZ", "");

  return {
    db,
    now: () => now,
    setNow: (iso) => (now = iso),
    advance: (ms) => (now = new Date(Date.parse(now) + ms).toISOString()),
    presigned,
    session,
    async call(handler, path, o = {}) {
      const url = new URL(`http://pandabase.test${path}`);
      for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
      const headers = new Headers(o.headers);
      const auth = o.auth ?? "agent";
      if (typeof auth === "object") headers.set("authorization", `Bearer ${auth.bearer}`);
      else if (auth === "session") session.email ??= "alex@example.com";
      else if (auth === "none") session.email = null;
      else headers.set("authorization", `Bearer ${TOKENS[auth]}`);
      const init: RequestInit = { method: o.body === undefined ? "GET" : "POST", headers };
      if (o.body !== undefined) {
        headers.set("content-type", "application/json");
        init.body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
      }
      const res = await (handler as Handler)(new Request(url, init), {
        params: Promise.resolve(o.params ?? {}) as Promise<never>,
      });
      const text = await res.text();
      return {
        status: res.status,
        body: (text ? JSON.parse(text) : null) as never,
        headers: res.headers,
      };
    },
    async itemId(name) {
      const [r] = await db.select({ id: item.id }).from(item).where(eq(item.canonicalName, name));
      if (!r) throw new Error(`no item ${name}`);
      return r.id;
    },
    async productId(title) {
      const [r] = await db.select({ id: product.id }).from(product).where(eq(product.title, title));
      if (!r) throw new Error(`no product ${title}`);
      return r.id;
    },
    async memberId(discordId) {
      const [r] = await db
        .select({ id: member.id })
        .from(member)
        .where(eq(member.discordUserId, discordId));
      if (!r) throw new Error(`no member ${discordId}`);
      return r.id;
    },
    close() {
      setAppContext({});
      setSessionResolver(null);
      vi.unstubAllEnvs();
      db.$client.close();
    },
  };
}
