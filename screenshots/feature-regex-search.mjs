// Feature shot: regex search mode. Loads dist/ as an unpacked extension on a
// LOCAL JSON fixture (no network), opens the search bar, enables the .* regex
// toggle, types a regex pattern that matches several string values, waits for
// the match counter + highlighted rows, then captures a 1280x800 PNG with the
// toggle active, the pattern, the counter, and the matches all in frame.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const outDir = join(here, "features");

// Local fixture with string values: some start with "lau", some are emails
// ending in .com/.net, plus non-matching values for visual contrast. The
// pattern below (^lau|@\w+\.(com|net)) matches the former two groups.
const payload = JSON.stringify(
  {
    project: "json-bonsai",
    notes: ["launch checklist", "audit pass", "alpha review"],
    team: [
      { name: "Alice", role: "lead", email: "alice@example.com" },
      { name: "Bob", role: "maintainer", email: "bob@mail.net" },
      { name: "Carol", role: "designer", email: "carol@studio.org" },
    ],
    releases: {
      latest: "launching soon",
      changelog: "https://example.com/log",
      contact: "support@bonsai.net",
    },
  },
  null,
  2
);

// Serve the fixture for every path so the extension activates on a JSON
// response without touching the network.
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(payload);
});
await new Promise((r) => server.listen(0, "127.0.0.1", () => r()));
const port = server.address().port;

const context = await chromium.launchPersistentContext(
  mkdtempSync(join(tmpdir(), "jv-feat-")),
  {
    headless: false,
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark", // Catppuccin Mocha default
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  }
);

const page = context.pages()[0] ?? (await context.newPage());

await page.goto(`http://127.0.0.1:${port}/data.json`, {
  waitUntil: "domcontentloaded",
});
await page.waitForSelector("#jv-root .jv-line", { timeout: 20000 });
await page.waitForTimeout(800);

// Open search, enable the .* regex toggle, type a clearly-regex pattern.
await page.click("#jv-search-toggle");
await page.click("#jv-search-regex");
await page.waitForSelector('#jv-search-regex[aria-pressed="true"]', {
  timeout: 5000,
});
await page.fill("#jv-search-input", "^lau|@\\w+\\.(com|net)");
await page.waitForTimeout(900); // debounce + index

// Wait for the match counter ("N of M") and highlighted rows.
await page.waitForFunction(
  () => /\bof\b/.test(document.getElementById("jv-search-status")?.textContent ?? ""),
  { timeout: 10000 }
);
await page.waitForSelector(".jv-line.jv-search-match", { timeout: 10000 });

// Pin the search panel under the toolbar so panel + toolbar + results show
// together (take.mjs staging trick).
await page.addStyleTag({
  content: "#jv-search-panel, #jv-query-panel { top: 56px !important; }",
});

await page.mouse.move(0, 0); // park cursor so no hover chip shows
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);

await page.screenshot({ path: join(outDir, "regex-search.png") });

await context.close();
server.close();
console.log("regex-search.png written to", outDir);
