// E2E (PLAN M5): `next dev` with DEV_AUTH_BYPASS against a freshly seeded database, phone viewport.
import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 3210);
const E2E_DB = path.resolve(import.meta.dirname, "..", "db", "e2e.db");
// The sandbox ships its own Chromium; CI installs Playwright's (`playwright install chromium`).
const LOCAL_CHROMIUM = "/opt/pw-browsers/chromium";
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (existsSync(LOCAL_CHROMIUM) ? LOCAL_CHROMIUM : undefined);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["iPhone 13"],
    browserName: "chromium",
    defaultBrowserType: "chromium",
    launchOptions: executablePath ? { executablePath } : {},
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec tsx e2e/seed-db.ts && pnpm exec next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      E2E_DB,
      TURSO_DATABASE_URL: `file:${E2E_DB}`,
      DEV_AUTH_BYPASS: "1",
      ALLOWED_EMAILS: "alex@example.com,sam@example.com",
      AUTH_SECRET: "e2e-only-secret-not-for-production-use",
      AUTH_TRUST_HOST: "true",
      NEXT_TELEMETRY_DISABLED: "1",
      // A separate build dir so the suite can run next to `pnpm dev`.
      NEXT_DIST_DIR: ".next-e2e",
    },
  },
});
