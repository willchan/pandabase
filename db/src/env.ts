import { fileURLToPath } from "node:url";

/**
 * Absolute path of `rel` resolved against this directory. A function rather than an inline
 * `new URL("literal", import.meta.url)` so bundlers (Next/Turbopack, when /web imports this
 * package) don't try to bundle the target as an asset.
 */
export const packagePath = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/** Local default: `db/dev.db`, resolved absolutely so every package's scripts share one file. */
export const DEFAULT_DATABASE_URL = `file:${packagePath("../dev.db")}`;

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.TURSO_DATABASE_URL || DEFAULT_DATABASE_URL;
}
