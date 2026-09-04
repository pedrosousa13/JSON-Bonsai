// Search on a ~100k-node document, and where each half of it runs.
//
// Plain substring search stays on the main thread: it cannot backtrack, so it
// cannot wedge, and the index scans in chunks to keep every task short. It
// spawns nothing. Regex search does the opposite — it runs in a worker owned by
// a hidden extension-origin frame, because a catastrophic pattern can only be
// stopped by terminating the thread running it (issue #51). This spec pins both
// halves: which one spawns a worker, and that neither blocks a frame.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

// 25,000 objects × 3 leaves + the objects themselves + the root array node.
const ITEM_COUNT = 25_000;
const NODE_COUNT = ITEM_COUNT * 4 + 1;
const payload = JSON.stringify(
  Array.from({ length: ITEM_COUNT }, (_, index) => ({
    id: index,
    name: `item-${index}`,
    tag: `row-${index}`,
  }))
);

// Matches exactly one leaf value, so the hit count is an exact assertion.
const NEEDLE = "row-12345";

let context: BrowserContext;
let page: Page;
let server: FixtureServer;
const workerUrls: string[] = [];

test.beforeAll(async () => {
  server = await serveJson(payload);
  context = await launchWithExtension();
  page = context.pages()[0] ?? (await context.newPage());
  page.on("worker", (worker) => workerUrls.push(worker.url()));
  await page.goto(`http://127.0.0.1:${server.port}/large.json`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#jv-root .jv-line", { timeout: 40000 });
  await expect(page.locator("#jv-info")).toContainText(`${NODE_COUNT} nodes`);
});

test.afterAll(async () => {
  await context.close();
  server.close();
});

test.describe.configure({ mode: "serial" });

// Long tasks are only reported at 50 ms and up, so a clean run reports none.
async function startLongTaskObserver(): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as { __jvLongTasks: number[] };
    store.__jvLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) store.__jvLongTasks.push(entry.duration);
    }).observe({ entryTypes: ["longtask"] });
  });
}

async function longestTaskMs(label: string, elapsedMs: number): Promise<number> {
  // Give the observer a turn to flush its buffer before reading it.
  await page.waitForTimeout(500);
  const durations = await page.evaluate(
    () => (window as unknown as { __jvLongTasks: number[] }).__jvLongTasks
  );
  const longest = durations.length > 0 ? Math.max(...durations) : 0;
  console.log(
    `${label} over ${NODE_COUNT} nodes: ${elapsedMs} ms wall, ` +
      `${durations.length} long tasks, longest ${longest.toFixed(1)} ms`
  );
  return longest;
}

test("substring search finds its match without spawning a worker or blocking a frame", async () => {
  await startLongTaskObserver();

  await page.click("#jv-search-toggle");
  const started = Date.now();
  await page.fill("#jv-search-input", NEEDLE);
  await expect(page.locator("#jv-search-status")).toContainText("1 of 1", {
    timeout: 20000,
  });
  const longest = await longestTaskMs("substring search", Date.now() - started);

  await expect(page.locator(".jv-line.jv-search-active")).toHaveCount(1);
  // Substring search never leaves the main thread, and the frame that hosts the
  // regex worker is only injected on the first regex search.
  expect(workerUrls).toEqual([]);
  expect(longest).toBeLessThan(100);
});

test("regex search stays off the critical path too", async () => {
  await startLongTaskObserver();

  await page.click("#jv-search-regex");
  await expect(page.locator("#jv-search-regex")).toHaveAttribute("aria-pressed", "true");

  const started = Date.now();
  // Ten leaf values (row-12340 … row-12349); a regex test per node is the
  // most expensive scan the index runs.
  await page.fill("#jv-search-input", "row-1234[0-9]");
  await expect(page.locator("#jv-search-status")).toContainText("1 of 10", {
    timeout: 20000,
  });
  const longest = await longestTaskMs("regex search", Date.now() - started);

  // Regex search is the half that does spawn one, from inside the frame.
  expect(workerUrls.length).toBeGreaterThan(0);
  for (const url of workerUrls) expect(url).toMatch(/\/tree-worker\.js$/);
  expect(longest).toBeLessThan(100);
});
