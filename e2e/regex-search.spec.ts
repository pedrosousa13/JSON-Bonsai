// Regex search: toggling the .* button switches tree search to case-insensitive
// regex matching, navigation steps through hits, and an invalid pattern shows an
// inline error instead of crashing.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

const payload = JSON.stringify({
  user: { name: "Alice", city: "Berlin" },
  items: [{ tag: "alpha" }, { tag: "beta" }, { tag: "alpine" }],
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

async function search(text: string) {
  await page.fill("#jv-search-input", text);
  await page.waitForTimeout(900); // input debounce
}

test.describe.configure({ mode: "serial" });

test("regex toggle enables pattern matching and navigation", async () => {
  await page.click("#jv-search-toggle");
  await page.click("#jv-search-regex");
  await expect(page.locator("#jv-search-regex")).toHaveAttribute("aria-pressed", "true");

  // "al(pha|pine)" matches alpha and alpine via regex alternation; as a literal
  // substring it would match neither.
  await search("al(pha|pine)");
  await expect(page.locator("#jv-search-status")).toContainText("of 2");
  await expect(page.locator(".jv-line.jv-search-active")).toHaveCount(1);

  // Step to the next match.
  await page.click("#jv-search-next");
  await expect(page.locator("#jv-search-status")).toContainText("2 of 2");
});

test("invalid regex shows an inline error without crashing", async () => {
  await search("(");
  await expect(page.locator("#jv-search-status")).toContainText("Invalid regex");
  // The viewer is still alive and interactive.
  await expect(page.locator("#jv-root .jv-line").first()).toBeVisible();

  // Fixing the pattern clears the error and matches again.
  await search("ber.in");
  await expect(page.locator("#jv-search-status")).not.toContainText("Invalid");
  await expect(page.locator("#jv-search-status")).toContainText("of 1");
});
