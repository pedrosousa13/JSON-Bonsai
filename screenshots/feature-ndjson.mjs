// NDJSON feature shot: load dist/ as an unpacked extension, serve a local
// newline-delimited JSON body (realistic event-log records, one per line) over
// loopback so there's no external network, and capture the array tree with the
// "NDJSON" mode badge visible (1280x800 — Chrome Web Store size).
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

// Newline-delimited JSON — one event/log record per line, as a service would
// emit it. Served verbatim with an application/json content type.
const payload = [
  { ts: "2026-06-17T09:14:02Z", level: "info", event: "auth.login", user: "alice", ip: "10.0.4.21", ms: 42 },
  { ts: "2026-06-17T09:14:05Z", level: "info", event: "cart.add", user: "alice", sku: "BNS-118", qty: 2 },
  { ts: "2026-06-17T09:14:09Z", level: "warn", event: "payment.retry", user: "alice", attempt: 2, gateway: "stripe" },
  { ts: "2026-06-17T09:14:11Z", level: "info", event: "order.placed", user: "alice", orderId: 9007199254740993, total: 78.5 },
  { ts: "2026-06-17T09:14:18Z", level: "error", event: "email.send", user: "bob", code: "SMTP_TIMEOUT", retryable: true },
]
  .map((r) => JSON.stringify(r))
  .join("\n");

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(payload);
});
await new Promise((r) => server.listen(0, "127.0.0.1", () => r()));
const port = server.address().port;

const context = await chromium.launchPersistentContext(
  mkdtempSync(join(tmpdir(), "jv-ndjson-shot-")),
  {
    headless: false,
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark", // resolves to the Catppuccin Mocha default
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
    ],
  }
);

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(`http://127.0.0.1:${port}/events.ndjson`, {
  waitUntil: "domcontentloaded",
});

// Wait for the rendered tree, then confirm the NDJSON badge is shown.
await page.waitForSelector("#jv-root .jv-line", { timeout: 20000 });
await page.waitForSelector("#jv-mode-badge:not([hidden])", { timeout: 10000 });
const badge = await page.$eval("#jv-mode-badge", (el) => el.textContent ?? "");
if (badge.trim() !== "NDJSON") {
  throw new Error(`expected NDJSON badge, got "${badge}"`);
}

await page.mouse.move(0, 0); // park the cursor so no hover-path chip shows
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(500);

const out = join(outDir, "ndjson.png");
await page.screenshot({ path: out });

await context.close();
server.close();
console.log("NDJSON feature screenshot written to", out);
