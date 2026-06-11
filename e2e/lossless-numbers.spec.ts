// Lossless numbers: exact display in tree + formatted, exact clipboard copy.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

const payload = `{"id": 9007199254740993, "snowflake": 1146169290024843337, "pi": 3.14159265358979323846, "safe": 42, "price": 19.99, "sci": 1e3}`;

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
  await page.waitForTimeout(600);
});

test.afterAll(async () => {
  await context.close();
  server.close();
});

test.describe.configure({ mode: "serial" });

test("tree shows exact tokens, never the corrupted parse", async () => {
  const treeText = await page.$eval("#jv-tree", (el) => el.textContent ?? "");
  expect(treeText).toContain("9007199254740993");
  expect(treeText).toContain("1146169290024843337");
  expect(treeText).toContain("3.14159265358979323846");
  expect(treeText).not.toContain("9007199254740992");
});

test("formatted view re-emits exact tokens", async () => {
  await page.click('.jv-view-btn[data-view="formatted"]');
  await page.waitForTimeout(400);
  const fmtText = await page.$eval("#jv-formatted", (el) => el.textContent ?? "");
  expect(fmtText).toContain("9007199254740993");
  expect(fmtText).toContain("3.14159265358979323846");
});

test("Copy JSON puts exact tokens on the clipboard", async () => {
  await page.click('.jv-view-btn[data-view="tree"]');
  await page.waitForTimeout(300);
  await page.click("#jv-content");
  await page.keyboard.press("c");
  await page.waitForTimeout(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("9007199254740993");
  expect(clip).toContain("3.14159265358979323846");
  expect(clip).not.toContain("9007199254740992");
});
