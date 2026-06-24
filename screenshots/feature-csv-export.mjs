// Feature shot: CSV/TSV export bar above the Table view. Loads dist/ as an
// unpacked extension, serves a LOCAL array-of-objects fixture (no network),
// switches to Table view, and captures the export bar + rows at 1280x800.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const outDir = join(here, "features");
mkdirSync(outDir, { recursive: true });

// Local array-of-objects fixture so the Table view is eligible. A few rows with
// readable columns make the export bar's purpose obvious.
const payload = JSON.stringify([
  { id: 1, product: "Keyboard", category: "Peripherals", price: 79.99, inStock: true },
  { id: 2, product: "Monitor", category: "Displays", price: 249.0, inStock: true },
  { id: 3, product: "Mouse", category: "Peripherals", price: 39.5, inStock: false },
  { id: 4, product: "Webcam", category: "Video", price: 119.99, inStock: true },
  { id: 5, product: "Headset", category: "Audio", price: 89.0, inStock: false },
  { id: 6, product: "Dock", category: "Accessories", price: 199.99, inStock: true },
]);

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(payload);
});
await new Promise((r) => server.listen(0, "127.0.0.1", () => r()));
const { port } = server.address();

const context = await chromium.launchPersistentContext(
  mkdtempSync(join(tmpdir(), "jv-feature-")),
  {
    headless: false,
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
    ],
  }
);

const page = context.pages()[0] ?? (await context.newPage());

await page.goto(`http://127.0.0.1:${port}/products.json`, {
  waitUntil: "domcontentloaded",
});
await page.waitForSelector("#jv-root .jv-line", { timeout: 20000 });
await page.waitForTimeout(500);

await page.click('.jv-view-btn[data-view="table"]');
await page.waitForSelector(".jv-table-row");
await page.waitForSelector(".jv-table-export .jv-table-export-btn");
await page.mouse.move(0, 0); // no hover state on any button
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);

await page.screenshot({ path: join(outDir, "csv-export.png") });

await context.close();
server.close();
console.log("wrote", join(outDir, "csv-export.png"));
