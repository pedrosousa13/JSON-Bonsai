# Relative Queries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make JMESPath autocomplete pipe-aware so a query after `|` resolves against the piped subtree, turning the existing pipe operator into a first-class "query relative to any node" feature.

**Architecture:** The pipe already runs in jmespath (`runQuery` unchanged). Add a pure `splitPipes` scanner and a `suggestAtScoped` wrapper in `query-suggest.ts` that resolves the caret's pipe segment against the value the left side produces. The left-side value is supplied by an injected, memoized resolver (`createScopeResolver` in `query.ts`) so `query-suggest.ts` keeps its no-jmespath boundary. `content.ts` wires the resolver in and updates the placeholder; README documents it.

**Tech Stack:** TypeScript (vanilla, no UI framework), `jmespath@0.16`, vitest.

## Global Constraints

- No new runtime dependencies.
- `query-suggest.ts` must not import `jmespath` (keep its pure/no-AST boundary — the scope value arrives via an injected resolver).
- `runQuery` / query execution stays unchanged; "Query from here" behavior stays unchanged.
- Match existing code style: hand scanners (no AST), `describe/test` vitest blocks, two-space indent.
- Commit messages: Conventional Commits, no attribution/co-author lines.

---

### Task 1: `splitPipes` pure scanner

**Files:**
- Modify: `src/query-suggest.ts` (add export near the other pure helpers, e.g. after `toJmespath`)
- Test: `src/query-suggest.test.ts` (new `describe("splitPipes")`)

**Interfaces:**
- Produces: `splitPipes(text: string): { start: number; end: number }[]` — top-level pipe segments. `start` is the index of the segment's first char (immediately after the preceding `|`); `end` is the index of the terminating `|` (or `text.length` for the last). A string with no top-level pipe returns a single segment `[{ start: 0, end: text.length }]`. `|` is NOT a boundary when part of `||`, inside a quote (`"`, `'`, `` ` ``), or inside `[]`/`()`.

- [ ] **Step 1: Write the failing tests**

Add to `src/query-suggest.test.ts`:

```ts
describe("splitPipes", () => {
  test("no pipe yields a single whole-string segment", () => {
    expect(splitPipes("a.b.c")).toEqual([{ start: 0, end: 5 }]);
  });

  test("a single top-level pipe splits into two segments", () => {
    expect(splitPipes("a | b")).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });

  test("multiple pipes split into multiple segments", () => {
    expect(splitPipes("a | b | c")).toHaveLength(3);
  });

  test("|| (or-operator) is not a boundary", () => {
    expect(splitPipes("a || b")).toEqual([{ start: 0, end: 6 }]);
  });

  test("a pipe inside a string literal is not a boundary", () => {
    expect(splitPipes("a == 'x|y'")).toHaveLength(1);
  });

  test("a pipe inside brackets is not a boundary", () => {
    expect(splitPipes("items[?a | b]")).toHaveLength(1);
  });

  test("a pipe inside parens is not a boundary", () => {
    expect(splitPipes("f(a | b)")).toHaveLength(1);
  });

  test("a trailing pipe yields an empty final segment", () => {
    expect(splitPipes("a | ")).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 4 },
    ]);
  });
});
```

Add `splitPipes` to the import block at the top of the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/query-suggest.test.ts -t splitPipes`
Expected: FAIL — `splitPipes is not exported` / not defined.

- [ ] **Step 3: Implement `splitPipes`**

Add to `src/query-suggest.ts` (after `toJmespath`):

```ts
// Top-level pipe segments of a JMESPath expression. Used to scope autocomplete
// to the segment under the caret. A hand scanner (no AST — jmespath@0.16 has no
// parser): `|` is a boundary only at bracket/paren depth 0, outside any quote,
// and not when it is part of `||` (the or-operator).
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/query-suggest.test.ts -t splitPipes`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/query-suggest.ts src/query-suggest.test.ts
git commit -m "feat: add splitPipes scanner for query expressions"
```

---

### Task 2: `suggestAtScoped` — pipe-aware autocomplete

