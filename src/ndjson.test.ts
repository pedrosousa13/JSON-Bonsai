import { describe, expect, test } from "vitest";

import { parseNdjson, parseNdjsonLines } from "./ndjson";
import {
  parseWithExactNumbers,
  stringifyWithExactNumbers,
} from "./lossless-numbers";
import { buildTreeModel } from "./tree-model";

// Reviver source access needs V8 11.4+ (Node 21+, Chrome 114+); the lossless
// assertions degrade to plain parse below it, so they are guarded.
const hasReviverSource = parseWithExactNumbers("{}").exactNumbers !== null;
const hasRawJSON =
  typeof (JSON as { rawJSON?: unknown }).rawJSON === "function";

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

  test("does NOT detect number-only lines as NDJSON", () => {
    expect(parseNdjson("1\n2\n3")).toBeNull();
  });

  test("does NOT detect boolean-only lines as NDJSON", () => {
    expect(parseNdjson("true\nfalse")).toBeNull();
  });

  test("does NOT detect null-only lines as NDJSON", () => {
    expect(parseNdjson("null\nnull")).toBeNull();
  });

  test("detects two objects, one per line", () => {
    const result = parseNdjson('{"a":1}\n{"a":2}');

    expect(result).not.toBeNull();
    expect(result!.data).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("detects a mix of scalar and object lines — one container is enough", () => {
    const result = parseNdjson('1\n{"a":1}');

    expect(result).not.toBeNull();
    expect(result!.data).toEqual([1, { a: 1 }]);
  });

  test.runIf(hasReviverSource)(
    "preserves a bare big-number line on the detection path too",
    () => {
      const result = parseNdjson('9007199254740993\n{"a": 1}')!;

      expect(result.exactNumbers!.get(result.data)?.get("0")).toBe(
        "9007199254740993"
      );
    }
  );

  test("detects array-per-line NDJSON", () => {
    const result = parseNdjson("[1]\n[2]");

    expect(result).not.toBeNull();
    expect(result!.data).toEqual([[1], [2]]);
  });
});

describe("parseNdjsonLines", () => {
  test("keeps scalar-only lines, which the explicit Content-Type vouches for", () => {
    const result = parseNdjsonLines("1\n2");

    expect(result).not.toBeNull();
    expect(result!.data).toEqual([1, 2]);
  });

  test.runIf(hasReviverSource)(
    "records a bare number line against the synthetic array",
    () => {
      const raw = '9007199254740993\n{"id": 9007199254740993}';
      const result = parseNdjsonLines(raw)!;

      expect(result.exactNumbers).not.toBeNull();
      // A top-level scalar has no holder of its own, so the synthetic array
      // stands in for one, keyed by the line's index.
      expect(result.exactNumbers!.get(result.data)?.get("0")).toBe(
        "9007199254740993"
      );
      // The object line keeps recording against its own holder.
      const second = result.data[1] as object;
      expect(result.exactNumbers!.get(second)?.get("id")).toBe(
        "9007199254740993"
      );
    }
  );

  test.runIf(hasReviverSource)(
    "gives the tree exact text for both a bare number line and an object line",
    () => {
      const raw = '9007199254740993\n{"id": 9007199254740993}';
      const result = parseNdjsonLines(raw)!;
      const model = buildTreeModel(result.data, result.exactNumbers);

      // numberText is what the viewer renders and what marks a node exact.
      const bare = model.nodes[model.pathToId.get("data[0]")!];
      const nested = model.nodes[model.pathToId.get("data[1].id")!];
      expect(bare.numberText).toBe("9007199254740993");
      expect(nested.numberText).toBe("9007199254740993");
    }
  );

  test.runIf(hasReviverSource && hasRawJSON)(
    "round-trips both a bare number line and an object line through Copy JSON",
    () => {
      const raw = '9007199254740993\n{"id": 9007199254740993}';
      const result = parseNdjsonLines(raw)!;

      expect(
        stringifyWithExactNumbers(result.data, result.exactNumbers)
      ).toBe('[9007199254740993,{"id":9007199254740993}]');
    }
  );

  test.runIf(hasReviverSource)("preserves -0 on its own line", () => {
    const result = parseNdjsonLines('{"a": 1}\n-0')!;

    expect(result.exactNumbers!.get(result.data)?.get("1")).toBe("-0");
  });

  test.runIf(hasReviverSource)(
    "leaves lossless scalar lines and container lines untouched",
    () => {
      const result = parseNdjsonLines('1\n[9007199254740993]\n{"a": 2}')!;

      // Nothing lossy at the top level, so the array holder stays unrecorded.
      expect(result.exactNumbers!.get(result.data)).toBeUndefined();
      // The array line still records against the parsed array itself.
      const inner = result.data[1] as unknown[];
      expect(result.exactNumbers!.get(inner)?.get("0")).toBe(
        "9007199254740993"
      );
    }
  );
});
