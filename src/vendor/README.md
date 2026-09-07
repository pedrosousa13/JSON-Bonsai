# Vendored third-party source

## jmespath.cjs

`jmespath.js` 0.16.0, the JMESPath expression engine behind the query panel.

- Upstream: https://github.com/jmespath/jmespath.js
- Copyright 2014 James Saryerwinnie
- Licensed under the Apache License, Version 2.0 — full text in `LICENSE`
- Taken from the published `jmespath@0.16.0` npm tarball, file `jmespath.js`
  (sha256 `a88012bb68aa9e52a316d3be81598573d686cdad226a4c5d3177d720e187fe53`)

The file is byte-identical to that published file apart from two patch hunks,
each marked in place with a `VENDOR PATCH` comment naming the issue it fixes:

- **json-bonsai#101** — `strictDeepEqual` gained a depth bound. Operands nested
  past `MAX_COMPARISON_DEPTH` levels compare as not equal instead of
  overflowing the call stack.
- **json-bonsai#104** — the tree interpreter's `Field` branch gained an
  own-property guard, so a field read of an inherited name resolves to `null`
  instead of returning a live JavaScript built-in.

Only the extension needs this source. Nothing else was renamed, reformatted or
modernized: the value of the file is that it diffs cleanly against upstream.

Two files beside it are this repo's own work rather than upstream's, so a
directory-level diff against the published tarball will show them: `jmespath.d.cts`
and `jmespath.test.ts`. Every other test in the repo is a flat `src/*.test.ts`;
this one sits here because it tests the two patch hunks and nothing else, so it
belongs next to what it guards and moves or dies with it.

Why the source lives here rather than in `package.json` — including why the
maintained forks were rejected and when to revisit — is recorded in
`docs/adr/0001-vendor-jmespath.md`.
