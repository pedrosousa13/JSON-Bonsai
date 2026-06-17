// Per-origin prefs: view + level persist across reload, isolated per origin.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

const payload = JSON.stringify({
  a: { b: { c: { d: 1 } } },
  list: [1, 2, 3],
  name: "prefs-test",
});

let context: BrowserContext;
let page: Page;
let server: FixtureServer;

test.beforeAll(async () => {
  server = await serveJson(payload);
  context = await launchWithExtension();
  page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
  await context.close();
  server.close();
});

async function load(host: string) {
  await page.goto(`http://${host}:${server.port}/data.json`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#jv-root .jv-line, #jv-root pre", {
    timeout: 20000,
  });
  await page.waitForTimeout(600);
}

const activeView = () =>
  page.$eval(".jv-view-btn.jv-active", (el) => (el as HTMLElement).dataset.view);

test.describe.configure({ mode: "serial" });

test("default view is tree", async () => {
  await load("127.0.0.1");
  expect(await activeView()).toBe("tree");
});

test("formatted view restored after reload", async () => {
  await page.click('.jv-view-btn[data-view="formatted"]');
  await page.waitForTimeout(600); // past the 250ms write debounce
  await load("127.0.0.1");
  expect(await activeView()).toBe("formatted");
});

test("tree view and explicit level restored after reload", async () => {
  await page.click('.jv-view-btn[data-view="tree"]');
  await page.keyboard.press("2"); // collapse to depth 2 via the stepper path
  await expect(page.locator("#jv-level-value")).toHaveText("2");
  await page.waitForTimeout(600);
  await load("127.0.0.1");
  expect(await activeView()).toBe("tree");
  await expect(page.locator("#jv-level-value")).toHaveText("2");
});

test("a different origin keeps defaults", async () => {
  // localhost and 127.0.0.1 are distinct origins
  await load("localhost");
  expect(await activeView()).toBe("tree");
  await expect(page.locator("#jv-level-value")).toHaveText("All");
});
