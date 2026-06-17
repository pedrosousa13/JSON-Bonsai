import { describe, expect, test } from "vitest";

import { buildTreeModel } from "./tree-model";
import {
  compileSearchRegex,
  createTreeSearchNodes,
  searchTreeSearchNodes,
} from "./tree-search";

const model = buildTreeModel({
  user: { name: "Alice", city: "Berlin" },
  items: [{ tag: "alpha" }, { tag: "beta" }],
});
const nodes = createTreeSearchNodes(model);

function pathsFor(ids: number[]): string[] {
  return ids
    .map((id) => model.nodes[id].path)
    .sort();
}

describe("regex search", () => {
  test("matches against value via regex", () => {
    const ids = searchTreeSearchNodes(nodes, "al.ce", { regex: true });
    expect(pathsFor(ids)).toContain("data.user.name");
  });

  test("matches against key via regex", () => {
    const ids = searchTreeSearchNodes(nodes, "^name$", { regex: true });
    expect(pathsFor(ids)).toContain("data.user.name");
  });

  test("matches against path via regex", () => {
    const ids = searchTreeSearchNodes(nodes, "items\\[0\\]", { regex: true });
    expect(pathsFor(ids)).toContain("data.items[0]");
  });

  test("is case-insensitive", () => {
    const ids = searchTreeSearchNodes(nodes, "BERLIN", { regex: true });
    expect(pathsFor(ids)).toContain("data.user.city");
  });

  test("supports alternation across multiple nodes", () => {
    const ids = searchTreeSearchNodes(nodes, "alpha|beta", { regex: true });
    expect(pathsFor(ids)).toEqual(["data.items[0].tag", "data.items[1].tag"]);
  });

  test("invalid regex does not throw and yields no matches", () => {
    expect(() => searchTreeSearchNodes(nodes, "(", { regex: true })).not.toThrow();
    expect(searchTreeSearchNodes(nodes, "(", { regex: true })).toEqual([]);
  });

  test("compileSearchRegex returns null for an invalid pattern", () => {
    expect(compileSearchRegex("(")).toBeNull();
    expect(compileSearchRegex("[a-z]+")).toBeInstanceOf(RegExp);
  });
});

describe("substring search (regex off)", () => {
  test("still matches substrings when regex is off", () => {
    const ids = searchTreeSearchNodes(nodes, "ali");
    expect(pathsFor(ids)).toContain("data.user.name");
  });

  test("treats regex metacharacters literally when regex is off", () => {
    // "al.ce" should NOT match "alice" as a literal substring.
    expect(searchTreeSearchNodes(nodes, "al.ce")).toEqual([]);
  });
});
