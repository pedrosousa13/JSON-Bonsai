// Pure helpers backing the query panel's autocomplete and "Query from here"
// affordance. No DOM, no jmespath parsing — suggestions come from the loaded
// document's keys plus a static function list, since jmespath@0.16.0 exposes
// no public parser/AST.
import type { TreeModel } from "./tree-model";

// JMESPath builtin functions worth suggesting. From the JMESPath spec's
// built-in function list (https://jmespath.org/specification.html#functions).
export const JMESPATH_FUNCTIONS: string[] = [
  "abs",
  "avg",
  "ceil",
  "contains",
  "ends_with",
  "floor",
  "join",
  "keys",
  "length",
  "map",
  "max",
  "max_by",
  "min",
  "min_by",
  "not_null",
  "reverse",
  "sort",
  "sort_by",
  "starts_with",
  "sum",
  "to_array",
  "to_number",
  "to_string",
  "type",
  "values",
];

// Distinct object keys (string keys only) across every node, deduped and
// sorted. Array indices and the synthetic root are skipped. O(n) once — the
// caller caches the result for the document's lifetime.
export function collectKeyUniverse(model: TreeModel): string[] {
  const keys = new Set<string>();
  for (const node of model.nodes) {
    // Array elements carry a numeric `key`; the root carries null.
    if (typeof node.key === "string" && !node.isArrayElement) {
      keys.add(node.key);
    }
  }
  return Array.from(keys).sort();
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;

// The trailing identifier-ish token immediately left of the caret, plus its
// start index. No JMESPath parsing — just a scan over identifier characters.
// Empty token when the char left of the caret is a non-identifier.
export function currentToken(
  text: string,
  caret: number
): { token: string; start: number } {
  let start = caret;
  while (start > 0 && IDENTIFIER_CHAR.test(text[start - 1])) {
    start -= 1;
  }
  return { token: text.slice(start, caret), start };
}

// Case-insensitive prefix match. Keys first, then function names; deduped and
// capped (default 50). An empty token yields nothing — never dump the universe.
export function suggest(
  token: string,
  keys: string[],
  functions: string[],
  limit = 50
): string[] {
  if (token === "") return [];
  const prefix = token.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of keys) {
    if (out.length >= limit) return out;
    if (candidate.toLowerCase().startsWith(prefix) && !seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  for (const candidate of functions) {
    if (out.length >= limit) return out;
    if (candidate.toLowerCase().startsWith(prefix) && !seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

// Converts a buildPath() string ("data", "data.a.b", `data["a b"][0].c`) into
// an equivalent JMESPath expression. O(depth) per call — runs once per click.
export function toJmespath(nodePath: string): string {
  if (nodePath === "data") return "@";
  // Drop the leading "data" root; everything after it is segments.
  const rest = nodePath.slice("data".length);

  let out = "";
  let i = 0;
  let first = true;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === ".") {
      // Identifier segment: ".key" — keep as-is (drop the dot when it leads).
      let j = i + 1;
      while (j < rest.length && IDENTIFIER_CHAR.test(rest[j])) j += 1;
      const key = rest.slice(i + 1, j);
      out += first ? key : `.${key}`;
      i = j;
    } else if (ch === "[") {
      const close = rest.indexOf("]", i);
      const inner = rest.slice(i + 1, close);
      if (inner.startsWith('"')) {
        // Quoted string key: `["a b"]` → `."a b"` (or leading `"a b"`).
        out += first ? inner : `.${inner}`;
      } else {
        // Array index: `[3]` stays `[3]`, even when it leads.
        out += `[${inner}]`;
      }
      i = close + 1;
    } else {
      // buildPath only emits "." and "[" between segments; bail defensively.
      i += 1;
      continue;
    }
    first = false;
  }
  return out;
}
