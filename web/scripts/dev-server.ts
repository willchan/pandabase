// Local `next dev` for verifying changes (docs/TESTING.md "Verification loops"; the `dev-seeded`
// and `dev-prod-copy` entries in .claude/launch.json, and `pnpm shot`).
//
//   seeded     a throwaway db/dev-seeded.db with the synthetic seed (as web/e2e/seed-db.ts), the
//              dev sign-in as the fake alex@ / sam@example.com.
//   prod-copy  the local prod copy (`make prod-copy` → .scratch/prod-copy.db), the dev sign-in as
//              one real member. Refuses unless TURSO_DATABASE_URL is a `file:` URL.
//
// Both blank every secret that could reach a real service (Turso token, Google, R2, agent/worker
// tokens): Next keeps a variable that is already set, even to "", over any .env file.
import { createClient } from "@libsql/client";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { seedFreshFile } from "./seed-file";

export type DevMode = "seeded" | "prod-copy";

const REPO = path.resolve(import.meta.dirname, "..", "..");
export const SEEDED_DB = path.join(REPO, "db", "dev-seeded.db");
export const PROD_COPY_DB = path.join(REPO, ".scratch", "prod-copy.db");
export const SEEDED_EMAILS = ["alex@example.com", "sam@example.com"];

/** Blanked in the child's env so neither process.env nor a .env file can supply them. */
export const BLANKED = [
  "TURSO_AUTH_TOKEN",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AGENT_API_TOKEN",
  "WORKER_API_TOKEN",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "PROD_RO_TURSO_URL",
  "PROD_RO_TURSO_TOKEN",
];

export interface DevServer {
  env: NodeJS.ProcessEnv;
  /** The email the dev sign-in button signs in as. */
  email: string;
}

/** Why `url` may not back the prod-copy server, or null when it may. */
export function prodCopyRefusal(url: string | undefined): string | null {
  if (!url) return "TURSO_DATABASE_URL is not set";
  if (!url.startsWith("file:"))
    return "TURSO_DATABASE_URL must be a file: URL (the local prod copy), never a remote database";
  if (!existsSync(url.slice("file:".length)))
    return `${url} does not exist: run \`make prod-copy\` first`;
  return null;
}

/** The member to sign in as: PROD_COPY_MEMBER (an email) if it is one, else the first created. */
export async function pickMember(url: string, wanted?: string): Promise<string> {
  const db = createClient({ url });
  try {
    const rows = (await db.execute("SELECT email FROM member ORDER BY created_at, id")).rows;
    const emails = rows.map((r) => String(r.email).toLowerCase());
    if (emails.length === 0) throw new Error("the prod copy has no members");
    if (!wanted) return emails[0]!;
    if (!emails.includes(wanted.toLowerCase()))
      throw new Error("PROD_COPY_MEMBER is not a member in the prod copy");
    return wanted.toLowerCase();
  } finally {
    db.close();
  }
}

export async function prepareDevServer(
  mode: DevMode,
  base: NodeJS.ProcessEnv = process.env,
): Promise<DevServer> {
  const env: NodeJS.ProcessEnv = {
    ...base,
    DEV_AUTH_BYPASS: "1",
    AUTH_SECRET: "dev-only-secret-not-for-production-use",
    AUTH_TRUST_HOST: "true",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  for (const k of BLANKED) env[k] = "";
  let email: string;
  if (mode === "seeded") {
    await seedFreshFile(SEEDED_DB);
    env.TURSO_DATABASE_URL = `file:${SEEDED_DB}`;
    env.ALLOWED_EMAILS = SEEDED_EMAILS.join(",");
    env.NEXT_DIST_DIR = ".next-seeded";
    email = SEEDED_EMAILS[0]!;
  } else {
    const url = base.TURSO_DATABASE_URL || `file:${PROD_COPY_DB}`;
    const refusal = prodCopyRefusal(url);
    if (refusal) throw new Error(`dev-prod-copy refused: ${refusal}`);
    env.TURSO_DATABASE_URL = url;
    email = await pickMember(url, base.PROD_COPY_MEMBER);
    env.ALLOWED_EMAILS = email;
    env.NEXT_DIST_DIR = ".next-prod-copy";
  }
  return { env, email };
}

export function startNext(server: DevServer, port: number, quiet = false): ChildProcess {
  return spawn("pnpm", ["exec", "next", "dev", "--port", String(port)], {
    cwd: path.join(REPO, "web"),
    env: server.env,
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({
    options: { mode: { type: "string", default: "seeded" }, port: { type: "string" } },
  });
  const mode = values.mode as DevMode;
  if (mode !== "seeded" && mode !== "prod-copy") {
    console.error("--mode must be seeded or prod-copy");
    process.exit(2);
  }
  const port = Number(values.port ?? process.env.PORT ?? 3000);
  try {
    const server = await prepareDevServer(mode);
    // The member's email is personal data: say which kind of sign-in, not who.
    console.log(
      mode === "seeded"
        ? `dev-seeded: ${SEEDED_DB}, sign in as ${server.email}`
        : "dev-prod-copy: .scratch/prod-copy.db, sign in with the one 'Continue as' button",
    );
    const child = startNext(server, port);
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
    child.on("exit", (code) => process.exit(code ?? 0));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
