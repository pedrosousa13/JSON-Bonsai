import { describe, expect, test } from "vitest";

import { buildTreeModel } from "./tree-model";
import { compileSearchRegex, createLocalTreeSearchIndex } from "./tree-search";

const model = buildTreeModel({
  user: { name: "Alice", city: "Berlin" },
  items: [{ tag: "alpha" }, { tag: "beta" }],
});
const index = createLocalTreeSearchIndex(model);

function pathsFor(ids: number[]): string[] {
  return ids
    .map((id) => model.nodes[id].path)
    .sort();
}

describe("regex search", () => {
  test("matches against value via regex", async () => {
    const ids = await index.search("al.ce", { regex: true });
    expect(pathsFor(ids)).toContain("data.user.name");
  });

  test("matches against key via regex", async () => {
    const ids = await index.search("^name$", { regex: true });
    expect(pathsFor(ids)).toContain("data.user.name");
  });

  test("matches against path via regex", async () => {
    const ids = await index.search("items\\[0\\]", { regex: true });
    expect(pathsFor(ids)).toContain("data.items[0]");
  });

  test("is case-insensitive", async () => {
    const ids = await index.search("BERLIN", { regex: true });
    expect(pathsFor(ids)).toContain("data.user.city");
  });

  test("supports alternation across multiple nodes", async () => {
    const ids = await index.search("alpha|beta", { regex: true });
    expect(pathsFor(ids)).toEqual(["data.items[0].tag", "data.items[1].tag"]);
  });

  test("invalid regex does not throw and yields no matches", async () => {
    await expect(index.search("(", { regex: true })).resolves.toEqual([]);
  });

  test("compileSearchRegex returns null for an invalid pattern", () => {
    expect(compileSearchRegex("(")).toBeNull();
    expect(compileSearchRegex("[a-z]+")).toBeInstanceOf(RegExp);
  });
});

describe("substring search (regex off)", () => {
  test("still matches substrings when regex is off", async () => {
    const ids = await index.search("ali");
    expect(pathsFor(ids)).toContain("data.user.name");
  });

  test("treats regex metacharacters literally when regex is off", async () => {
    // "al.ce" should NOT match "alice" as a literal substring.
    await expect(index.search("al.ce")).resolves.toEqual([]);
  });

  test("ranks an exact value match ahead of a path match", async () => {
    await expect(index.search("alpha")).resolves.toEqual([
      model.pathToId.get("data.items[0].tag"),
    ]);
  });
});

describe("chunked scanning", () => {
  // Larger than one scan batch, so the index has to span several tasks.
  const largeModel = buildTreeModel(
    Array.from({ length: 5000 }, (_, item) => ({ tag: `item-${item}` }))
  );

  test("scans a multi-batch model across event-loop tasks", async () => {
    const largeIndex = createLocalTreeSearchIndex(largeModel);

    let settled = false;
    const pending = largeIndex.search("item-1023").then((matches) => {
      settled = true;
      return matches;
    });

    // Drain the microtask queue: an unchunked scan resolves here, a chunked
    // one is still waiting on an event-loop task.
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    expect(settled).toBe(false);

    await expect(pending).resolves.toEqual([
      largeModel.pathToId.get("data[1023].tag"),
    ]);
  });

  test("an empty query settles without scanning a single batch", async () => {
    const largeIndex = createLocalTreeSearchIndex(largeModel);

    let settled = false;
    void largeIndex.search("   ").then(() => {
      settled = true;
    });

    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    expect(settled).toBe(true);
  });
});
