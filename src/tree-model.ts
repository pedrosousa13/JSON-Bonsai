import { exactTextUnavailable, type ExactNumberMap } from "./lossless-numbers";
import { keepLastCodePoints, truncateCodePoints } from "./truncate";

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
  // Exact source text for numbers JSON.parse couldn't represent losslessly;
  // null for everything else. Display and copy prefer it over `value`.
  numberText: string | null;
  // This number's exact source text is unavailable and the digits in `value`
  // are only the nearest double — see exactTextUnavailable(). Display marks it;
  // copy, export and search ignore it.
  numberIsRounded: boolean;
  isArrayElement: boolean;
  // This node is an array element, or descends from one. Equivalently: its path
  // carries a real array index, so it can be generalized with `[*]`.
  inArray: boolean;
  isLast: boolean;
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
  // Any node carries numberIsRounded. The text views cannot mark a value
  // inline without corrupting the JSON, so they show one document-level note
  // off this instead.
  hasRoundedNumbers: boolean;
}

// One cap governs both search previews: a value's leading characters, and a
// path's trailing ones.
export const SEARCH_VALUE_PREVIEW_LIMIT = 200;

const ROOT_PATH = "data";

function pathSegment(key: string | number, isArrayElement: boolean): string {
  if (isArrayElement) return `[${key}]`;
  if (typeof key === "string" && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
    return `.${key}`;
  }
  // JSON string escaping, so `\` and `"` in the key survive the round trip and
  // the segment is a valid JMESPath quoted identifier (see toJmespath).
  return `[${JSON.stringify(String(key))}]`;
}

// HAZARD — read before adding any per-node consumer of `path`.
//
// A path is the parent's path plus one segment, and V8 keeps that as a cons
// string: a pair of pointers, O(1) per node however deep the node sits. That
// is the only reason a 40,000-level document can hold a path per node at all.
//
// Reading the string whole flattens the rope into contiguous characters that
// stay reachable for as long as the node does. Doing that once, for one node,
// is free — the hover path display, copy-path and query composition all do it,
// and the rendered `data-path` attribute is bounded by virtualization. Doing it
// for EVERY node costs O(depth^2) characters and runs the tab out of memory:
// `searchPath: normalizeSearchText(path)` did exactly that and OOM'd a 2 GB
// heap on a 234 KB document (#99).
//
// Per-node is the trigger, and lowercasing is not the only one — slicing,
// comparing, serializing or measuring every `path` flattens it just the same.
// Walk the ancestors instead, the way buildSearchPath does.
function buildPath(
  parentPath: string,
  key: string | number,
  isArrayElement: boolean
): string {
  return `${parentPath}${pathSegment(key, isArrayElement)}`;
}

// The node's own segment, then its ancestors' segments leaf-first, stopping as
// soon as the cap is reached — so this costs O(cap), not O(depth), and never
// touches `path`.
//
// Truncation keeps the leaf-ward end, the opposite of the value preview: a
// path search is nearly always about the deep end, and a node's own key is the
// part a user is most likely to type. The accepted cost is that on a document
// deep enough for the cap to bite, a path search misses on root-ward segments.
function buildSearchPath(nodes: JsonNode[], task: VisitTask): string {
  if (task.parentId === null) return normalizeSearchText(task.path);

  const segments = [pathSegment(task.key!, task.isArrayElement)];
  let length = segments[0].length;
  let ancestorId: number | null = task.parentId;
  while (ancestorId !== null && length < SEARCH_VALUE_PREVIEW_LIMIT) {
    // Annotated because `ancestorId` is reassigned from this node's own
    // parentId, which makes the inferred type circular.
    const ancestor: JsonNode = nodes[ancestorId];
    // The root carries no key: its whole path is the one segment it owns.
    const segment =
      ancestor.parentId === null
        ? ROOT_PATH
        : pathSegment(ancestor.key!, ancestor.isArrayElement);
    segments.push(segment);
    length += segment.length;
    ancestorId = ancestor.parentId;
  }
  segments.reverse();

  return keepLastCodePoints(
    normalizeSearchText(segments.join("")),
    SEARCH_VALUE_PREVIEW_LIMIT
  );
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
    searchValue: truncateCodePoints(normalized, SEARCH_VALUE_PREVIEW_LIMIT),
    hasLongSearchValue: true,
  };
}

export function isContainerNode(node: JsonNode): boolean {
  return node.type === "object" || node.type === "array";
}

interface VisitTask {
  value: JsonValue;
  numberText: string | null;
  parentId: number | null;
  key: string | number | null;
  path: string;
  depth: number;
  isArrayElement: boolean;
  inArray: boolean;
  isLast: boolean;
  siblingIndex: number;
}

export function buildTreeModel(
  data: JsonValue,
  exactNumbers?: ExactNumberMap | null
): TreeModel {
  const nodes: JsonNode[] = [];
  let maxDepth = 0;
  let rootId = 0;
  let hasRoundedNumbers = false;

  // Iterative pre-order traversal with an explicit stack. Children are pushed
  // in reverse so they pop in forward order, preserving the recursive layout
  // (node ids and childIds match a depth-first walk). An explicit stack avoids
  // the call-stack overflow a recursive version hit on deeply nested JSON.
  const stack: VisitTask[] = [
    {
      value: data,
      numberText: null,
      parentId: null,
      key: null,
      path: ROOT_PATH,
      depth: 0,
      isArrayElement: false,
      inArray: false,
      isLast: true,
      siblingIndex: 0,
    },
  ];

  while (stack.length > 0) {
    const task = stack.pop()!;
    const { value, numberText, parentId, key, path, depth, isArrayElement, inArray, isLast, siblingIndex } = task;
    const type = typeOf(value);
    const childCount = countEntries(value);
    const label = buildLabel(type, childCount);
    // Index the exact source text so searching for the real digits matches.
    const { searchValue, hasLongSearchValue } = buildSearchValue(numberText ?? value);
    const numberIsRounded = exactTextUnavailable(value, numberText, exactNumbers);
    if (numberIsRounded) hasRoundedNumbers = true;

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
      numberText,
      numberIsRounded,
      isArrayElement,
      inArray,
      isLast,
      label,
      hasNestedContainers: false,
      searchKey: key === null ? "" : normalizeSearchText(String(key)),
      searchPath: buildSearchPath(nodes, task),
      searchValue,
      hasLongSearchValue,
    };

    nodes.push(node);
    if (depth > maxDepth) maxDepth = depth;
    if (parentId === null) {
      rootId = node.id;
    } else {
      nodes[parentId].childIds.push(node.id);
    }

    // Reviver keys are strings (array indices included), hence String(key).
    const holderExactNumbers =
      childCount > 0 ? exactNumbers?.get(value as object) : undefined;

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) {
        stack.push({
          value: value[index],
          numberText: holderExactNumbers?.get(String(index)) ?? null,
          parentId: node.id,
          key: index,
          path: buildPath(path, index, true),
          depth: depth + 1,
          isArrayElement: true,
          inArray: true,
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
          numberText: holderExactNumbers?.get(childKey) ?? null,
          parentId: node.id,
          key: childKey,
          path: buildPath(path, childKey, false),
          depth: depth + 1,
          isArrayElement: false,
          inArray,
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
    hasRoundedNumbers,
  };
}

// Test seam: production code always has a node id in hand, so this is unused outside tests.
export function findNodeByPath(model: TreeModel, path: string): JsonNode | undefined {
  return model.nodes.find((node) => node.path === path);
}
