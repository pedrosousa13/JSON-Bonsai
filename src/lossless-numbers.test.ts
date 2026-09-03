import { afterEach, describe, expect, test, vi } from "vitest";

import {
  mayContainLossyNumbers,
  numberLosesPrecision,
  parseIntoExactNumbers,
  parseWithExactNumbers,
  stringifyWithExactNumbers,
  type ExactNumberMap,
} from "./lossless-numbers";

// Reviver source access and JSON.rawJSON need V8 11.4+ (Node 21+, Chrome
// 114+). On older engines the feature degrades to plain JSON.parse, so the
// dependent tests are skipped rather than failed.
const hasReviverSource = parseWithExactNumbers("{}").exactNumbers !== null;
const hasRawJSON =
  typeof (JSON as { rawJSON?: unknown }).rawJSON === "function";

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("mayContainLossyNumbers", () => {
  test("clears a document whose numbers all fit a double", () => {
    expect(
      mayContainLossyNumbers('{"a": [1, 2.5, -3, 1e3, 0.1], "b": null}')
    ).toBe(false);
  });

  test("flags an integer of 16 or more digits", () => {
    expect(mayContainLossyNumbers('{"id": 9007199254740993}')).toBe(true);
    expect(mayContainLossyNumbers('{"id": 900719925474099}')).toBe(false);
  });

  test("flags precision that straddles the decimal point", () => {
    // 18 significant digits, but no run of 16 on either side of the dot.
    expect(mayContainLossyNumbers("[1234567.89012345678]")).toBe(true);
  });

  test("flags -0 without flagging negative numbers that merely start with 0", () => {
    expect(mayContainLossyNumbers('{"a": -0}')).toBe(true);
    expect(mayContainLossyNumbers('{"a": -0.0}')).toBe(true);
    expect(mayContainLossyNumbers('{"a": -0.5}')).toBe(false);
    expect(mayContainLossyNumbers('{"a": -0.05}')).toBe(false);
  });

  test("flags -0 in every position a number can legally sit", () => {
    // The rule looks at the character before the minus, so each of these has
    // to be pinned: nothing may slip through because of its surroundings.
    for (const raw of ['{"a":-0}', '{"a": -0}', "[-0]", "[1,-0]", "-0", '{"a":1}\n-0']) {
      expect(mayContainLossyNumbers(raw)).toBe(true);
    }
  });

  test("clears a -0 that is only the tail of a string", () => {
    // "batch-0" is not a number, and letting it through would put every
    // document with an id like that on the slow path.
    expect(mayContainLossyNumbers('{"name": "batch-0"}')).toBe(false);
  });

  test("flags exponents large enough to overflow or flush to zero", () => {
    expect(mayContainLossyNumbers("[1e999]")).toBe(true);
    expect(mayContainLossyNumbers("[1e-999]")).toBe(true);
    expect(mayContainLossyNumbers("[1e99]")).toBe(false);
  });

  test("flags digit runs inside string literals — the harmless direction", () => {
    // The scan does not tokenize, so an order id in a string trips it. That
    // costs a slower parse and nothing else.
    expect(mayContainLossyNumbers('{"order": "12345678901234567890"}')).toBe(
      true
    );
  });

  test("never clears a token that numberLosesPrecision would flag", () => {
    // A false positive costs parse time; a false negative parses a lossy token
    // plainly and corrupts it silently. Sweep every token shape the parser can
    // meet and pin that direction.
    const mantissas: string[] = [];
    for (let len = 1; len <= 22; len += 1) {
      mantissas.push("9".repeat(len));
      mantissas.push("1" + "0".repeat(len - 1));
      mantissas.push("0".repeat(len));
      mantissas.push("1234567890".repeat(3).slice(0, len));
      mantissas.push("1" + "0".repeat(len - 1) + "1");
    }

    const tokens = new Set<string>();
    for (const digits of mantissas) {
      for (let split = 0; split <= digits.length; split += 1) {
        const body =
          split === 0
            ? `0.${digits}`
            : split === digits.length
              ? digits
              : `${digits.slice(0, split)}.${digits.slice(split)}`;
        for (const exp of ["", "e5", "e-5", "e99", "e-99", "e300", "e-300", "e999"]) {
          tokens.add(`${body}${exp}`);
          tokens.add(`-${body}${exp}`);
        }
      }
    }

    const missed = [...tokens].filter(
      (token) =>
        numberLosesPrecision(token, Number(token)) &&
        !mayContainLossyNumbers(token)
    );
    expect(missed).toEqual([]);
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

  test.runIf(hasReviverSource)(
    "parses a document with no lossy token without a reviver",
    () => {
      const spy = vi.spyOn(JSON, "parse");
      parseWithExactNumbers('{"a": [1, 2.5, "x"], "b": null}');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBeUndefined();
    }
  );

  test.runIf(hasReviverSource)(
    "still reaches for the reviver when a token can lose precision",
    () => {
      const spy = vi.spyOn(JSON, "parse");
      parseWithExactNumbers('{"id": 9007199254740993}');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(typeof spy.mock.calls[0][1]).toBe("function");
    }
  );

  test.runIf(hasReviverSource)(
    "returns an empty map, not null, on the fast path",
    () => {
      const { data, exactNumbers } = parseWithExactNumbers('{"ok": 7}');

      // null means "this engine cannot do exact numbers at all"; the fast path
      // must not be mistaken for that.
      expect(exactNumbers).not.toBeNull();
      expect(exactNumbers!.get(data as object)).toBeUndefined();
    }
  );

  test.runIf(hasReviverSource)("preserves a 64-bit integer", () => {
    const { data, exactNumbers } = parseWithExactNumbers(
      '{"a": 9007199254740993}'
    );

    expect(exactNumbers!.get(data as object)?.get("a")).toBe(
      "9007199254740993"
    );
  });

  test.runIf(hasReviverSource)("preserves -0", () => {
    const { data, exactNumbers } = parseWithExactNumbers('{"a": -0}');

    expect(exactNumbers!.get(data as object)?.get("a")).toBe("-0");
  });

  test("parses correctly when the only long digit run is inside a string", () => {
    const raw = '{"order": "12345678901234567890", "n": 1}';
    expect(parseWithExactNumbers(raw).data).toEqual(JSON.parse(raw));
  });
});

describe("parseIntoExactNumbers", () => {
  test.runIf(hasReviverSource)(
    "records a lossy top-level number against the caller's root slot",
    () => {
      const into: ExactNumberMap = new WeakMap();
      const holder: unknown[] = [];
      const value = parseIntoExactNumbers("9007199254740993", into, {
        holder,
        key: "0",
      });

      // The parsed value is already corrupted; only the recorded text is exact.
      expect(value).toBe(9007199254740992);
      expect(into.get(holder)?.get("0")).toBe("9007199254740993");
    }
  );

  test.runIf(hasReviverSource)("records a top-level -0 against the root slot", () => {
    const into: ExactNumberMap = new WeakMap();
    const holder: unknown[] = [];
    parseIntoExactNumbers("-0", into, { holder, key: "2" });

    expect(into.get(holder)?.get("2")).toBe("-0");
  });

  test.runIf(hasReviverSource)(
    "leaves the root slot alone for a lossless top-level number",
    () => {
      const into: ExactNumberMap = new WeakMap();
      const holder: unknown[] = [];
      parseIntoExactNumbers("42", into, { holder, key: "0" });

      expect(into.get(holder)).toBeUndefined();
    }
  );

  test.runIf(hasReviverSource)(
    "does not mistake an empty-string member for the root",
    () => {
      // The reviver sees key "" twice here: once for the member, once for
      // JSON.parse's root wrapper. Only a top-level number may reach the slot.
      const into: ExactNumberMap = new WeakMap();
      const holder: unknown[] = [];
      const value = parseIntoExactNumbers('{"": 9007199254740993}', into, {
        holder,
        key: "0",
      });

      expect(into.get(value as object)?.get("")).toBe("9007199254740993");
      expect(into.get(holder)).toBeUndefined();
    }
  );

  test.runIf(hasReviverSource)(
    "keeps nested recording unchanged when no root slot is given",
    () => {
      const into: ExactNumberMap = new WeakMap();
      const value = parseIntoExactNumbers('{"id": 9007199254740993}', into);

      expect(into.get(value as object)?.get("id")).toBe("9007199254740993");
    }
  );
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
