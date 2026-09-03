// The search field's own clear and history controls, in place of Chrome's
// native search-cancel button and datalist indicator: themed, 24 px hit
// targets, keyboard-reachable, and identical in Firefox (which draws neither
// native control at all).
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

const payload = JSON.stringify({
  user: { name: "Alice", city: "Berlin" },
  items: [{ tag: "alpha" }, { tag: "beta" }],
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
  await page.click("#jv-search-toggle");
  await expect(page.locator("#jv-search-panel")).toBeVisible();
});

test.afterAll(async () => {
  await context.close();
  server.close();
});

const activeId = () => page.evaluate(() => document.activeElement?.id ?? "");

test.describe.configure({ mode: "serial" });

test("the input renders no native clear or datalist affordance", async () => {
  const input = page.locator("#jv-search-input");
  await expect(input).toHaveAttribute("type", "text");
  expect(await input.evaluate((el) => el.hasAttribute("list"))).toBe(false);
  expect(await page.locator("datalist").count()).toBe(0);
});

test("the clear button empties the field, drops highlights and refocuses", async () => {
  const clear = page.locator("#jv-search-input-clear");
  await expect(clear).toBeHidden();

  await page.fill("#jv-search-input", "alpha");
  await page.waitForTimeout(900); // input debounce
  await expect(page.locator("#jv-search-status")).toContainText("of 1");
  await expect(page.locator(".jv-line.jv-search-match")).not.toHaveCount(0);

  await expect(clear).toBeVisible();
  await expect(clear).toHaveAttribute("aria-label", "Clear search");
  const box = (await clear.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);

  await clear.click();
  await page.waitForTimeout(500);
  await expect(page.locator("#jv-search-input")).toHaveValue("");
  await expect(clear).toBeHidden();
  await expect(page.locator(".jv-line.jv-search-match")).toHaveCount(0);
  expect(await activeId()).toBe("jv-search-input");
  // Clearing the field is not closing the panel.
  await expect(page.locator("#jv-search-panel")).toBeVisible();
});

test("the history popover lists a committed term and re-runs it", async () => {
  const historyToggle = page.locator("#jv-search-history-toggle");
  // Typing alone does not commit, so nothing has been remembered yet.
  await expect(historyToggle).toBeHidden();

  await page.fill("#jv-search-input", "Berlin");
  await page.locator("#jv-search-input").press("Enter");
  await page.waitForTimeout(500);
  await expect(historyToggle).toBeVisible();

  const historyBox = (await historyToggle.boundingBox())!;
  expect(historyBox.width).toBeGreaterThanOrEqual(24);
  expect(historyBox.height).toBeGreaterThanOrEqual(24);
  await expect(historyToggle).toHaveAttribute("aria-label", "Recent searches");
  await expect(historyToggle).toHaveAttribute("aria-expanded", "false");

  // Both controls sit in the Tab order, right after the field they belong to.
  await page.locator("#jv-search-input").focus();
  await page.keyboard.press("Tab");
  expect(await activeId()).toBe("jv-search-input-clear");
  await page.keyboard.press("Tab");
  expect(await activeId()).toBe("jv-search-history-toggle");

  await page.locator("#jv-search-input-clear").click();
  await page.waitForTimeout(400);

  await historyToggle.click();
  await expect(page.locator("#jv-search-history")).toBeVisible();
  await expect(historyToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".jv-search-history-item")).toHaveText(["Berlin"]);
  // Opening moves focus into the popover so the arrows have a starting point.
  await expect(page.locator(".jv-search-history-item").first()).toBeFocused();

  // Enter picks the focused term, refills the field and runs the search.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await expect(page.locator("#jv-search-history")).toBeHidden();
  await expect(page.locator("#jv-search-input")).toHaveValue("Berlin");
  await expect(page.locator("#jv-search-status")).toContainText("of 1");
  expect(await activeId()).toBe("jv-search-input");
});

test("Escape closes the popover and leaves the search panel open", async () => {
  await page.locator("#jv-search-input-clear").click();
  await page.waitForTimeout(400);
  await page.click("#jv-search-history-toggle");
  await expect(page.locator("#jv-search-history")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#jv-search-history")).toBeHidden();
  await expect(page.locator("#jv-search-panel")).toBeVisible();
  expect(await activeId()).toBe("jv-search-history-toggle");

  // A second Escape, with no popover in the way, closes the panel itself.
  await page.keyboard.press("Escape");
  await expect(page.locator("#jv-search-panel")).toBeHidden();
});