**Files:**
- Modify: `src/query-suggest.ts` (add export `suggestAtScoped`; add `JsonValue` to the `./tree-model` type import)
- Test: `src/query-suggest.test.ts` (new `describe("suggestAtScoped")`)

**Interfaces:**
- Consumes: `splitPipes` (Task 1); existing `suggestAt`; `JsonValue` from `./tree-model`.
- Produces:
  ```ts
  suggestAtScoped(
    text: string,
    caret: number,
    data: JsonValue,
    universe: string[],
    functions: string[],
    resolveScope: (leftExpr: string) => JsonValue | null,
    limit?: number
  ): { items: KeySuggestion[]; start: number }
  ```
  When the caret is in the first segment (or there is no pipe) it delegates to `suggestAt` against `data`. Otherwise it resolves the segment against `resolveScope(<expr left of this pipe>)`; on `null` (unresolvable left) it returns no suggestions. The returned `start` is an absolute index into the full `text`.

- [ ] **Step 1: Write the failing tests**

Add to `src/query-suggest.test.ts`. Reuse a doc + a real resolver built on `runQuery`:

```ts
describe("suggestAtScoped", () => {
  const doc = {
    users: [
      { name: "Ada", role: "admin", tags: ["x"] },
      { name: "Grace", role: "user" },
    ],
    settings: { theme: "dark" },
    count: 2,
  };
  const UNIVERSE = ["U_one", "U_two"];
  const resolve = (expr: string) => {
    const outcome = runQuery(doc, expr);
    return outcome.ok ? outcome.result : null;
  };
  const scoped = (text: string, caret = text.length) =>
    suggestAtScoped(text, caret, doc, UNIVERSE, JMESPATH_FUNCTIONS, resolve);
  const names = (text: string, caret = text.length) =>
    scoped(text, caret).items.map((i) => i.name);

  test("no pipe resolves against the document root", () => {
    expect(names("us")).toEqual(["users"]);
  });

  test("right of a pipe resolves against the piped scope", () => {
    // `users[0]` is an object; the right segment sees its keys.
    expect(names("users[0] | na")).toEqual(["name"]);
  });

  test("a filter right of a pipe resolves against the piped array", () => {
    expect(names("users | [?ro")).toEqual(["role"]);
  });

  test("reports an absolute token start across the pipe", () => {
    // "users[0] | na" → the "na" token starts at index 11.
    expect(scoped("users[0] | na").start).toBe(11);
  });

  test("an unresolvable left side yields no suggestions", () => {
    // abs() on an object errors → resolve returns null.
    expect(names("abs(@) | na")).toEqual([]);
  });

  test("|| does not trigger scoping (stays a root-level expression)", () => {
    // If `||` were a pipe, the left `users` scope would offer no `us*` key.
    expect(names("users || us")).toEqual(["users"]);
  });
});
```

Add `suggestAtScoped` to the test file's import from `./query-suggest`, and add `import { runQuery } from "./query";`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/query-suggest.test.ts -t suggestAtScoped`
Expected: FAIL — `suggestAtScoped is not exported`.

- [ ] **Step 3: Implement `suggestAtScoped`**

In `src/query-suggest.ts`, extend the `./tree-model` import to include the value type:

```ts
import type { JsonValue, TreeModel } from "./tree-model";
```

Add (after `suggestAt`):

