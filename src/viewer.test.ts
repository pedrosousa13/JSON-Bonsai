// @vitest-environment jsdom

import { describe, expect, test } from "vitest";

import { buildTreeModel } from "./tree-model";
import type { ExactNumberMap } from "./lossless-numbers";
import { createTreeView } from "./viewer";
import {
  SearchLimitError,
  createLocalTreeSearchIndex,
  type TreeSearchIndex,
} from "./tree-search";
import { runQuery } from "./query";
import { composeNodeQuery, projectLastIndex } from "./query-suggest";

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.innerHTML = "";
  document.body.appendChild(container);
  return container;
}

// The "ƒ all" button on the rendered row for `path`. Attribute selectors are
// awkward for paths carrying quotes, so match on the dataset instead.
function queryAllAction(container: HTMLElement, path: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".jv-line")).find(
    (line) => line.dataset.path === path
  );
  if (!row) throw new Error(`no rendered row for path ${path}`);
  return row.querySelector<HTMLElement>(".jv-action-query-all-node")!;
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

  // The two ways a search can stop short are different events, and the state
  // says which: a scan that outlived its budget touched the document, while a
  // refused pattern never ran at all.
  test.each([
    ["timeout" as const, new SearchLimitError("timeout")],
    ["pattern-too-slow" as const, new SearchLimitError("pattern-too-slow")],
  ])("a search stopped by %s reports it and the next search clears it", async (
    reason,
    error
  ) => {
    const container = createContainer();
    const model = buildTreeModel({ alpha: "one", beta: "two" });
    let limitPending = true;
    const searchIndex: TreeSearchIndex = {
      search(): Promise<number[]> {
        if (limitPending) {
          limitPending = false;
          return Promise.reject(error);
        }
        return Promise.resolve([model.pathToId.get("data.beta")!]);
      },
      dispose(): void {},
    };
    const treeView = createTreeView(container, model, {
      initialExpansionDepth: 1,
      searchIndex,
    });

    await treeView.render();

    const stopped = await treeView.search("(a+)+$", true);
    expect(stopped.limitReason).toBe(reason);
    expect(stopped.matchCount).toBe(0);
    expect(container.querySelector(".jv-search-active")).toBeNull();

    const recovered = await treeView.search("two");
    expect(recovered.limitReason).toBeNull();
    expect(recovered.matchCount).toBe(1);
    expect(container.querySelector<HTMLElement>(".jv-search-active")?.dataset.path).toBe(
      "data.beta"
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

  test("scroll is not clamped to the tree height while the tree is hidden", async () => {
    const scrollContainer = createContainer();
    const container = document.createElement("div");
    scrollContainer.appendChild(container);
    const model = buildTreeModel({ a: 1, b: 2 });
    const treeView = createTreeView(container, model, { scrollContainer });
    await treeView.render();

    // Another view (raw/formatted/schema) is active: the tree is hidden but
    // the shared scroll container now holds taller content.
    container.classList.add("jv-hidden");
    scrollContainer.scrollTop = 5000;
    scrollContainer.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(scrollContainer.scrollTop).toBe(5000);
  });

  test("refresh re-renders the window once the tree is visible again", async () => {
    const scrollContainer = createContainer();
    const container = document.createElement("div");
    scrollContainer.appendChild(container);
    const model = buildTreeModel({
      items: Array.from({ length: 500 }, (_, i) => ({ id: i })),
    });
    const treeView = createTreeView(container, model, { scrollContainer });
    await treeView.render();
    const rowsLayer = container.querySelector<HTMLElement>(".jv-tree-rows")!;
    const initialTransform = rowsLayer.style.transform;

    container.classList.add("jv-hidden");
    scrollContainer.scrollTop = 5000;
    scrollContainer.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rowsLayer.style.transform).toBe(initialTransform);

    container.classList.remove("jv-hidden");
    treeView.refresh();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The window render ran for the scroll position it missed while hidden.
    expect(rowsLayer.style.transform).not.toBe(initialTransform);
  });

  test("scrolling a visible tree never writes scrollTop back", async () => {
    const scrollContainer = createContainer();
    const container = document.createElement("div");
    scrollContainer.appendChild(container);
    const model = buildTreeModel({
      items: Array.from({ length: 500 }, (_, i) => ({ id: i })),
    });
    const treeView = createTreeView(container, model, { scrollContainer });
    await treeView.render();

    // The browser owns the real scroll bounds (content padding, etc.); the
    // virtualizer clamping scrollTop itself made the last rows unreachable.
    scrollContainer.scrollTop = 999999;
    scrollContainer.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(scrollContainer.scrollTop).toBe(999999);
  });

  test("renders preserved exact numbers with badge class and tooltip", async () => {
    const container = createContainer();
    // Manual map (rather than parseWithExactNumbers) so the test runs on
    // engines without JSON.parse source access.
    const data = { big: 9007199254740992, small: 1 };
    const exactNumbers: ExactNumberMap = new WeakMap([
      [data as object, new Map([["big", "9007199254740993"]])],
    ]);
    const model = buildTreeModel(data, exactNumbers);
    const treeView = createTreeView(container, model);

    await treeView.render();

    const bigValue = container
      .querySelector<HTMLElement>('[data-path="data.big"]')!
      .querySelector<HTMLElement>(".jv-number")!;
    expect(bigValue.classList.contains("jv-number-exact")).toBe(true);
    expect(bigValue.textContent).toBe("9007199254740993");
    expect(bigValue.title).toContain("Exact value preserved");

    const smallValue = container
      .querySelector<HTMLElement>('[data-path="data.small"]')!
      .querySelector<HTMLElement>(".jv-number")!;
    expect(smallValue.classList.contains("jv-number-exact")).toBe(false);
    expect(smallValue.textContent).toBe("1");
    expect(smallValue.title).toBe("");

    // Copy actions read the exact source through this accessor.
    expect(treeView.getNodeNumberText(model.pathToId.get("data.big")!)).toBe(
      "9007199254740993"
    );
    expect(treeView.getNodeNumberText(model.pathToId.get("data.small")!)).toBe(null);
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

  test("hides the all-array-items action on a key that merely looks indexed", async () => {
    const container = createContainer();
    const model = buildTreeModel({ "a[0]": 1 });
    const treeView = createTreeView(container, model);

    await treeView.render();

    expect(queryAllAction(container, 'data["a[0]"]').hidden).toBe(true);
  });

  test("offers the all-array-items action on a real array element's field", async () => {
    const container = createContainer();
    const model = buildTreeModel([{ a: 1 }]);
    const treeView = createTreeView(container, model);

    await treeView.render();

    expect(queryAllAction(container, "data[0].a").hidden).toBe(false);
    expect(composeNodeQuery(null, projectLastIndex("data[0].a")!)).toBe("[*].a");
  });
});
