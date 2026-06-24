// Table export: Copy CSV/TSV writes the on-screen rows (current sort + filter)
// to the clipboard, RFC 4180 escaped.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

const payload = JSON.stringify([
  { id: 1, name: "alpha", note: "Smith, John" },
  { id: 2, name: "beta", note: 'said "hi"' },
  { id: 3, name: "alphabet", note: "plain" },
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

const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());

test.describe.configure({ mode: "serial" });

test("Copy CSV puts RFC 4180 CSV of the visible rows on the clipboard", async () => {
  await page.getByRole("button", { name: "Copy CSV", exact: true }).click();
  await page.waitForTimeout(200);
  expect(await readClipboard()).toBe(
    [
      "id,name,note",
      '1,alpha,"Smith, John"',
      '2,beta,"said ""hi"""',
      "3,alphabet,plain",
    ].join("\r\n")
  );
});

test("Copy TSV uses tab delimiters", async () => {
  await page.getByRole("button", { name: "Copy TSV", exact: true }).click();
  await page.waitForTimeout(200);
  expect(await readClipboard()).toBe(
    [
      "id\tname\tnote",
      "1\talpha\tSmith, John",
      '2\tbeta\t"said ""hi"""',
      "3\talphabet\tplain",
    ].join("\r\n")
  );
});

test("export reflects the active sort and row filter", async () => {
  // Sort ascending by name (4 headers: #, id, name, note → 3rd column).
  await page.locator(".jv-table-header .jv-table-th").nth(2).click();
  await page.waitForTimeout(300);
  // Filter to the "alp" rows.
  await page.click("#jv-search-toggle");
  await page.fill("#jv-search-input", "alp");
  await page.waitForTimeout(900);
  await expect(page.locator(".jv-table-row:visible")).toHaveCount(2);

  await page.getByRole("button", { name: "Copy CSV", exact: true }).click();
  await page.waitForTimeout(200);
  // alpha and alphabet only, sorted ascending by name ("alpha" < "alphabet").
  expect(await readClipboard()).toBe(
    ["id,name,note", '1,alpha,"Smith, John"', "3,alphabet,plain"].join("\r\n")
  );
});
