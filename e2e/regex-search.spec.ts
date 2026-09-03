// Regex search: toggling the .* button switches tree search to case-insensitive
// regex matching, navigation steps through hits, an invalid pattern shows an
// inline error instead of crashing, and a catastrophically backtracking pattern
// is refused instead of wedging the page (issue #51).
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

// The value from issue #51: a 28-character run a nested quantifier can partition
// 2^27 ways, then a character that makes the match fail. Unguarded, `(a+)+$`
// over it holds the page's main thread for ~16 s.
const catastrophicValue = `${"a".repeat(28)}b${"c".repeat(271)}`;

const payload = JSON.stringify({
  user: { name: "Alice", city: "Berlin" },
  items: [{ tag: "alpha" }, { tag: "beta" }, { tag: "alpine" }],
  blob: catastrophicValue,
  // A 30-character run, inside the 200-character preview the index stores, so
  // `(a+)+\W$` has fuel here whatever the long-value cap is.
  run: "a".repeat(30),
  // Fuel for a pattern whose lookahead needs a character the run does not have.
  runx: `${"a".repeat(28)}x`,
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

// Each of these is catastrophic against a value in the fixture. The last three
// have a tail that can consume a single trailing sentinel character, so a probe
// that only appends one lets them through.
for (const pattern of ["(a+)+$", "(a+)+\\W$", "(a+)+[^b]$", "(?=.*x)(a+)+$"]) {
  test(`the pattern ${pattern} is refused instead of wedging the page`, async () => {
    const started = Date.now();
    await search(pattern);
    await expect(page.locator("#jv-search-status")).toContainText(
      "Pattern too slow to run"
    );
    expect(Date.now() - started).toBeLessThan(2000);

    // The page is still responsive, and the next search behaves normally.
    await search("alpine");
    await expect(page.locator("#jv-search-status")).toContainText("of 1");
    await expect(page.locator(".jv-line.jv-search-active")).toHaveCount(1);
  });
}
