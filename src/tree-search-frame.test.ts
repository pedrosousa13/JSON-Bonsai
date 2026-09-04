import { expect, test } from "vitest";

import { buildTreeModel } from "./tree-model";
import type { SearchFrameRequest, SearchFrameResponse } from "./tree-search-protocol";
import {
  SEARCH_FRAME_READY_TIMEOUT_MS,
  SEARCH_REQUEST_TIMEOUT_MS,
} from "./tree-search-protocol";
import {
  TreeSearchTimeoutError,
  TreeSearchUnavailableError,
  createSearchFrameHost,
  createTreeSearchIndex,
  type SearchFrameHost,
  type SearchFramePostTarget,
} from "./tree-search-frame";

// The two are deliberately different hosts. Under `use_dynamic_url: true`
// Chrome hands out a per-session GUID host for the resource URL, and the
// document that URL loads still runs at the extension's static origin — so the
// URL to load and the origin to trust cannot be the same value.
const FRAME_URL = "chrome-extension://a99be5a8-78cc-48aa-9fc4-4ec17bf14448/worker-host.html";
const FRAME_ORIGIN = "chrome-extension://okiimodnidbidnjmoneimjiekakmacof";

class FakeFrameWindow implements SearchFramePostTarget {
  readonly posted: SearchFrameRequest[] = [];
  readonly targetOrigins: string[] = [];

  postMessage(message: SearchFrameRequest, targetOrigin: string): void {
    this.posted.push(message);
    this.targetOrigins.push(targetOrigin);
  }
}

interface FakeTimer {
  handler: () => void;
  delayMs: number;
  cancelled: boolean;
}

