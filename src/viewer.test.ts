// @vitest-environment jsdom

import { describe, expect, test } from "vitest";

import { buildTreeModel } from "./tree-model";
import { createTreeView } from "./viewer";
import { createLocalTreeSearchIndex, type TreeSearchIndex } from "./tree-worker-client";
import { runQuery } from "./query";

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.innerHTML = "";
  document.body.appendChild(container);
  return container;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createTreeView", () => {
  test("search finds scalar values and highlights the active row", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      users: [{ name: "Ada Lovelace", role: "admin" }],
      metadata: { count: 1 },
    });
    const treeView = createTreeView(container, model);

    await treeView.render();
    const state = await treeView.search("ada");

    expect(state.matchCount).toBeGreaterThan(0);
    const activeRow = container.querySelector<HTMLElement>(".jv-search-active");
    expect(activeRow?.dataset.path).toBe("data.users[0].name");
  });

  test("search finds container nodes by key and path", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      metadata: { totalCount: 42 },
      data: { items: [] },
    });
    const treeView = createTreeView(container, model, {
      initialExpansionDepth: 1,
    });

    await treeView.render();
    let state = await treeView.search("metadata");
    expect(state.matchCount).toBeGreaterThan(0);
    expect(container.querySelector<HTMLElement>(".jv-search-active")?.dataset.path).toBe(
      "data.metadata"
    );

    state = await treeView.search("data.data.items");
    expect(state.matchCount).toBeGreaterThan(0);
    expect(container.querySelector<HTMLElement>(".jv-search-active")?.dataset.path).toBe(
      "data.data.items"
    );
  });

  test("clearing search restores the previous expansion state", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      users: [{ name: "Ada Lovelace", role: "admin" }],
      metadata: { count: 1 },
    });
    const treeView = createTreeView(container, model);

    const visible = () => container.querySelectorAll(".jv-line:not([hidden])").length;

    await treeView.collapseToLevel(1);
    const visibleBeforeSearch = visible();

    await treeView.search("ada");
    expect(visible()).toBeGreaterThan(visibleBeforeSearch);

    await treeView.clearSearch();
    expect(visible()).toBe(visibleBeforeSearch);
  });

  test("changing depth keeps active search match revealed", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      alpha: { nested: { deep: { target: "match" } } },
      beta: { other: 1 },
    });
    const treeView = createTreeView(container, model);

    await treeView.render();
    await treeView.search("match");
    expect(container.querySelector<HTMLElement>(".jv-search-active")?.dataset.path).toBe(
      "data.alpha.nested.deep.target"
    );

    await treeView.collapseToLevel(1);

    const activeRow = container.querySelector<HTMLElement>(".jv-search-active");
    expect(activeRow?.dataset.path).toBe("data.alpha.nested.deep.target");

    const visiblePaths = Array.from(
      container.querySelectorAll<HTMLElement>(".jv-line:not([hidden])")
    ).map((row) => row.dataset.path);
    expect(visiblePaths).toContain("data.alpha.nested.deep.target");
  });

  test("clearing search after depth change restores chosen depth, not pre-search", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      alpha: { nested: { target: "match" } },
      beta: { other: 1 },
    });
    const treeView = createTreeView(container, model);

    await treeView.render();
    await treeView.search("match");
    await treeView.collapseToLevel(1);
    await treeView.clearSearch();

    const visiblePaths = Array.from(
      container.querySelectorAll<HTMLElement>(".jv-line:not([hidden])")
    ).map((row) => row.dataset.path);
    expect(visiblePaths).toEqual(["data", "data.alpha", "data.beta"]);
  });

  test("stepping search keeps previously revealed branches expanded", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      alpha: { nested: { target: "match" } },
      beta: { nested: { target: "match" } },
    });
    const treeView = createTreeView(container, model, {
      initialExpansionDepth: 1,
    });

    await treeView.render();
    await treeView.search("match");

    let visiblePaths = Array.from(container.querySelectorAll<HTMLElement>(".jv-line")).map(
      (row) => row.dataset.path
    );

    expect(visiblePaths).toContain("data.alpha.nested");

    await treeView.stepSearch(1);

    visiblePaths = Array.from(container.querySelectorAll<HTMLElement>(".jv-line")).map(
      (row) => row.dataset.path
    );

    expect(container.querySelector<HTMLElement>(".jv-search-active")?.dataset.path).toBe(
      "data.beta.nested.target"
    );
    expect(visiblePaths).toContain("data.alpha.nested");
    expect(visiblePaths).toContain("data.beta.nested");
  });

  test("stale async search results do not overwrite the latest query", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      alpha: { nested: { target: "first" } },
      beta: { nested: { target: "second" } },
    });
    const alphaResult = createDeferred<number[]>();
    const betaResult = createDeferred<number[]>();
    const searchIndex: TreeSearchIndex = {
      search(query: string): Promise<number[]> {
        return query === "first" ? alphaResult.promise : betaResult.promise;
      },
      dispose(): void {},
    };
    const treeView = createTreeView(container, model, {
      initialExpansionDepth: 1,
      searchIndex,
    });

    await treeView.render();

    const firstSearch = treeView.search("first");
    const secondSearch = treeView.search("second");

    betaResult.resolve([model.pathToId.get("data.beta.nested.target")!]);
    await secondSearch;

    expect(container.querySelector<HTMLElement>(".jv-search-active")?.dataset.path).toBe(
      "data.beta.nested.target"
    );

    alphaResult.resolve([model.pathToId.get("data.alpha.nested.target")!]);
    await firstSearch;

    expect(treeView.getSearchState().query).toBe("second");
    expect(container.querySelector<HTMLElement>(".jv-search-active")?.dataset.path).toBe(
      "data.beta.nested.target"
    );
  });

  test("branch toggles reuse the visible row list instead of rebuilding it", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      alpha: { nested: { deep: "value" } },
      beta: { nested: { deep: "other" } },
    });
    let recomputeCount = 0;
    const treeView = createTreeView(container, model, {
      initialExpansionDepth: 1,
      debugHooks: {
        onVisibleListRecomputed() {
          recomputeCount += 1;
        },
      },
    });

    await treeView.render();
    expect(recomputeCount).toBe(1);

    await treeView.toggleNode(model.pathToId.get("data.alpha")!);
    expect(recomputeCount).toBe(1);

    await treeView.toggleNode(model.pathToId.get("data.alpha")!);
    expect(recomputeCount).toBe(1);
  });

  test("initialExpansionDepth limits the initial visible rows", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      users: [{ name: "Ada Lovelace", role: "admin" }],
      metadata: { count: 1 },
    });
    const treeView = createTreeView(container, model, {
      initialExpansionDepth: 1,
    });

    await treeView.render();

    const visiblePaths = Array.from(container.querySelectorAll<HTMLElement>(".jv-line")).map(
      (row) => row.dataset.path
    );

    expect(visiblePaths).toEqual(["data", "data.users", "data.metadata"]);
  });

  test("expandAll keeps the DOM windowed instead of rendering every row", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      users: Array.from({ length: 20 }, (_, index) => ({
        name: `User ${index}`,
        role: "admin",
        links: { profile: `/users/${index}` },
      })),
    });
    const treeView = createTreeView(container, model, {
      initialExpansionDepth: 1,
    });

    await treeView.render();
    await treeView.expandAll();

    const renderedRows = container.querySelectorAll(".jv-line").length;
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(model.totalNodes);
  });

  test("swapping the model to a query result re-renders and search targets the result", async () => {
    const container = createContainer();
    const data = {
      items: [
        { name: "cheap", price: 5 },
        { name: "pricey", price: 30 },
      ],
      metadata: { count: 2 },
    };

    const originalModel = buildTreeModel(data);
    const originalView = createTreeView(container, originalModel);
    await originalView.render();
    expect(
      Array.from(container.querySelectorAll<HTMLElement>(".jv-line:not([hidden])")).map(
        (row) => row.dataset.path
      )
    ).toContain("data.metadata.count");

    // Run a query and mount a fresh view for the result (mirrors mountTree).
    const outcome = runQuery(data, "items[?price > `10`].name");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const resultModel = buildTreeModel(outcome.result);
    const resultIndex = createLocalTreeSearchIndex(resultModel);
    const resultView = createTreeView(container, resultModel, {
      searchIndex: resultIndex,
    });
    await resultView.render();

    const visiblePaths = Array.from(
      container.querySelectorAll<HTMLElement>(".jv-line:not([hidden])")
    ).map((row) => row.dataset.path);
    expect(visiblePaths).toEqual(["data", "data[0]"]);
    expect(visiblePaths).not.toContain("data.metadata");

    const state = await resultView.search("pricey");
    expect(state.matchCount).toBe(1);
    expect(container.querySelector<HTMLElement>(".jv-search-active")?.dataset.path).toBe(
      "data[0]"
    );

    // Restoring mounts the original model again on the same container.
    const restoredView = createTreeView(container, originalModel);
    await restoredView.render();
    expect(
      Array.from(container.querySelectorAll<HTMLElement>(".jv-line:not([hidden])")).map(
        (row) => row.dataset.path
      )
    ).toContain("data.metadata.count");
  });

  test("expandAll keeps DOM windowed at any size", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      users: Array.from({ length: 2500 }, (_, index) => ({
        name: `User ${index}`,
        profile: {
          id: index,
          tags: [`tag-${index}`, `group-${index}`],
        },
      })),
    });
    const treeView = createTreeView(container, model, {
      initialExpansionDepth: 1,
    });

    await treeView.render();
    await treeView.expandAll();

    const renderedRows = container.querySelectorAll(".jv-line").length;
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(model.totalNodes);
  });
});
