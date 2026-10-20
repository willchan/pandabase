// Process-wide dependencies of route handlers and services: database, clock, R2 presigner.
// Tests swap them with `setAppContext`; production builds them lazily from env.
import { createDb, type Db } from "@pandabase/db";
import { connection } from "next/server";
import path from "node:path";
import { r2FromEnv, type Presigner } from "./r2";

export interface AppContext {
  db: Db;
  /** Current instant as an ISO string (fixed in tests). */
  now: () => string;
  r2: Presigner;
  /**
   * Resolves once there is a real request (Next's `connection()`): API routes must never be
   * prerendered or run at build time. Tests, which run outside Next, pass a no-op.
   */
  requestBoundary: () => Promise<void>;
}

/**
 * `TURSO_DATABASE_URL`, else the shared local `db/dev.db`. `next dev`/`next start` run in `/web`,
 * so the default resolves from the cwd (the db package's own default resolves from its source
 * location, which isn't meaningful inside a Next bundle).
 */
export const databaseUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.TURSO_DATABASE_URL || `file:${path.resolve(process.cwd(), "..", "db", "dev.db")}`;

let base: AppContext | null = null;
let overrides: Partial<AppContext> = {};

export function appContext(): AppContext {
  base ??= {
    db: createDb({ url: databaseUrl() }),
    now: () => new Date().toISOString(),
    r2: r2FromEnv(),
    requestBoundary: connection,
  };
  return { ...base, ...overrides };
}

/** Replace parts of the context (tests). Pass `{}` to restore the defaults. */
export function setAppContext(next: Partial<AppContext>): void {
  overrides = next;
}
