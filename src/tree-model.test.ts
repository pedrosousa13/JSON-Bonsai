import { describe, expect, test } from "vitest";

import { buildTreeModel, type JsonValue } from "./tree-model";

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

  test("flags nodes that contain nested containers", () => {
    const model = buildTreeModel({ outer: { inner: 1 }, scalar: 2 });
    const root = model.nodes[model.rootId];
    const outer = model.nodes[root.childIds[0]];
    const scalar = model.nodes[root.childIds[1]];

    expect(root.hasNestedContainers).toBe(true);
    expect(outer.hasNestedContainers).toBe(false);
    expect(scalar.hasNestedContainers).toBe(false);
  });
});
