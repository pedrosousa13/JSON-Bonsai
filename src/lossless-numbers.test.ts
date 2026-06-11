import { describe, expect, test } from "vitest";

import {
  numberLosesPrecision,
  parseWithExactNumbers,
  stringifyWithExactNumbers,
} from "./lossless-numbers";

// Reviver source access and JSON.rawJSON need V8 11.4+ (Node 21+, Chrome
// 114+). On older engines the feature degrades to plain JSON.parse, so the
// dependent tests are skipped rather than failed.
const hasReviverSource = parseWithExactNumbers("{}").exactNumbers !== null;
const hasRawJSON =
  typeof (JSON as { rawJSON?: unknown }).rawJSON === "function";

describe("numberLosesPrecision", () => {
  test("flags integers beyond the IEEE-754 safe range", () => {
    expect(numberLosesPrecision("9007199254740993", 9007199254740992)).toBe(true);
    expect(numberLosesPrecision("18446744073709551615", 18446744073709552000)).toBe(true);
  });

  test("flags decimals with more precision than a double holds", () => {
    expect(numberLosesPrecision("3.141592653589793238", 3.141592653589793)).toBe(true);
    expect(numberLosesPrecision("0.10000000000000001", 0.1)).toBe(true);
  });

  test("treats alternate spellings of the same value as lossless", () => {
    expect(numberLosesPrecision("1e3", 1000)).toBe(false);
    expect(numberLosesPrecision("1.0", 1)).toBe(false);
    expect(numberLosesPrecision("1E+2", 100)).toBe(false);
    expect(numberLosesPrecision("0.1", 0.1)).toBe(false);
    expect(numberLosesPrecision("1000000000000000000000", 1e21)).toBe(false);
  });

  test("keeps safe integers and exact decimals unflagged", () => {
    expect(numberLosesPrecision("9007199254740991", 9007199254740991)).toBe(false);
    expect(numberLosesPrecision("-42", -42)).toBe(false);
    expect(numberLosesPrecision("0.5", 0.5)).toBe(false);
  });

  test("flags -0 because JSON.stringify drops the sign", () => {
    expect(numberLosesPrecision("-0", -0)).toBe(true);
    expect(numberLosesPrecision("0", 0)).toBe(false);
  });

  test("flags magnitudes that overflow to Infinity", () => {
    expect(numberLosesPrecision("1e999", Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe("parseWithExactNumbers", () => {
  test.runIf(hasReviverSource)(
    "records exact source text keyed by holder and key",
    () => {
      const raw = '{"id": 9007199254740993, "list": [1.0, 0.30000000000000000004], "ok": 7}';
      const { data, exactNumbers } = parseWithExactNumbers(raw);
      const root = data as { list: unknown[] };

      expect(exactNumbers).not.toBeNull();
      expect(exactNumbers!.get(root as object)?.get("id")).toBe("9007199254740993");
      // Array entries are keyed by stringified index; "1.0" is lossless so
      // index 0 must not be recorded.
      expect(exactNumbers!.get(root.list)?.get("1")).toBe("0.30000000000000000004");
      expect(exactNumbers!.get(root.list)?.has("0")).toBe(false);
      expect(exactNumbers!.get(root as object)?.has("ok")).toBe(false);
    }
  );

  test("parses plain values identically to JSON.parse", () => {
    const raw = '{"a": [1, 2.5, "x"], "b": null}';
    expect(parseWithExactNumbers(raw).data).toEqual(JSON.parse(raw));
  });
});

describe("stringifyWithExactNumbers", () => {
  test.runIf(hasReviverSource && hasRawJSON)(
    "re-emits preserved number tokens verbatim",
    () => {
      const raw = '{"id":9007199254740993,"nested":{"pi":3.141592653589793238},"ok":7}';
      const { data, exactNumbers } = parseWithExactNumbers(raw);

      expect(stringifyWithExactNumbers(data, exactNumbers)).toBe(raw);
    }
  );

  test("falls back to plain stringify without a map", () => {
    const data = { a: 1, b: [2, 3] };
    expect(stringifyWithExactNumbers(data, null, 2)).toBe(
      JSON.stringify(data, null, 2)
    );
  });
});
