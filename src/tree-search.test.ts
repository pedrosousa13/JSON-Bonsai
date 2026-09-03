import { describe, expect, test, vi } from "vitest";

import { buildTreeModel } from "./tree-model";
import {
  SearchLimitError,
  compileSearchRegex,
  createLocalTreeSearchIndex,
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
      model.pathToId.get("data.items[0].tag"),
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
});

describe("bounded search time", () => {
  // The value from the bug report: a 28-character run a nested quantifier can
  // partition 2^27 ways, then a character that makes the match fail. Tested
  // unguarded on V8 this costs ~16 s per call.
  const catastrophicModel = buildTreeModel({
    long: `${"a".repeat(28)}b${"c".repeat(271)}`,
    plain: "findable",
  });

  // Values that make each pattern in this block catastrophic on V8. Measured
  // unguarded, one call per fresh node process: `(a+)+\W$` over `run30` costs
  // ~65 s, `(a+)+[^b]$` over `runThenB` ~18 s, `(?=.*x)(a+)+$` over `runThenX`
  // ~16 s. `run30` is 30 characters, well inside the 200-character preview the
  // index stores, so no long-value cap can bound any of them.
  const trapModel = buildTreeModel({
    run30: "a".repeat(30),
    runThenB: `${"a".repeat(28)}b${"c".repeat(271)}`,
    runThenX: `${"a".repeat(28)}x`,
    plain: "findable",
  });

  test("a catastrophically backtracking pattern rejects instead of freezing", async () => {
    const searchIndex = createLocalTreeSearchIndex(catastrophicModel);
    const started = Date.now();

    await expect(searchIndex.search("(a+)+$", { regex: true })).rejects.toMatchObject({
      reason: "pattern-too-slow",
    });

    expect(Date.now() - started).toBeLessThan(2000);
  });

  // Every one of these has a tail that can consume a trailing sentinel
  // character, so a probe that only appends one measures a successful match in
  // microseconds and learns nothing. The refusal has to come from probes the
  // pattern cannot match.
  test.each(["(a+)+\\W$", "(a+)+[^b]$", "(?=.*x)(a+)+$"])(
    "the guard refuses %s, whose tail can swallow a sentinel",
    async (pattern) => {
      const searchIndex = createLocalTreeSearchIndex(trapModel);
      const started = Date.now();

      await expect(searchIndex.search(pattern, { regex: true })).rejects.toMatchObject({
        reason: "pattern-too-slow",
      });

      expect(Date.now() - started).toBeLessThan(2000);
    }
  );

  // The guard is itself code that runs on the main thread, so its own decision
  // has to be bounded. A single probe test's cost scales with the pattern's
  // branching factor, so the probe grows its input one character at a time and
  // stops the moment a measurement stops being cheap. Deciding about these two
  // with the budget read after each test instead cost 3.5 s and 143 ms.
  test.each([
    [
      "a heavily branching alternation",
      `(${Array.from({ length: 160 }, () => "a").join("|")})+$`,
    ],
    ["deeply nested quantifiers", "((((a+)+)+)+)+$"],
  ])("the guard decides about %s inside its own time ceiling", async (_label, pattern) => {
    const searchIndex = createLocalTreeSearchIndex(model);
    const started = performance.now();

    await expect(searchIndex.search(pattern, { regex: true })).rejects.toMatchObject({
      reason: "pattern-too-slow",
    });

    // The pattern never reaches the document, so this measures the decision.
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("a plain search returns correct matches after a timeout", async () => {
    const searchIndex = createLocalTreeSearchIndex(catastrophicModel);

    await expect(searchIndex.search("(a+)+$", { regex: true })).rejects.toThrow();

    await expect(searchIndex.search("findable")).resolves.toEqual([
      catastrophicModel.pathToId.get("data.plain"),
    ]);
  });

  test("an ordinary pattern is not mistaken for a catastrophic one", async () => {
    const searchIndex = createLocalTreeSearchIndex(catastrophicModel);

    await expect(searchIndex.search("^finda.le$", { regex: true })).resolves.toEqual([
      catastrophicModel.pathToId.get("data.plain"),
    ]);
  });

  // The pattern guard refuses a search outright, so a false positive is a
  // feature that stops working. These are the shapes people actually type.
  test.each([
    "al(pha|pine)",
    "^name$",
    "items\\[0\\]",
    "alpha|beta",
    "[a-z]+@[a-z]+\\.[a-z]{2,}",
    "^\\d{4}-\\d{2}-\\d{2}$",
    ".*",
    "a{1,10}b",
    "(foo|bar)+baz",
    "(?:[a-z]+-)+[a-z]+",
    "(hello )+world",
    "(\\d{1,3}\\.){3}\\d{1,3}",
    "^(.*,)*.*$",
    // Nested quantifiers without a failing tail: this matches any value with an
    // "a" in it at the first offset it reaches, so it never backtracks. The
    // guard measures cost, so it must not refuse this on shape alone.
    "(a+)+",
  ])("the pattern guard lets %s through", async (pattern) => {
    const searchIndex = createLocalTreeSearchIndex(model);
    await expect(searchIndex.search(pattern, { regex: true })).resolves.toBeInstanceOf(
      Array
    );
  });

  // The price of the guard: a pattern whose worst case is catastrophic is
  // refused even on a document that would never have triggered it. This one
  // matches "findable" in well under a millisecond, and is still refused.
  test("a pattern with a catastrophic worst case is refused even when this document is small", async () => {
    const searchIndex = createLocalTreeSearchIndex(catastrophicModel);

    await expect(
      searchIndex.search("^(\\w+\\s?)+findable$", { regex: true })
    ).rejects.toMatchObject({ reason: "pattern-too-slow" });
  });

  test("a scan that outlives the wall-clock budget rejects", async () => {
    const searchIndex = createLocalTreeSearchIndex(model);
    // Every reading of the clock jumps 5 s, so the budget is spent by the
    // second node whatever the budget constant happens to be.
    let clock = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      const reading = clock;
      clock += 5000;
      return reading;
    });

    try {
      await expect(searchIndex.search("alice")).rejects.toMatchObject({
        reason: "timeout",
      });
      await expect(searchIndex.search("alice")).rejects.toBeInstanceOf(SearchLimitError);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("regex search reads only the head of a very long value", async () => {
    const longModel = buildTreeModel({ blob: `${"x".repeat(5000)}needle` });
    const searchIndex = createLocalTreeSearchIndex(longModel);

    // Past the regex read limit, so regex mode cannot see it...
    await expect(searchIndex.search("needle", { regex: true })).resolves.toEqual([]);
    // ...while substring matching stays linear and still reads the whole value.
    await expect(searchIndex.search("needle")).resolves.toEqual([
      longModel.pathToId.get("data.blob"),
    ]);
  });

  // A key and a path are stored whole, so without a cap of their own they hand
  // a polynomial pattern an input as long as the document is deep.
  test("regex search reads only the head of a very long key and path", async () => {
    const longKey = `${"k".repeat(5000)}needle`;
    const longModel = buildTreeModel({ [longKey]: "value" });
    const searchIndex = createLocalTreeSearchIndex(longModel);
    const nodeId = longModel.pathToId.get(`data.${longKey}`);

    // Past the regex read limit, so regex mode cannot see it in the key or in
    // the path that contains the key...
    await expect(searchIndex.search("needle", { regex: true })).resolves.toEqual([]);
    // ...while substring matching stays linear and still reads both whole.
    await expect(searchIndex.search("needle")).resolves.toEqual([nodeId]);
  });
});
