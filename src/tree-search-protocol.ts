// The wire contract shared by the three participants in a regex search: the
// content script, the extension-origin frame document (`worker-host.html`) and
// the worker that frame spawns (`tree-worker.js`). Kept in its own module so
// none of them has to import another's implementation to agree on a message.
//
// Every request that reaches the worker is a regex search. A plain substring
// search never leaves the main thread — it cannot backtrack, so it cannot
// wedge — which is why no message carries a `regex` flag.
//
// See docs/research/2026-09-03-firefox-worker-hosting.md for why the frame
// exists at all: a blob-URL worker is blocked by ordinary page CSP on both
// Chrome and Firefox, and an extension-origin iframe is the only host that
// survives it.

// One node as the matcher sees it. Built on the main thread by
// `createTreeSearchNodes` and structured-cloned to the worker.
export interface TreeSearchNode {
  id: number;
  searchValue: string;
  hasLongSearchValue: boolean;
  rawStringValue?: string;
  searchKey: string;
  searchPath: string;
  isContainer: boolean;
}

// `index` identifies which node set a message targets. A page mounts more than
// one search index over its life (the original document, plus a fresh one per
// JMESPath query result), so both the frame and the worker keep a
// Map<index, nodes> — the frame's copy is what it replays to a respawned
// worker.

// Content script -> frame, via `iframe.contentWindow.postMessage`.
export type SearchFrameRequest =
  | { type: "jv-search-init"; index: number; nodes: TreeSearchNode[] }
  | { type: "jv-search-release"; index: number }
  | { type: "jv-search-request"; id: number; index: number; query: string }
  | { type: "jv-search-abort"; id: number };

// Frame -> content script, via `window.parent.postMessage`.
export type SearchFrameResponse =
  | { type: "jv-search-ready" }
  | { type: "jv-search-unavailable" }
  | { type: "jv-search-result"; id: number; matches: number[] }
  | { type: "jv-search-failed"; id: number };

// Frame -> worker.
export type TreeWorkerRequest =
  | { type: "handshake" }
  | { type: "init"; index: number; nodes: TreeSearchNode[] }
  | { type: "release"; index: number }
  | { type: "search"; id: number; index: number; query: string };

// Worker -> frame.
export type TreeWorkerResponse =
  | { type: "handshake-ok" }
  | { type: "result"; id: number; matches: number[] };

// The three timeouts below have to compose inside one 2-second budget: issue
// #51 requires that a catastrophic pattern settles in the UI within 2 seconds,
// cold frame or warm. The request deadline is armed when the request is made
// rather than when it is delivered, so it is the outer bound and the other two
// are sized to land inside it.

// Bounds one search, from the moment the content script is asked for it to
// `jv-search-result` — the wait for a frame that has not started yet included.
// On expiry the content script posts `jv-search-abort`, which terminates the
// worker, and settles the search as a timeout. 1500 ms leaves 500 ms of the
// 2-second criterion for the UI to repaint.
export const SEARCH_REQUEST_TIMEOUT_MS = 1500;

// Bounds the frame document's own start-up: from injecting the iframe to
// receiving `jv-search-ready` from it. 1200 ms is roughly 10x the measured
// handshake (80-120 ms on Chrome, the same range on Firefox) and still inside
// the request deadline above, so a cold frame that never answers fails the
// search rather than outliving it. Expiry is a guess, not a verdict: the next
// regex search remounts once (SEARCH_FRAME_MOUNT_ATTEMPTS), and only a second
// silent frame turns regex mode off for the life of the page.
export const SEARCH_FRAME_READY_TIMEOUT_MS = 1200;

// Bounds the worker handshake inside the frame. A worker that cannot start
// reports nothing useful — on both browsers the failure is an async `error`
// event with `message`, `filename` and `lineno` all `undefined` — so a
// handshake with a timeout is the only available detection. On expiry the
// frame posts `jv-search-unavailable`. 1000 ms sits under the frame-readiness
// budget so the frame's own verdict reaches the content script before that
// budget expires, which is what turns a dead worker into an immediate,
// terminal "unavailable" instead of a retried readiness timeout.
export const WORKER_HANDSHAKE_TIMEOUT_MS = 1000;

// Runs `handler` after `delayMs` and returns a cancel function. Shared by the
// content script's frame host and the frame's own worker host, both of which
// take it as an injectable default so tests drive their deadlines without
// waiting on real time.
export function defaultSchedule(handler: () => void, delayMs: number): () => void {
  const handle = setTimeout(handler, delayMs);
  return () => clearTimeout(handle);
}
