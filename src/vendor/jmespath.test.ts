import { describe, expect, test } from "vitest";

import { search, strictDeepEqual } from "./jmespath.cjs";

// Nests `depth` objects, innermost first: nest(2) is {n:{n:0}}. Built
// iteratively so the fixture itself cannot overflow the stack.
function nest(depth: number): unknown {
  let node: unknown = 0;
  for (let i = 0; i < depth; i++) {
    node = { n: node };
  }
  return node;
}

// The same, one array per level: nestArray(2) is [[0]].
function nestArray(depth: number): unknown {
  let node: unknown = 0;
  for (let i = 0; i < depth; i++) {
    node = [node];
  }
  return node;
}

// Two structurally equal operands under `items[0]`, so `items[?a == b]` walks
// both to `depth` before it can decide.
function twinDoc(depth: number): unknown {
  return { items: [{ a: nest(depth), b: nest(depth) }] };
}

describe("field resolution reads own properties only (issue #104)", () => {
  const doc = { a: 1 };

  test("a top-level inherited name resolves to null, not a built-in", () => {
    expect(search(doc, "constructor")).toBeNull();
    expect(search(doc, "__proto__")).toBeNull();
    expect(search(doc, "toString")).toBeNull();
    expect(search(doc, "hasOwnProperty")).toBeNull();
    expect(search(doc, "valueOf")).toBeNull();
  });

  test("an inherited name resolves to null below the top level too", () => {
    expect(search({ a: {} }, "a.constructor")).toBeNull();
    expect(search({ a: { b: {} } }, "a.b.__proto__")).toBeNull();
  });

  test("an inherited name resolves to null inside a projection", () => {
    expect(search({ items: [{}, {}] }, "items[*].constructor")).toEqual([]);
  });

  test("an inherited name resolves to null inside a filter", () => {
    const oneItem = { items: [{ a: 1 }] };
    expect(search(oneItem, "items[?constructor]")).toEqual([]);
  });

  test("a real own key with an inherited name still returns its value", () => {
    expect(search({ constructor: "mine" }, "constructor")).toBe("mine");
    // A computed key: `{ __proto__: … }` in a literal sets the prototype
    // instead of creating the own property this asserts on.
    expect(search({ ["__proto__"]: "mine" }, "__proto__")).toBe("mine");
    expect(search({ toString: 7 }, "toString")).toBe(7);
    expect(search({ a: { constructor: [1] } }, "a.constructor")).toEqual([1]);
  });
});

describe("deep equality is depth bounded (issue #101)", () => {
  test("`==` over operands nested past the bound returns a result", () => {
    expect(search(twinDoc(50000), "items[?a == b]")).toEqual([]);
  });

  test("`!=` past the bound is the complement of `==`", () => {
    const result = search(twinDoc(50000), "items[?a != b]");
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
  });

  test("shallow equal operands still match", () => {
    const doc = { items: [{ a: { x: 1 }, b: { x: 1 } }] };
    expect(search(doc, "items[?a == b]")).toEqual([{ a: { x: 1 }, b: { x: 1 } }]);
    expect(search(doc, "items[?a != b]")).toEqual([]);
  });

  test("equal operands nested within the bound still match", () => {
    const doc = twinDoc(100);
    expect(search(doc, "items[?a == b]")).toHaveLength(1);
    expect(search(doc, "items[?a != b]")).toEqual([]);
  });

  test("unequal shallow operands still compare unequal", () => {
    const doc = { items: [{ a: { x: 1 }, b: { x: 2 } }] };
    expect(search(doc, "items[?a == b]")).toEqual([]);
    expect(search(doc, "items[?a != b]")).toHaveLength(1);
  });

  test("strictDeepEqual reports not-equal past the bound instead of throwing", () => {
    expect(strictDeepEqual(nest(50000), nest(50000))).toBe(false);
    expect(strictDeepEqual(nest(100), nest(100))).toBe(true);
  });

  // Pins where the bound actually falls, which the depths above are far too
  // coarse to catch. MAX_COMPARISON_DEPTH is a `var` inside the vendored
  // file's wrapper and is not on its exports, so these are literals: 199 is
  // MAX_COMPARISON_DEPTH - 1 and 200 is MAX_COMPARISON_DEPTH. nest(k)'s
  // innermost scalar is compared at depth k, so 199 lands one level inside
  // the bound and 200 lands on it. Both lines move together if that constant
  // changes; the second alone fails if the `>=` check weakens back to `>`.
  test("the bound falls between nesting depths 199 and 200", () => {
    expect(strictDeepEqual(nest(199), nest(199))).toBe(true);
    expect(strictDeepEqual(nest(200), nest(200))).toBe(false);
  });

  test("the bound also holds for arrays, not just objects", () => {
    expect(strictDeepEqual(nestArray(50000), nestArray(50000))).toBe(false);
    expect(strictDeepEqual(nestArray(100), nestArray(100))).toBe(true);
  });
});
