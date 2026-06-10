// Store screenshots: load dist/ as an unpacked extension, open a JSON API
// response, capture the 5 feature shots (1280x800 — Chrome Web Store size,
// accepted by Firefox AMO too).
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const out = here;

const context = await chromium.launchPersistentContext(
  mkdtempSync(join(tmpdir(), "jv-shots-")),
  {
    headless: false,
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark", // auto mode resolves to the Catppuccin Mocha default
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
    ],
  }
);

const page = context.pages()[0] ?? (await context.newPage());

// The search/query panels anchor to the viewport bottom edge (8px below it,
// revealed by a focus scroll). For the shots, pin them under the toolbar so
// panel + toolbar + results are visible together.
async function stagePanels() {
  await page.addStyleTag({
    content: "#jv-search-panel, #jv-query-panel { top: 56px !important; }",
  });
}

async function shoot(name) {
  await page.mouse.move(0, 0); // park the cursor so no hover-path chip shows
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, name) });
}

async function load() {
  await page.goto("https://jsonplaceholder.typicode.com/comments", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#jv-root .jv-line", { timeout: 20000 });
  await page.waitForTimeout(800);
  await stagePanels();
}

await load();

// 1. Query — JMESPath expression visible in the panel, result + chip shown
await page.click("#jv-query-toggle");
await page.fill("#jv-query-input", "[?postId == `1`].{name: name, email: email}");
await page.click("#jv-query-run");
await page.waitForSelector("#jv-query-chip:not([hidden])", { timeout: 10000 });
await page.waitForTimeout(500);
await shoot("1-query.png");

// 2. Search — panel with match counter + highlighted rows
await load(); // fresh page: clears query state and any pinned path chip
await page.click("#jv-search-toggle");
await page.fill("#jv-search-input", "laudantium");
await page.waitForTimeout(900); // debounce + index
await shoot("2-search.png");

// 3. Theming — settings menu open showing scheme pickers + custom paste
await load();
await page.click("#jv-settings-toggle");
await page.waitForSelector("#jv-settings-menu.jv-open");
await shoot("3-theming.png");
await page.click("#jv-info"); // click-outside closes the menu
await page.waitForTimeout(300);

// 4. Formatted view
await page.click('.jv-view-btn[data-view="formatted"]');
await page.waitForTimeout(400);
await shoot("4-formatted.png");

// 5. Schema view
await page.click('.jv-view-btn[data-view="schema"]');
await page.waitForTimeout(400);
await shoot("5-schema.png");

await context.close();
console.log("5 screenshots written to", out);
