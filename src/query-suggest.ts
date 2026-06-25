// Pure helpers backing the query panel's autocomplete and "Query from here"
// affordance. No DOM, no jmespath parsing — suggestions come from the loaded
// document's keys plus a static function list, since jmespath@0.16.0 exposes
// no public parser/AST.
import type { JsonValue, TreeModel } from "./tree-model";

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

// Generalize a node path to "this field across all array items" by replacing
// the LAST array index with a `[*]` wildcard — `data[0].company` →
// `data[*].company`, `data[0].tags[2]` → `data[0].tags[*]`. Only pure-digit
// brackets are indices; quoted keys (`["a1"]`) are left alone. Returns null when
// the path has no array index (nothing to project). Pairs with toJmespath.
export function projectLastIndex(path: string): string | null {
  const re = /\[\d+\]/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(path); m !== null; m = re.exec(path)) last = m;
  if (last === null) return null;
  return `${path.slice(0, last.index)}[*]${path.slice(last.index + last[0].length)}`;
}

// Build the JMESPath query for "query from here" on a node. `nodePath` is the
// node's path string (rooted at "data"). Queries always evaluate against the
// original document, but when a query is already active the node lives in the
// RESULT tree, so its path is relative to the result — chain it onto the active
// expression with a pipe. With no active query the path queries the root.
export function composeNodeQuery(
  activeExpression: string | null,
  nodePath: string
): string {
  const relative = toJmespath(nodePath);
  return activeExpression === null
    ? relative
    : `${activeExpression} | ${relative}`;
}

// Top-level pipe segments of a JMESPath expression. Used to scope autocomplete
// to the segment under the caret. A hand scanner (no AST — jmespath@0.16 has no
// parser): `|` is a boundary only at bracket/paren depth 0, outside any quote,
// and not when it is part of `||` (the or-operator). `start` is the index of the
// segment's first char (just after the preceding `|`); `end` is the terminating
// `|` index (or text.length for the last). No top-level pipe ⇒ one whole segment.
export function splitPipes(text: string): { start: number; end: number }[] {
  const segments: { start: number; end: number }[] = [];
  let segStart = 0;
  let depth = 0; // [] and () nesting
  let quote: string | null = null; // active quote char: " ' `
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote !== null) {
      if (c === "\\") {
        i += 1; // skip the escaped char
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "[" || c === "(") {
      depth += 1;
    } else if (c === "]" || c === ")") {
      if (depth > 0) depth -= 1;
    } else if (c === "|" && depth === 0) {
      if (text[i + 1] === "|") {
        i += 1; // `||` — consume both, not a boundary
        continue;
      }
      segments.push({ start: segStart, end: i });
      segStart = i + 1;
    }
  }
  segments.push({ start: segStart, end: text.length });
  return segments;
}

// ── Contextual autocomplete ────────────────────────────────────────────────
// Suggestions resolved against the actual parsed document: we walk the simple
// path typed left of the caret and offer the keys that exist at that position,
// each tagged with the kind of its value. No jmespath AST — a hand path scan
// over identifiers, ["k"], [n], [*], [], [?…]. Anything else (pipes, function
// calls, multiselect) is unresolvable and the caller falls back to the flat
// key universe.

export type ValueKind = "array" | "object" | "scalar";

export interface KeySuggestion {
  name: string;
  kind: ValueKind;
}

