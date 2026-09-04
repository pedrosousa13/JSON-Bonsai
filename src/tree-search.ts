import { type TreeModel, isContainerNode } from "./tree-model";
// The node shape lives in the protocol module: the worker matches over nodes
// that were built here and structured-cloned across, so both sides need one
// definition. Re-exported so existing importers keep working.
import type { TreeSearchNode } from "./tree-search-protocol";

export type { TreeSearchNode };

// Module-internal: `collectTreeSearchMatches` hands these to
// `sortTreeSearchMatches`, and every caller of that pair — the local index here
// and the worker — only ever passes them straight through.
interface TreeSearchMatch {
  nodeId: number;
  score: number;
}

export interface TreeSearchOptions {
  regex?: boolean;
}

export interface TreeSearchIndex {
  search(query: string, options?: TreeSearchOptions): Promise<number[]>;
  dispose(): void;
}

// Nodes scanned per event-loop task. Search runs on the main thread, so the
// scan is chunked to keep any single task short enough to leave frames free.
const SEARCH_SCAN_BATCH_SIZE = 500;

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

// Compiles a regex query with the case-insensitive flag, returning null when
// the pattern is invalid so callers can degrade gracefully instead of throwing.
// Values are indexed lowercased and truncated to 200 chars (see
// SEARCH_VALUE_PREVIEW_LIMIT in tree-model.ts), but the compiled regex is not
// limited to that: long strings are also tested against the untruncated
// `rawStringValue`, and keys and paths are never truncated.
export function compileSearchRegex(query: string): RegExp | null {
  try {
    return new RegExp(query, "i");
  } catch {
    return null;
  }
}

function valueMatches(node: TreeSearchNode, query: string): boolean {
  if (!node.searchValue) return false;
  if (node.searchValue.includes(query)) return true;
  return node.hasLongSearchValue && typeof node.rawStringValue === "string"
    ? node.rawStringValue.includes(query)
    : false;
}

function valueMatchesRegex(node: TreeSearchNode, regex: RegExp): boolean {
  if (!node.searchValue) return false;
  if (regex.test(node.searchValue)) return true;
  return node.hasLongSearchValue && typeof node.rawStringValue === "string"
    ? regex.test(node.rawStringValue)
    : false;
}

function matchScore(node: TreeSearchNode, query: string): number | null {
  if (node.searchKey === query || node.searchPath === query) return 0;
  if (!node.isContainer && node.searchValue === query) return 1;
  if (!node.isContainer && valueMatches(node, query)) return 2;
  if (node.searchKey && node.searchKey.includes(query)) return 3;
  if (node.searchPath.includes(query)) return 4;
  return null;
}

// Regex matches don't carry a meaningful ranking the way substring matches do,
// so every hit shares one score and the node id breaks ties (see
// sortTreeSearchMatches). Key/path/value are tested in that priority order.
function matchScoreRegex(node: TreeSearchNode, regex: RegExp): number | null {
  if (node.searchKey && regex.test(node.searchKey)) return 0;
  if (regex.test(node.searchPath)) return 0;
  if (!node.isContainer && valueMatchesRegex(node, regex)) return 0;
  return null;
}

export function createTreeSearchNodes(model: TreeModel): TreeSearchNode[] {
  return model.nodes.map((node) => ({
    id: node.id,
    searchValue: node.searchValue,
    hasLongSearchValue: node.hasLongSearchValue,
    rawStringValue:
      node.hasLongSearchValue && typeof node.value === "string"
        ? node.value.toLowerCase()
        : undefined,
    searchKey: node.searchKey,
    searchPath: node.searchPath,
    isContainer: isContainerNode(node),
  }));
}

// `query` arrives ready to match: normalized for a substring search, verbatim
// for a regex one. Normalizing here would repeat the work on every batch.
export function collectTreeSearchMatches(
  nodes: readonly TreeSearchNode[],
  query: string,
  start = 0,
  end: number = nodes.length,
  options?: TreeSearchOptions
): TreeSearchMatch[] {
  if (options?.regex) {
    const regex = compileSearchRegex(query);
    if (regex === null) return [];

    const matches: TreeSearchMatch[] = [];
    for (let index = start; index < end; index += 1) {
      const node = nodes[index];
      const score = matchScoreRegex(node, regex);
      if (score !== null) matches.push({ nodeId: node.id, score });
    }
    return matches;
  }

  const matches: TreeSearchMatch[] = [];
  for (let index = start; index < end; index += 1) {
    const node = nodes[index];
    const score = matchScore(node, query);
    if (score !== null) matches.push({ nodeId: node.id, score });
  }
  return matches;
}

export function sortTreeSearchMatches(matches: readonly TreeSearchMatch[]): number[] {
  return [...matches]
    .sort((left, right) =>
      left.score === right.score ? left.nodeId - right.nodeId : left.score - right.score
    )
    .map((match) => match.nodeId);
}

// Hands control back to the event loop. A MessageChannel task is used rather
// than setTimeout because chained timers are clamped to 4 ms once nested,
// which would add hundreds of milliseconds to a scan of a large document.
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export function createLocalTreeSearchIndex(model: TreeModel): TreeSearchIndex {
  const searchNodes = createTreeSearchNodes(model);
  let disposed = false;

  return {
    async search(query: string, options?: TreeSearchOptions): Promise<number[]> {
      const effectiveQuery = options?.regex ? query : normalizeSearchText(query);

      // An empty substring query has no matches; skip iterating every batch.
      // (Regex matching is left to collectTreeSearchMatches, which also
      // handles invalid patterns by returning no matches.)
      if (!options?.regex && !effectiveQuery) return [];

      const matches: TreeSearchMatch[] = [];
      const total = searchNodes.length;

      for (let start = 0; start < total; start += SEARCH_SCAN_BATCH_SIZE) {
        // Disposal during a chunked scan abandons the remaining batches and
        // resolves empty: the caller is tearing this index down, and the
        // viewer discards a superseded search's ids anyway. Resolving rather
        // than rejecting keeps dispose() safe on the ordinary replace path.
        if (disposed) return [];

        const end = Math.min(start + SEARCH_SCAN_BATCH_SIZE, total);
        const batch = collectTreeSearchMatches(searchNodes, effectiveQuery, start, end, options);
        matches.push(...batch);

        if (end < total) await nextTask();
      }

      return sortTreeSearchMatches(matches);
    },

    dispose(): void {
      disposed = true;
    },
  };
}
