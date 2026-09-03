import type { JsonValue } from "./tree-model";
import {
  mayContainLossyNumbers,
  parseIntoExactNumbers,
  supportsReviverSource,
  type ExactNumberMap,
} from "./lossless-numbers";

// Detects newline-delimited JSON (NDJSON / JSON Lines) and parses it into a
// synthetic array, one element per line. Detection is conservative: it returns
// null unless the whole text fails to parse as a single JSON value AND every
// non-empty line parses independently as valid JSON, with at least two such
// lines, AND at least one of them is an object or an array. That guard keeps
// ordinary pretty-printed multi-line JSON — which parses fine as a single
// value — from ever being treated as NDJSON, and it keeps plain-text files off
// the NDJSON path: real NDJSON streams are overwhelmingly object-per-line, so
// a scalar-only file like "1\n2\n3" is far more likely prose or a number list
// than a JSON stream. null counts as a scalar here, not a container.
//
// Lossless numbers from every line are merged into one ExactNumberMap without
// colliding: a line that parses to a container brings its own holder, and a
// line that parses to a bare number is keyed on the synthetic array under that
// line's index (see `parseLines`). Returns null (not an exception) for
// anything that is not NDJSON.
export function parseNdjson(raw: string): {
  data: JsonValue[];
  exactNumbers: ExactNumberMap | null;
} | null {
  // A document that parses as a single JSON value is plain JSON, not NDJSON —
  // including pretty-printed objects/arrays spanning many lines.
  try {
    JSON.parse(raw);
    return null;
  } catch {
    // Not a single JSON value; fall through to the per-line check.
  }

  // Split on LF; CRLF lines keep a trailing \r that JSON.parse tolerates as
  // whitespace, and trimming makes the non-empty check robust to it anyway.
  const lines = raw.split("\n");
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length < 2) return null;

  // Validation and parsing are the same pass: parseLines returns null on the
  // first line that is not JSON, so a rejected document costs one parse per
  // line and a confirmed one costs no re-parse.
  const parsed = parseLines(raw, nonEmpty);
  if (!parsed) return null;

  const hasContainer = parsed.data.some(
    (value) => typeof value === "object" && value !== null
  );
  if (!hasContainer) return null;

  return parsed;
}

// Forces the NDJSON path for documents the caller already knows are NDJSON
// (e.g. an application/x-ndjson Content-Type). Returns null when the lines do
// not all parse, so a mislabeled body falls back to normal handling.
export function parseNdjsonLines(raw: string): {
  data: JsonValue[];
  exactNumbers: ExactNumberMap | null;
} | null {
  const nonEmpty = raw.split("\n").filter((line) => line.trim() !== "");
  if (nonEmpty.length === 0) return null;
  return parseLines(raw, nonEmpty);
}

// Parses every line of `nonEmpty` exactly once into a synthetic array, or
// returns null at the first line that is not valid JSON. `raw` is the whole
// document, scanned once to choose the parser for all of the lines: a text
// with no lossy number token anywhere has no lossy line either, and deciding
// per line would scan the same characters over again.
function parseLines(
  raw: string,
  nonEmpty: string[]
): {
  data: JsonValue[];
  exactNumbers: ExactNumberMap | null;
} | null {
  const exactNumbers: ExactNumberMap | null = supportsReviverSource()
    ? new WeakMap()
    : null;
  // Null when the engine cannot record exact numbers at all, and null again
  // when the document holds no token that could lose any — either way every
  // line takes the plain, much faster parse.
  const recordInto =
    exactNumbers !== null && mayContainLossyNumbers(raw) ? exactNumbers : null;

  // A line that is a bare number has no holder of its own — its exact token
  // would land on JSON.parse's discarded root wrapper. Point each line at its
  // slot in the synthetic array instead; the map is keyed on the array's
  // identity, so recording into it while it is still filling is fine.
  const data: JsonValue[] = [];
  for (const [index, line] of nonEmpty.entries()) {
    try {
      data.push(
        recordInto
          ? parseIntoExactNumbers(line, recordInto, {
              holder: data,
              key: String(index),
            })
          : (JSON.parse(line) as JsonValue)
      );
    } catch {
      return null;
    }
  }
  return { data, exactNumbers };
}
