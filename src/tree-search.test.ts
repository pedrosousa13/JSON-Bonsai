import { describe, expect, test } from "vitest";

import {
  SEARCH_VALUE_PREVIEW_LIMIT,
  buildTreeModel,
  findNodeByPath,
  type JsonValue,
} from "./tree-model";
import {
  compileSearchRegex,
  createLocalTreeSearchIndex,
  createTreeSearchNodes,
} from "./tree-search";

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
      findNodeByPath(model, "data.items[0].tag")!.id,
    ]);
  });
});

describe("chunked scanning", () => {
  // Larger than one scan batch, so the index has to span several tasks.
  // 10001 nodes at 500 per batch is 21 batches, so a full scan needs 20 tasks.
  const largeModel = buildTreeModel(
    Array.from({ length: 5000 }, (_, item) => ({ tag: `item-${item}` }))
  );

  // Yields one event-loop task, the same way the scan does between batches.
  function eventLoopTurn(): Promise<void> {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }

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
      findNodeByPath(largeModel, "data[1023].tag")!.id,
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

  test("dispose stops an in-flight scan before its remaining batches run", async () => {
    const largeIndex = createLocalTreeSearchIndex(largeModel);

    let settled = false;
    const pending = largeIndex.search("item-1023").then((matches) => {
      settled = true;
      return matches;
    });
    largeIndex.dispose();

    // A scan that ran to completion would need 20 tasks; settling within a
    // handful proves the batches after the disposal never ran.
    for (let turn = 0; turn < 4; turn += 1) await eventLoopTurn();
    expect(settled).toBe(true);

    await expect(pending).resolves.toEqual([]);
  });

  test("an aborted signal stops an in-flight scan before its remaining batches run", async () => {
    const largeIndex = createLocalTreeSearchIndex(largeModel);
    const superseded = new AbortController();

    let settled = false;
    const pending = largeIndex
      .search("item-1023", { signal: superseded.signal })
      .then((matches) => {
        settled = true;
        return matches;
      });

    // Let the scan get a couple of batches in, so the abort lands mid-scan
    // rather than before the first batch.
    for (let turn = 0; turn < 2; turn += 1) await eventLoopTurn();
    expect(settled).toBe(false);

    superseded.abort();

    // A scan that ran to completion would need 20 tasks; settling within a
    // handful proves the batches after the abort never ran.
    for (let turn = 0; turn < 4; turn += 1) await eventLoopTurn();
    expect(settled).toBe(true);

    await expect(pending).resolves.toEqual([]);
  });

  test("an aborted scan leaves the index able to serve the next search", async () => {
    const largeIndex = createLocalTreeSearchIndex(largeModel);
    const superseded = new AbortController();

    const abandoned = largeIndex.search("item-1023", { signal: superseded.signal });
    superseded.abort();
    await expect(abandoned).resolves.toEqual([]);

    // A fresh controller, not a bare call: the abort must stop that one scan
    // and leave the index answering a later signalled search normally.
    const current = new AbortController();
    await expect(largeIndex.search("item-1023", { signal: current.signal })).resolves.toEqual([
      findNodeByPath(largeModel, "data[1023].tag")!.id,
    ]);
  });
});

describe("deeply nested paths", () => {
  // 2000 levels, so every path past ~level 98 is longer than the search cap.
  // The index must carry the capped text buildTreeModel produced: before #99
  // it carried whole paths, and the payload grew with the square of the depth.
  let nested: JsonValue = "leaf";
  for (let i = 1999; i >= 0; i--) {
    nested = { [`k${i}`]: nested };
  }
  const deepModel = buildTreeModel(nested);
  const deepIndex = createLocalTreeSearchIndex(deepModel);
  const leaf = deepModel.nodes[deepModel.nodes.length - 1];

  test("caps the path text handed to the worker", () => {
    for (const node of createTreeSearchNodes(deepModel)) {
      expect(node.searchPath.length).toBeLessThanOrEqual(
        SEARCH_VALUE_PREVIEW_LIMIT
      );
    }
  });

  test("finds a deep node by its own key", async () => {
    await expect(deepIndex.search("k1999")).resolves.toContain(leaf.id);
  });

  test("finds a deep node by the last segments of its path", async () => {
    await expect(deepIndex.search("k1997.k1998.k1999")).resolves.toContain(
      leaf.id
    );
  });
});
