// Table view: eligibility, sorting, query swap, fallback.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

const scores = [30, 5, 100, 2, 88, 7, 61, 19, 44, 73, 11, 56];
const arrayPayload = JSON.stringify(
  Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    name: `row ${String.fromCharCode(122 - i)}`,
    score: scores[i],
    nested: { a: 1, b: 2 },
  }))
);
const objectPayload = JSON.stringify({ id: 1, name: "single object" });

let context: BrowserContext;
let page: Page;
let server: FixtureServer;

test.beforeAll(async () => {
  server = await serveJson((url) =>
    url.includes("object") ? objectPayload : arrayPayload
  );
  context = await launchWithExtension();
  page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
  await context.close();
  server.close();
});

async function load(path: string) {
  await page.goto(`http://127.0.0.1:${server.port}${path}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#jv-root .jv-line", { timeout: 20000 });
  await page.waitForTimeout(500);
}

const firstScore = () =>
  page
    .locator(".jv-table-row")
    .first()
    .locator(".jv-table-cell")
    .nth(3)
    .textContent();

test.describe.configure({ mode: "serial" });

test("table enabled for an array of objects and renders all rows", async () => {
  await load("/array.json");
  const tableBtn = page.locator('.jv-view-btn[data-view="table"]');
  await expect(tableBtn).toBeEnabled();
  await tableBtn.click();
  await page.waitForSelector(".jv-table-row");
  await expect(page.locator(".jv-table-row:visible")).toHaveCount(12);
});

test("numeric column sorts asc, desc, then back to original order", async () => {
  const scoreTh = page.locator(".jv-table-header .jv-table-th").nth(3);
  await scoreTh.click();
  await page.waitForTimeout(300);
  expect((await firstScore())?.trim()).toBe("2");
  await scoreTh.click();
  await page.waitForTimeout(300);
  expect((await firstScore())?.trim()).toBe("100");
  await scoreTh.click();
  await page.waitForTimeout(300);
  expect((await firstScore())?.trim()).toBe("30");
});

test("JMESPath query result renders in the table", async () => {
  await page.click("#jv-query-toggle");
  await page.fill("#jv-query-input", "[?score > `50`]");
  await page.click("#jv-query-run");
  await page.waitForTimeout(800);
  await expect(page.locator(".jv-table-row:visible")).toHaveCount(5);
});

test("scalar query result falls back to tree and disables the table", async () => {
  await page.fill("#jv-query-input", "length(@)");
  await page.click("#jv-query-run");
  await page.waitForTimeout(800);
  await expect(page.locator(".jv-view-btn.jv-active")).toHaveAttribute(
    "data-view",
    "tree"
  );
  await expect(page.locator('.jv-view-btn[data-view="table"]')).toBeDisabled();
});

test("clearing the query re-enables the table", async () => {
  await page.click("#jv-query-chip-clear");
  await page.waitForTimeout(800);
  await expect(page.locator('.jv-view-btn[data-view="table"]')).toBeEnabled();
});

test("single-object root disables the table with an explanatory tooltip", async () => {
  await load("/object.json");
  const tableBtn = page.locator('.jv-view-btn[data-view="table"]');
  await expect(tableBtn).toBeDisabled();
  expect(((await tableBtn.getAttribute("title")) ?? "").length).toBeGreaterThan(5);
});
