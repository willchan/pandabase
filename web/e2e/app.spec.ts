import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, path = "/") {
  await page.goto(path);
  await expect(page).toHaveURL(/\/sign-in/);
  await page.getByRole("button", { name: "Continue as alex@example.com" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test("sign-in gate: signed-out visitors land on /sign-in, then come back", async ({ page }) => {
  await page.goto("/pantry");
  await expect(page).toHaveURL(/\/sign-in\?callbackUrl=%2Fpantry/);
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await page.getByRole("button", { name: "Continue as alex@example.com" }).click();
  await expect(page).toHaveURL(/\/pantry$/);
  await expect(page.getByRole("heading", { name: "Pantry", level: 1 })).toBeVisible();
});

test("This Week: add a one-off item and skip a planned one", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "This Week", level: 1 })).toBeVisible();
  const cart = page.locator("section", { has: page.locator("#cart-plan") });

  await page.getByLabel("Add to the list").fill("party balloons");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Added party balloons.")).toBeVisible();
  await expect(cart.getByText("party balloons", { exact: true })).toBeVisible();
  await expect(page.locator("section", { has: page.locator("#running-list") })).toContainText(
    "Alex added party balloons",
  );

  const first = cart.locator("li details").first();
  const name = (await first.locator("summary span.font-medium").first().textContent())!;
  await first.locator("summary").click();
  await first.getByRole("button", { name: "Skip this week" }).click();
  await expect(page.getByRole("button", { name: `Add ${name} back` })).toBeVisible();
});

test("Cleanup: confirm a receipt review with one tap", async ({ page }) => {
  await signIn(page, "/cleanup");
  await page.getByRole("link", { name: /Whole Foods/ }).click();
  await expect(page.getByText("Check each line against the photo")).toBeVisible();
  await expect(page.getByLabel(/What is “BRGHTBRW GNGR KMBCHA 16”/)).toHaveValue("keep");
  await page.getByRole("button", { name: "Confirm receipt" }).click();
  await expect(page).toHaveURL(/\/cleanup\?done=receipt/);
  await expect(page.getByText("Receipt confirmed")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Receipts/ })).not.toContainText("1");
});

test("Settings: add an away period", async ({ page }) => {
  await signIn(page, "/settings");
  const d = new Date(Date.now() + 30 * 86_400_000);
  const ymd = (x: Date) => x.toISOString().slice(0, 10);
  await page.getByLabel("From").fill(ymd(d));
  await page.getByLabel("Until (incl.)").fill(ymd(new Date(d.getTime() + 3 * 86_400_000)));
  await page.getByLabel("Note").fill("Grandma's");
  await page.getByRole("button", { name: "Add away period" }).click();
  await expect(page.getByText("Away period saved")).toBeVisible();
  await expect(page.getByText("Grandma's")).toBeVisible();
});
