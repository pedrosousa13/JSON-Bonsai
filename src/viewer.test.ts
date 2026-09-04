// @vitest-environment jsdom

import { describe, expect, test } from "vitest";

import { buildTreeModel, findNodeByPath } from "./tree-model";
import type { ExactNumberMap } from "./lossless-numbers";
import { createTreeView } from "./viewer";
import {
  createLocalTreeSearchIndex,
  type TreeSearchIndex,
  type TreeSearchOptions,
} from "./tree-search";
import { runQuery } from "./query";
import { composeNodeQuery, projectLastIndex } from "./query-suggest";

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.innerHTML = "";
  document.body.appendChild(container);
  return container;
}

// The rendered row for `path`. Attribute selectors are awkward for paths
// carrying quotes, so match on the dataset instead.
function lineForPath(container: HTMLElement, path: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".jv-line")).find(
    (line) => line.dataset.path === path
  );
  if (!row) throw new Error(`no rendered row for path ${path}`);
  return row;
}

// The "ƒ all" button on the rendered row for `path`.
function queryAllAction(container: HTMLElement, path: string): HTMLElement {
  return lineForPath(container, path).querySelector<HTMLElement>(
    ".jv-action-query-all-node"
  )!;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

    betaResult.resolve([findNodeByPath(model, "data.beta.nested.target")!.id]);
    await secondSearch;

    expect(container.querySelector<HTMLElement>(".jv-search-active")?.dataset.path).toBe(
      "data.beta.nested.target"
    );

    alphaResult.resolve([findNodeByPath(model, "data.alpha.nested.target")!.id]);
    await firstSearch;

    expect(treeView.getSearchState().query).toBe("second");
    expect(container.querySelector<HTMLElement>(".jv-search-active")?.dataset.path).toBe(
      "data.beta.nested.target"
    );
  });

  test("a superseded search has its scan aborted, and the newer one is left running", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      alpha: { nested: { target: "first" } },
      beta: { nested: { target: "second" } },
    });
    const signals: (AbortSignal | undefined)[] = [];
    const stale = createDeferred<number[]>();
    const searchIndex: TreeSearchIndex = {
      search(query: string, options?: TreeSearchOptions): Promise<number[]> {
        signals.push(options?.signal);
        return query === "first"
          ? stale.promise
          : Promise.resolve([findNodeByPath(model, "data.beta.nested.target")!.id]);
      },
      dispose(): void {},
    };
    const treeView = createTreeView(container, model, { searchIndex });

    await treeView.render();

    const firstSearch = treeView.search("first");
    expect(signals[0]?.aborted).toBe(false);

    await treeView.search("second");
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    // An aborted scan resolves empty rather than rejecting, so a supersede
    // must not surface as an error to the abandoned caller either.
    stale.resolve([]);
    await expect(firstSearch).resolves.toMatchObject({ query: "second" });
    expect(treeView.getSearchState().matchCount).toBe(1);
  });

  test("clearing the search aborts the in-flight scan", async () => {
    const container = createContainer();
    const model = buildTreeModel({ alpha: { nested: { target: "first" } } });
    const signals: (AbortSignal | undefined)[] = [];
    const pending = createDeferred<number[]>();
    const searchIndex: TreeSearchIndex = {
      search(_query: string, options?: TreeSearchOptions): Promise<number[]> {
        signals.push(options?.signal);
        return pending.promise;
      },
      dispose(): void {},
    };
    const treeView = createTreeView(container, model, { searchIndex });

    await treeView.render();

    const search = treeView.search("first");
    treeView.clearSearch();
    expect(signals[0]?.aborted).toBe(true);

    pending.resolve([]);
    await expect(search).resolves.toMatchObject({ query: "" });
  });

  test("a search after a superseded one gets a fresh, unaborted signal", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      alpha: { nested: { target: "first" } },
      beta: { nested: { target: "second" } },
    });
    const signals: (AbortSignal | undefined)[] = [];
    const searchIndex: TreeSearchIndex = {
      search(query: string, options?: TreeSearchOptions): Promise<number[]> {
        signals.push(options?.signal);
        const path = query === "first" ? "data.alpha.nested.target" : "data.beta.nested.target";
        return Promise.resolve([findNodeByPath(model, path)!.id]);
      },
      dispose(): void {},
    };
    const treeView = createTreeView(container, model, { searchIndex });

    await treeView.render();

    await treeView.search("first");
    treeView.clearSearch();
    await treeView.search("second");

    expect(signals[1]?.aborted).toBe(false);
    expect(treeView.getSearchState().matchCount).toBe(1);
    expect(container.querySelector<HTMLElement>(".jv-search-active")?.dataset.path).toBe(
      "data.beta.nested.target"
    );
  });

  test("a rejected search clears the matches and the render state, then rethrows", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      alpha: { nested: { target: "first" } },
      beta: { nested: { target: "second" } },
    });
    let fail = false;
    const renderStates: string[] = [];
    const searchIndex: TreeSearchIndex = {
      async search(): Promise<number[]> {
        if (fail) throw new Error("terminated");
        return [findNodeByPath(model, "data.alpha.nested.target")!.id];
      },
      dispose(): void {},
    };
    const treeView = createTreeView(container, model, {
      searchIndex,
      onRenderStateChange(message) {
        renderStates.push(message);
      },
    });

    await treeView.render();
    await treeView.search("first");
    expect(treeView.getSearchState().matchCount).toBe(1);

    fail = true;
    renderStates.length = 0;
    await expect(treeView.search("second")).rejects.toThrow("terminated");

    // No stale highlights left over, and the status is not stuck on
    // "Searching..." — the caller renders the failure itself.
    expect(treeView.getSearchState().matchCount).toBe(0);
    expect(container.querySelector(".jv-search-active")).toBeNull();
    expect(renderStates.at(-1)).toBe("");
  });

  test("a rejected search that has been superseded leaves the newer one alone", async () => {
    const container = createContainer();
    const model = buildTreeModel({
      alpha: { nested: { target: "first" } },
      beta: { nested: { target: "second" } },
    });
    const failing = createDeferred<number[]>();
    const searchIndex: TreeSearchIndex = {
      search(query: string): Promise<number[]> {
        return query === "first"
          ? failing.promise
          : Promise.resolve([findNodeByPath(model, "data.beta.nested.target")!.id]);
      },
      dispose(): void {},
    };
    const treeView = createTreeView(container, model, { searchIndex });

    await treeView.render();
    const firstSearch = treeView.search("first");
    await treeView.search("second");

    failing.reject(new Error("terminated"));
    await expect(firstSearch).rejects.toThrow("terminated");

    expect(treeView.getSearchState().query).toBe("second");
    expect(treeView.getSearchState().matchCount).toBe(1);
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

    await treeView.toggleNode(findNodeByPath(model, "data.alpha")!.id);
    expect(recomputeCount).toBe(1);

    await treeView.toggleNode(findNodeByPath(model, "data.alpha")!.id);
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
    expect(treeView.getNodeNumberText(findNodeByPath(model, "data.big")!.id)).toBe(
      "9007199254740993"
    );
    expect(treeView.getNodeNumberText(findNodeByPath(model, "data.small")!.id)).toBe(null);
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

  test("truncates a long string value without splitting a surrogate pair", async () => {
    const container = createContainer();
    // 499 plain characters then an emoji, so the 500-unit cut falls between
    // the emoji's two halves and a naive slice renders U+FFFD.
    const value = `${"a".repeat(499)}😀${"b".repeat(10)}`;
    const model = buildTreeModel({ s: value });
    const treeView = createTreeView(container, model);

    await treeView.render();

    const span = container.querySelector<HTMLElement>(
      '[data-path="data.s"] .jv-string'
    )!;
    expect(span.textContent).toBe(`"${"a".repeat(499)}…" (511 chars)`);
  });

  test("JSON-escapes string values and keys", async () => {
    const container = createContainer();
    const model = buildTreeModel({ 'say "hi"': 'say "hi"\u0001\n' });
    const treeView = createTreeView(container, model);

    await treeView.render();

    const row = lineForPath(container, 'data["say \\"hi\\""]');
    expect(row.querySelector<HTMLElement>(".jv-key")!.textContent).toBe(
      '"say \\"hi\\""'
    );
    expect(row.querySelector<HTMLElement>(".jv-string")!.textContent).toBe(
      '"say \\"hi\\"\\u0001\\n"'
    );
  });

  test("JSON-escapes a link's text but keeps the href raw", async () => {
    const container = createContainer();
    // URL_PATTERN only rejects whitespace, so a quote or control character
    // reaches the link branch too.
    const url = 'https://x.test/?q="a"\u0001';
    const model = buildTreeModel({ u: url });
    const treeView = createTreeView(container, model);

    await treeView.render();

    const span = container.querySelector<HTMLElement>(
      '[data-path="data.u"] .jv-string'
    )!;
    expect(span.textContent).toBe('"https://x.test/?q=\\"a\\"\\u0001"');
    // Escaping is display only; the anchor still has to navigate.
    const link = span.querySelector<HTMLAnchorElement>("a.jv-link")!;
    expect(link.getAttribute("href")).toBe(url);
  });

  test("truncates before escaping, so the char count stays the source length", async () => {
    const container = createContainer();
    const value = `${'"'.repeat(500)}x`;
    const model = buildTreeModel({ s: value });
    const treeView = createTreeView(container, model);

    await treeView.render();

    const span = container.querySelector<HTMLElement>(
      '[data-path="data.s"] .jv-string'
    )!;
    expect(span.textContent).toBe(`"${'\\"'.repeat(500)}…" (501 chars)`);
  });

  // Rows past MAX_PHYSICAL_HEIGHT / 24 px (~41.6k) compress the spacer by
  // `scale`, while pooled rows keep rendering at native height. 10 million
  // rows — the size the acceptance criterion names, scale ≈ 240 — will not run
  // here: buildTreeModel allocates a node object per row, so it needs ~5 GB of
  // heap and ~8 s, which kills the vitest worker under its default ceiling and
  // only passes with --max-old-space-size raised past 12 GB. That is a cost,
  // not a test. Measured there for the record: 55 pooled rows against the 64
  // the criterion allows (2x the 32 visible), the extra 22 being the pad that
  // covers one pixel of scroll error at that compression.
  //
  // So pin the property the criterion is really about at two sizes whose
  // compression factors differ 6x: the pooled count is set by the viewport, so
  // it stays inside a fixed allowance over the visible rows, growing only by
  // the pixel of scroll error the pad covers and never by `scale`.
  async function windowAt(totalRows: number): Promise<{
    count: number;
    paths: string[];
    scrolledToIndex: number;
  }> {
    const scrollContainer = createContainer();
    const container = document.createElement("div");
    scrollContainer.appendChild(container);
    const model = buildTreeModel(Array.from({ length: totalRows }, (_, i) => i));
    const treeView = createTreeView(container, model, { scrollContainer });
    await treeView.render();

    const scrollTop = 400_000;
    scrollContainer.scrollTop = scrollTop;
    await treeView.render();

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(".jv-line:not([hidden])")
    );
    // The spacer stands in for every row, so the fraction of it scrolled past
    // is the fraction of the rows scrolled past, whatever the compression.
    // Derived from the DOM rather than from the scale factor, so it does not
    // restate the arithmetic under test.
    const spacerHeight = Number.parseFloat(
      container.querySelector<HTMLElement>(".jv-tree-spacer")!.style.height
    );
    return {
      count: rows.length,
      paths: rows.map((row) => row.dataset.path ?? ""),
      // There are totalRows + 1 visible rows counting the root, and visible
      // row n holds `data[n - 1]`.
      scrolledToIndex:
        Math.round((scrollTop / spacerHeight) * (totalRows + 1)) - 1,
    };
  }

  test("compressed-scrollbar regime pools about as many rows as fit on screen", async () => {
    const viewportHeight = window.innerHeight;
    const visibleRows = Math.ceil(viewportHeight / 24);

    const low = await windowAt(200_000); // scale ≈ 4.8
    const high = await windowAt(1_200_000); // scale ≈ 28.8

    // A fixed allowance over the viewport rather than a multiple of it: the
    // pad is the overscan (13 rows at scale 4.8, 5 at 28.8), which does not
    // ride on the viewport. A window still sized by viewport × scale would
    // build 154 rows at scale 4.8 and 922 at 28.8. The allowance is sized for
    // these two scales — the pad grows by one pixel of scroll error, so scale
    // 240 needs the criterion's looser 2x-visible bound (55 of 64).
    expect(low.count).toBeLessThanOrEqual(visibleRows + 16);
    expect(high.count).toBeLessThanOrEqual(visibleRows + 16);
    // Six times the compression must not cost a multiple of the DOM.
    expect(high.count).toBeLessThanOrEqual(low.count);

    // The overscan has to cover at least one pixel of scroll error — 1.2 rows
    // at scale 28.8, since browsers snap scrollTop to whole device pixels —
    // or a scrollToNode landing renders a window that misses its target.
    expect(high.count).toBeGreaterThanOrEqual(visibleRows + 4);

    // Counting rows alone passes a window of the right size in the wrong
    // place, so pin the content too: the row the scroll position points at is
    // one of the rows rendered.
    expect(low.paths).toContain(`data[${low.scrolledToIndex}]`);
    expect(high.paths).toContain(`data[${high.scrolledToIndex}]`);
  });

  test("compressed-scrollbar regime still scrolls a target row into the window", async () => {
    const scrollContainer = createContainer();
    const container = document.createElement("div");
    scrollContainer.appendChild(container);
    const model = buildTreeModel(Array.from({ length: 200_000 }, (_, i) => i));
    const treeView = createTreeView(container, model, { scrollContainer });

    treeView.revealNode(findNodeByPath(model, "data[150000]")!.id);

    expect(lineForPath(container, "data[150000]").hidden).toBe(false);
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
