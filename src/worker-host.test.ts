import { expect, test } from "vitest";

import type {
  SearchFrameResponse,
  TreeSearchNode,
  TreeWorkerRequest,
  TreeWorkerResponse,
} from "./tree-search-protocol";
import { WORKER_HANDSHAKE_TIMEOUT_MS } from "./tree-search-protocol";
import { type HostedWorker, createWorkerHost } from "./worker-host";

class FakeWorker implements HostedWorker {
  readonly posted: TreeWorkerRequest[] = [];
  terminated = 0;
  onmessage: ((event: MessageEvent<TreeWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: TreeWorkerRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated += 1;
  }

  // Test-side pushes: what a real worker would deliver to the frame.
  reply(response: TreeWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<TreeWorkerResponse>);
  }

  fail(): void {
    this.onerror?.({} as ErrorEvent);
  }
}

interface FakeTimer {
  handler: () => void;
  delayMs: number;
  cancelled: boolean;
}

function createHostHarness() {
  const workers: FakeWorker[] = [];
  const parentMessages: SearchFrameResponse[] = [];
  const timers: FakeTimer[] = [];

  const host = createWorkerHost({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    postToParent: (message) => parentMessages.push(message),
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
    workers,
    parentMessages,
    timers,
    // Fires every armed timer once, in the order they were armed.
    runTimers(): void {
      for (const timer of timers) {
        if (timer.cancelled) continue;
        timer.cancelled = true;
        timer.handler();
      }
    },
  };
}

const nodes: TreeSearchNode[] = [
  {
    id: 0,
    searchValue: "alpha",
    hasLongSearchValue: false,
    searchKey: "tag",
    searchPath: "data.tag",
    isContainer: false,
  },
];

test("a worker that never answers the handshake makes regex search unavailable", () => {
  const harness = createHostHarness();

  expect(harness.workers[0].posted).toEqual([{ type: "handshake" }]);
  expect(harness.timers[0].delayMs).toBe(WORKER_HANDSHAKE_TIMEOUT_MS);

  harness.runTimers();

  expect(harness.parentMessages).toEqual([{ type: "jv-search-unavailable" }]);
});

test("a worker that answers the handshake makes regex search ready", () => {
  const harness = createHostHarness();

  harness.workers[0].reply({ type: "handshake-ok" });

  expect(harness.parentMessages).toEqual([{ type: "jv-search-ready" }]);

  // The armed handshake timeout must not fire after a successful handshake.
  harness.runTimers();
  expect(harness.parentMessages).toEqual([{ type: "jv-search-ready" }]);
});

test("a request made before the worker is ready is flushed once it handshakes", () => {
  const harness = createHostHarness();

  harness.host.handleRequest({ type: "jv-search-init", index: 0, nodes });
  harness.host.handleRequest({ type: "jv-search-request", id: 1, index: 0, query: "alpha" });

  expect(harness.workers[0].posted).toEqual([{ type: "handshake" }]);

  harness.workers[0].reply({ type: "handshake-ok" });

  expect(harness.workers[0].posted).toEqual([
    { type: "handshake" },
    { type: "init", index: 0, nodes },
    { type: "search", id: 1, index: 0, query: "alpha" },
  ]);
});

test("a worker result is relayed to the content script", () => {
  const harness = createHostHarness();
  harness.workers[0].reply({ type: "handshake-ok" });

  harness.host.handleRequest({ type: "jv-search-init", index: 0, nodes });
  harness.host.handleRequest({ type: "jv-search-request", id: 4, index: 0, query: "alpha" });
  harness.workers[0].reply({ type: "result", id: 4, matches: [0] });

  expect(harness.parentMessages).toEqual([
    { type: "jv-search-ready" },
    { type: "jv-search-result", id: 4, matches: [0] },
  ]);
});

test("an abort terminates the worker and respawns one with the stored inits", () => {
  const harness = createHostHarness();
  harness.workers[0].reply({ type: "handshake-ok" });
  harness.host.handleRequest({ type: "jv-search-init", index: 0, nodes });
  harness.host.handleRequest({ type: "jv-search-request", id: 1, index: 0, query: "(a+)+$" });

  harness.host.handleRequest({ type: "jv-search-abort", id: 1 });

  expect(harness.workers[0].terminated).toBe(1);
  expect(harness.workers).toHaveLength(2);

  harness.workers[1].reply({ type: "handshake-ok" });
  expect(harness.workers[1].posted).toEqual([
    { type: "handshake" },
    { type: "init", index: 0, nodes },
  ]);

  // The aborted request is dropped — the content script settled it as a
  // timeout before sending the abort.
  expect(harness.parentMessages).toEqual([
    { type: "jv-search-ready" },
    { type: "jv-search-ready" },
  ]);
});

test("a terminated worker's late reply is ignored", () => {
  const harness = createHostHarness();
  harness.workers[0].reply({ type: "handshake-ok" });
  harness.host.handleRequest({ type: "jv-search-request", id: 1, index: 0, query: "alpha" });
  harness.host.handleRequest({ type: "jv-search-abort", id: 1 });

  harness.workers[0].reply({ type: "result", id: 1, matches: [0] });

  expect(harness.parentMessages).toEqual([{ type: "jv-search-ready" }]);
});

test("a search issued after a respawn is answered", () => {
  const harness = createHostHarness();
  harness.workers[0].reply({ type: "handshake-ok" });
  harness.host.handleRequest({ type: "jv-search-init", index: 0, nodes });
  harness.host.handleRequest({ type: "jv-search-request", id: 1, index: 0, query: "(a+)+$" });
  harness.host.handleRequest({ type: "jv-search-abort", id: 1 });

  // The next search arrives before the fresh worker has handshaked, which is
  // the normal case: the content script does not know a respawn happened.
  harness.host.handleRequest({ type: "jv-search-request", id: 2, index: 0, query: "alpha" });
  harness.workers[1].reply({ type: "handshake-ok" });
  harness.workers[1].reply({ type: "result", id: 2, matches: [0] });

  expect(harness.workers[1].posted).toEqual([
    { type: "handshake" },
    { type: "init", index: 0, nodes },
    { type: "search", id: 2, index: 0, query: "alpha" },
  ]);
  expect(harness.parentMessages.at(-1)).toEqual({ type: "jv-search-result", id: 2, matches: [0] });
});

test("a worker error fails every request in flight and respawns", () => {
  const harness = createHostHarness();
  harness.workers[0].reply({ type: "handshake-ok" });
  harness.host.handleRequest({ type: "jv-search-request", id: 3, index: 0, query: "alpha" });

  harness.workers[0].fail();

  expect(harness.parentMessages).toEqual([
    { type: "jv-search-ready" },
    { type: "jv-search-failed", id: 3 },
  ]);
  expect(harness.workers[0].terminated).toBe(1);
  expect(harness.workers).toHaveLength(2);
});

test("a worker that errors before it ever handshakes reports unavailable", () => {
  const harness = createHostHarness();

  // An error this early means the worker script cannot start at all — a
  // respawn would fail the same way, forever.
  harness.workers[0].fail();

  expect(harness.parentMessages).toEqual([{ type: "jv-search-unavailable" }]);
  expect(harness.workers).toHaveLength(1);
});

test("requests waiting on a handshake that times out are reported failed", () => {
  const harness = createHostHarness();
  harness.host.handleRequest({ type: "jv-search-request", id: 5, index: 0, query: "alpha" });

  harness.runTimers();

  expect(harness.parentMessages).toEqual([
    { type: "jv-search-unavailable" },
    { type: "jv-search-failed", id: 5 },
  ]);
});

test("a request made after the frame is unavailable fails instead of hanging", () => {
  const harness = createHostHarness();
  harness.runTimers();

  harness.host.handleRequest({ type: "jv-search-request", id: 6, index: 0, query: "alpha" });

  expect(harness.parentMessages).toEqual([
    { type: "jv-search-unavailable" },
    { type: "jv-search-failed", id: 6 },
  ]);
  expect(harness.workers).toHaveLength(1);
});

test("an abort reports the other requests the dead worker was holding", () => {
  const harness = createHostHarness();
  harness.workers[0].reply({ type: "handshake-ok" });
  harness.host.handleRequest({ type: "jv-search-request", id: 1, index: 0, query: "(a+)+$" });
  harness.host.handleRequest({ type: "jv-search-request", id: 2, index: 0, query: "alpha" });

  harness.host.handleRequest({ type: "jv-search-abort", id: 1 });

  // id 2 was queued behind the wedged regex inside the worker and never ran,
  // so it can only be reported failed — not left to hang, and not aborted
  // silently the way id 1 is.
  expect(harness.parentMessages).toEqual([
    { type: "jv-search-ready" },
    { type: "jv-search-failed", id: 2 },
  ]);
});

test("a release reaches a worker that is already running", () => {
  const harness = createHostHarness();
  harness.workers[0].reply({ type: "handshake-ok" });
  harness.host.handleRequest({ type: "jv-search-init", index: 0, nodes });

  harness.host.handleRequest({ type: "jv-search-release", index: 0 });

  expect(harness.workers[0].posted).toEqual([
    { type: "handshake" },
    { type: "init", index: 0, nodes },
    { type: "release", index: 0 },
  ]);

  // A released node set is not replayed into the next worker.
  harness.host.handleRequest({ type: "jv-search-abort", id: 0 });
  harness.workers[1].reply({ type: "handshake-ok" });
  expect(harness.workers[1].posted).toEqual([{ type: "handshake" }]);
});
