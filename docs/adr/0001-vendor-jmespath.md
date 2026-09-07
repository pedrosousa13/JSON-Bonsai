# 1. Vendor jmespath.js 0.16.0 instead of depending on it

- **Status:** Accepted
- **Date:** 2026-09-07
- **Issue:** [#106](https://github.com/pedrosousa13/JSON-Bonsai/issues/106), which absorbs [#101](https://github.com/pedrosousa13/JSON-Bonsai/issues/101) and [#104](https://github.com/pedrosousa13/JSON-Bonsai/issues/104)

## Decision

**The JMESPath engine's source lives in this repo, at `src/vendor/jmespath.cjs`,
and the `jmespath` npm dependency is gone.** The file is the published
`jmespath@0.16.0` source, byte-identical apart from two patch hunks that fix
#101 and #104 in place. `package.json` now has no `dependencies` field at all,
so the shipped extension has zero runtime dependencies.

## Context

`jmespath@0.16.0` was the extension's only runtime dependency, reached through a
single `search(data, expression)` call in `src/query.ts`. It is the one
dependency that evaluates user-authored expressions over untrusted page JSON.

It is also unmaintained. Last published 2022-06-19, last commit is the 0.16.0
release itself, no newer version, 46 open issues. `npm audit` reports no
advisory against it, and this decision does not claim a vulnerability — but the
OWASP sweep (#61) traced two real defects into the package, and there is no
upstream that will take a fix:

- **#101** — `strictDeepEqual` recurses once per level of nesting with no bound.
  An ordinary `[?a == b]` filter over two deeply nested, structurally equal
  operands overflows the call stack. Measured: fine to depth 5,000 on Node 24,
  `RangeError` at 8,000. A browser stack is smaller, so the real threshold in
  the extension is lower. The trigger is narrower than #101's title suggests —
  it needs *both* operands deep and equal far down, because the comparison
  short-circuits on a type mismatch before it recurses.
- **#104** — the tree interpreter's `Field` branch reads `value[node.name]` with
  no own-property guard, so any inherited name is addressable as a query.
  Measured: `search({a: 1}, "constructor")` returned `function Object() {
  [native code] }`, and `search({a: 1}, "__proto__")` returned the prototype
  object. A live JavaScript built-in came back as a query result.

## The alternatives, and why each was rejected

Each was measured against a real build, not inferred from source.

### Migrate to the community fork, `@jmespath-community/jmespath@1.3.0`

Rejected: it reproduces both defects verbatim.

| depth of `list[?x == y]`, both sides equal | 1,000 | 3,000 | 6,000 |
| --- | --- | --- | --- |
| `jmespath@0.16.0` | ok | ok | `RangeError` |
| `@jmespath-community/jmespath@1.3.0` | ok | ok | `RangeError` |
| `@aws-lambda-powertools/jmespath@2.35.0` | ok | `RangeError` | `RangeError` |

`search({a: {}}, 'a.constructor')` returns the live `Object` function in all
three. The fork is a faithful TypeScript port, and porting faithfully ported the
bugs: its `strictDeepEqual` takes no depth parameter, and its field resolution
is `value[identifier] ?? null` with no own-property guard. A depth bound there
is an open, unfixed request —
[jmespath-community/typescript-jmespath#68](https://github.com/jmespath-community/typescript-jmespath/issues/68),
filed 2025-07-13.

So migrating buys maintenance and newer spec features, costs roughly +2.5 KB
gzipped and an Apache-2.0 → MPL-2.0 license change, and still leaves this repo
writing the same two patches — against a build pipeline it does not own.

### Migrate to `@aws-lambda-powertools/jmespath@2.35.0`

Rejected: worse on both counts, and it does not build for a browser target at
all. It imports `node:crypto` and `node:zlib`.

### Stay on `jmespath@0.16.0` and mitigate in `src/query.ts`

Rejected: the wrapper is not a sufficient mitigation point. It receives
`(data, expression)` and cannot reach inside the library's deep-equality
recursion. The only wrapper-level mitigation for #101 is refusing deep
documents, which is a document-level cap — a separate, undecided question that
#99 deferred. That rules the option out rather than merely making it
unattractive.

### Why vendoring is cheap here

Vendoring's usual cost is rebasing a fork onto a moving upstream. That cost is
absent. There is no newer version to rebase onto, and no advisory to track —
confirmed empty in the npm bulk advisory API, the GitHub Advisory Database and
OSV. The file is 1,672 lines of plain, un-transpiled, commented ES5 in one UMD
file, Apache-2.0, with no build step. Both defect sites are single-site and
small. And it takes the extension to zero runtime dependencies, which for
software that parses untrusted page JSON is worth something on its own.

## The two patches

Both are marked in place with a `VENDOR PATCH` comment naming the issue, so the
file diffs cleanly against the published one and a reader sees only the intended
changes. `src/vendor/README.md` records the provenance and the source hash.

### `strictDeepEqual` gains a depth bound (#101)

The function takes a third `depth` argument, defaulted for the two entry calls
that omit it, and each recursive call passes `depth + 1`. It compares at most
`MAX_COMPARISON_DEPTH` — 200 — levels of nesting; at level 200 it stops
recursing and answers without descending.

**What it protects against:** a `RangeError` thrown out of an ordinary `==` or
`!=` filter, over data whose nesting depth the page chooses. The bound is on the
comparison's recursion only, not on what the viewer will accept as a document;
the document cap remains #99's separate question. 200 is far deeper than any
hand-written JSON structure and far below the frame budget of the smallest
browser stack, so the bound is reached only by data built to reach it.

**Past the bound, the comparison reports "not equal".** Three behaviors were
available. Reporting "equal" is not defensible: it would claim an equality that
was never checked. Throwing a query error is defensible — the panel renders
`ok: false` fine — but it turns a filter over one pathological element into a
failure for the whole query, and #106's acceptance criteria call for a result
rather than a throw. "Not equal" is the conservative direction: it never
asserts an equality it did not verify, it keeps `[?a == b]` returning a normal
filtered list the UI can render, and it is deterministic. `!=` inverts this same
result, so the two forms stay complementary at every depth: past the bound
`[?a == b]` excludes the element and `[?a != b]` includes it.

The cost is a false negative for two genuinely equal structures nested past 200
levels. That is accepted.

### `Field` resolution gains an own-property guard (#104)

The `Field` branch checks `hasOwnProperty.call(value, node.name)` before the
read, and returns `null` when it fails — the same `null` the existing
`field === undefined` branch already produced for an absent key.

**What it protects against:** a query returning a live JavaScript built-in.
`constructor`, `__proto__`, `toString`, `hasOwnProperty` and every other
inherited name now read as absent, at every position in an expression rather
than only at the top level. A document with a real own key of that name still
returns the key's value, so no legitimate query loses anything.

## Consequences

- **The file is `.cjs`, not `.js`.** The published file is a UMD that assigns to
  `exports` or to `this.jmespath`. esbuild does not detect the CommonJS form —
  `exports` is shadowed as the wrapper's parameter — so as `.js` it is treated
  as an ES module with no exports, and `search` bundles as `undefined`. The
  `.cjs` extension makes esbuild's CommonJS interpretation explicit and leaves
  the file's own module boundary untouched, which is what keeps the diff against
  upstream down to the two defect hunks. It also reproduces exactly how the npm
  dependency was interpreted before: `dist/content.js` grew by 102 bytes,
  94,886 → 94,988 minified.
- **Types are hand-written**, at `src/vendor/jmespath.d.cts`. The
  `@types/jmespath` devDependency is gone. `search`'s signature is unchanged
  from that stub, so the swap is invisible at the call site.
- **`src/query.ts` is unchanged except its import specifier.** So are the
  autocomplete and `toJmespath`. The `toJmespath` round-trip test still runs
  against the real engine.
- **This repo now owns these edge cases.** That is the trade being accepted, and
  it is bounded: this decision fixes two defects and adopts none of the other 44
  open upstream issues.
- **The vendored source stays ES5 and un-transpiled.** Rewriting or modernizing
  it would destroy the property that makes it safe to hold — that it diffs
  cleanly against the published file.

## When to revisit

**When there is a product need for the newer JMESPath spec features** —
`let … in`, arithmetic, the ternary operator, the root `$` reference. 0.16.0
does not have them and never will, and vendoring it deliberately forgoes them.

At that point the move is to the community fork, and it comes with a condition:
**contribute the depth bound and the own-property guard upstream first, rather
than swapping blind.** Both defects exist there too. Swapping without landing
them reintroduces the two bugs this decision exists to fix.

A published advisory against `jmespath@0.16.0` would also force a re-read, but
would not by itself change the answer — the fix would land here, in the same
file, the same way these two did.
