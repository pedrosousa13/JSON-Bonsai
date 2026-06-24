import { describe, expect, test } from "vitest";

import { parseNdjson } from "./ndjson";
import { parseWithExactNumbers } from "./lossless-numbers";

// Reviver source access needs V8 11.4+ (Node 21+, Chrome 114+); the lossless
// assertions degrade to plain parse below it, so they are guarded.
const hasReviverSource = parseWithExactNumbers("{}").exactNumbers !== null;

describe("parseNdjson", () => {
  test("parses three JSON objects, one per line, into an array of three", () => {
    const raw = '{"a": 1}\n{"b": 2}\n{"c": 3}';
    const result = parseNdjson(raw);

    expect(result).not.toBeNull();
    expect(result!.data).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test.runIf(hasReviverSource)(
    "preserves a 64-bit int on one line losslessly",
    () => {
      const raw =
        '{"id": 1}\n{"id": 9007199254740993}\n{"id": 3}';
      const result = parseNdjson(raw);

      expect(result).not.toBeNull();
      const arr = result!.data as Array<{ id: number }>;
      // The lossy line's holder must carry the exact source text.
      expect(result!.exactNumbers).not.toBeNull();
      expect(result!.exactNumbers!.get(arr[1])?.get("id")).toBe(
        "9007199254740993"
      );
      // Lossless lines must not be recorded.
      expect(result!.exactNumbers!.get(arr[0])?.has("id") ?? false).toBe(false);
    }
  );

  test("does NOT detect a single pretty-printed JSON object as NDJSON", () => {
    const raw = `{
  "name": "bonsai",
  "nested": {
    "a": 1,
    "b": 2
  },
  "list": [
    1,
    2,
    3
  ]
}`;
    expect(parseNdjson(raw)).toBeNull();
  });

  test("does NOT detect arbitrary non-JSON text as NDJSON", () => {
    expect(parseNdjson("hello world\nthis is not json\n- a list item")).toBeNull();
  });

  test("does NOT detect a single JSON value spanning one line as NDJSON", () => {
    expect(parseNdjson('{"a": 1, "b": 2}')).toBeNull();
    expect(parseNdjson("[1, 2, 3]")).toBeNull();
  });

  test("ignores a trailing blank line", () => {
    const raw = '{"a": 1}\n{"b": 2}\n';
    const result = parseNdjson(raw);

    expect(result).not.toBeNull();
    expect(result!.data).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("handles CRLF line endings", () => {
    const raw = '{"a": 1}\r\n{"b": 2}\r\n{"c": 3}';
    const result = parseNdjson(raw);

    expect(result).not.toBeNull();
    expect(result!.data).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test("does NOT detect a single line even with a trailing newline", () => {
    expect(parseNdjson('{"a": 1}\n')).toBeNull();
  });
});
