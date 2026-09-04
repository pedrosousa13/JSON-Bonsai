// Regex search: toggling the .* button switches tree search to case-insensitive
// regex matching, navigation steps through hits, an invalid pattern shows an
// inline error instead of crashing, and a catastrophic-backtracking pattern is
// killed off-thread instead of freezing the page.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

// The proven freeze case from issue #51: `(a+)+$` against this value blocks a
// thread for as long as it takes — 17,431 ms measured on Chromium's main thread
// by the sanity check at the bottom of this file, 5552 ms in the issue's own
// repro — and the cost doubles per added `a`. The trailing `c`s push it past
// SEARCH_VALUE_PREVIEW_LIMIT so the untruncated copy is matched too, which is
// the node the local index would have wedged on.
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

// Sampled inside the page rather than from Node: a `setInterval` recording the
// largest gap between its own ticks. A Node-side sample pays a CDP round trip
// and a Node timer on every reading, which adds tens of milliseconds of jitter
// and forces a bar an order of magnitude looser than the jank it is supposed to
// catch. In-page, the reading is the same thing the research harness measured.
const SAMPLE_INTERVAL_MS = 25;

// The research harness pinged in-page at 25 ms and saw a 34 ms worst-case gap;
// this sampler measures 26 ms across the timed-out search, warm or cold. The
// bar is roughly 6x that, which is headroom for a loaded CI box also laying out
// the viewer and collecting garbage on the same thread, and it is still two
// orders of magnitude under the 17-second block the same pattern causes when it
// runs on the main thread — the sanity check at the bottom pins that end.
const MAX_MAIN_THREAD_GAP_MS = 150;

interface SamplerState {
  maxGap: number;
  ticks: number;
  last: number;
  handle: number;
}

type SamplerWindow = Window & { __sampler?: SamplerState };

async function startMainThreadSampler(target: Page) {
  await target.evaluate((intervalMs) => {
    const state: SamplerState = { maxGap: 0, ticks: 0, last: performance.now(), handle: 0 };
    state.handle = window.setInterval(() => {
      const now = performance.now();
      state.maxGap = Math.max(state.maxGap, now - state.last);
      state.last = now;
      state.ticks += 1;
    }, intervalMs);
    (window as SamplerWindow).__sampler = state;
  }, SAMPLE_INTERVAL_MS);
}

async function stopMainThreadSampler(target: Page) {
  return target.evaluate(() => {
    const state = (window as SamplerWindow).__sampler!;
    clearInterval(state.handle);
    return { maxGap: state.maxGap, ticks: state.ticks };
  });
}

// Resolves with how long the status line took to reach `text`, measured in-page
// from just before the keypress, so neither Playwright's assertion polling nor
// CDP latency inflates it. Armed before the search is committed.
async function watchSearchStatus(target: Page, text: string) {
  await target.evaluate((wanted) => {
    const status = document.getElementById("jv-search-status")!;
    (window as unknown as { __settled: Promise<number> }).__settled = new Promise((resolve) => {
      const start = performance.now();
      const observer = new MutationObserver(() => {
        if (status.textContent === wanted) {
          observer.disconnect();
          resolve(performance.now() - start);
        }
      });
      observer.observe(status, { childList: true, characterData: true, subtree: true });
    });
  }, text);
}

function awaitSearchStatus(target: Page) {
  return target.evaluate(
    () => (window as unknown as { __settled: Promise<number> }).__settled
  );
}

// Sets the field and commits with Enter rather than typing: it runs exactly one
// search with no 180 ms debounce racing the keypress, so the measured settle
// time is one search's, not two.
async function commitSearch(target: Page, pattern: string) {
  await target.evaluate((value) => {
    (document.getElementById("jv-search-input") as HTMLInputElement).value = value;
  }, pattern);
  await target.press("#jv-search-input", "Enter");
}

test("a catastrophic pattern times out without freezing the page", async () => {
  await expect(page.locator("#jv-search-regex")).toHaveAttribute("aria-pressed", "true");

  await watchSearchStatus(page, "Search timed out");
  await startMainThreadSampler(page);
  await commitSearch(page, FREEZE_PATTERN);

  const settleMs = await awaitSearchStatus(page);
  const sample = await stopMainThreadSampler(page);

  await expect(page.locator("#jv-search-status")).toHaveText("Search timed out");
  expect(settleMs).toBeLessThan(2000);

  // The whole point of the frame: the regex burned a worker, not the page.
  expect(sample.ticks).toBeGreaterThan(10);
  expect(sample.maxGap).toBeLessThan(MAX_MAIN_THREAD_GAP_MS);

  // Prev/next have nothing to step through.
  await expect(page.locator("#jv-search-prev")).toBeDisabled();
  await expect(page.locator("#jv-search-next")).toBeDisabled();
});

