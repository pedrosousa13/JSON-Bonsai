# Relative Queries (Query Relative to Any Node) — Design

**Date:** 2026-06-25
**Status:** Approved (do not commit this file — local working artifact)

## Goal

Let the user run a JMESPath query *scoped to any node* in the tree — e.g. "from
`users[0]`, give me `[?active].name`" — without manually prefixing the full path
into every expression.

## Key insight: the engine already exists

JMESPath's pipe operator already does this today. Typing

```
users[0] | [?active].name
```

into the query bar works right now: the left side navigates to the node, the
pipe resets the evaluation context, and the right side runs against that subtree
as a fresh root. The pipe also terminates projections, so the right side sees a
clean single value — exactly relative-query semantics.

`runQuery(data, expr)` (`src/query.ts`) passes the whole expression straight to
`jmespath.search`, so **no query-execution change is needed**.

What's missing is assistance: the autocomplete is blind to pipes. After a `|` it
keeps suggesting keys of the document **root**, not of the scoped subtree. The
feature is therefore: **make autocomplete pipe-aware**, plus light
discoverability and docs.

## Non-goals

- No persistent "scope chip" UI (considered and deferred — adds scope state,
  clear handling, and absolute-path reconstruction in results). The visible-pipe
  approach needs none of that.
- No change to query execution, the result tree, or path display.
- No change to "Query from here" behavior (one-click "show this subtree" stays).

## How the user triggers it

The `|` token is the trigger. Two paths:

1. **From a node (primary).** Hover a node → pin its path → click "Query from
   here". The input is seeded with the node path (e.g. `users[0]`) and the
   subtree renders — unchanged from today. The user then types ` | ` and the
   pipe-aware autocomplete immediately pops the *subtree's* keys. That pop is the
   self-revealing teaching moment.
2. **By hand.** Open the panel (`Q`), type `path | relative-expr`.

## Design

### 1. `splitPipes(text)` — new pure helper (`src/query-suggest.ts`)

Returns the top-level pipe-segment boundaries of an expression so the caller can
find which segment the caret is in and what's left of it.

Must treat these as **not** segment boundaries:

- `||` — the JMESPath or-operator (two chars, single token).
- `|` inside a string literal: `"a|b"`, `'a|b'`.
- `|` inside brackets: `items[?a || b]`, `[?x | y]`.

Implementation: a single left-to-right scan tracking string state and bracket
depth, matching the existing hand-scanner style of `pathStart` /
`openBracketBefore` (no AST — `jmespath@0.16` exposes no parser).

Signature (shape, not final):

```ts
// Boundaries of top-level pipe segments. "a | b | c" → segments for a, b, c
// with their [start, end) offsets in the original text.
export function splitPipes(text: string): { start: number; end: number }[];
```

A string with no top-level pipe returns a single segment spanning the whole
text — so the existing (non-piped) code path is preserved by construction.

### 2. Pipe-aware suggestions (`src/content.ts`, `updateSuggest`)

Today:

```ts
const { items, start } = suggestAt(value, caret, data, keyUniverse, JMESPATH_FUNCTIONS);
```

New flow:

1. `const segs = splitPipes(value)` and find the segment containing `caret`.
2. If it's the **first** segment → behave exactly as today (scope is `data`).
3. Otherwise compute the **scope value** = result of evaluating everything left
   of this segment's opening pipe:
   - `leftExpr = value.slice(0, segment.start - 1).trim()` (drop the `|`).
   - `scope = evalScope(leftExpr)` (see caching below). On error → fall back to
     the flat `keyUniverse` (same as any unresolvable context today).
4. Let `rightText = value.slice(segment.start)` and
   `rightCaret = caret - segment.start`.
5. `const { items, start } = suggestAt(rightText, rightCaret, scope, keyUniverse, JMESPATH_FUNCTIONS)`.
6. Splice offset: the real token start in the input is `segment.start + start`.
   Store that in `suggestTokenStart` so `acceptSuggest` inserts at the right place.

`suggestAt` itself needs **no change** — it already accepts an arbitrary `data`
root and returns a `start` relative to the `text` it was given. The only new
responsibility in the caller is choosing the scope root and offsetting `start`.

`acceptSuggest` already splices using `suggestTokenStart` against the full input
value, so once `suggestTokenStart` carries the offset it works unchanged.

### 3. Scope eval + cache (`src/content.ts`)

`updateSuggest` runs on every keystroke. Evaluating the left side per keystroke
could be wasteful on large payloads if the left side is heavy (e.g. a top-level
filter). Mitigation — memoize on the left-expression string:

```ts
let scopeCache: { expr: string; value: JsonValue } | null = null;

function evalScope(leftExpr: string): JsonValue | null {
  if (scopeCache?.expr === leftExpr) return scopeCache.value;
  const outcome = runQuery(data, leftExpr);
  if (!outcome.ok) return null;           // invalid mid-type → caller falls back
  scopeCache = { expr: leftExpr, value: outcome.result };
  return outcome.result;
}
```

Typing the *right* side never changes `leftExpr`, so the cache hits on every
right-side keystroke — the common case. A cheap left side (`users[0]`) is trivial
anyway. Cache is a single-entry slot (only the active left matters).

### 4. Discoverability (`src/content.ts`)

Update the query input placeholder (currently
`e.g. items[?price > \`10\`].name`) to advertise the pipe, e.g.:

```
e.g. items[?price > `10`] | sort_by(@, &name)
```

This shows only when the input is empty (covers the hand-typed path); the
from-node path is covered by the autocomplete pop on `|`.

### 5. Docs (`README.md`)

Extend the "Query, search, and copy" bullet list with a relative-query line,
e.g.:

> - Scope a query to any node — "Query from here" seeds the node's path; append
>   `| expr` to query inside that subtree, with autocomplete resolving against it.

## Performance

- **Query execution:** unchanged, and scoping is neutral-to-faster — the right
  side traverses only the subtree, the navigation prefix is O(depth) (no sibling
  scan for a known key/index). No reparse, no copy (references only).
- **Result rendering** (`buildTreeModel` + search index): the real per-query
  cost, O(result nodes), already incurred by every query today. Scoped queries
  usually yield smaller results → faster.
- **Autocomplete left-eval:** the one new cost. Bounded by the single-entry
  `scopeCache` (hits on every right-side keystroke) and by the fact that the
  left side is normally a cheap path. Invalid/heavy left → falls back to the flat
  universe, same as any unresolvable context today.

## Testing

`src/query-suggest.test.ts`:

- `splitPipes`: no pipe (single segment), single pipe, multiple pipes, `||` not
  split, `|` inside `"…"` / `'…'` not split, `|` inside `[?…]` not split,
  trailing pipe (`a | `), leading whitespace.

`src/content.test.ts` (or query-suggest integration):

- After `users[0] | `, suggestions resolve to `users[0]`'s element keys, not root
  keys.
- `suggestTokenStart` offset is correct so an accepted suggestion splices into
  the right place in the full expression.
- First segment (no pipe) still resolves against root (regression guard).
- Invalid left side (`nope[ | `) falls back to the flat universe without
  throwing.

## Files touched

| Change | File |
|---|---|
| `splitPipes` pure helper + tests | `src/query-suggest.ts`, `src/query-suggest.test.ts` |
| pipe-aware `updateSuggest`, `evalScope`/cache | `src/content.ts` |
| placeholder hint | `src/content.ts` |
| pipe-suggest integration tests | `src/content.test.ts` |
| relative-query docs line | `README.md` |
