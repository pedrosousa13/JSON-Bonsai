// The content script's half of terminable regex search.
//
// A catastrophic-backtracking pattern blocks inside a single `regex.test` call,
// and nothing on the main thread can interrupt that — not batching, not a time
// budget. So regex search runs in a worker owned by a hidden extension-origin
// iframe (worker-host.html), where `terminate()` genuinely stops the regex
// engine. This module injects that frame, speaks the protocol to it, and bounds
// every request with a deadline.
//
// Plain substring search stays on the main thread in the existing local index:
// it cannot backtrack, so it cannot wedge, and it costs nothing to keep local.
//
// See docs/research/2026-09-03-firefox-worker-hosting.md.

import type { TreeModel } from "./tree-model";
import {
  createLocalTreeSearchIndex,
  createTreeSearchNodes,
  type TreeSearchIndex,
  type TreeSearchOptions,
} from "./tree-search";
import type {
  SearchFrameRequest,
  SearchFrameResponse,
  TreeSearchNode,
} from "./tree-search-protocol";
import {
  SEARCH_FRAME_READY_TIMEOUT_MS,
  SEARCH_REQUEST_TIMEOUT_MS,
} from "./tree-search-protocol";

// A search that was killed rather than answered: its worker was terminated
// because the pattern was still running when the deadline passed, or because
// another request's pattern was. Distinct from "0 results" on purpose — the two
// must not look alike in the UI.
export class TreeSearchTimeoutError extends Error {
  constructor(message = "Search timed out") {
    super(message);
    this.name = "TreeSearchTimeoutError";
  }
}

// No frame could be started on this page, so regex search has nowhere to run.
// Terminal for the life of the page.
export class TreeSearchUnavailableError extends Error {
  constructor(message = "Regex search is unavailable on this page") {
    super(message);
    this.name = "TreeSearchUnavailableError";
  }
}

// The part of a `Window` this module posts to, so tests can supply a fake.
export interface SearchFramePostTarget {
  postMessage(message: SearchFrameRequest, targetOrigin: string): void;
}

export interface MountedSearchFrame {
  // The frame's own window, or null before its document exists. Read through a
  // getter because a freshly appended iframe acquires one asynchronously, and
  // compared by identity against `event.source` on the way in.
  readonly target: SearchFramePostTarget | null;
  remove(): void;
}

// The fields of a `MessageEvent` the origin/source check needs. Narrowed so a
// test can deliver an event without constructing a real one.
export interface SearchFrameMessageEvent {
  readonly source: unknown;
  readonly origin: string;
  readonly data: unknown;
}

export interface SearchFrameHostDeps {
  // The URL to load the frame document from.
  frameUrl: string;
  // The origin its messages must arrive from. Separate from `frameUrl` on
  // purpose: `worker-host.html` is declared `use_dynamic_url: true`, so
  // `runtime.getURL` hands back a per-session GUID host, while the document it
  // loads still runs at the extension's static origin — that static origin is
  // what shows up as `event.origin`. Measured in Chromium: the URL's host was
  // `a99be5a8-…` and the frame's origin `chrome-extension://okiimod…`. Both
  // must be computed at runtime; neither may be a hardcoded extension id.
  frameOrigin: string;
  mountFrame: (url: string) => MountedSearchFrame;
  // Subscribes to the window's message events; returns the unsubscribe.
  onWindowMessage: (listener: (event: SearchFrameMessageEvent) => void) => () => void;
  // Runs `handler` after `delayMs` and returns a cancel function. Injected so
  // tests drive the two deadlines without waiting on real time.
  schedule?: (handler: () => void, delayMs: number) => () => void;
}

export interface SearchFrameHost {
  // Claims an `index` for one node set. A page mounts several over its life.
  allocateIndex(): number;
  init(index: number, nodes: TreeSearchNode[]): void;
  release(index: number): void;
  search(index: number, query: string): Promise<number[]>;
  dispose(): void;
}

interface PendingSearch {
  resolve: (matches: number[]) => void;
  reject: (error: Error) => void;
  cancelTimer: (() => void) | null;
}

function defaultSchedule(handler: () => void, delayMs: number): () => void {
  const handle = setTimeout(handler, delayMs);
  return () => clearTimeout(handle);
}

