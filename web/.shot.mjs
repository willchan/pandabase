import { chromium } from "@playwright/test";
const [, , base, out, ...paths] = process.argv;
const scheme = process.env.SCHEME ?? "light";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: scheme,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("console:", m.text());
});
await page.goto(base + "/sign-in");
await page.getByRole("button", { name: /Continue as alex/ }).click();
await page.waitForURL(base + "/");
for (const p of paths) {
  await page.goto(base + p);
  await page.waitForLoadState("networkidle");
  const name = p === "/" ? "this-week" : p.replace(/^\//, "").replace(/\//g, "_");
  await page.screenshot({ path: `${out}/${name}-${scheme}.png`, fullPage: true });
  console.log("shot", name);
}
await browser.close();
