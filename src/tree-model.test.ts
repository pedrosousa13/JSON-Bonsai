import { describe, expect, test } from "vitest";

import { buildTreeModel, findNodeByPath, type JsonValue } from "./tree-model";
import { projectLastIndex } from "./query-suggest";
import type { ExactNumberMap } from "./lossless-numbers";

describe("buildTreeModel", () => {
  test("does not overflow the stack on deeply nested JSON", () => {
    // 10k levels of nesting — well past the V8 call-stack ceiling a recursive
    // walk hit (RangeError). Kept at 10k because node paths grow per level, so
    // deeper trees cost O(n^2) memory regardless of the traversal style.
    let nested: JsonValue = "leaf";
    for (let i = 0; i < 10_000; i++) {
      nested = { a: nested };
    }

    const model = buildTreeModel(nested);

    expect(model.totalNodes).toBe(10_001);
    expect(model.maxDepth).toBe(10_000);
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

  test("truncates a long search value without splitting a surrogate pair", () => {
    // 199 plain characters then an emoji, so the 200-unit cut falls between
    // the emoji's two halves. Indexing a lone surrogate matches nothing.
    const value = `${"a".repeat(199)}😀${"b".repeat(20)}`;

    const model = buildTreeModel({ s: value });
    const node = findNodeByPath(model, "data.s")!;

    expect(node.hasLongSearchValue).toBe(true);
    expect(node.searchValue).toBe("a".repeat(199));
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