export function createSearchFrameHost(deps: SearchFrameHostDeps): SearchFrameHost {
  const schedule = deps.schedule ?? defaultSchedule;

  let frame: MountedSearchFrame | null = null;
  let unsubscribe: (() => void) | null = null;
  let cancelReadyTimer: (() => void) | null = null;
  let ready = false;
  let unavailable = false;

  let nextIndex = 0;
  let nextRequestId = 0;
  const pending = new Map<number, PendingSearch>();

  // Messages written before the frame reported ready. The frame's own document
  // does not exist for the first hundred milliseconds or so, and posting into
  // the placeholder about:blank window it starts with would simply lose the
  // message, so nothing goes out until `jv-search-ready` arrives.
  let outbox: SearchFrameRequest[] = [];

  function deliver(message: SearchFrameRequest): void {
    frame?.target?.postMessage(message, deps.frameOrigin);
    // The deadline covers the frame's turnaround, not the wait for a frame that
    // has not started yet — so it is armed at the moment the request goes out.
    if (message.type === "jv-search-request") armDeadline(message.id);
  }

  function post(message: SearchFrameRequest): void {
    if (ready) deliver(message);
    else outbox.push(message);
  }

  function armDeadline(id: number): void {
    const entry = pending.get(id);
    if (entry === undefined) return;
    entry.cancelTimer = schedule(() => {
      entry.cancelTimer = null;
      pending.delete(id);
      // Aborting terminates the worker, which is the only thing that stops a
      // regex mid-`test`. The frame respawns and replays the stored inits, so
      // the next search needs nothing from us.
      deliver({ type: "jv-search-abort", id });
      entry.reject(new TreeSearchTimeoutError());
    }, SEARCH_REQUEST_TIMEOUT_MS);
  }

  function settleAllWith(error: Error): void {
    const abandoned = [...pending.values()];
    pending.clear();
    for (const entry of abandoned) {
      entry.cancelTimer?.();
      entry.reject(error);
    }
  }

  function teardown(): void {
    cancelReadyTimer?.();
    cancelReadyTimer = null;
    frame?.remove();
    frame = null;
    unsubscribe?.();
    unsubscribe = null;
    ready = false;
    outbox = [];
  }

  // Either the frame said so, or it never answered in time. Both are terminal:
  // regex search is off for the life of this page, and the frame goes away
  // rather than being left to report ready late and resurrect itself.
  function markUnavailable(): void {
    unavailable = true;
    teardown();
    settleAllWith(new TreeSearchUnavailableError());
  }

  function onReady(): void {
    // The frame posts this on every successful worker handshake, a respawn's
    // included, so a repeat is a no-op.
    if (ready) return;
    cancelReadyTimer?.();
    cancelReadyTimer = null;
    ready = true;

    const flushing = outbox;
    outbox = [];
    for (const message of flushing) deliver(message);
  }

  function onResult(id: number, matches: number[]): void {
    const entry = pending.get(id);
    // Nothing pending means this request was already settled as a timeout and
    // the worker's answer lost the race. Dropping it is correct.
    if (entry === undefined) return;
    entry.cancelTimer?.();
    pending.delete(id);
    entry.resolve(matches);
  }

  function onFailed(id: number): void {
    const entry = pending.get(id);
    if (entry === undefined) return;
    entry.cancelTimer?.();
    pending.delete(id);
    // A failure while the frame still works means this request died with a
    // worker terminated for someone else's runaway pattern — it never ran, and
    // "timed out" is the honest thing to tell the user. The unavailable case is
    // already settled by markUnavailable, so it cannot reach here.
    entry.reject(new TreeSearchTimeoutError());
  }

  function handleMessage(event: SearchFrameMessageEvent): void {
    if (frame === null) return;
    // The frame replies with "*" as its target origin — it cannot know the
    // page's origin — so these two checks are the whole of what separates it
    // from any other script that can post to this window.
    if (event.source !== frame.target) return;
    if (event.origin !== deps.frameOrigin) return;

    const message = event.data as SearchFrameResponse | null;
    if (!message || typeof message.type !== "string") return;

    switch (message.type) {
      case "jv-search-ready":
        onReady();
        return;
      case "jv-search-unavailable":
        markUnavailable();
        return;
      case "jv-search-result":
        onResult(message.id, message.matches);
        return;
      case "jv-search-failed":
        onFailed(message.id);
        return;
    }
  }

  // Injected on the first regex search, never at page load: a user who never
  // opens regex mode should not pay for the frame, and the init payload it
  // needs is proportional to document size.
  function ensureFrame(): void {
    if (frame !== null || unavailable) return;
    unsubscribe = deps.onWindowMessage(handleMessage);
    frame = deps.mountFrame(deps.frameUrl);
    cancelReadyTimer = schedule(() => {
      cancelReadyTimer = null;
      markUnavailable();
    }, SEARCH_FRAME_READY_TIMEOUT_MS);
  }

  return {
    allocateIndex(): number {
      nextIndex += 1;
      return nextIndex - 1;
    },

    init(index: number, nodes: TreeSearchNode[]): void {
      ensureFrame();
      if (unavailable) return;
      post({ type: "jv-search-init", index, nodes });
    },

    release(index: number): void {
      if (frame === null) return;
      post({ type: "jv-search-release", index });
    },

    search(index: number, query: string): Promise<number[]> {
      ensureFrame();
      if (unavailable) return Promise.reject(new TreeSearchUnavailableError());

      nextRequestId += 1;
      const id = nextRequestId;
      return new Promise<number[]>((resolve, reject) => {
        pending.set(id, { resolve, reject, cancelTimer: null });
        post({ type: "jv-search-request", id, index, query });
      });
    },

    dispose(): void {
      teardown();
      settleAllWith(new TreeSearchUnavailableError());
    },
  };
}