test("search still works after a timeout killed the worker", async () => {
  // Plain substring search never left the main thread, so it is unaffected.
  await page.click("#jv-search-regex");
  await expect(page.locator("#jv-search-regex")).toHaveAttribute("aria-pressed", "false");
  await commitSearch(page, "alpine");
  await expect(page.locator("#jv-search-status")).toHaveText("1 of 1");

  // And the frame respawned its worker, so regex search answers again.
  await page.click("#jv-search-regex");
  await expect(page.locator("#jv-search-regex")).toHaveAttribute("aria-pressed", "true");
  await commitSearch(page, "al(pha|pine)");
  await expect(page.locator("#jv-search-status")).toHaveText("1 of 2");
});

test("a sandboxed page reports regex unavailable and keeps plain search", async () => {
  // The one page response known to defeat the frame. Ordinary CSP directives do
  // not: `docs/research/2026-09-03-firefox-worker-hosting.md` records the frame
  // loading and its worker running under `default-src 'none'`,
  // `default-src 'none'; frame-src 'none'`, `worker-src 'none'` and
  // `child-src 'none'` on both browsers. This suite does not re-prove those.
  // `Content-Security-Policy: sandbox` gives the page an opaque origin, the
  // frame never reports ready, and the readiness timeouts turn regex mode off
  // for the page. The research listed this policy as untested; this is the
  // answer for Chromium.
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

// Its own context, so no earlier test has warmed the shared frame. The tests
// above all run against a page that has already paid the mount and the worker
// handshake, which leaves the cold path — the one a real first regex search
// takes — unmeasured.
test.describe("a cold first regex search", () => {
  let coldContext: BrowserContext;
  let coldPage: Page;

  test.beforeAll(async () => {
    coldContext = await launchWithExtension();
    coldPage = coldContext.pages()[0] ?? (await coldContext.newPage());
    await coldPage.goto(`http://127.0.0.1:${server.port}/data.json`, {
      waitUntil: "domcontentloaded",
    });
    await coldPage.waitForSelector("#jv-root .jv-line", { timeout: 20000 });
  });

  test.afterAll(async () => {
    await coldContext.close();
  });

  test("settles inside two seconds with nothing warmed up", async () => {
    await coldPage.click("#jv-search-toggle");
    await coldPage.click("#jv-search-regex");

    // Nothing has searched on this page yet, so the frame is still uninjected:
    // this measurement pays the mount and the worker handshake on top of the
    // search deadline, which is exactly the composition the 2-second criterion
    // is about.
    await expect(coldPage.locator("#jv-search-frame")).toHaveCount(0);

    await watchSearchStatus(coldPage, "Search timed out");
    await startMainThreadSampler(coldPage);
    await commitSearch(coldPage, FREEZE_PATTERN);

    const settleMs = await awaitSearchStatus(coldPage);
    const sample = await stopMainThreadSampler(coldPage);

    await expect(coldPage.locator("#jv-search-frame")).toHaveCount(1);
    expect(settleMs).toBeLessThan(2000);
    expect(sample.ticks).toBeGreaterThan(10);
    expect(sample.maxGap).toBeLessThan(MAX_MAIN_THREAD_GAP_MS);
  });

  // Proves the sampler above can see a frozen main thread at all: the same
  // pattern, the same value, run on the page's own thread instead of in the
  // worker. Deliberately last in this block — it wedges this page for seconds.
  test("the same pattern on the page's own thread blows the bar", async () => {
    await startMainThreadSampler(coldPage);

    const blocked = await coldPage.evaluate(
      async ({ pattern, value, settleMs }) => {
        const state = (window as SamplerWindow).__sampler!;
        const start = performance.now();
        new RegExp(pattern, "i").test(value);
        const blockedMs = performance.now() - start;
        // Let the interval tick that the block held up actually land, so the
        // gap it records is readable.
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        return { blockedMs, maxGap: state.maxGap };
      },
      { pattern: FREEZE_PATTERN, value: FREEZE_VALUE, settleMs: SAMPLE_INTERVAL_MS * 4 }
    );

    await stopMainThreadSampler(coldPage);

    // Measured at 17,431 ms here, with the sampler reporting a 17,432 ms gap —
    // it sees the freeze exactly. The assertion asks for only 5x the bar so no
    // faster machine can flake it, which still proves the sampler against a
    // block two orders of magnitude past what it has to catch.
    expect(blocked.blockedMs).toBeGreaterThan(MAX_MAIN_THREAD_GAP_MS * 5);
    expect(blocked.maxGap).toBeGreaterThan(MAX_MAIN_THREAD_GAP_MS * 5);
  });
});
