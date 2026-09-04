// Regex search: toggling the .* button switches tree search to case-insensitive
// regex matching, navigation steps through hits, an invalid pattern shows an
// inline error instead of crashing, and a catastrophic-backtracking pattern is
// killed off-thread instead of freezing the page.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

// The proven freeze case from issue #51: `(a+)+$` against this value costs
// roughly sixteen seconds on Chrome's main thread and doubles per added `a`.
// The trailing `c`s push it past SEARCH_VALUE_PREVIEW_LIMIT so the untruncated
// copy is matched too — the same node the local index would have wedged on.
const FREEZE_VALUE = `${"a".repeat(28)}b${"c".repeat(271)}`;
const FREEZE_PATTERN = "(a+)+$";

const payload = JSON.stringify({
  user: { name: "Alice", city: "Berlin" },
  items: [{ tag: "alpha" }, { tag: "beta" }, { tag: "alpine" }],
  freeze: FREEZE_VALUE,
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

// Polls the page's main thread from the Playwright side. Each sample is a full
// CDP round trip, so it cannot answer while the main thread is blocked.
const POLL_INTERVAL_MS = 25;
// The research harness pinged in-page at 25 ms and saw a 34 ms worst case. A
// sample here also pays a CDP round trip and a Node timer, both of which add
// tens of milliseconds of jitter under a headless CI, so the bar needs real
// headroom over 34 ms. 400 ms is still well inside the 1500 ms search deadline
// and three orders of magnitude below the 69,935 ms freeze this pattern causes
// on the main thread, so it separates "responsive" from "frozen" without
// flaking on jitter.
const MAX_MAIN_THREAD_GAP_MS = 400;

function pollMainThread() {
  const gaps: number[] = [];
  let running = true;
  let last = Date.now();
  const done = (async () => {
    while (running) {
      await page.evaluate(() => document.readyState);
      const now = Date.now();
      gaps.push(now - last);
      last = now;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  })();
  return {
    gaps,
    async stop() {
      running = false;
      await done;
    },
  };
}

// Sets the field and commits with Enter rather than typing: it runs exactly one
// search with no 180 ms debounce racing the keypress, so the measured settle
// time is one search's, not two.
async function commitSearch(pattern: string) {
  await page.evaluate((value) => {
    (document.getElementById("jv-search-input") as HTMLInputElement).value = value;
  }, pattern);
  await page.press("#jv-search-input", "Enter");
}

test("a catastrophic pattern times out without freezing the page", async () => {
  await expect(page.locator("#jv-search-regex")).toHaveAttribute("aria-pressed", "true");

  // Measured in-page, from just before the keypress to the status text landing,
  // so neither Playwright's assertion polling nor CDP latency inflates it.
  await page.evaluate(() => {
    const status = document.getElementById("jv-search-status")!;
    (window as unknown as { __settled: Promise<number> }).__settled = new Promise(
      (resolve) => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (status.textContent === "Search timed out") {
            observer.disconnect();
            resolve(performance.now() - start);
          }
        });
        observer.observe(status, { childList: true, characterData: true, subtree: true });
      }
    );
  });

  const poll = pollMainThread();
  await commitSearch(FREEZE_PATTERN);

  const settleMs = await page.evaluate(
    () => (window as unknown as { __settled: Promise<number> }).__settled
  );
  await poll.stop();

  await expect(page.locator("#jv-search-status")).toHaveText("Search timed out");
  expect(settleMs).toBeLessThan(2000);

  // The whole point of the frame: the regex burned a worker, not the page.
  expect(poll.gaps.length).toBeGreaterThan(10);
  expect(Math.max(...poll.gaps)).toBeLessThan(MAX_MAIN_THREAD_GAP_MS);

  // Prev/next have nothing to step through.
  await expect(page.locator("#jv-search-prev")).toBeDisabled();
  await expect(page.locator("#jv-search-next")).toBeDisabled();
});

test("search still works after a timeout killed the worker", async () => {
  // Plain substring search never left the main thread, so it is unaffected.
  await page.click("#jv-search-regex");
  await expect(page.locator("#jv-search-regex")).toHaveAttribute("aria-pressed", "false");
  await commitSearch("alpine");
  await expect(page.locator("#jv-search-status")).toHaveText("1 of 1");

  // And the frame respawned its worker, so regex search answers again.
  await page.click("#jv-search-regex");
  await expect(page.locator("#jv-search-regex")).toHaveAttribute("aria-pressed", "true");
  await commitSearch("al(pha|pine)");
  await expect(page.locator("#jv-search-status")).toHaveText("1 of 2");
});

test("a sandboxed page reports regex unavailable and keeps plain search", async () => {
  // The one page response that does defeat the frame. Every ordinary directive
  // leaves regex search working — verified here on Chromium against
  // `default-src 'none'`, `default-src 'none'; frame-src 'none'`,
  // `frame-src 'none'` and `child-src 'none'; worker-src 'none'`, all of which
  // returned matches. `Content-Security-Policy: sandbox` gives the page an
  // opaque origin, the frame never reports ready, and the readiness timeout
  // turns regex mode off for the life of the page. The research listed this
  // policy as untested; this is the answer for Chromium.
  const sandboxServer = await serveJson(payload, {
    "Content-Security-Policy": "sandbox allow-scripts",
  });
  const sandboxContext = await launchWithExtension();
  const sandboxPage = sandboxContext.pages()[0] ?? (await sandboxContext.newPage());

  try {
    await sandboxPage.goto(`http://127.0.0.1:${sandboxServer.port}/data.json`, {
      waitUntil: "domcontentloaded",
    });
    await sandboxPage.waitForSelector("#jv-root .jv-line", { timeout: 20000 });
    await sandboxPage.click("#jv-search-toggle");
    await sandboxPage.click("#jv-search-regex");

    await sandboxPage.fill("#jv-search-input", "al(pha|pine)");
    await expect(sandboxPage.locator("#jv-search-status")).toHaveText(
      "Regex search unavailable here",
      { timeout: 10000 }
    );
    await expect(sandboxPage.locator("#jv-search-next")).toBeDisabled();

    // Substring search never needed the frame, so it is unaffected.
    await sandboxPage.click("#jv-search-regex");
    await sandboxPage.fill("#jv-search-input", "alpine");
    await expect(sandboxPage.locator("#jv-search-status")).toHaveText("1 of 1");
  } finally {
    await sandboxContext.close();
    sandboxServer.close();
  }
});
