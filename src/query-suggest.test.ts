import { describe, expect, test } from "vitest";
import { runQuery } from "./query";
import { buildTreeModel, type JsonValue } from "./tree-model";
import {
  JMESPATH_FUNCTIONS,
  collectKeyUniverse,
  composeNodeQuery,
  currentToken,
  projectLastIndex,
  splitPipes,
  suggest,
  suggestAt,
  suggestAtScoped,
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

// Valid JMESPath the context resolver used to walk away from: negative
// indices, slices and dot-quoted member access. Each must resolve to the right
// node; anything still unresolvable keeps falling back to the flat universe.
describe("suggestAt on negative indices, slices and quoted members (item 11)", () => {
  const doc = {
    users: [
      { name: "Ada", role: "admin" },
      { name: "Grace", role: "user" },
      { last: true },
    ],
    "my key": { inner: 1 },
    settings: { "my key": { deep: 1 }, 'he"llo]': { odd: 1 } },
    count: 2,
  };
  const UNIVERSE = ["U_one", "U_two"];
  const names = (text: string, caret = text.length) =>
    suggestAt(text, caret, doc, UNIVERSE, JMESPATH_FUNCTIONS).items.map(
      (i) => i.name
    );

  test("a negative index resolves from the end of the array", () => {
    expect(names("users[-1].")).toEqual(["last"]);
    expect(names("users[-3].")).toEqual(["name", "role"]);
  });

  test("an out-of-range negative index offers nothing", () => {
    expect(names("users[-9].")).toEqual([]);
  });

  test("a slice lists the keys of the sliced elements only", () => {
    expect(names("users[0:2].")).toEqual(["name", "role"]);
    expect(names("users[1:].")).toEqual(["name", "role", "last"]);
    expect(names("users[:1].")).toEqual(["name", "role"]);
    expect(names("users[::2].")).toEqual(["name", "role", "last"]);
    expect(names("users[::-1].")).toEqual(["last", "name", "role"]);
  });

  test("a slice then a prefix filters the sliced element keys", () => {
    expect(names("users[0:2].ro")).toEqual(["role"]);
  });

  test("a slice of a non-array stays unresolvable (flat universe)", () => {
    expect(names("settings[0:2].")).toEqual(["U_one", "U_two"]);
  });

  test("dot-quoted member access resolves to that key's value", () => {
    expect(names('settings."my key".')).toEqual(["deep"]);
    expect(names('settings."my key".de')).toEqual(["deep"]);
  });

  test("a leading quoted key resolves against the document root", () => {
    expect(names('"my key".')).toEqual(["inner"]);
  });

  test("a quoted key carrying an escaped quote and a bracket resolves", () => {
    expect(names('settings."he\\"llo]".')).toEqual(["odd"]);
    // Bracket form of the same key: the `]` inside it must not end the segment.
    expect(names('settings["he\\"llo]"].')).toEqual(["odd"]);
  });

  test("a quoted member of a scalar offers nothing", () => {
    expect(names('count."my key".')).toEqual([]);
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

  test("a ] inside a quoted key does not end the bracket segment", () => {
    expect(toJmespath('data["arr]x"].id')).toBe('"arr]x".id');
  });

  test("an escaped quote inside a quoted key does not end the bracket segment", () => {
    expect(toJmespath('data["say \\"]\\""].id')).toBe('"say \\"]\\"".id');
  });
});

// "Query from here" must survive keys that need JSON escaping: the model's path
// builder escapes them, toJmespath keeps them intact, and jmespath resolves the
// clicked node. End to end against the real jmespath dependency.
describe("query from here on keys that need escaping", () => {
  const AWKWARD_KEYS = ["a\\b", 'say "hi"', "arr]x", ""];

  for (const key of AWKWARD_KEYS) {
    test(`round-trips ${JSON.stringify(key)} through model, convert and query`, () => {
      const doc: JsonValue = { items: [{ [key]: { id: 7 } }] };
      const model = buildTreeModel(doc);
      const node = model.nodes.find((n) => n.key === key)!;

      expect(runQuery(doc, toJmespath(node.path))).toEqual({
        ok: true,
        result: { id: 7 },
      });

      // The child proves the scanner resumes after the quoted segment.
      const child = model.nodes[model.pathToId.get(`${node.path}.id`)!];
      expect(runQuery(doc, toJmespath(child.path))).toEqual({
        ok: true,
        result: 7,
      });
    });
  }

  test("round-trips an awkward top-level key holding an array", () => {
    const doc: JsonValue = { "arr]x": [10, 20] };
    const model = buildTreeModel(doc);
    const node = model.nodes.find((n) => n.key === "arr]x")!;

    expect(runQuery(doc, toJmespath(node.path))).toEqual({
      ok: true,
      result: [10, 20],
    });

    // The element proves the scanner resumes after the quoted segment.
    const element = model.nodes[model.pathToId.get(`${node.path}[1]`)!];
    expect(runQuery(doc, toJmespath(element.path))).toEqual({
      ok: true,
      result: 20,
    });
  });

  test("round-trips an awkward key nested inside another awkward key", () => {
    const doc: JsonValue = { 'say "hi"': { "a\\b": 5 } };
    const model = buildTreeModel(doc);
    const node = model.nodes.find((n) => n.key === "a\\b")!;

    expect(runQuery(doc, toJmespath(node.path))).toEqual({
      ok: true,
      result: 5,
    });
  });
});

describe("projectLastIndex", () => {
  test("projects the only array index over all elements", () => {
    expect(projectLastIndex("data[0].company")).toBe("data[*].company");
  });

  test("projects an index under a named key", () => {
    expect(projectLastIndex("data.users[3].company")).toBe(
      "data.users[*].company"
    );
  });

  test("projects the last (innermost) index, leaving earlier ones", () => {
    expect(projectLastIndex("data[0].tags[2]")).toBe("data[0].tags[*]");
  });

  test("returns null when the path has no array index", () => {
    expect(projectLastIndex("data.settings.theme")).toBeNull();
  });

  test("ignores quoted keys that contain digits", () => {
    expect(projectLastIndex('data["a1"][4].x')).toBe('data["a1"][*].x');
  });

  test("returns null when the only bracketed digits sit inside a quoted key", () => {
    expect(projectLastIndex('data["k[0]y"].x')).toBeNull();
  });

  test("projects the real index, not a later quoted key's bracketed digits", () => {
    expect(projectLastIndex('data[2]["k[0]y"]')).toBe('data[*]["k[0]y"]');
  });

  test("projects past a quoted key holding an escaped quote", () => {
    const doc: JsonValue = [{ 'say "hi"': 5 }];
    const model = buildTreeModel(doc);
    const node = model.nodes.find((n) => n.key === 'say "hi"')!;

    expect(projectLastIndex(node.path)).toBe('data[*]["say \\"hi\\""]');
  });

  test("a projected path with a bracket-bearing quoted key still runs", () => {
    const doc: JsonValue = [{ "k[0]y": 5 }, { "k[0]y": 6 }];
    const model = buildTreeModel(doc);
    const node = model.nodes.find((n) => n.key === "k[0]y")!;
    const projected = projectLastIndex(node.path)!;

    expect(projected).toBe('data[*]["k[0]y"]');
    expect(runQuery(doc, composeNodeQuery(null, projected))).toEqual({
      ok: true,
      result: [5, 6],
    });
  });

  test("a projected path with an escaped-quote key still runs", () => {
    const doc: JsonValue = [{ 'say "hi"': 5 }, { 'say "hi"': 6 }];
    const model = buildTreeModel(doc);
    const node = model.nodes.find((n) => n.key === 'say "hi"')!;
    const projected = projectLastIndex(node.path)!;

    expect(runQuery(doc, composeNodeQuery(null, projected))).toEqual({
      ok: true,
      result: [5, 6],
    });
  });
});

describe("composeNodeQuery", () => {
  test("with no active query, returns the path as a root query", () => {
    expect(composeNodeQuery(null, "data.story.content")).toBe("story.content");
  });

  test("with an active query, chains the node path onto it via a pipe", () => {
    // The node lives in the result tree, so its path is relative to the result.
    expect(composeNodeQuery("story.content", "data.featured_story")).toBe(
      "story.content | featured_story"
    );
  });

  test("the result root node chains as @ (the whole result)", () => {
    expect(composeNodeQuery("story.content", "data")).toBe("story.content | @");
  });

  test("composes a projected (query-all) path", () => {
    expect(composeNodeQuery("items[*]", "data[*].name")).toBe(
      "items[*] | [*].name"
    );
  });
});

describe("splitPipes", () => {
  test("no pipe yields a single whole-string segment", () => {
    expect(splitPipes("a.b.c")).toEqual([{ start: 0, end: 5 }]);
  });

  test("a single top-level pipe splits into two segments", () => {
    expect(splitPipes("a | b")).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });

  test("multiple pipes split into multiple segments", () => {
    expect(splitPipes("a | b | c")).toHaveLength(3);
  });

  test("|| (or-operator) is not a boundary", () => {
    expect(splitPipes("a || b")).toEqual([{ start: 0, end: 6 }]);
  });

  test("a pipe inside a string literal is not a boundary", () => {
    expect(splitPipes("a == 'x|y'")).toHaveLength(1);
  });

  test("a pipe inside brackets is not a boundary", () => {
    expect(splitPipes("items[?a | b]")).toHaveLength(1);
  });

  test("a pipe inside parens is not a boundary", () => {
    expect(splitPipes("f(a | b)")).toHaveLength(1);
  });

  test("a trailing pipe yields an empty final segment", () => {
    expect(splitPipes("a | ")).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 4 },
    ]);
  });
});

