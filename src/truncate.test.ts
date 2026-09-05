import { describe, expect, test } from "vitest";

import { keepLastCodePoints, truncateCodePoints } from "./truncate";

describe("truncateCodePoints", () => {
  test("leaves text within the limit untouched", () => {
    expect(truncateCodePoints("abc", 3)).toBe("abc");
    expect(truncateCodePoints("abc", 10)).toBe("abc");
  });

  test("cuts at the limit when nothing straddles it", () => {
    expect(truncateCodePoints("abcdef", 3)).toBe("abc");
  });

  test("drops an astral character straddling the limit whole", () => {
    // "a😀b": the emoji occupies units 1 and 2.
    expect(truncateCodePoints("a😀b", 2)).toBe("a");
    expect(truncateCodePoints("a😀b", 3)).toBe("a😀");
  });

  test("keeps a lone low surrogate rather than inventing a pair", () => {
    // Already-broken input: cutting after it is still a faithful prefix.
    expect(truncateCodePoints("a\udc00bc", 2)).toBe("a\udc00");
  });
});

describe("keepLastCodePoints", () => {
  test("leaves text within the limit untouched", () => {
    expect(keepLastCodePoints("abc", 3)).toBe("abc");
    expect(keepLastCodePoints("abc", 10)).toBe("abc");
  });

  test("cuts at the limit when nothing straddles it", () => {
    expect(keepLastCodePoints("abcdef", 3)).toBe("def");
  });

  test("drops an astral character straddling the limit whole", () => {
    // "a😀b": the emoji occupies units 1 and 2.
    expect(keepLastCodePoints("a😀b", 2)).toBe("b");
    expect(keepLastCodePoints("a😀b", 3)).toBe("😀b");
  });

  test("keeps a lone high surrogate rather than inventing a pair", () => {
    // Already-broken input: cutting before it is still a faithful suffix.
    expect(keepLastCodePoints("ab\ud800c", 2)).toBe("\ud800c");
  });
});
