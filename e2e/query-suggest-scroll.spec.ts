// Keyboard navigation through a long autocomplete list must scroll the active
// item into view — arrowing past the visible window should follow the highlight.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

// 60 keys sharing the "field" prefix → suggest() returns its 50-item cap, far
// more than fit in the 220px dropdown.
const obj: Record<string, number> = {};
for (let i = 0; i < 60; i++) obj[`field${String(i).padStart(2, "0")}`] = i;
const payload = JSON.stringify(obj);

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
  await page.waitForTimeout(300);
});

test.afterAll(async () => {
  await context.close();
  server.close();
});

test("arrowing down keeps the highlighted suggestion in view", async () => {
  await page.click("#jv-query-toggle");
  await page.fill("#jv-query-input", "field");
  const list = page.locator("#jv-query-suggest");
  await expect(list).toBeVisible();

  // Arrow well past the visible window (~9 items in 220px).
  for (let i = 0; i < 25; i++) {
    await page.locator("#jv-query-input").press("ArrowDown");
  }

  const inView = await list.evaluate((el) => {
    const active = el.querySelector<HTMLElement>(".jv-active");
    if (!active) return { ok: false, reason: "no active item" };
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    const ok = top >= el.scrollTop && bottom <= el.scrollTop + el.clientHeight;
    return { ok, top, bottom, scrollTop: el.scrollTop, clientHeight: el.clientHeight };
  });
  expect(inView.ok, JSON.stringify(inView)).toBe(true);
});
