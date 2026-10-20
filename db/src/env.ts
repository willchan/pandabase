import { fileURLToPath } from "node:url";

/** Local default: `db/dev.db`, resolved absolutely so every package's scripts share one file. */
export const DEFAULT_DATABASE_URL = `file:${fileURLToPath(new URL("../dev.db", import.meta.url))}`;

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.TURSO_DATABASE_URL || DEFAULT_DATABASE_URL;
}
