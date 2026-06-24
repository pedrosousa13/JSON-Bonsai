// Query explorer demo shot: load dist/ as an unpacked extension on a LOCAL
// array-of-objects fixture (no network), open the JMESPath query panel staged
// under the toolbar, type a prefix that matches several object keys AND
// builtin functions, and capture the populated autocomplete dropdown.
// Mirrors e2e/helpers.ts (extension launch + local fixture server) and
// screenshots/take.mjs (1280x800, the #jv-query-panel { top: 56px } stage trick).
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const featuresDir = join(here, "features");
mkdirSync(featuresDir, { recursive: true });

// Array-of-objects fixture. Keys "sku", "status", "shippedAt", "subtotal"
// all start with "s" — typing "s" surfaces those keys plus the JMESPath
// builtins (sort, sort_by, starts_with, sum, ...) in one rich dropdown.
const payload = JSON.stringify(
  [
    {
      sku: "BON-001",
      status: "shipped",
      shippedAt: "2026-05-01",
      subtotal: 42.0,
      customer: "Ada Lovelace",
      quantity: 3,
    },
    {
      sku: "BON-002",
      status: "pending",
      shippedAt: null,
      subtotal: 18.5,
      customer: "Grace Hopper",
      quantity: 1,
    },
    {
      sku: "BON-003",
      status: "shipped",
      shippedAt: "2026-05-04",
      subtotal: 99.9,
      customer: "Alan Turing",
      quantity: 5,
    },
  ],
  null,
  0
);

// Local fixture server — never touches the network.
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(payload);
});
await new Promise((r) => server.listen(0, "127.0.0.1", () => r()));
const port = server.address().port;

const context = await chromium.launchPersistentContext(
  mkdtempSync(join(tmpdir(), "jv-feature-")),
  {
    headless: false,
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  }
);

const page = context.pages()[0] ?? (await context.newPage());

await page.goto(`http://127.0.0.1:${port}/orders.json`, {
  waitUntil: "domcontentloaded",
});
await page.waitForSelector("#jv-root .jv-line", { timeout: 20000 });
await page.waitForTimeout(600);

// Pin the query panel under the toolbar so panel + dropdown + tree are all
// visible in one frame (it normally anchors to the viewport bottom edge).
await page.addStyleTag({
  content: "#jv-query-panel { top: 56px !important; }",
});

// Open the query panel and type a prefix that populates the dropdown.
await page.click("#jv-query-toggle");
await page.waitForSelector("#jv-query-panel:not([hidden])", { timeout: 10000 });
// Type so the input + autocomplete look natural; "s" matches keys + functions.
await page.fill("#jv-query-input", "s");
await page.waitForSelector("#jv-query-suggest:not([hidden])", {
  timeout: 10000,
});
// Confirm the dropdown actually has items before shooting.
await page.waitForFunction(
  () => document.querySelectorAll(".jv-query-suggest-item").length >= 4,
  { timeout: 10000 }
);
await page.waitForTimeout(400);

const shot = join(featuresDir, "query-explorer.png");
await page.screenshot({ path: shot });
const count = await page.locator(".jv-query-suggest-item").count();
console.log(`autocomplete shot: ${count} suggestions ->`, shot);

// Bonus: a second shot showing the "Query from here" path chip. Close the
// query panel, click a node line to pin its path (reveals the path chip with
// the "Query" button), then capture.
await page.click("#jv-query-close");
await page.waitForTimeout(200);

const statusLine = page
  .locator("#jv-tree .jv-line")
  .filter({ hasText: "status" })
  .first();
await statusLine.click();
await page.waitForSelector("#jv-path-display.jv-visible", { timeout: 5000 });
// Hover the "Query from here" button so it reads clearly.
await page.hover("#jv-path-query");
await page.waitForTimeout(300);
const chipShot = join(featuresDir, "query-from-here.png");
await page.screenshot({ path: chipShot });
console.log("query-from-here shot ->", chipShot);

await context.close();
server.close();
console.log("done");
