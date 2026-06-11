// Prefs × table integration: table view restores per origin, and a saved
// "table" view degrades gracefully when the same origin serves a
// non-tabular payload (regression: createTableView crashed on non-arrays).
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

const arrayPayload = JSON.stringify(
  Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `row ${i + 1}` }))
);
const objectPayload = JSON.stringify({ id: 1, name: "not an array" });

let context: BrowserContext;
let page: Page;
let server: FixtureServer;
const pageErrors: string[] = [];

test.beforeAll(async () => {
  server = await serveJson((url) =>
    url.includes("object") ? objectPayload : arrayPayload
  );
  context = await launchWithExtension();
  page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) => pageErrors.push(String(e)));
});

test.afterAll(async () => {
  await context.close();
  server.close();
});

async function load(path: string) {
  await page.goto(`http://127.0.0.1:${server.port}${path}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#jv-root", { timeout: 20000 });
  await page.waitForTimeout(700);
}

test.describe.configure({ mode: "serial" });

test("saved table view is restored with rows on reload", async () => {
  await load("/array.json");
  await page.click('.jv-view-btn[data-view="table"]');
  await page.waitForTimeout(600);
  await load("/array.json");
  await expect(page.locator(".jv-view-btn.jv-active")).toHaveAttribute(
    "data-view",
    "table"
  );
  await expect(page.locator(".jv-table-row:visible")).toHaveCount(5);
});

test("saved table view on a non-tabular doc falls back to a working tree", async () => {
  await load("/object.json");
  await expect(page.locator(".jv-view-btn.jv-active")).toHaveAttribute(
    "data-view",
    "tree"
  );
  expect(await page.locator("#jv-tree .jv-line:visible").count()).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});
