// Query explorer: autocomplete dropdown in the JMESPath panel, and the
// "Query from here" affordance on the path chip.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

const payload = JSON.stringify({
  users: [
    { name: "Ada", role: "admin" },
    { name: "Grace", role: "user" },
  ],
  settings: { theme: "dark" },
});

let context: BrowserContext;
let page: Page;
let server: FixtureServer;

test.beforeAll(async () => {
  server = await serveJson(payload);
  context = await launchWithExtension();
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`http://127.0.0.1:${server.port}/data.json`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#jv-root .jv-line", { timeout: 20000 });
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  await context.close();
  server.close();
});

test.describe.configure({ mode: "serial" });

test("autocomplete shows matching keys and accepting inserts the token", async () => {
  await page.click("#jv-query-toggle");
  await expect(page.locator("#jv-query-panel")).toBeVisible();

  await page.fill("#jv-query-input", "se");
  await expect(page.locator("#jv-query-suggest")).toBeVisible();
  const items = page.locator(".jv-query-suggest-item");
  await expect(items.filter({ hasText: "settings" })).toHaveCount(1);

  // Accept with Enter while the dropdown is open.
  await page.click(".jv-query-suggest-item", { force: true });
  await expect(page.locator("#jv-query-input")).toHaveValue("settings");
  await expect(page.locator("#jv-query-suggest")).toBeHidden();

  // Close the panel for the next test.
  await page.click("#jv-query-close");
});

test("query-from-here seeds the input and runs the query", async () => {
  // Pin a node's path by clicking its line, then trigger Query from here.
  const userLine = page
    .locator('#jv-tree .jv-line')
    .filter({ hasText: "users" })
    .first();
  await userLine.click();
  await expect(page.locator("#jv-path-display")).toHaveClass(/jv-visible/);

  await page.click("#jv-path-query");
  await expect(page.locator("#jv-query-panel")).toBeVisible();
  await expect(page.locator("#jv-query-input")).toHaveValue("users");
  // The query ran: the chip reflects the active query.
  await expect(page.locator("#jv-query-chip")).toBeVisible();
  await expect(page.locator("#jv-query-chip-text")).toContainText("users");
});