// One frame per page, shared by every index mounted over its life. Created
// lazily so nothing touches `chrome.runtime` or the DOM until regex search is
// actually used.
let sharedHost: SearchFrameHost | null = null;

// The origin the frame document runs at. Taken from the extension root, which
// is never rotated — only resources declared `use_dynamic_url` get a GUID host,
// and "/" is not one of them — so this is what arrives as `event.origin` on
// both browsers, with no extension id spelled out anywhere. Written as protocol
// + host rather than read off `URL.origin` because `chrome-extension:` and
// `moz-extension:` are not "special" schemes, and `origin` serialises to the
// string "null" for those outside a browser.
function extensionOrigin(): string {
  const root = new URL(chrome.runtime.getURL("/"));
  return `${root.protocol}//${root.host}`;
}

function sharedSearchFrameHost(): SearchFrameHost {
  sharedHost ??= createSearchFrameHost({
    frameUrl: chrome.runtime.getURL("worker-host.html"),
    frameOrigin: extensionOrigin(),
    mountFrame: (url) => {
      const iframe = document.createElement("iframe");
      iframe.id = "jv-search-frame";
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.display = "none";
      iframe.src = url;
      // On <html>, outside the viewer's body: the tree and table replace their
      // own subtrees as queries come and go, and an iframe that gets reparented
      // reloads — taking the worker and every stored node set with it.
      document.documentElement.appendChild(iframe);
      return {
        get target() {
          return iframe.contentWindow;
        },
        remove: () => iframe.remove(),
      };
    },
    onWindowMessage: (listener) => {
      const handler = (event: MessageEvent): void => listener(event);
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    },
  });
  return sharedHost;
}

// Removes the shared frame. For viewer teardown only — disposing one index must
// not take the frame with it, because other indexes may still be using it.
export function disposeSharedSearchFrame(): void {
  sharedHost?.dispose();
  sharedHost = null;
}

export interface TreeSearchIndexDeps {
  // The frame host to route regex searches through. Defaults to the page's
  // shared one; tests pass their own.
  host?: SearchFrameHost;
}

// A `TreeSearchIndex` that keeps plain substring search local and sends regex
// search to the frame. Regex failure rejects with one of the two errors above —
// never an empty match list — and there is deliberately no main-thread
// fallback: running the regex here is the bug.
export function createTreeSearchIndex(
  model: TreeModel,
  deps?: TreeSearchIndexDeps
): TreeSearchIndex {
  const local = createLocalTreeSearchIndex(model);
  let host: SearchFrameHost | null = deps?.host ?? null;
  let frameIndex: number | null = null;

  return {
    async search(query: string, options?: TreeSearchOptions): Promise<number[]> {
      if (!options?.regex) return local.search(query, options);

      host ??= sharedSearchFrameHost();
      if (frameIndex === null) {
        frameIndex = host.allocateIndex();
        // Built here and handed over: the frame keeps the only copy it needs,
        // and replays it into a respawned worker without asking again.
        host.init(frameIndex, createTreeSearchNodes(model));
      }
      return host.search(frameIndex, query);
    },

    dispose(): void {
      local.dispose();
      if (host !== null && frameIndex !== null) host.release(frameIndex);
    },
  };
}
