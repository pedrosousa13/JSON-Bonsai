import type { JsonValue } from "./tree-model";
import {
  parseIntoExactNumbers,
  parseWithExactNumbers,
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
// Lossless numbers from every line are merged into one ExactNumberMap; the
// per-line holders are distinct objects, so they never collide. Returns null
// (not an exception) for anything that is not NDJSON.
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

  let hasContainer = false;
  for (const line of nonEmpty) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof value === "object" && value !== null) hasContainer = true;
  }
  if (!hasContainer) return null;

  // Confirmed NDJSON: build the synthetic array, preserving exact numbers.
  return parseLines(nonEmpty);
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
  for (const line of nonEmpty) {
    try {
      JSON.parse(line);
    } catch {
      return null;
    }
  }
  return parseLines(nonEmpty);
}

function parseLines(nonEmpty: string[]): {
  data: JsonValue[];
  exactNumbers: ExactNumberMap | null;
} {
  if (!supportsReviverSource()) {
    return {
      data: nonEmpty.map((line) => parseWithExactNumbers(line).data),
      exactNumbers: null,
    };
  }

  // A line that is a bare number has no holder of its own — its exact token
  // would land on JSON.parse's discarded root wrapper. Point each line at its
  // slot in the synthetic array instead; the map is keyed on the array's
  // identity, so recording into it while it is still filling is fine.
  const exactNumbers: ExactNumberMap = new WeakMap();
  const data: JsonValue[] = [];
  nonEmpty.forEach((line, index) => {
    data.push(
      parseIntoExactNumbers(line, exactNumbers, {
        holder: data,
        key: String(index),
      })
    );
  });
  return { data, exactNumbers };
}