describe("suggestAtScoped", () => {
  const doc: JsonValue = {
    users: [
      { name: "Ada", role: "admin", tags: ["x"] },
      { name: "Grace", role: "user" },
    ],
    settings: { theme: "dark" },
    count: 2,
  };
  const UNIVERSE = ["U_one", "U_two"];
  const resolve = (expr: string) => {
    const outcome = runQuery(doc, expr);
    return outcome.ok ? outcome.result : null;
  };
  const scoped = (text: string, caret = text.length) =>
    suggestAtScoped(text, caret, doc, UNIVERSE, JMESPATH_FUNCTIONS, resolve);
  const names = (text: string, caret = text.length) =>
    scoped(text, caret).items.map((i) => i.name);

  test("no pipe resolves against the document root", () => {
    expect(names("us")).toEqual(["users"]);
  });

  test("right of a pipe resolves against the piped scope", () => {
    // `users[0]` is an object; the right segment sees its keys.
    expect(names("users[0] | na")).toEqual(["name"]);
  });

  test("a filter right of a pipe resolves against the piped array", () => {
    expect(names("users | [?ro")).toEqual(["role"]);
  });

  test("reports an absolute token start across the pipe", () => {
    // "users[0] | na" → the "na" token starts at index 11.
    expect(scoped("users[0] | na").start).toBe(11);
  });

  test("an unresolvable left side yields no suggestions", () => {
    // abs() on an object errors → resolve returns null.
    expect(names("abs(@) | na")).toEqual([]);
  });

  test("|| does not trigger scoping (stays a root-level expression)", () => {
    // If `||` were a pipe, the left `users` scope would offer no `us*` key.
    expect(names("users || us")).toEqual(["users"]);
  });
});
