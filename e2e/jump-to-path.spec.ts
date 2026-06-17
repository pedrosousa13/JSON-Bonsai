// Jump-to-path: the G shortcut opens a path input that expands ancestors,
// scrolls the target into view, and flash-highlights its row.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

// Many top-level keys so a deep target starts collapsed and off-screen.
const payload = JSON.stringify({
  meta: { version: 1 },
  users: Array.from({ length: 60 }, (_, i) => ({
    id: i,
    name: `user ${i}`,
    profile: { city: `city ${i}` },
  })),
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

test("pressing G focuses the path input", async () => {
  await page.keyboard.press("g");
  await expect(page.locator("#jv-goto-panel")).toBeVisible();
  await expect(page.locator("#jv-goto-input")).toBeFocused();
  // Close it again so the next test starts clean.
  await page.keyboard.press("Escape");
  await expect(page.locator("#jv-goto-panel")).toBeHidden();
});

test("jumping to a path reveals and flash-highlights the target row", async () => {
  // Collapse to a shallow level so the deep target is hidden first.
  await page.keyboard.press("1");
  await page.waitForTimeout(200);

  const target = page.locator(
    '.jv-line[data-path="data.users[40].profile.city"]'
  );
  await expect(target).toHaveCount(0);

  await page.keyboard.press("g");
  await page.fill("#jv-goto-input", "users[40].profile.city");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);

  // Ancestors expanded → the row exists, is visible, and flashed.
  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/jv-goto-flash/);
});

test("an unknown path shows an inline error", async () => {
  await page.keyboard.press("g");
  await page.fill("#jv-goto-input", "users[999].name");
  await page.keyboard.press("Enter");
  await expect(page.locator("#jv-goto-error")).toBeVisible();
  await expect(page.locator("#jv-goto-error")).toContainText("No node at that path");
});
