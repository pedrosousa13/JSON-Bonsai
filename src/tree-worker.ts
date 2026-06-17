import {
  collectTreeSearchMatches,
  hydrateTreeSearchNodes,
  sortTreeSearchMatches,
  type TreeSearchMatch,
  type TreeSearchNode,
} from "./tree-search";
import type {
  TreeWorkerMessage,
  WorkerSearchMessage,
} from "./tree-worker-protocol";

const WORKER_SEARCH_BATCH_SIZE = 500;

let searchNodes: TreeSearchNode[] = [];
let latestRequestId = 0;

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function runSearch(message: WorkerSearchMessage): Promise<void> {
  latestRequestId = message.requestId;
  // Regex queries are matched verbatim; substring queries are normalized.
  const query = message.regex ? message.query : message.query.trim().toLowerCase();

  // An empty substring query has no matches; skip iterating every batch.
  // (Regex matching is left to collectTreeSearchMatches, which also handles
  // invalid patterns by returning no matches.)
  if (!message.regex && !query) {
    self.postMessage({
      type: "search-result",
      requestId: message.requestId,
      matches: [],
    });
    return;
  }

  const matches: TreeSearchMatch[] = [];
  const total = searchNodes.length;

  for (let start = 0; start < total; start += WORKER_SEARCH_BATCH_SIZE) {
    if (message.requestId !== latestRequestId) return;

    const end = Math.min(start + WORKER_SEARCH_BATCH_SIZE, total);
    const batch = collectTreeSearchMatches(searchNodes, query, start, end, {
      regex: message.regex,
    });
    for (let index = 0; index < batch.length; index += 1) matches.push(batch[index]);

    if (end < total) await nextTask();
  }

  if (message.requestId !== latestRequestId) {
    return;
  }

  self.postMessage({
    type: "search-result",
    requestId: message.requestId,
    matches: sortTreeSearchMatches(matches),
  });
}

self.addEventListener("message", (event: MessageEvent<TreeWorkerMessage>) => {
  const message = event.data;

  if (message.type === "init") {
    searchNodes = hydrateTreeSearchNodes(message.nodes);
    return;
  }

  void runSearch(message);
});
