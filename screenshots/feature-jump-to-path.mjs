// Jump-to-path feature shot: load dist/ as an unpacked extension, serve a
// nested local JSON fixture (no network), press G, type a deep path, and
// capture the goto panel + flash-highlighted target row (1280x800).
//
// Mirrors screenshots/take.mjs's launch config and e2e/helpers.ts's local
// fixture server + e2e/jump-to-path.spec.ts's open/jump interactions.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const out = join(here, "features");
mkdirSync(out, { recursive: true });

// Many top-level keys + a long array so the deep target starts collapsed and
// off-screen (mirrors the e2e fixture).
const payload = JSON.stringify({
  meta: { version: 1 },
  users: Array.from({ length: 60 }, (_, i) => ({
    id: i,
    name: `user ${i}`,
    profile: { city: `city ${i}` },
  })),
});

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
    colorScheme: "dark", // Catppuccin Mocha default
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  }
);

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(`http://127.0.0.1:${port}/data.json`, {
  waitUntil: "domcontentloaded",
});
await page.waitForSelector("#jv-root .jv-line", { timeout: 20000 });
await page.waitForTimeout(500);

// The goto panel anchors below the toolbar; pin it just under so panel +
// toolbar + highlighted row are all visible together (same trick as take.mjs).
await page.addStyleTag({
  content: "#jv-goto-panel { top: 56px !important; }",
});

// Collapse to a shallow level so the deep target is hidden first.
await page.keyboard.press("1");
await page.waitForTimeout(200);

// Open the goto panel and jump to a deep node. The jump expands every
// ancestor of the target and flash-highlights its row.
await page.keyboard.press("g");
await page.fill("#jv-goto-input", "users[40].profile.city");
await page.keyboard.press("Enter");
await page.waitForSelector(".jv-line.jv-goto-flash", { timeout: 5000 });

const target = '.jv-line[data-path="data.users[40].profile.city"]';

// Bring the now-revealed target into the viewport (centered below the pinned
// panel). The scroll re-renders the virtualized rows, so let that settle
// before re-flashing — otherwise the fresh row node loses the flash class.
await page.evaluate((sel) => {
  document.querySelector(sel)?.scrollIntoView({ block: "center" });
}, target);
await page.waitForTimeout(250);

// Restart the flash on the settled row so the pulse is captured fresh.
await page.evaluate((sel) => {
  const row = document.querySelector(sel);
  if (!row) return;
  row.classList.remove("jv-goto-flash");
  void row.offsetWidth; // force reflow so re-adding restarts the animation
  row.classList.add("jv-goto-flash");
}, target);

// Capture while the pulse is at full strength (the highlight holds solid
// through the first 20% of the 1.2s animation, i.e. ~240ms).
await page.waitForTimeout(80);
await page.mouse.move(0, 0); // park cursor so no hover-path chip shows
await page.screenshot({ path: join(out, "jump-to-path.png") });

await context.close();
server.close();
console.log("Wrote", join(out, "jump-to-path.png"));
