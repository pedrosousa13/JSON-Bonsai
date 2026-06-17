// NDJSON / JSON Lines: a newline-delimited body renders as an array tree with
// an "NDJSON" mode badge, and 64-bit ints stay lossless.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

// Three JSON objects, one per line; the second carries a 64-bit int.
const payload = `{"name": "alpha", "id": 1}
{"name": "beta", "id": 9007199254740993}
{"name": "gamma", "id": 3}`;

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

test("renders the NDJSON lines as a three-element array", async () => {
  // Root reports three array items.
  const info = await page.$eval("#jv-info", (el) => el.textContent ?? "");
  expect(info).toMatch(/\bnodes\b/);

  const treeText = await page.$eval("#jv-tree", (el) => el.textContent ?? "");
  expect(treeText).toContain("alpha");
  expect(treeText).toContain("beta");
  expect(treeText).toContain("gamma");
  // The synthetic array exposes numeric indices 0, 1, 2.
  expect(treeText).toContain("3 items");
});

test("shows the NDJSON mode badge", async () => {
  const badge = await page.$eval("#jv-mode-badge", (el) => ({
    text: el.textContent ?? "",
    hidden: (el as HTMLElement).hidden,
  }));
  expect(badge.hidden).toBe(false);
  expect(badge.text).toBe("NDJSON");
});

test("keeps a 64-bit int lossless, never the corrupted parse", async () => {
  const treeText = await page.$eval("#jv-tree", (el) => el.textContent ?? "");
  expect(treeText).toContain("9007199254740993");
  expect(treeText).not.toContain("9007199254740992");
});