function createHarness() {
  const mountedUrls: string[] = [];
  const frames: FakeFrameWindow[] = [];
  const timers: FakeTimer[] = [];
  let removed = 0;
  let unsubscribed = 0;
  let listener: ((event: { source: unknown; origin: string; data: unknown }) => void) | null =
    null;

  const host = createSearchFrameHost({
    frameUrl: FRAME_URL,
    frameOrigin: FRAME_ORIGIN,
    mountFrame: (url) => {
      mountedUrls.push(url);
      const frameWindow = new FakeFrameWindow();
      frames.push(frameWindow);
      return {
        get target() {
          return frameWindow;
        },
        remove: () => {
          removed += 1;
        },
      };
    },
    onWindowMessage: (handler) => {
      listener = handler;
      return () => {
        unsubscribed += 1;
      };
    },
    schedule: (handler, delayMs) => {
      const timer: FakeTimer = { handler, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });

  return {
    host,
    mountedUrls,
    frames,
    timers,
    get removed() {
      return removed;
    },
    get unsubscribed() {
      return unsubscribed;
    },
    // What the real frame document would post back: right source, right origin.
    fromFrame(message: SearchFrameResponse): void {
      listener?.({ source: frames.at(-1), origin: FRAME_ORIGIN, data: message });
    },
    // An arbitrary window message, for the validation tests.
    deliver(event: { source: unknown; origin: string; data: unknown }): void {
      listener?.(event);
    },
    // Fires every armed timer of exactly this duration, once.
    fire(delayMs: number): void {
      for (const timer of timers) {
        if (timer.cancelled || timer.delayMs !== delayMs) continue;
        timer.cancelled = true;
        timer.handler();
      }
    },
  };
}

test("the frame is not injected until the first regex search", () => {
  const harness = createHarness();

  expect(harness.mountedUrls).toEqual([]);

  void harness.host.search(0, "alpha").catch(() => {});

  expect(harness.mountedUrls).toEqual([FRAME_URL]);
});

test("a frame that never reports ready makes regex search unavailable", async () => {
  const harness = createHarness();
  const search = harness.host.search(0, "alpha");

  expect(harness.timers[0].delayMs).toBe(SEARCH_FRAME_READY_TIMEOUT_MS);
  harness.fire(SEARCH_FRAME_READY_TIMEOUT_MS);

  await expect(search).rejects.toBeInstanceOf(TreeSearchUnavailableError);
});

test("an unavailable frame is not retried on the next search", async () => {
  const harness = createHarness();
  await expect(
    (() => {
      const search = harness.host.search(0, "alpha");
      harness.fire(SEARCH_FRAME_READY_TIMEOUT_MS);
      return search;
    })()
  ).rejects.toBeInstanceOf(TreeSearchUnavailableError);

  const timersAfterFirst = harness.timers.length;
  await expect(harness.host.search(0, "beta")).rejects.toBeInstanceOf(
    TreeSearchUnavailableError
  );

  // No second frame, and no fresh readiness timer: the state is cached for the
  // life of the page rather than re-probed per keystroke.
  expect(harness.mountedUrls).toEqual([FRAME_URL]);
  expect(harness.timers.length).toBe(timersAfterFirst);
});

test("the frame reporting itself unavailable rejects the search in flight", async () => {
  const harness = createHarness();
  const search = harness.host.search(0, "alpha");

  harness.fromFrame({ type: "jv-search-unavailable" });

  await expect(search).rejects.toBeInstanceOf(TreeSearchUnavailableError);
});

test("a request made before the frame is ready is held and then posted", async () => {
  const harness = createHarness();
  const search = harness.host.search(3, "alpha");

  expect(harness.frames[0].posted).toEqual([]);

  harness.fromFrame({ type: "jv-search-ready" });

  expect(harness.frames[0].posted).toEqual([
    { type: "jv-search-request", id: 1, index: 3, query: "alpha" },
  ]);
  // Replies are addressed to the frame's own origin, never "*".
  expect(harness.frames[0].targetOrigins).toEqual([FRAME_ORIGIN]);

  harness.fromFrame({ type: "jv-search-result", id: 1, matches: [4, 7] });
  await expect(search).resolves.toEqual([4, 7]);
});

test("a search that outruns its deadline aborts the worker and rejects as a timeout", async () => {
  const harness = createHarness();
  const search = harness.host.search(0, "(a+)+$");
  harness.fromFrame({ type: "jv-search-ready" });

  harness.fire(SEARCH_REQUEST_TIMEOUT_MS);

  expect(harness.frames[0].posted).toEqual([
    { type: "jv-search-request", id: 1, index: 0, query: "(a+)+$" },
    { type: "jv-search-abort", id: 1 },
  ]);
  await expect(search).rejects.toBeInstanceOf(TreeSearchTimeoutError);
});

test("a regex search after a timeout succeeds against the respawned worker", async () => {
  const harness = createHarness();
  const wedged = harness.host.search(0, "(a+)+$");
  harness.fromFrame({ type: "jv-search-ready" });
  harness.fire(SEARCH_REQUEST_TIMEOUT_MS);
  await expect(wedged).rejects.toBeInstanceOf(TreeSearchTimeoutError);

  // The frame posts ready again once the fresh worker handshakes. It is
  // idempotent here: the next search does not wait for it.
  const search = harness.host.search(0, "alpha");
  harness.fromFrame({ type: "jv-search-ready" });
  harness.fromFrame({ type: "jv-search-result", id: 2, matches: [9] });

  await expect(search).resolves.toEqual([9]);
});

test("a late result for an aborted search is ignored", async () => {
  const harness = createHarness();
  const search = harness.host.search(0, "(a+)+$");
  harness.fromFrame({ type: "jv-search-ready" });
  harness.fire(SEARCH_REQUEST_TIMEOUT_MS);
  await expect(search).rejects.toBeInstanceOf(TreeSearchTimeoutError);

  // Nothing left to settle, so this must not throw an unhandled rejection.
  harness.fromFrame({ type: "jv-search-result", id: 1, matches: [1] });
});

test("a search the frame reports failed rejects as a timeout", async () => {
  const harness = createHarness();
  const search = harness.host.search(0, "alpha");
  harness.fromFrame({ type: "jv-search-ready" });

  // The frame answers this way when the request died with a worker that was
  // terminated for someone else's runaway pattern.
  harness.fromFrame({ type: "jv-search-failed", id: 1 });

  await expect(search).rejects.toBeInstanceOf(TreeSearchTimeoutError);
});

test("a search the frame reports failed after it went unavailable says so", async () => {
  const harness = createHarness();
  await expect(
    (() => {
      const first = harness.host.search(0, "alpha");
      harness.fromFrame({ type: "jv-search-unavailable" });
      return first;
    })()
  ).rejects.toBeInstanceOf(TreeSearchUnavailableError);

  await expect(harness.host.search(0, "beta")).rejects.toBeInstanceOf(
    TreeSearchUnavailableError
  );
});

test("a message from another window is ignored", async () => {
  const harness = createHarness();
  const search = harness.host.search(0, "alpha");
  harness.fromFrame({ type: "jv-search-ready" });

  harness.deliver({
    source: { not: "the frame" },
    origin: FRAME_ORIGIN,
    data: { type: "jv-search-result", id: 1, matches: [666] },
  });
  // Still unsettled, so the real reply is what decides it.
  harness.fromFrame({ type: "jv-search-result", id: 1, matches: [4] });

  await expect(search).resolves.toEqual([4]);
});

test("a message from the frame URL's own host is ignored", async () => {
  const harness = createHarness();
  const search = harness.host.search(0, "alpha");
  harness.fromFrame({ type: "jv-search-ready" });

  // Not a hypothetical: this is the dynamic host Chrome puts in the resource
  // URL, and it is not the origin the frame document ends up running at.
  harness.deliver({
    source: harness.frames[0],
    origin: new URL(FRAME_URL).protocol + "//" + new URL(FRAME_URL).host,
    data: { type: "jv-search-result", id: 1, matches: [666] },
  });
  harness.fromFrame({ type: "jv-search-result", id: 1, matches: [4] });

  await expect(search).resolves.toEqual([4]);
});

test("a message from another origin is ignored", async () => {
  const harness = createHarness();
  const search = harness.host.search(0, "alpha");
  harness.fromFrame({ type: "jv-search-ready" });

  harness.deliver({
    source: harness.frames[0],
    origin: "https://evil.example",
    data: { type: "jv-search-result", id: 1, matches: [666] },
  });
  harness.fromFrame({ type: "jv-search-result", id: 1, matches: [4] });

  await expect(search).resolves.toEqual([4]);
});

test("disposing the host removes the frame and drops its listener", async () => {
  const harness = createHarness();
  const search = harness.host.search(0, "alpha");
  harness.fromFrame({ type: "jv-search-ready" });

  harness.host.dispose();

  await expect(search).rejects.toBeInstanceOf(TreeSearchUnavailableError);
  expect(harness.removed).toBe(1);
  expect(harness.unsubscribed).toBe(1);
});

// --- the composite index -------------------------------------------------

function recordingHost() {
  const calls: string[] = [];
  const host: SearchFrameHost = {
    allocateIndex: () => {
      calls.push("allocate");
      return 7;
    },
    init: (index, nodes) => {
      calls.push(`init:${index}:${nodes.length}`);
    },
    release: (index) => {
      calls.push(`release:${index}`);
    },
    search: async (index, query) => {
      calls.push(`search:${index}:${query}`);
      return [1];
    },
    dispose: () => {
      calls.push("dispose");
    },
  };
  return { host, calls };
}

const model = buildTreeModel({ items: [{ tag: "alpha" }, { tag: "beta" }] });

test("a plain search never reaches the frame", async () => {
  const { host, calls } = recordingHost();
  const index = createTreeSearchIndex(model, { host });

  await expect(index.search("alpha")).resolves.toHaveLength(1);

  expect(calls).toEqual([]);
});

test("a regex search reaches the frame and initialises the node set once", async () => {
  const { host, calls } = recordingHost();
  const index = createTreeSearchIndex(model, { host });

  await index.search("al(pha|pine)", { regex: true });
  await index.search("bet.", { regex: true });

  expect(calls).toEqual([
    "allocate",
    `init:7:${model.nodes.length}`,
    "search:7:al(pha|pine)",
    "search:7:bet.",
  ]);
});

test("disposing an index releases its node set without disposing the frame", async () => {
  const { host, calls } = recordingHost();
  const index = createTreeSearchIndex(model, { host });
  await index.search("alpha", { regex: true });

  index.dispose();

  expect(calls.at(-1)).toBe("release:7");
  expect(calls).not.toContain("dispose");
});

test("disposing an index that never ran a regex search releases nothing", async () => {
  const { host, calls } = recordingHost();
  const index = createTreeSearchIndex(model, { host });
  await index.search("alpha");

  index.dispose();

  expect(calls).toEqual([]);
});
