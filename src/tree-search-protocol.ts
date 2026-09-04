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

// Bounds the frame document's own start-up: from injecting the iframe to
// receiving `jv-search-ready` from it. Expiry marks regex mode unavailable for
// the life of the page — cache that, do not retry per keystroke.
export const SEARCH_FRAME_READY_TIMEOUT_MS = 3000;

// Bounds the worker handshake inside the frame. A worker that cannot start
// reports nothing useful — on both browsers the failure is an async `error`
// event with `message`, `filename` and `lineno` all `undefined` — so a
// handshake with a timeout is the only available detection. On expiry the
// frame posts `jv-search-unavailable`.
export const WORKER_HANDSHAKE_TIMEOUT_MS = 2000;

// Bounds one search, from `jv-search-request` to `jv-search-result`. On expiry
// the content script posts `jv-search-abort`, which terminates the worker, and
// settles the search as a timeout. 1500 ms keeps the whole thing inside the
// 2-second acceptance criterion.
export const SEARCH_REQUEST_TIMEOUT_MS = 1500;
