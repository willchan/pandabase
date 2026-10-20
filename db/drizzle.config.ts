import { defineConfig } from "drizzle-kit";
import { databaseUrlFromEnv } from "./src/env";

export default defineConfig({
  dialect: "turso",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: databaseUrlFromEnv(),
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  },
  strict: true,
  verbose: true,
});
