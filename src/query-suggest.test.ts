import { describe, expect, test } from "vitest";
import { buildTreeModel } from "./tree-model";
import {
  JMESPATH_FUNCTIONS,
  collectKeyUniverse,
  currentToken,
  suggest,
  suggestAt,
  toJmespath,
} from "./query-suggest";

describe("collectKeyUniverse", () => {
  test("collects distinct object keys, sorted, skipping indices and root", () => {
    const model = buildTreeModel({
      users: [
        { name: "Ada", role: "admin" },
        { name: "Grace", role: "user" },
      ],
      count: 2,
    });
    expect(collectKeyUniverse(model)).toEqual([
      "count",
      "name",
      "role",
      "users",
    ]);
  });

  test("skips array indices entirely (only string keys)", () => {
    const model = buildTreeModel([{ a: 1 }, { b: 2 }]);
    // The array elements have numeric keys (0, 1) which must not appear.
    expect(collectKeyUniverse(model)).toEqual(["a", "b"]);
  });

  test("does not include the root", () => {
    const model = buildTreeModel({ only: 1 });
    expect(collectKeyUniverse(model)).toEqual(["only"]);
  });

  test("dedupes keys repeated across nodes", () => {
    const model = buildTreeModel([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    expect(collectKeyUniverse(model)).toEqual(["id"]);
  });

  test("handles a primitive root with no keys", () => {
    const model = buildTreeModel(42);
    expect(collectKeyUniverse(model)).toEqual([]);
  });
});

describe("currentToken", () => {
  test("returns the trailing identifier token and its start", () => {
    expect(currentToken("users", 5)).toEqual({ token: "users", start: 0 });
  });

  test("returns the token under the caret when caret is mid-string", () => {
    expect(currentToken("users.na", 8)).toEqual({ token: "na", start: 6 });
  });

  test("empty token when char left of caret is a non-identifier", () => {
    expect(currentToken("users.", 6)).toEqual({ token: "", start: 6 });
  });

  test("empty token at start of string", () => {
    expect(currentToken("", 0)).toEqual({ token: "", start: 0 });
  });

  test("stops at brackets and operators", () => {
    expect(currentToken("items[?price > foo", 18)).toEqual({
      token: "foo",
      start: 15,
    });
  });

  test("includes underscores and digits", () => {
    expect(currentToken("a.b_2c", 6)).toEqual({ token: "b_2c", start: 2 });
  });
});

describe("suggest", () => {
  const keys = ["age", "name", "role"];
  const funcs = ["abs", "avg", "keys", "length"];

  test("case-insensitive prefix match", () => {
    expect(suggest("NA", keys, funcs)).toEqual(["name"]);
  });

  test("keys come before function names", () => {
    // "a" matches key "age" and funcs "abs"/"avg".
    expect(suggest("a", keys, funcs)).toEqual(["age", "abs", "avg"]);
  });

  test("empty token returns empty array", () => {
    expect(suggest("", keys, funcs)).toEqual([]);
  });

  test("caps results at the limit", () => {
    const manyKeys = Array.from({ length: 100 }, (_, i) => `k${i}`);
    expect(suggest("k", manyKeys, [], 10)).toHaveLength(10);
  });

  test("default cap is 50", () => {
    const manyKeys = Array.from({ length: 80 }, (_, i) => `k${i}`);
    expect(suggest("k", manyKeys, [])).toHaveLength(50);
  });

  test("dedupes a name that is both a key and a function", () => {
    expect(suggest("ke", ["keys"], ["keys"])).toEqual(["keys"]);
  });

  test("no match returns empty", () => {
    expect(suggest("zzz", keys, funcs)).toEqual([]);
  });
});

describe("JMESPATH_FUNCTIONS", () => {
  test("includes common builtins", () => {
    for (const fn of ["length", "keys", "sort_by", "map", "to_string"]) {
      expect(JMESPATH_FUNCTIONS).toContain(fn);
    }
  });
});

describe("suggestAt", () => {
  const doc = {
    users: [
      { name: "Ada", role: "admin", tags: ["x"] },
      { name: "Grace", role: "user" },
    ],
    settings: { theme: "dark", nested: { deep: 1 } },
    count: 2,
  };
  // A sentinel universe so a fall-back to the flat list is unmistakable.
  const UNIVERSE = ["U_one", "U_two"];
  const at = (text: string, caret = text.length) =>
    suggestAt(text, caret, doc, UNIVERSE, JMESPATH_FUNCTIONS);
  const names = (text: string, caret = text.length) =>
    at(text, caret).items.map((i) => i.name);

  test("a trailing dot dumps the contextual keys", () => {
    expect(names("settings.")).toEqual(["theme", "nested"]);
  });

  test("dot after an array projection lists the element keys (union)", () => {
    expect(names("users[*].")).toEqual(["name", "role", "tags"]);
  });

  test("dot after an array index lists that element's keys", () => {
    expect(names("users[0].")).toEqual(["name", "role", "tags"]);
  });

  test("dot then a prefix filters the contextual keys", () => {
    expect(names("users[*].na")).toEqual(["name"]);
  });

  test("nested member access resolves through objects", () => {
    expect(names("settings.nested.")).toEqual(["deep"]);
  });

  test("a scalar context offers nothing (no member keys)", () => {
    expect(names("count.")).toEqual([]);
  });

  test("top-level prefix matches root keys, tagging each value's kind", () => {
    expect(at("us").items).toEqual([{ name: "users", kind: "array" }]);
    expect(at("se").items).toEqual([{ name: "settings", kind: "object" }]);
    // 'co' also matches the contains() function — keys come first, then funcs.
    expect(at("co").items).toContainEqual({ name: "count", kind: "scalar" });
    expect(names("co")).toEqual(["count", "contains"]);
  });

  test("functions are offered at top level but not after a dot", () => {
    expect(names("len")).toContain("length");
    expect(names("users[*].len")).toEqual([]);
  });

  test("an open filter predicate lists the array's element keys", () => {
    expect(names("users[?")).toEqual(["name", "role", "tags"]);
    expect(names("users[?ro")).toEqual(["role"]);
  });

  test("an empty top-level token never dumps the universe", () => {
    expect(at("").items).toEqual([]);
  });

  test("a numeric bracket position offers nothing", () => {
    expect(names("users[0")).toEqual([]);
  });

  test("reports the token start so the caller can splice the accepted token", () => {
    expect(at("users[*].na").start).toBe(9);
  });

  test("unresolvable expression falls back to the flat universe", () => {
    // settings is an object, so a filter projection can't resolve → fallback.
    expect(names("settings[?x].")).toEqual(["U_one", "U_two"]);
  });

  test("the array-key badge is reliable, never guessed", () => {
    // 'tags' is an array on element objects; 'name' is a string.
    const items = at("users[*].").items;
    expect(items).toContainEqual({ name: "tags", kind: "array" });
    expect(items).toContainEqual({ name: "name", kind: "scalar" });
  });
});

describe("toJmespath", () => {
  test("strips the data root from a dotted path", () => {
    expect(toJmespath("data.users[3].name")).toBe("users[3].name");
  });

  test("bare data becomes @", () => {
    expect(toJmespath("data")).toBe("@");
  });

  test("data with a leading index keeps the index", () => {
    expect(toJmespath("data[0]")).toBe("[0]");
  });

  test("simple dotted path", () => {
    expect(toJmespath("data.a.b")).toBe("a.b");
  });

  test("quoted weird key becomes a JMESPath quoted identifier", () => {
    expect(toJmespath('data["a b"].c')).toBe('"a b".c');
  });

  test("leading bracketed string key becomes a leading quoted identifier", () => {
    expect(toJmespath('data["a b"].c.d')).toBe('"a b".c.d');
  });

  test("mixes indices and quoted keys", () => {
    expect(toJmespath('data.items[2]["weird key"].id')).toBe(
      'items[2]."weird key".id'
    );
  });
});