```ts
// Pipe-aware wrapper over suggestAt. When the caret sits after a top-level pipe,
// suggestions resolve against the value the left side produces (supplied by the
// injected `resolveScope`, so this module stays jmespath-free) instead of the
// document root. Unresolvable left side ⇒ no suggestions. The returned `start`
// is offset back into the full text so the caller splices in the right place.
export function suggestAtScoped(
  text: string,
  caret: number,
  data: JsonValue,
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/query-suggest.test.ts -t suggestAtScoped`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/query-suggest.ts src/query-suggest.test.ts
git commit -m "feat: add pipe-aware suggestAtScoped autocomplete"
```

---

### Task 3: `createScopeResolver` — memoized left-side evaluator

**Files:**
- Modify: `src/query.ts` (add export `createScopeResolver`)
- Test: `src/query.test.ts` (new `describe("createScopeResolver")`)

**Interfaces:**
- Consumes: existing `runQuery`; `JsonValue` (already imported in `query.ts`).
- Produces: `createScopeResolver(data: JsonValue): (leftExpr: string) => JsonValue | null` — evaluates `leftExpr` against `data`, returning the result or `null` on any query error. Single-entry memo keyed on `leftExpr` (the right side of a pipe changes per keystroke but the left side does not, so the cache hits on every right-side keystroke).

- [ ] **Step 1: Write the failing tests**

Add to `src/query.test.ts`:

```ts
describe("createScopeResolver", () => {
  const data = { users: [{ name: "Ada" }], count: 2 };

  test("resolves a valid expression to its value", () => {
    const resolve = createScopeResolver(data);
    expect(resolve("users[0]")).toEqual({ name: "Ada" });
  });

  test("returns null for a syntax error", () => {
    const resolve = createScopeResolver(data);
    expect(resolve("[invalid")).toBeNull();
  });

  test("returns null for a runtime type error", () => {
    const resolve = createScopeResolver(data);
    expect(resolve("abs(users)")).toBeNull();
  });

  test("distinct expressions resolve independently (cache keyed by expr)", () => {
    const resolve = createScopeResolver(data);
    expect(resolve("count")).toBe(2);
    expect(resolve("users[0]")).toEqual({ name: "Ada" });
    expect(resolve("count")).toBe(2);
  });
});
```

Add `createScopeResolver` to the import in `src/query.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/query.test.ts -t createScopeResolver`
Expected: FAIL — `createScopeResolver is not exported`.

- [ ] **Step 3: Implement `createScopeResolver`**

Add to `src/query.ts`:

```ts
// A memoized evaluator for the left side of a pipe, used by the query bar's
// pipe-aware autocomplete. Returns the value `leftExpr` selects from `data`, or
// null on any error (invalid/incomplete mid-typing). Single-entry cache: the
// left side is stable while the user types the right side, so this collapses the
// per-keystroke cost to a single search.
export function createScopeResolver(
  data: JsonValue
): (leftExpr: string) => JsonValue | null {
  let cache: { expr: string; value: JsonValue } | null = null;
  return (leftExpr: string): JsonValue | null => {
    if (cache !== null && cache.expr === leftExpr) return cache.value;
    const outcome = runQuery(data, leftExpr);
    if (!outcome.ok) return null;
    cache = { expr: leftExpr, value: outcome.result };
    return outcome.result;
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/query.test.ts -t createScopeResolver`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/query.ts src/query.test.ts
git commit -m "feat: add memoized createScopeResolver for pipe scopes"
```

---

### Task 4: Wire pipe-aware autocomplete into the query panel

**Files:**
- Modify: `src/content.ts` — import (`./query`, `./query-suggest`), create the resolver, swap the `suggestAt` call in `updateSuggest`, update the placeholder.

**Interfaces:**
- Consumes: `suggestAtScoped` (Task 2), `createScopeResolver` (Task 3).

This task has no isolated unit seam (it lives inside the content init closure). Its logic is covered by Tasks 1–3; the gate here is typecheck + the full suite + build, plus a manual smoke check.

- [ ] **Step 1: Add the imports**

In `src/content.ts`, change line 19:

```ts
import { createScopeResolver, runQuery } from "./query";
```

In the `./query-suggest` import block (lines 20–27), add `suggestAtScoped`:

```ts
import {
  JMESPATH_FUNCTIONS,
  collectKeyUniverse,
  suggestAt,
  suggestAtScoped,
  toJmespath,
  type KeySuggestion,
  type ValueKind,
} from "./query-suggest";
```

(Leave `suggestAt` imported — it remains the delegate used by `suggestAtScoped`'s first-segment path is internal; `content.ts` no longer calls `suggestAt` directly after Step 3, so if the linter/`tsc` flags it as unused, drop `suggestAt` from this import.)

- [ ] **Step 2: Create the resolver once**

Find the `keyUniverse` declaration (around line 919: `let keyUniverse: string[] | null = null;`). Immediately after it, add:

```ts
  // Memoized evaluator for the left side of a pipe — powers pipe-aware
  // autocomplete (`<path> | <relative query>`). Built once; `data` is stable.
  const scopeResolver = createScopeResolver(data);
```

- [ ] **Step 3: Use the scoped suggester**

In `updateSuggest` (around line 1027), replace:

```ts
    const { items, start } = suggestAt(value, caret, data, keyUniverse, JMESPATH_FUNCTIONS);
```

with:

```ts
    const { items, start } = suggestAtScoped(
      value,
      caret,
      data,
      keyUniverse,
      JMESPATH_FUNCTIONS,
      scopeResolver
    );
```

If `tsc` now reports `suggestAt` as unused, remove it from the import block in Step 1.

- [ ] **Step 4: Update the placeholder to advertise the pipe**

Replace line 235:

```html
        <input id="jv-query-input" type="text" placeholder="e.g. items[?price > \`10\`].name" spellcheck="false" autocomplete="off">
```

with:

```html
        <input id="jv-query-input" type="text" placeholder="e.g. items[?price > \`10\`] | sort_by(@, &name)" spellcheck="false" autocomplete="off">
```

- [ ] **Step 5: Typecheck, test, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all vitest suites pass; build succeeds.

- [ ] **Step 6: Manual smoke check**

Load the unpacked extension (or `npm run dev`) on a JSON page with an array of objects:
1. Open the query panel (`Q`). Confirm the placeholder shows the pipe example.
2. Type `<arrayKey>[0] | ` then a letter — confirm the dropdown suggests keys of that element (not document-root keys).
3. Run `<arrayKey>[0] | [?<field>]` and confirm the result tree renders the scoped result.

- [ ] **Step 7: Commit**

```bash
git add src/content.ts
git commit -m "feat: pipe-aware autocomplete and pipe placeholder hint in query bar"
```

---

### Task 5: Document relative queries in the README

**Files:**
- Modify: `README.md` (the "Query, search, and copy" bullet list)

- [ ] **Step 1: Add the bullet**

In `README.md`, in the "Query, search, and copy" list, immediately after the
`JMESPath query bar (\`Q\`)` bullet, add:

```markdown
- Query relative to any node — "Query from here" seeds a node's path; append `| expr` to query inside that subtree, and autocomplete resolves keys against the scoped node
```

- [ ] **Step 2: Verify the README renders**

Run: `npx vitest run src/manifest.test.ts` (sanity that nothing references the changed docs) and eyeball `README.md`.
Expected: no errors; the new bullet reads correctly under the query section.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document relative (piped) queries in README"
```

---

## Self-Review

**Spec coverage:**
- `splitPipes` (spec §1) → Task 1.
- Pipe-aware `updateSuggest` + offset (spec §2) → Task 2 (logic) + Task 4 (wiring).
- Scope eval + cache (spec §3) → Task 3.
- Placeholder hint (spec §4) → Task 4 Step 4.
- README (spec §5) → Task 5.
- Tests (spec "Testing") → Tasks 1–3 carry unit tests; Task 4 gated by suite+build+manual.

Note vs. spec: the spec sketched the cache/pipe logic inside `content.ts` and suggested a flat-universe fallback on failed left eval. This plan instead (a) puts the cache in a testable `createScopeResolver` in `query.ts`, (b) puts pipe routing in a testable `suggestAtScoped` in `query-suggest.ts`, and (c) returns **no** suggestions (not the flat universe) on an unresolvable left side — cleaner and avoids dumping misleading root keys while scoped. Net behavior and files match the spec's intent.

**Placeholder scan:** No TBD/TODO; every code step shows complete code.

**Type consistency:** `splitPipes` returns `{start,end}[]` used by `suggestAtScoped`; `resolveScope`/`createScopeResolver` share `(leftExpr: string) => JsonValue | null`; `suggestAtScoped` returns `{ items: KeySuggestion[]; start: number }` matching `suggestAt`'s shape consumed by `updateSuggest`.