function kindOf(value: unknown): ValueKind {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "scalar";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Keys valid at a resolved context value. An array means a projection context
// (`arr[*]` / `arr[?…]`): we union the keys across element objects so the
// suggestions are the element fields. Scalars and arrays-of-scalars yield none.
function keysOf(value: unknown, limit: number): KeySuggestion[] {
  if (Array.isArray(value)) {
    const seen = new Map<string, ValueKind>();
    const cap = Math.min(value.length, 500);
    for (let i = 0; i < cap && seen.size < limit; i += 1) {
      const el = value[i];
      if (isObject(el)) {
        for (const [k, v] of Object.entries(el)) {
          if (!seen.has(k)) seen.set(k, kindOf(v));
        }
      }
    }
    return Array.from(seen, ([name, kind]) => ({ name, kind }));
  }
  if (isObject(value)) {
    return Object.entries(value).map(([name, v]) => ({ name, kind: kindOf(v) }));
  }
  return [];
}

// Member lookup that transparently maps over a projection (array) context.
function memberValue(node: unknown, key: string): unknown {
  if (Array.isArray(node)) {
    for (const el of node) if (isObject(el)) return el[key];
    return undefined;
  }
  return isObject(node) ? node[key] : undefined;
}

function parseQuotedKey(inner: string): string | null {
  try {
    const parsed = JSON.parse(inner);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

// Walk a simple path expression against `data`. Returns the value at the end
// (an array stays an array — a live projection context), or null when the path
// uses a construct we don't resolve.
function resolveContext(path: string, data: unknown): { value: unknown } | null {
  const s = path.trim();
  let node: unknown = data;
  let i = 0;
  if (s[i] === "@") i += 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ".") {
      i += 1;
      continue;
    }
    if (ch === "[") {
      const close = s.indexOf("]", i);
      if (close === -1) return null;
      const inner = s.slice(i + 1, close).trim();
      if (inner === "*" || inner === "" || inner[0] === "?") {
        if (!Array.isArray(node)) return null;
        // Projection: keep the array so keysOf unions the element keys.
      } else if (inner[0] === '"') {
        const key = parseQuotedKey(inner);
        if (key === null) return null;
        node = memberValue(node, key);
      } else if (/^-?\d+$/.test(inner)) {
        if (!Array.isArray(node)) return null;
        node = node[Number(inner)];
      } else {
        return null;
      }
      i = close + 1;
      continue;
    }
    if (IDENTIFIER_CHAR.test(ch)) {
      let j = i;
      while (j < s.length && IDENTIFIER_CHAR.test(s[j])) j += 1;
      node = memberValue(node, s.slice(i, j));
      i = j;
      continue;
    }
    return null;
  }
  return { value: node };
}

// Start of the contiguous path expression ending just before `end`. Consumes
// identifier chars, dots, `@`, quotes, and balanced [...] groups (so filter
// predicates ride along); stops at the first non-path char (space, `(`, `|`…).
function pathStart(text: string, end: number): number {
  let i = end;
  let depth = 0;
  while (i > 0) {
    const c = text[i - 1];
    if (c === "]") {
      depth += 1;
      i -= 1;
    } else if (c === "[") {
      if (depth === 0) break;
      depth -= 1;
      i -= 1;
    } else if (depth > 0) {
      i -= 1;
    } else if (IDENTIFIER_CHAR.test(c) || c === "." || c === "@" || c === '"') {
      i -= 1;
    } else {
      break;
    }
  }
  return i;
}

// Index of the nearest unmatched `[` left of `from`, or -1 when the caret is
// not inside an open bracket.
function openBracketBefore(text: string, from: number): number {
  let depth = 0;
  for (let i = from - 1; i >= 0; i -= 1) {
    const c = text[i];
    if (c === "]") depth += 1;
    else if (c === "[") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

type Trigger = "dot" | "filter" | "index" | "top";

interface TokenContext {
  value: unknown;
  functions: boolean;
  trigger: Trigger;
}

// What the current token's keys should resolve against. null ⇒ unresolvable.
function resolveTokenContext(
  text: string,
  start: number,
  data: unknown
): TokenContext | null {
  // Member access: `…<path>.<token>`
  if (start > 0 && text[start - 1] === ".") {
    const ctx = resolveContext(text.slice(pathStart(text, start - 1), start - 1), data);
    return ctx === null ? null : { value: ctx.value, functions: false, trigger: "dot" };
  }
  // Inside an open bracket: `…<path>[<token>`
  const open = openBracketBefore(text, start);
  if (open !== -1) {
    if (text[open + 1] === "?") {
      // Filter predicate — keys are the array's element fields.
      const ctx = resolveContext(text.slice(pathStart(text, open), open), data);
      return ctx === null ? null : { value: ctx.value, functions: true, trigger: "filter" };
    }
    // `[0` / `[*` — a numeric/wildcard position, not a key.
    return { value: undefined, functions: false, trigger: "index" };
  }
  // Top level: keys of the document root, plus function names.
  return { value: data, functions: true, trigger: "top" };
}

// The autocomplete entry point. Resolves the caret's context against `data` and
// returns the matching key suggestions (with kinds for badges) plus the token
// start so the caller can splice the accepted token in. Falls back to the flat
// `universe` when the surrounding expression can't be resolved.
export function suggestAt(
  text: string,
  caret: number,
  data: unknown,
  universe: string[],
  functions: string[],
  limit = 50
): { items: KeySuggestion[]; start: number } {
  const { token, start } = currentToken(text, caret);
  const afterDot = start > 0 && text[start - 1] === ".";
  const ctx = resolveTokenContext(text, start, data);

  if (ctx === null) {
    // Unresolvable expression: best-effort over the flat key universe.
    if (token === "") {
      return afterDot
        ? { items: universe.slice(0, limit).map((name) => ({ name, kind: "scalar" })), start }
        : { items: [], start };
    }
    const names = suggest(token, universe, afterDot ? [] : functions, limit);
    return { items: names.map((name) => ({ name, kind: "scalar" })), start };
  }

  const candidates = keysOf(ctx.value, limit);

  if (token === "") {
    // Empty token: dot/filter triggers dump the contextual keys; a bare top
    // level or a numeric bracket position stay quiet (never dump unprompted).
    if (ctx.trigger === "dot" || ctx.trigger === "filter") {
      return { items: candidates.slice(0, limit), start };
    }
    return { items: [], start };
  }

  const kindByName = new Map(candidates.map((c) => [c.name, c.kind]));
  const names = candidates.map((c) => c.name);
  const matched = suggest(token, names, ctx.functions ? functions : [], limit);
  const items = matched.map((name) => ({
    name,
    kind: kindByName.get(name) ?? ("scalar" as ValueKind),
  }));
  return { items, start };
}

// Pipe-aware wrapper over suggestAt. When the caret sits after a top-level pipe,
// suggestions resolve against the value the left side produces (supplied by the
// injected `resolveScope`, so this module stays jmespath-free) instead of the
// document root. Unresolvable left side ⇒ no suggestions. The returned `start`
// is offset back into the full text so the caller splices in the right place.
export function suggestAtScoped(
  text: string,
  caret: number,
  data: unknown,
  universe: string[],
  functions: string[],
  resolveScope: (leftExpr: string) => JsonValue | null,
  limit = 50
): { items: KeySuggestion[]; start: number } {
  const segments = splitPipes(text);
  // The segment under the caret: the last one starting at or before it.
  let active = segments[0];
  for (const seg of segments) if (seg.start <= caret) active = seg;

  // First segment (or no pipe): unchanged — resolve against the root.
  if (active.start === 0) {
    return suggestAt(text, caret, data, universe, functions, limit);
  }

  const leftExpr = text.slice(0, active.start - 1).trim();
  const scope = resolveScope(leftExpr);
  if (scope === null) return { items: [], start: caret };

  const inner = suggestAt(
    text.slice(active.start),
    caret - active.start,
    scope,
    universe,
    functions,
    limit
  );
  return { items: inner.items, start: inner.start + active.start };
}
