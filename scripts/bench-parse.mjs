// Measures what the exact-number machinery costs on top of a plain
// JSON.parse. Run with `node scripts/bench-parse.mjs`.
//
// This is a script rather than a test on purpose: a wall-clock assertion in
// the suite fails on a loaded CI box for reasons that have nothing to do with
// the code under test.
//
// Two fixtures, because the answer depends on the document. V8's JSON parser
// runs at very different speeds on a string-heavy document and on one that is
// almost entirely numbers, while the precision scan costs roughly the same on
// both — so the ratio the scan adds is worst exactly where the parser is
// fastest.
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

// The sources import each other without file extensions, which Node's ESM
// resolver will not follow, so bundle them the way the extension itself is
// built and import the result.
const bundle = await esbuild.build({
  stdin: {
    contents: `export { parseWithExactNumbers, parseIntoExactNumbers } from "./src/lossless-numbers";
export { parseNdjson } from "./src/ndjson";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
});
const { parseWithExactNumbers, parseIntoExactNumbers, parseNdjson } = await import(
  `data:text/javascript;base64,${Buffer.from(
    bundle.outputFiles[0].text
  ).toString("base64")}`
);

const WORDS =
  "the quick brown fox jumps over a lazy dog while parsing large documents in the browser".split(
    " "
  );

function words(count, seed) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(WORDS[(seed * 7 + i * 13) % WORDS.length]);
  }
  return out.join(" ");
}

// An API response: nested, mostly text, the shape of most documents someone
// opens in a viewer.
function apiRecord(i) {
  return {
    id: `3f2504e0-4f89-11d3-9a0c-${String(i).padStart(12, "0")}`,
    created_at: `2024-${String((i % 12) + 1).padStart(2, "0")}-${String(
      (i % 28) + 1
    ).padStart(2, "0")}T10:23:45Z`,
    author: { name: words(3, i), email: `user${i}@example.com`, verified: i % 2 === 0 },
    title: words(8, i),
    body: words(40, i),
    stats: { views: i * 17, likes: i % 97, ratio: (i % 100) / 4 },
    tags: [words(1, i), words(1, i + 1)],
  };
}

// A metrics export: almost every byte is a digit. Worst case for the scan and
// best case for the parser.
function metricRecord(i) {
  return {
    id: i,
    a: i * 3,
    b: i * 7,
    c: (i % 1000) / 4,
    d: i % 9,
    e: [i, i + 1, i + 2, i + 3],
    f: i * 11,
    g: (i % 77) / 4,
  };
}

function time(label, run) {
  // One warm-up pass, then the best of five — the best run is the one least
  // disturbed by GC and by whatever else the machine is doing.
  run();
  let best = Infinity;
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  console.log(`  ${label.padEnd(34)} ${best.toFixed(1)} ms`);
  return best;
}

function report(label, doc) {
  console.log(`\n${label}: ${(doc.length / 1e6).toFixed(1)} MB\n`);
  // A lossy variant of the same document, to price the reviver path.
  const lossy = `${doc.slice(0, -1)},{"id":9007199254740993}]`;

  const plain = time("JSON.parse (plain)", () => JSON.parse(doc));
  const fast = time("parseWithExactNumbers (fast)", () =>
    parseWithExactNumbers(doc)
  );
  const slow = time("parseWithExactNumbers (reviver)", () =>
    parseWithExactNumbers(lossy)
  );

  console.log(`\n  fast path    ${(fast / plain).toFixed(2)}x plain JSON.parse`);
  console.log(`  reviver path ${(slow / plain).toFixed(2)}x plain JSON.parse`);
}

report(
  "API response (nested, string-heavy)",
  JSON.stringify(Array.from({ length: 30_000 }, (_, i) => apiRecord(i)))
);
report(
  "Metrics export (number-dense)",
  JSON.stringify(Array.from({ length: 150_000 }, (_, i) => metricRecord(i)))
);

const LINES = 200_000;
const ndjson = Array.from({ length: LINES }, (_, i) =>
  JSON.stringify({ id: i, name: `row ${i}`, ok: i % 2 === 0 })
).join("\n");

console.log(
  `\nNDJSON: ${(ndjson.length / 1e6).toFixed(1)} MB, ${LINES} lines\n`
);
const floor = time("JSON.parse, one pass per line", () => {
  for (const line of ndjson.split("\n")) JSON.parse(line);
});
// What the old code did: a plain parse of every line to validate it, then a
// second reviver parse of every line to build the array.
const before = time("validate, then re-parse (before)", () => {
  const lines = ndjson.split("\n");
  for (const line of lines) JSON.parse(line);
  const into = new WeakMap();
  const data = [];
  lines.forEach((line, index) =>
    data.push(parseIntoExactNumbers(line, into, { holder: data, key: String(index) }))
  );
});
const detectAndParse = time("parseNdjson (detect + parse)", () =>
  parseNdjson(ndjson)
);
console.log(
  `\n  ${(detectAndParse / floor).toFixed(2)}x the one-parse-per-line floor` +
    `, ${(before / detectAndParse).toFixed(2)}x faster than before\n`
);
