import { type TreeModel, isContainerNode } from "./tree-model";

export interface TreeSearchNode {
  id: number;
  searchValue: string;
  hasLongSearchValue: boolean;
  rawStringValue?: string;
  searchKey: string;
  searchPath: string;
  isContainer: boolean;
}

export interface TreeSearchMatch {
  nodeId: number;
  score: number;
}

export interface TreeSearchOptions {
  regex?: boolean;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

// Compiles a regex query with the case-insensitive flag, returning null when
// the pattern is invalid so callers can degrade gracefully instead of throwing.
// The search index stores text lowercased and truncated to 200 chars (see
// SEARCH_VALUE_PREVIEW_LIMIT in tree-model.ts), so a regex only ever sees that
// truncated, lowercased text.
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

export function collectTreeSearchMatches(
  nodes: readonly TreeSearchNode[],
  query: string,
  start = 0,
  end: number = nodes.length,
  options?: TreeSearchOptions
): TreeSearchMatch[] {
  if (options?.regex) {
    // The raw query is used verbatim — trimming/lowercasing it would corrupt
    // regex metacharacters and escapes. Invalid patterns yield no matches.
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

  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const matches: TreeSearchMatch[] = [];
  for (let index = start; index < end; index += 1) {
    const node = nodes[index];
    const score = matchScore(node, normalizedQuery);
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

export function searchTreeSearchNodes(
  nodes: readonly TreeSearchNode[],
  query: string,
  options?: TreeSearchOptions
): number[] {
  return sortTreeSearchMatches(
    collectTreeSearchMatches(nodes, query, 0, nodes.length, options)
  );
}

export function hydrateTreeSearchNodes(
  nodes: Array<{
    id: number;
    searchKey: string;
    searchPath: string;
    searchValue: string;
    hasLongSearchValue: boolean;
    rawStringValue?: string;
    isContainer: boolean;
  }>
): TreeSearchNode[] {
  return nodes as TreeSearchNode[];
}
