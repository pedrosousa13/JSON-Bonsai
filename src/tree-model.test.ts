import { describe, expect, test } from "vitest";

import {
  SEARCH_VALUE_PREVIEW_LIMIT,
  buildTreeModel,
  findNodeByPath,
  type JsonValue,
} from "./tree-model";
import { projectLastIndex } from "./query-suggest";
import type { ExactNumberMap } from "./lossless-numbers";

describe("buildTreeModel", () => {
  test("does not overflow the stack on deeply nested JSON", () => {
    // 40k levels of nesting — well past the V8 call-stack ceiling a recursive
    // walk hit (RangeError). 40k is also the depth that used to exhaust a 2 GB
    // heap: paths grow one segment per level, and indexing every one of them
    // whole retained O(depth^2) characters (#99).
    let nested: JsonValue = "leaf";
    for (let i = 0; i < 40_000; i++) {
      nested = { a: nested };
    }

    const model = buildTreeModel(nested);

    expect(model.totalNodes).toBe(40_001);
    expect(model.maxDepth).toBe(40_000);
  });

  test("preserves pre-order layout and child ordering", () => {
    const model = buildTreeModel({
      first: { nested: 1 },
      second: [10, 20],
    });

    const root = model.nodes[model.rootId];
    expect(root.path).toBe("data");
    expect(root.childIds.map((id) => model.nodes[id].key)).toEqual([
      "first",
      "second",
    ]);

    const second = model.nodes[root.childIds[1]];
    expect(second.type).toBe("array");
    expect(second.childIds.map((id) => model.nodes[id].siblingIndex)).toEqual([
      0, 1,
    ]);
    // Pre-order: every child id is greater than its parent's id.
    for (const node of model.nodes) {
      for (const childId of node.childIds) {
        expect(childId).toBeGreaterThan(node.id);
      }
    }
  });

  test("attaches exact number source text and indexes it for search", () => {
    // Manual map (rather than parseWithExactNumbers) so the test runs on
    // engines without JSON.parse source access.
    const data = { id: 9007199254740992, plain: 1 };
    const exactNumbers: ExactNumberMap = new WeakMap([
      [data as object, new Map([["id", "9007199254740993"]])],
    ]);

    const model = buildTreeModel(data, exactNumbers);
    const idNode = findNodeByPath(model, "data.id")!;
    const plainNode = findNodeByPath(model, "data.plain")!;

    expect(idNode.numberText).toBe("9007199254740993");
    // Search must find the source digits, not the corrupted parsed value.
    expect(idNode.searchValue).toBe("9007199254740993");
    expect(plainNode.numberText).toBe(null);
    expect(plainNode.searchValue).toBe("1");
  });

  test("marks an unsafe integer that has no exact source text", () => {
    // What a projecting query hands the tree: a new holder, so the exact text
    // recorded against the parsed one never resolves (issue #87).
    const parsed = { id: 9007199254740993 };
    const exactNumbers: ExactNumberMap = new WeakMap([
      [parsed as object, new Map([["id", "9007199254740993"]])],
    ]);
    const projected = { id: parsed.id, small: 1, exact: parsed.id };
    exactNumbers.set(projected as object, new Map([["exact", "9007199254740993"]]));

    const model = buildTreeModel(projected, exactNumbers);

    expect(findNodeByPath(model, "data.id")!.numberIsRounded).toBe(true);
    // A safe integer, and a number whose source text did resolve, stay quiet.
    expect(findNodeByPath(model, "data.small")!.numberIsRounded).toBe(false);
    expect(findNodeByPath(model, "data.exact")!.numberIsRounded).toBe(false);
    expect(model.hasRoundedNumbers).toBe(true);
  });

  test("marks nothing when the document holds no rounded number", () => {
    const data = { id: 9007199254740993 };
    const exactNumbers: ExactNumberMap = new WeakMap([
      [data as object, new Map([["id", "9007199254740993"]])],
    ]);

    const model = buildTreeModel(data, exactNumbers);

    expect(findNodeByPath(model, "data.id")!.numberIsRounded).toBe(false);
    expect(model.hasRoundedNumbers).toBe(false);
  });

  test("marks an exactly-representable integer past 2^53 too", () => {
    // Documented false positive: 2^53 is exactly representable, so nothing was
    // lost and it never enters the map — but "no exact text" is all the rule
    // has to go on without re-keying exactness, which #87 declined. The marker
    // only ever claims the source text is unavailable, which is true here.
    const model = buildTreeModel({ id: 9007199254740992 }, new WeakMap());

    expect(findNodeByPath(model, "data.id")!.numberIsRounded).toBe(true);
  });

  test("marks nothing when the engine has no exact numbers at all", () => {
    // exactNumbers null (or absent) means the engine has no reviver source, so
    // exact and rounded are indistinguishable — mark nothing rather than mark
    // every unsafe integer.
    for (const exactNumbers of [null, undefined]) {
      const model = buildTreeModel({ id: 9007199254740993 }, exactNumbers);

      expect(findNodeByPath(model, "data.id")!.numberIsRounded).toBe(false);
      expect(model.hasRoundedNumbers).toBe(false);
    }
  });

  test("truncates a long search value without splitting a surrogate pair", () => {
    // 199 plain characters then an emoji, so the 200-unit cut falls between
    // the emoji's two halves. Indexing a lone surrogate matches nothing.
    const value = `${"a".repeat(199)}😀${"b".repeat(20)}`;

    const model = buildTreeModel({ s: value });
    const node = findNodeByPath(model, "data.s")!;

    expect(node.hasLongSearchValue).toBe(true);
    expect(node.searchValue).toBe("a".repeat(199));
  });

  test("indexes the whole lowercased path when it fits under the cap", () => {
    const model = buildTreeModel({ Users: [{ "Full Name": "x" }] });

    expect(model.nodes.map((node) => node.searchPath)).toEqual([
      "data",
      "data.users",
      "data.users[0]",
      'data.users[0]["full name"]',
    ]);
  });

  test("caps every node's search path on a deeply nested document", () => {
    // Deep enough that the full path of the leaf is ~50x the cap. Before #99
    // every node kept its whole lowercased path, so the model retained
    // O(depth^2) characters and the tab ran out of memory.
    let nested: JsonValue = "leaf";
    for (let i = 0; i < 5_000; i++) {
      nested = { a: nested };
    }

    const model = buildTreeModel(nested);
    const total = model.nodes.reduce(
      (sum, node) => sum + node.searchPath.length,
      0
    );

    for (const node of model.nodes) {
      expect(node.searchPath.length).toBeLessThanOrEqual(
        SEARCH_VALUE_PREVIEW_LIMIT
      );
    }
    expect(total).toBeLessThanOrEqual(
      model.totalNodes * SEARCH_VALUE_PREVIEW_LIMIT
    );
  });

  test("keeps the leaf-ward end of a capped search path", () => {
    // A path search is about the deep end: the node's own key, and the last
    // few segments above it. The root-ward end is what gets dropped.
    let nested: JsonValue = "leaf";
    for (let i = 299; i >= 0; i--) {
      nested = { [`k${i}`]: nested };
    }

    const model = buildTreeModel(nested);
    const leaf = model.nodes[model.nodes.length - 1];

    expect(leaf.key).toBe("k299");
    expect(leaf.searchPath.endsWith(".k297.k298.k299")).toBe(true);
    expect(leaf.searchPath.includes("data.k0.")).toBe(false);
    expect(leaf.searchPath.length).toBeLessThanOrEqual(
      SEARCH_VALUE_PREVIEW_LIMIT
    );
  });

  test("leaves `path` at full fidelity when the search path is capped", () => {
    let nested: JsonValue = "leaf";
    for (let i = 299; i >= 0; i--) {
      nested = { [`k${i}`]: nested };
    }
    const expected = `data${Array.from({ length: 300 }, (_, i) => `.k${i}`).join("")}`;

    const model = buildTreeModel(nested);
    const leaf = model.nodes[model.nodes.length - 1];

    expect(leaf.path).toBe(expected);
    expect(findNodeByPath(model, expected)).toBe(leaf);
  });

  test("JSON-escapes quoted path segments", () => {
    const model = buildTreeModel({ "a\\b": 1, 'say "hi"': 2, "arr]x": 3, "": 4 });

    expect(model.nodes.map((node) => node.path)).toEqual([
      "data",
      'data["a\\\\b"]',
      'data["say \\"hi\\""]',
      'data["arr]x"]',
      'data[""]',
    ]);
  });

  test("flags nodes that contain nested containers", () => {
    const model = buildTreeModel({ outer: { inner: 1 }, scalar: 2 });
    const root = model.nodes[model.rootId];
    const outer = model.nodes[root.childIds[0]];
    const scalar = model.nodes[root.childIds[1]];

    expect(root.hasNestedContainers).toBe(true);
    expect(outer.hasNestedContainers).toBe(false);
    expect(scalar.hasNestedContainers).toBe(false);
  });

  test("flags array elements and their descendants as inside an array", () => {
    const model = buildTreeModel({ "a[0]": 1, users: [{ tags: ["x"] }] });
    const inArrayByPath = new Map(
      model.nodes.map((node) => [node.path, node.inArray])
    );

    expect(inArrayByPath).toEqual(
      new Map([
        ["data", false],
        ['data["a[0]"]', false],
        ["data.users", false],
        ["data.users[0]", true],
        ["data.users[0].tags", true],
        ["data.users[0].tags[0]", true],
      ])
    );
  });

  // Pins the invariant `node.inArray === (projectLastIndex(node.path) !== null)`.
  //
  // The "ƒ all" affordance is split across two call sites that must agree, and
  // nothing but this test makes them:
  //   - src/viewer.ts hides the button on `!node.inArray` (whether to SHOW it),
  //   - src/content.ts's click handler recomputes projectLastIndex(dataset.path)
  //     and does nothing when it is null (what the button DOES).
  //
  // They agree only because buildPath emits a digit-only bracket segment on its
  // `isArrayElement` branch alone: every other key becomes `.identifier` or
  // `[JSON.stringify(key)]`, and the latter always opens with `"`. Change that
  // path format and the pairing breaks silently in both places at once — a
  // visible-but-dead button, or a hidden-but-projectable node. Fail here first.
  test("inArray agrees with projectLastIndex on every node", () => {
    const documents: JsonValue[] = [
      // Pure-digit key: not an index, however much its path looks like one.
      { "0": 1 },
      // Digits inside brackets inside the key itself.
      { "a[0]": 1 },
      // Key carrying both a quote and a bracket, so the escaped `]` must not
      // terminate the segment.
      { 'q"[3]': 1 },
      // Key carrying a backslash, which JSON-escapes to `\\`.
      { "a\\b": 1, "back\\slash[7]": 2 },
      // Array at the root.
      [1, 2, 3],
      // Arrays nested in objects nested in arrays.
      [{ tags: [["deep"], { more: [1] }] }, { tags: [] }],
      // Empty containers, at the root and inside an array.
      {},
      [],
      { empties: [[], {}], nested: { arr: [], obj: {} } },
      // Indices >= 10, so two-digit segments are exercised.
      { many: Array.from({ length: 12 }, (_, i) => ({ i })) },
      // A key that is literally the wildcard.
      { "[*]": 1 },
      [{ "[*]": 1 }],
      // Mixed bag: identifier keys, quoted keys and indices on one path.
      { "a b": [{ "0": [{ "[*]": { "k[0]y": 1 } }] }] },
    ];

    const divergences: string[] = [];
    for (const doc of documents) {
      for (const node of buildTreeModel(doc).nodes) {
        const projectable = projectLastIndex(node.path) !== null;
        if (node.inArray !== projectable) {
          divergences.push(
            `${node.path} — inArray=${node.inArray}, projectable=${projectable}`
          );
        }
      }
    }

    expect(divergences).toEqual([]);
  });
});
