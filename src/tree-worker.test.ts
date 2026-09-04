import { expect, test } from "vitest";

import { buildTreeModel } from "./tree-model";
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
