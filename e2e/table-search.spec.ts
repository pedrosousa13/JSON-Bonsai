// Table search: the search panel filters table rows, preserves sort, and
// hands back to tree search when the view switches.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

const payload = JSON.stringify([
  { id: 1, name: "alpha", score: 30 },
  { id: 2, name: "beta", score: 5 },
  { id: 3, name: "alphabet", score: 100 },
  { id: 4, name: "gamma", score: 2 },
  { id: 5, name: "delta", score: 88 },
  { id: 6, name: "alpine", score: 7 },
]);

let context: BrowserContext;
let page: Page;
let server: FixtureServer;

test.beforeAll(async () => {
  server = await serveJson(payload);
  context = await launchWithExtension();
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`http://127.0.0.1:${server.port}/rows.json`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#jv-root .jv-line", { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.click('.jv-view-btn[data-view="table"]');
  await page.waitForSelector(".jv-table-row");
});

test.afterAll(async () => {
  await context.close();
  server.close();
});

async function search(text: string) {
  await page.fill("#jv-search-input", text);
  await page.waitForTimeout(900); // input debounce
}

test.describe.configure({ mode: "serial" });

test("typing filters rows to matching cells with a row counter", async () => {
  await page.click("#jv-search-toggle");
  await search("alp");
  await expect(page.locator(".jv-table-row:visible")).toHaveCount(3); // alpha, alphabet, alpine
  await expect(page.locator("#jv-search-status")).toContainText("3 of 6");
  expect(await page.locator(".jv-table-cell.jv-search-match").count()).toBeGreaterThan(0);
});

test("sort is preserved through filter and clear", async () => {
  // sort by score (cells: #, id, name, score → 4th header)
  await page.locator(".jv-table-header .jv-table-th").nth(3).click();
  await page.waitForTimeout(300);
  const firstName = () =>
    page.locator(".jv-table-row:visible").first().locator(".jv-table-cell").nth(2).textContent();
  // filtered + sorted asc by score: alpine(7) < alpha(30) < alphabet(100)
  expect((await firstName())?.trim()).toBe("alpine");
  await search("");
  await expect(page.locator(".jv-table-row:visible")).toHaveCount(6);
  // still sorted asc: gamma(2) first
  expect((await firstName())?.trim()).toBe("gamma");
});

test("switching views mid-search keeps both views working", async () => {
  await search("alp");
  await page.click('.jv-view-btn[data-view="tree"]');
  await page.waitForTimeout(400);
  // tree search takes over: match navigation enabled, tree lines visible
  expect(await page.locator("#jv-tree .jv-line:visible").count()).toBeGreaterThan(0);
  await page.click('.jv-view-btn[data-view="table"]');
  await page.waitForTimeout(400);
  await expect(page.locator(".jv-table-row:visible")).toHaveCount(3);
  // closing search restores everything
  await page.click("#jv-search-clear");
  await page.waitForTimeout(400);
  await expect(page.locator(".jv-table-row:visible")).toHaveCount(6);
});
