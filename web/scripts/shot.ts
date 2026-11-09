// `pnpm --filter web shot [paths…]` (docs/TESTING.md "Verification loops"): phone screenshots
// (390×844 @2x) of each path in light and dark, signed in through the dev bypass. Starts its own
// `dev-seeded` server unless --base-url / SHOT_BASE_URL points at a running one; --prod-copy starts
// `dev-prod-copy` instead (shots then go to .shots/prod-copy/ and must never leave this machine).
// Prints every console error, page error and failed request, and exits 1 if there were any.
import { chromium, type Page } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { prepareDevServer, SEEDED_EMAILS, startNext } from "./dev-server";

const LOCAL_CHROMIUM = "/opt/pw-browsers/chromium";
const SCHEMES = ["light", "dark"] as const;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "base-url": { type: "string" },
    email: { type: "string" },
    "prod-copy": { type: "boolean", default: false },
    out: { type: "string" },
    port: { type: "string", default: "3211" },
  },
});
const paths = positionals.length ? positionals : ["/"];
const prodCopy = values["prod-copy"];
const out = path.resolve(
  import.meta.dirname,
  "..",
  values.out ?? (prodCopy ? ".shots/prod-copy" : ".shots"),
);

/** `/cleanup/receipts/abc?x=1` → `cleanup-receipts-abc-x-1`; `/` → `home`. */
const slug = (p: string) => p.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";

async function waitFor(url: string, ms: number, alive: () => boolean) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error("the dev server exited before it was ready");
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${url}`);
}

let baseUrl = values["base-url"] ?? process.env.SHOT_BASE_URL;
let email = values.email ?? process.env.SHOT_EMAIL ?? SEEDED_EMAILS[0]!;
let stop = () => {};
let serverLog = "";
if (!baseUrl) {
  const server = await prepareDevServer(prodCopy ? "prod-copy" : "seeded");
  email = values.email ?? server.email;
  const child = startNext(server, Number(values.port), true);
  child.stdout?.on("data", (d) => (serverLog += d));
  child.stderr?.on("data", (d) => (serverLog += d));
  stop = () => child.kill("SIGTERM");
  baseUrl = `http://localhost:${values.port}`;
  try {
    await waitFor(`${baseUrl}/sign-in`, 180_000, () => child.exitCode === null);
  } catch (err) {
    stop();
    console.error(`${(err as Error).message}\n${serverLog}`);
    process.exit(1);
  }
}

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (existsSync(LOCAL_CHROMIUM) ? LOCAL_CHROMIUM : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
mkdirSync(out, { recursive: true });
const problems: string[] = [];
const files: string[] = [];

async function signIn(page: Page) {
  await page.goto(`${baseUrl}/sign-in`);
  await page.getByRole("button", { name: `Continue as ${email}` }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 60_000 });
}

try {
  for (const scheme of SCHEMES) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      colorScheme: scheme,
    });
    // Hide the Next dev-tools badge; real errors are still caught below.
    await context.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const s = document.createElement("style");
        s.textContent = "nextjs-portal { display: none !important; }";
        document.head.append(s);
      });
    });
    const page = await context.newPage();
    let current = "sign-in";
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`[${scheme} ${current}] console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`[${scheme} ${current}] page error: ${e.message}`));
    page.on("requestfailed", (r) => {
      const err = r.failure()?.errorText ?? "";
      // Navigations and RSC prefetches cancelled by the next navigation aren't failures.
      if (!err.includes("ERR_ABORTED"))
        problems.push(`[${scheme} ${current}] request failed: ${r.method()} ${r.url()} ${err}`);
    });
    page.on("response", (r) => {
      if (r.status() >= 400)
        problems.push(
          `[${scheme} ${current}] HTTP ${r.status()}: ${r.request().method()} ${r.url()}`,
        );
    });
    await signIn(page);
    for (const p of paths) {
      current = p;
      // `load` with room for a cold `next dev` compile and big pages (hundreds of reviews on
      // real data); then let the network settle, but don't fail a page that keeps polling.
      const started = Date.now();
      await page.goto(new URL(p, baseUrl).href, { waitUntil: "load", timeout: 120_000 });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      console.log(`${p} [${scheme}] loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      await page.waitForTimeout(300);
      const file = path.join(out, `${slug(p)}-${scheme}.png`);
      // A `fullPage` capture leaves fixed elements (the bottom nav) where the first screen put
      // them, mid-image; growing the viewport to the page height puts them at the bottom.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: 390, height: Math.max(844, height) });
      await page.waitForTimeout(150);
      await page.screenshot({ path: file });
      await page.setViewportSize({ width: 390, height: 844 });
      files.push(file);
    }
    await context.close();
  }
} catch (err) {
  problems.push(`shot failed: ${(err as Error).message}`);
} finally {
  await browser.close();
  stop();
}

for (const f of files) console.log(path.relative(process.cwd(), f));
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`\n${files.length} screenshot(s), no console errors or failed requests`);
process.exit(0);
