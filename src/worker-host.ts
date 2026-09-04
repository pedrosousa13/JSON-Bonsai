// The extension-origin frame document's script, loaded by worker-host.html.
//
// The content script cannot construct a worker that survives page CSP, but
// this document can: it runs at the extension origin under the extension's own
// CSP, so `new Worker("tree-worker.js")` is an ordinary same-origin load. The
// frame relays search requests to that worker and kills it with `terminate()`
// when the content script gives up on a runaway pattern. See
// docs/research/2026-09-03-firefox-worker-hosting.md.

import type {
  SearchFrameRequest,
  SearchFrameResponse,
  TreeSearchNode,
  TreeWorkerRequest,
  TreeWorkerResponse,
} from "./tree-search-protocol";
import { WORKER_HANDSHAKE_TIMEOUT_MS, defaultSchedule } from "./tree-search-protocol";

// The part of `Worker` this module uses, so tests can supply a fake.
export interface HostedWorker {
  postMessage(message: TreeWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<TreeWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface WorkerHostDeps {
  createWorker: () => HostedWorker;
  postToParent: (message: SearchFrameResponse) => void;
  // Runs `handler` after `delayMs` and returns a cancel function. Injected so
  // tests can drive the handshake timeout without waiting on real time.
  schedule?: (handler: () => void, delayMs: number) => () => void;
}

// A search the frame still owes the content script an answer for.
interface SearchRequest {
  id: number;
  index: number;
  query: string;
}

export interface WorkerHost {
  handleRequest(message: SearchFrameRequest): void;
}

// How many node sets this frame will hold at once.
//
// `worker-host.html` is a `web_accessible_resources` entry for `<all_urls>`, and
// a page can read the injected iframe's `src` straight out of its own DOM — so a
// hostile page can embed this frame itself and speak the protocol to it. The
// content script's half of the channel validates both `event.source` and
// `event.origin`; this half can only validate the source, because the frame does
// not know the embedding page's origin ahead of time and no message from a page
// can prove one. That asymmetry is accepted rather than closed.
//
// What bounds the exposure: the worker is terminable and holds no secrets, and
// any page can already run its own regex on its own thread, so the compute is
// not a capability this frame grants. What is left is memory — an unbounded
// `nodeSets` — which this cap bounds. Eight is generous for the real caller: the
// content script holds two at a time, the document's and the current JMESPath
// result's.
export const MAX_NODE_SETS = 8;

export function createWorkerHost(deps: WorkerHostDeps): WorkerHost {
  const schedule = deps.schedule ?? defaultSchedule;

  let worker: HostedWorker | null = null;
  let ready = false;
  let unavailable = false;
  let cancelHandshakeTimer: (() => void) | null = null;

  // Every live node set, kept so a respawned worker can be re-initialised
  // without the content script sending the payload again.
  const nodeSets = new Map<number, TreeSearchNode[]>();

  // Requests that arrived while no worker was ready. Queuing them is what
  // makes a respawn invisible to the content script: it does not have to wait
  // for a second ready message before searching again.
  let queued: SearchRequest[] = [];

  // Requests handed to the current worker and not yet answered.
  const inFlight = new Map<number, SearchRequest>();

  function send(request: SearchRequest): void {
    if (!worker || !ready) {
      queued.push(request);
      return;
    }
    inFlight.set(request.id, request);
    worker.postMessage({
      type: "search",
      id: request.id,
      index: request.index,
      query: request.query,
    });
  }

  function onHandshake(): void {
    cancelHandshakeTimer?.();
    cancelHandshakeTimer = null;
    ready = true;

    for (const [index, nodes] of nodeSets) {
      worker?.postMessage({ type: "init", index, nodes });
    }

    const flushing = queued;
    queued = [];
    for (const request of flushing) send(request);

    // Posted on every successful handshake, including a respawn's. The content
    // script caches readiness, so a repeat is a no-op there.
    deps.postToParent({ type: "jv-search-ready" });
  }

  function onResult(id: number, matches: number[]): void {
    inFlight.delete(id);
    deps.postToParent({ type: "jv-search-result", id, matches });
  }

  // Detaches and kills the current worker. Terminating is the only thing that
  // interrupts a regex mid-`test`; the handlers are cleared first so a reply
  // that races the terminate cannot settle a request the frame gave up on.
  function killWorker(): void {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
    ready = false;
    cancelHandshakeTimer?.();
    cancelHandshakeTimer = null;
  }

  function failRequests(requests: readonly SearchRequest[]): void {
    for (const request of requests) {
      deps.postToParent({ type: "jv-search-failed", id: request.id });
    }
  }

  // No worker can be started here, so regex search is off for the life of this
  // frame. Nothing is left waiting: the content script caches the unavailable
  // state, and anything already asked for is answered as failed.
  function markUnavailable(): void {
    unavailable = true;
    killWorker();
    deps.postToParent({ type: "jv-search-unavailable" });

    const abandoned = [...queued, ...inFlight.values()];
    queued = [];
    inFlight.clear();
    failRequests(abandoned);
  }

  function spawn(): void {
    ready = false;
    worker = deps.createWorker();
    worker.onmessage = (event) => {
      const response = event.data;
      if (response.type === "handshake-ok") onHandshake();
      else onResult(response.id, response.matches);
    };
    worker.onerror = () => {
      const hadHandshaked = ready;
      const abandoned = [...inFlight.values()];
      inFlight.clear();
      killWorker();
      failRequests(abandoned);
      // An error before the handshake means the worker script never started,
      // and a respawn would fail identically — the research recorded the only
      // symptom as an `error` event with every field undefined, so this is all
      // there is to go on.
      if (hadHandshaked) spawn();
      else markUnavailable();
    };
    worker.postMessage({ type: "handshake" });
    cancelHandshakeTimer = schedule(() => {
      cancelHandshakeTimer = null;
      markUnavailable();
    }, WORKER_HANDSHAKE_TIMEOUT_MS);
  }

  spawn();

  return {
    handleRequest(message: SearchFrameRequest): void {
      if (unavailable) {
        if (message.type === "jv-search-request") {
          deps.postToParent({ type: "jv-search-failed", id: message.id });
        }
        return;
      }

      switch (message.type) {
        case "jv-search-init":
          // Refused past the cap. A search against a set that was never stored
          // answers with no matches (the worker treats an unknown index as
          // empty), so a refusal cannot leave anyone waiting.
          if (!nodeSets.has(message.index) && nodeSets.size >= MAX_NODE_SETS) return;
          nodeSets.set(message.index, message.nodes);
          if (ready) {
            worker?.postMessage({ type: "init", index: message.index, nodes: message.nodes });
          }
          return;

        case "jv-search-release":
          nodeSets.delete(message.index);
          if (ready) worker?.postMessage({ type: "release", index: message.index });
          return;

        case "jv-search-request":
          send({ id: message.id, index: message.index, query: message.query });
          return;

        case "jv-search-abort": {
          // The content script has already settled the aborted request, so it
          // is simply dropped. Everything else the dead worker was holding is
          // reported failed: those requests were queued behind a wedged regex
          // and never ran.
          inFlight.delete(message.id);
          const abandoned = [...inFlight.values()];
          inFlight.clear();
          killWorker();
          failRequests(abandoned);
          spawn();
          return;
        }
      }
    },
  };
}

// Load-time bootstrap. Guarded so the module stays importable from unit tests,
// which drive createWorkerHost with a fake worker instead.
function bootstrapWorkerHost(): void {
  const host = createWorkerHost({
    // Same-origin from this document, so it needs no web_accessible_resources
    // entry of its own — only worker-host.html does.
    createWorker: () => new Worker("tree-worker.js"),
    // Replies go out with "*" as the target origin: the frame cannot know the
    // page's origin ahead of time, and these payloads carry only node ids and
    // the user's own search query — nothing secret. The content script is what
    // validates the origin and source on the way in.
    postToParent: (message) => window.parent.postMessage(message, "*"),
  });

  window.addEventListener("message", (event) => {
    // Only the embedding parent may drive this frame. That is weaker than the
    // content script's check on the other end, which validates the origin too —
    // see MAX_NODE_SETS for why this side cannot, and what bounds the damage.
    if (event.source !== window.parent) return;
    const message = event.data as SearchFrameRequest | null;
    if (!message || typeof message.type !== "string") return;
    host.handleRequest(message);
  });
}

if (typeof window !== "undefined" && window.parent !== window) bootstrapWorkerHost();
