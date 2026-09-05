import { expect, test } from "vitest";

import { SEARCH_PREVIEW_LIMIT, buildTreeModel, type JsonValue } from "./tree-model";
import { createTreeSearchNodes } from "./tree-search";
import type { TreeWorkerResponse } from "./tree-search-protocol";
import { createTreeWorkerMessageHandler } from "./tree-worker";

const model = buildTreeModel({
  user: { name: "Alice", city: "Berlin" },
  items: [{ tag: "alpha" }, { tag: "beta" }],
});

function pathsFor(ids: number[]): string[] {
  return ids.map((id) => model.nodes[id].path).sort();
}

function createWorkerHarness() {
  const responses: TreeWorkerResponse[] = [];
  const handle = createTreeWorkerMessageHandler((response) => responses.push(response));
  return { responses, handle };
}

test("answers a handshake so the frame knows the worker started", () => {
  const { responses, handle } = createWorkerHarness();

  handle({ type: "handshake" });

  expect(responses).toEqual([{ type: "handshake-ok" }]);
});

test("searches an initialised node set with the regex matcher", () => {
  const { responses, handle } = createWorkerHarness();

  handle({ type: "init", index: 0, nodes: createTreeSearchNodes(model) });
  handle({ type: "search", id: 7, index: 0, query: "alpha|beta" });

  expect(responses).toHaveLength(1);
  const [response] = responses;
  expect(response.type).toBe("result");
  if (response.type !== "result") throw new Error("expected a result");
  expect(response.id).toBe(7);
  expect(pathsFor(response.matches)).toEqual(["data.items[0].tag", "data.items[1].tag"]);
});

test("searches a deeply nested document from capped path text", () => {
  // 2000 levels, so every path past ~level 98 is longer than the search cap.
  // The worker holds the array `init` hands it, so asserting on that array is
  // asserting on the worker's own copy: before #99 it was whole paths, and the
  // payload grew with the square of the depth. A deep node's own key is the
  // part the cap keeps, so it stays findable through the worker.
  let nested: JsonValue = "leaf";
  for (let i = 1999; i >= 0; i--) {
    nested = { [`k${i}`]: nested };
  }
  const deepModel = buildTreeModel(nested);
  const deepNodes = createTreeSearchNodes(deepModel);
  const leaf = deepModel.nodes[deepModel.nodes.length - 1];
  const { responses, handle } = createWorkerHarness();

  handle({ type: "init", index: 3, nodes: deepNodes });

  for (const node of deepNodes) {
    expect(node.searchPath.length).toBeLessThanOrEqual(SEARCH_PREVIEW_LIMIT);
  }

  handle({ type: "search", id: 4, index: 3, query: "k1999" });

  expect(responses).toEqual([{ type: "result", id: 4, matches: [leaf.id] }]);
});

test("a search for an index that was never initialised has no matches", () => {
  const { responses, handle } = createWorkerHarness();

  handle({ type: "search", id: 1, index: 9, query: "alpha" });

  expect(responses).toEqual([{ type: "result", id: 1, matches: [] }]);
});

test("release drops a node set so later searches over it have no matches", () => {
  const { responses, handle } = createWorkerHarness();

  handle({ type: "init", index: 0, nodes: createTreeSearchNodes(model) });
  handle({ type: "release", index: 0 });
  handle({ type: "search", id: 2, index: 0, query: "alpha|beta" });

  expect(responses).toEqual([{ type: "result", id: 2, matches: [] }]);
});
