import { describe, expect, test } from "vitest";

import { buildTreeModel } from "./tree-model";
import { resolvePathToNodeId } from "./jump-to-path";

describe("resolvePathToNodeId", () => {
  const model = buildTreeModel({
    users: [
      { name: "Ada", "weird key": 1 },
      { name: "Grace" },
    ],
    "first-class": true,
  });
  const { pathToId } = model;

  function pathOf(nodeId: number | null): string | null {
    return nodeId === null ? null : model.nodes[nodeId].path;
  }

  test("resolves a fully-qualified path with leading data", () => {
    const id = resolvePathToNodeId("data.users[1].name", pathToId);
    expect(pathOf(id)).toBe("data.users[1].name");
  });

  test("prepends data when the leading root is omitted", () => {
    const id = resolvePathToNodeId("users[1].name", pathToId);
    expect(pathOf(id)).toBe("data.users[1].name");
  });

  test("resolves quoted (non-identifier) keys", () => {
    const id = resolvePathToNodeId('users[0]["weird key"]', pathToId);
    expect(pathOf(id)).toBe('data.users[0]["weird key"]');

    const dashed = resolvePathToNodeId('["first-class"]', pathToId);
    expect(pathOf(dashed)).toBe('data["first-class"]');
  });

  test("resolves array indices", () => {
    const id = resolvePathToNodeId("users[0]", pathToId);
    expect(pathOf(id)).toBe("data.users[0]");
  });

  test("resolves the bare root", () => {
    expect(resolvePathToNodeId("data", pathToId)).toBe(model.rootId);
    expect(resolvePathToNodeId("", pathToId)).toBe(model.rootId);
  });

  test("trims surrounding whitespace", () => {
    const id = resolvePathToNodeId("  users[1].name  ", pathToId);
    expect(pathOf(id)).toBe("data.users[1].name");
  });

  test("returns null when the path is not in the model", () => {
    expect(resolvePathToNodeId("users[9].name", pathToId)).toBeNull();
    expect(resolvePathToNodeId("nope", pathToId)).toBeNull();
  });
});
