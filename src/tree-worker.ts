// The search worker. Spawned by the extension-origin frame document
// (worker-host.html) as `new Worker("tree-worker.js")`.
//
// There is deliberately no batching, no yielding and no time budget in here. A
// catastrophic-backtracking pattern blocks inside a single `regex.test` call,
// which nothing can interrupt — being killable by `terminate()` is the whole
// point of running it here, and a blocked worker harms nobody.

import { collectTreeSearchMatches, sortTreeSearchMatches } from "./tree-search";
import type {
  TreeSearchNode,
  TreeWorkerRequest,
  TreeWorkerResponse,
} from "./tree-search-protocol";

export function createTreeWorkerMessageHandler(
  post: (response: TreeWorkerResponse) => void
): (message: TreeWorkerRequest) => void {
  // One entry per live search index. The frame owns the same map and replays
  // every entry into a respawned worker.
  const nodeSets = new Map<number, TreeSearchNode[]>();

  return (message: TreeWorkerRequest): void => {
    switch (message.type) {
      case "handshake":
        post({ type: "handshake-ok" });
        return;

      case "init":
        nodeSets.set(message.index, message.nodes);
        return;

      case "release":
        nodeSets.delete(message.index);
        return;

      case "search": {
        // An index this worker never saw is not an error: the frame replays
        // inits after a respawn, and a release can race a request in flight.
        const nodes = nodeSets.get(message.index) ?? [];
        const matches = collectTreeSearchMatches(nodes, message.query, 0, nodes.length, {
          regex: true,
        });
        post({ type: "result", id: message.id, matches: sortTreeSearchMatches(matches) });
        return;
      }
    }
  };
}

// The worker global. `self` is typed as a Window under the DOM lib, which a
// dedicated worker scope is not, so it is narrowed to what this module uses.
interface TreeWorkerScope {
  importScripts?: unknown;
  postMessage(message: TreeWorkerResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<TreeWorkerRequest>) => void
  ): void;
}

const scope = globalThis as unknown as TreeWorkerScope;

// Only wire up when this bundle really is running as a worker. `importScripts`
// exists on every worker scope and on no other host, which keeps the module
// importable from unit tests.
if (typeof scope.importScripts === "function") {
  const handleMessage = createTreeWorkerMessageHandler((response) => scope.postMessage(response));
  scope.addEventListener("message", (event) => handleMessage(event.data));
}
