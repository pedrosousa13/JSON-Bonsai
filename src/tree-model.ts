export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonNodeType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null";

export interface JsonNode {
  id: number;
  parentId: number | null;
  siblingIndex: number;
  childIds: number[];
  key: string | number | null;
  path: string;
  depth: number;
  type: JsonNodeType;
  value: JsonValue;
  isArrayElement: boolean;
  isLast: boolean;
  childCount: number;
  label: string;
  hasNestedContainers: boolean;
  searchKey: string;
  searchPath: string;
  searchValue: string;
  hasLongSearchValue: boolean;
}

export interface TreeModel {
  nodes: JsonNode[];
  rootId: number;
  maxDepth: number;
  totalNodes: number;
  pathToId: Map<string, number>;
}

const SEARCH_VALUE_PREVIEW_LIMIT = 200;

function buildPath(
  parentPath: string,
  key: string | number,
  isArrayElement: boolean
): string {
  if (isArrayElement) return `${parentPath}[${key}]`;
  if (typeof key === "string" && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
    return `${parentPath}.${key}`;
  }
  return `${parentPath}["${key}"]`;
}

function typeOf(value: JsonValue): JsonNodeType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function countEntries(value: JsonValue): number {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function buildLabel(type: JsonNodeType, childCount: number): string {
  if (childCount === 0) return "";
  if (type === "array") return `${childCount} item${childCount === 1 ? "" : "s"}`;
  if (type === "object") return `${childCount} key${childCount === 1 ? "" : "s"}`;
  return "";
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase();
}

function buildSearchValue(value: JsonValue): {
  searchValue: string;
  hasLongSearchValue: boolean;
} {
  if (value === null || typeof value === "object") {
    return { searchValue: "", hasLongSearchValue: false };
  }

  const normalized = normalizeSearchText(String(value));
  if (normalized.length <= SEARCH_VALUE_PREVIEW_LIMIT) {
    return { searchValue: normalized, hasLongSearchValue: false };
  }

  return {
    searchValue: normalized.slice(0, SEARCH_VALUE_PREVIEW_LIMIT),
    hasLongSearchValue: true,
  };
}

export function isContainerNode(node: JsonNode): boolean {
  return node.type === "object" || node.type === "array";
}

interface VisitTask {
  value: JsonValue;
  parentId: number | null;
  key: string | number | null;
  path: string;
  depth: number;
  isArrayElement: boolean;
  isLast: boolean;
  siblingIndex: number;
}

export function buildTreeModel(data: JsonValue): TreeModel {
  const nodes: JsonNode[] = [];
  const pathToId = new Map<string, number>();
  let maxDepth = 0;
  let rootId = 0;

  // Iterative pre-order traversal with an explicit stack. Children are pushed
  // in reverse so they pop in forward order, preserving the recursive layout
  // (node ids and childIds match a depth-first walk). An explicit stack avoids
  // the call-stack overflow a recursive version hit on deeply nested JSON.
  const stack: VisitTask[] = [
    {
      value: data,
      parentId: null,
      key: null,
      path: "data",
      depth: 0,
      isArrayElement: false,
      isLast: true,
      siblingIndex: 0,
    },
  ];

  while (stack.length > 0) {
    const task = stack.pop()!;
    const { value, parentId, key, path, depth, isArrayElement, isLast, siblingIndex } = task;
    const type = typeOf(value);
    const childCount = countEntries(value);
    const label = buildLabel(type, childCount);
    const { searchValue, hasLongSearchValue } = buildSearchValue(value);

    const node: JsonNode = {
      id: nodes.length,
      parentId,
      siblingIndex,
      childIds: [],
      key,
      path,
      depth,
      type,
      value,
      isArrayElement,
      isLast,
      childCount,
      label,
      hasNestedContainers: false,
      searchKey: key === null ? "" : normalizeSearchText(String(key)),
      searchPath: normalizeSearchText(path),
      searchValue,
      hasLongSearchValue,
    };

    nodes.push(node);
    pathToId.set(path, node.id);
    if (depth > maxDepth) maxDepth = depth;
    if (parentId === null) {
      rootId = node.id;
    } else {
      nodes[parentId].childIds.push(node.id);
    }

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) {
        stack.push({
          value: value[index],
          parentId: node.id,
          key: index,
          path: buildPath(path, index, true),
          depth: depth + 1,
          isArrayElement: true,
          isLast: index === value.length - 1,
          siblingIndex: index,
        });
      }
    } else if (value !== null && typeof value === "object") {
      const keys = Object.keys(value);
      for (let index = keys.length - 1; index >= 0; index--) {
        const childKey = keys[index];
        stack.push({
          value: value[childKey],
          parentId: node.id,
          key: childKey,
          path: buildPath(path, childKey, false),
          depth: depth + 1,
          isArrayElement: false,
          isLast: index === keys.length - 1,
          siblingIndex: index,
        });
      }
    }
  }

  // childIds are populated above; compute container flags in a second pass
  // once every node exists.
  for (const node of nodes) {
    node.hasNestedContainers = node.childIds.some((childId) =>
      isContainerNode(nodes[childId])
    );
  }

  return {
    nodes,
    rootId,
    maxDepth,
    totalNodes: nodes.length,
    pathToId,
  };
}
