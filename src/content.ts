import { buildTreeModel, type JsonValue, type TreeModel } from "./tree-model";
import { createTreeView, setupHoverPath, type TreeViewController } from "./viewer";
import {
  createBestAvailableTreeSearchIndex,
  createLocalTreeSearchIndex,
  type TreeSearchIndex,
} from "./tree-worker-client";
import { toJsonSchema } from "./schema";
import {
  BUILTIN_SCHEMES,
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT_ID,
  parseScheme,
  schemeToCssVars,
  type Base16Scheme,
  type ThemeMode,
} from "./themes";
import { runQuery } from "./query";
import {
  createOriginPrefsWriter,
  loadOriginPrefs,
  type OriginPrefs,
} from "./prefs";
import {
  checkTableEligibility,
  createTableView,
  type TableViewController,
} from "./table";
import "./styles/viewer.css";

const LARGE_TREE_NODE_THRESHOLD = 8000;
const LARGE_TREE_INITIAL_EXPANSION_DEPTH = 2;

function detectJSON(): { data: JsonValue; raw: string } | null {
  const pre = document.querySelector("body > pre");
  const isPlainBody =
    document.body.children.length === 1 && pre instanceof HTMLPreElement;
  const hasJSONContentType = (document.contentType || "").includes("json");

  if (!isPlainBody && !hasJSONContentType) return null;

  const raw = (pre ? pre.textContent : document.body.textContent || "")!.trim();
  if (!raw) return null;

  try {
    const data = JSON.parse(raw) as JsonValue;
    if (data === null || typeof data !== "object") return null;
    return { data, raw };
  } catch {
    return null;
  }
}

async function storageSet(key: string, value: string): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

interface ThemeState {
  mode: ThemeMode;
  darkId: string;
  lightId: string;
  customs: Base16Scheme[];
}

async function loadThemeState(): Promise<ThemeState> {
  // One-time migration: jv-theme used to hold the mode; jv-custom-cursor is gone.
  const legacy = await chrome.storage.local.get(["jv-theme", "jv-custom-cursor"]);
  if (typeof legacy["jv-theme"] === "string") {
    await chrome.storage.local.set({ "jv-theme-mode": legacy["jv-theme"] });
  }
  const legacyKeys = ["jv-theme", "jv-custom-cursor"].filter((key) => key in legacy);
  if (legacyKeys.length > 0) {
    await chrome.storage.local.remove(legacyKeys);
  }

  const stored = await chrome.storage.local.get({
    "jv-theme-mode": "auto",
    "jv-theme-dark": DEFAULT_DARK_ID,
    "jv-theme-light": DEFAULT_LIGHT_ID,
    "jv-custom-themes": "[]",
  });

  let customs: Base16Scheme[] = [];
  try {
    const parsed = JSON.parse(stored["jv-custom-themes"] as string) as unknown;
    if (Array.isArray(parsed)) customs = parsed as Base16Scheme[];
  } catch {
    // Corrupted storage — start with no custom themes.
  }

  const mode = stored["jv-theme-mode"] as string;
  return {
    mode: mode === "dark" || mode === "light" ? mode : "auto",
    darkId: stored["jv-theme-dark"] as string,
    lightId: stored["jv-theme-light"] as string,
    customs,
  };
}

async function init(): Promise<void> {
  const result = detectJSON();
  if (!result) return;

  const { data, raw } = result;
  let prettyRaw: string | null = null;

  function getPrettyRaw(): string {
    if (prettyRaw === null) {
      prettyRaw = JSON.stringify(data, null, 2);
    }
    return prettyRaw;
  }

  document.documentElement.innerHTML = "";
  const head = document.createElement("head");
  const body = document.createElement("body");
  document.documentElement.appendChild(head);
  document.documentElement.appendChild(body);

  const root = document.createElement("div");
  root.id = "jv-root";

  root.innerHTML = `
    <div id="jv-toolbar">
      <span id="jv-info"></span>
      <span id="jv-path-display"><span id="jv-path-text"></span><button id="jv-path-copy" title="Copy path">Copy</button></span>
      <div id="jv-levels"></div>
      <button id="jv-search-toggle" title="Search (⌘F)">⌕</button>
      <button id="jv-query-toggle" title="Query (JMESPath) (Q)">ƒ</button>
      <span id="jv-query-chip" hidden><span id="jv-query-chip-text"></span><button id="jv-query-chip-clear" title="Clear query">✕</button></span>
      <div id="jv-view-picker">
        <button class="jv-view-btn jv-active" data-view="tree">Tree</button>
        <button class="jv-view-btn" data-view="table">Table</button>
        <button class="jv-view-btn" data-view="formatted">Formatted</button>
        <button class="jv-view-btn" data-view="raw">Raw</button>
        <button class="jv-view-btn" data-view="schema">Schema</button>
      </div>
      <span id="jv-render-status"></span>
      <button id="jv-theme-toggle" title="Toggle theme"></button>
      <button id="jv-copy"><span class="jv-copy-label">Copy JSON</span><kbd class="jv-kbd">C</kbd></button>
      <div id="jv-settings">
        <button id="jv-settings-toggle" title="Settings">⚙</button>
        <div id="jv-settings-menu">
          <div class="jv-settings-row"><span>Dark theme</span><select id="jv-theme-dark-select"></select></div>
          <div class="jv-settings-row"><span>Light theme</span><select id="jv-theme-light-select"></select></div>
          <textarea id="jv-theme-paste" placeholder="Paste a base16 scheme (YAML or JSON)" spellcheck="false"></textarea>
          <div class="jv-settings-row">
            <a id="jv-theme-browse" href="https://github.com/tinted-theming/schemes" target="_blank" rel="noreferrer">Find more themes</a>
            <button id="jv-theme-add">Add theme</button>
          </div>
          <div id="jv-theme-error"></div>
          <ul id="jv-custom-list"></ul>
        </div>
      </div>
    </div>
    <div id="jv-search-panel" hidden>
      <input id="jv-search-input" type="search" placeholder="Search keys, values, paths" spellcheck="false">
      <span id="jv-search-status"></span>
      <button id="jv-search-prev" title="Previous result (Shift+Enter)">↑</button>
      <button id="jv-search-next" title="Next result (Enter)">↓</button>
      <button id="jv-search-clear" title="Close (Esc)">×</button>
    </div>
    <div id="jv-query-panel" hidden>
      <input id="jv-query-input" type="text" placeholder="e.g. items[?price > \`10\`].name" spellcheck="false" autocomplete="off">
      <button id="jv-query-run" title="Run query (Enter)">Run</button>
      <button id="jv-query-close" title="Close (Esc)">×</button>
      <span id="jv-query-error" hidden></span>
    </div>
    <div id="jv-content">
      <div id="jv-tree"></div>
      <div id="jv-table"></div>
      <pre id="jv-formatted"></pre>
      <pre id="jv-raw"></pre>
      <pre id="jv-schema"></pre>
    </div>
  `;

  const themeState = await loadThemeState();
  const originPrefs = await loadOriginPrefs(location.origin);
  const saveOriginPrefs = createOriginPrefsWriter(location.origin, originPrefs);
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)");

  function allSchemes(): Base16Scheme[] {
    return [...BUILTIN_SCHEMES, ...themeState.customs];
  }

  function findScheme(id: string, variant: "dark" | "light"): Base16Scheme {
    const fallbackId = variant === "dark" ? DEFAULT_DARK_ID : DEFAULT_LIGHT_ID;
    return (
      allSchemes().find((s) => s.id === id) ??
      BUILTIN_SCHEMES.find((s) => s.id === fallbackId)!
    );
  }

  function resolveScheme(): Base16Scheme {
    const variant =
      themeState.mode === "auto"
        ? prefersLight.matches
          ? "light"
          : "dark"
        : themeState.mode;
    return variant === "dark"
      ? findScheme(themeState.darkId, "dark")
      : findScheme(themeState.lightId, "light");
  }

  function applyTheme(): void {
    const scheme = resolveScheme();
    for (const [name, value] of Object.entries(schemeToCssVars(scheme))) {
      root.style.setProperty(name, value);
    }
    // Overscroll area behind the viewer follows the toolbar color.
    document.documentElement.style.background = scheme.palette.base01;
  }

  prefersLight.addEventListener("change", () => {
    if (themeState.mode === "auto") applyTheme();
  });

  applyTheme();

  body.appendChild(root);

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("content.css");
  head.appendChild(link);

  const tree = document.getElementById("jv-tree")!;
  const tableEl = document.getElementById("jv-table")!;
  const formattedEl = document.getElementById("jv-formatted")!;
  const rawEl = document.getElementById("jv-raw")!;
  const schemaEl = document.getElementById("jv-schema")!;
  const pathDisplay = document.getElementById("jv-path-display")!;
  const pathText = document.getElementById("jv-path-text")!;
  const pathCopyBtn = document.getElementById("jv-path-copy")!;
  const searchInput = document.getElementById("jv-search-input") as HTMLInputElement;
  const searchStatus = document.getElementById("jv-search-status")!;
  const searchPrevBtn = document.getElementById("jv-search-prev") as HTMLButtonElement;
  const searchNextBtn = document.getElementById("jv-search-next") as HTMLButtonElement;
  const searchClearBtn = document.getElementById("jv-search-clear") as HTMLButtonElement;
  const info = document.getElementById("jv-info")!;
  const levelsContainer = document.getElementById("jv-levels")!;
  const renderStatus = document.getElementById("jv-render-status")!;
  const content = document.getElementById("jv-content")!;
  const viewBtns = document.querySelectorAll<HTMLElement>(".jv-view-btn");
  const views: Record<string, HTMLElement> = { tree, table: tableEl, formatted: formattedEl, raw: rawEl, schema: schemaEl };
  const copyBtn = document.getElementById("jv-copy")!;
  const copyLabel = copyBtn.querySelector<HTMLElement>(".jv-copy-label")!;
  const copyKbd = copyBtn.querySelector<HTMLElement>(".jv-kbd")!;
  const loadedViews = new Set<string>(["tree"]);
  let currentView = "tree";
  // Views share #jv-content as scroll container, so each remembers its own
  // scroll offset across switches.
  const viewScrollTops: Record<string, number> = {};
  let searchTimer: number | null = null;
  let activeQueryResult: { expression: string; result: JsonValue } | null = null;
  let tableView: TableViewController | null = null;

  function currentDocument(): JsonValue {
    return activeQueryResult !== null ? activeQueryResult.result : data;
  }

  renderStatus.textContent = "Indexing JSON...";
  const model = buildTreeModel(data);
  let treeView!: TreeViewController;
  let treeMounted = false;
  // The original document's index lives for the whole page so swapping to a
  // query result and back never pays the worker re-indexing cost again.
  let originalSearchIndex: TreeSearchIndex | null = null;
  let resultSearchIndex: TreeSearchIndex | null = null;
  // Last level button the user picked on the original tree ("all" = expand
  // all), so restoring after a query puts the depth back where they left it.
  // Seeded from this origin's saved prefs.
  let originalLevelSelection: number | "all" | null = originPrefs.level ?? null;

  // Persists the current view and last explicit level pick for this origin.
  function persistOriginPrefs(): void {
    const prefs: OriginPrefs = { view: currentView };
    if (originalLevelSelection !== null) prefs.level = originalLevelSelection;
    saveOriginPrefs(prefs);
  }

  function createSearchIndexFor(treeModel: TreeModel): TreeSearchIndex {
    return typeof Worker === "function"
      ? createBestAvailableTreeSearchIndex(treeModel)
      : createLocalTreeSearchIndex(treeModel);
  }

  // (Re)builds the tree view, level buttons and node stats for the given
  // model. Used for the initial mount, query results, and restore. The search
  // index lifecycle is owned by the callers.
  async function mountTree(treeModel: TreeModel, searchIndex: TreeSearchIndex): Promise<void> {
    if (treeMounted) treeView.dispose();
    treeMounted = true;
    const initialExpansionDepth =
      treeModel.totalNodes > LARGE_TREE_NODE_THRESHOLD
        ? LARGE_TREE_INITIAL_EXPANSION_DEPTH
        : null;
    treeView = createTreeView(tree, treeModel, {
      initialExpansionDepth,
      scrollContainer: content,
      searchIndex,
      onRenderStateChange(message) {
        renderStatus.textContent = message;
      },
    });

    const { maxDepth, totalNodes } = treeView.getStats();
    info.textContent = `${totalNodes} nodes · ${maxDepth} level${maxDepth !== 1 ? "s" : ""} deep`;
    await treeView.render();
    buildLevelButtons(maxDepth, initialExpansionDepth);

    // The previous view's search state is gone with it; reset the search UI.
    if (searchTimer !== null) {
      window.clearTimeout(searchTimer);
      searchTimer = null;
    }
    searchInput.value = "";
    updateSearchUi();
  }

  function buildLevelButtons(
    maxDepth: number,
    initialExpansionDepth: number | null
  ): void {
    levelsContainer.innerHTML = "";
    const levelCount = Math.min(maxDepth, 8);
    for (let i = 1; i <= levelCount; i++) {
      const btn = document.createElement("button");
      btn.dataset.level = String(i);
      btn.textContent = String(i);
      btn.title = `Show ${i} level${i === 1 ? "" : "s"} (press ${i})`;
      btn.addEventListener("click", () => {
        void treeView.collapseToLevel(i);
        setActiveLevel(btn);
        if (activeQueryResult === null) {
          originalLevelSelection = i;
          persistOriginPrefs();
        }
      });
      levelsContainer.appendChild(btn);
    }

    const allBtn = document.createElement("button");
    allBtn.textContent = "All";
    allBtn.dataset.action = "expand-all";
    allBtn.title = "Expand all (press 0)";
    allBtn.addEventListener("click", () => {
      void treeView.expandAll();
      setActiveLevel(allBtn);
      if (activeQueryResult === null) {
        originalLevelSelection = "all";
        persistOriginPrefs();
      }
    });
    levelsContainer.appendChild(allBtn);
    if (initialExpansionDepth !== null) {
      const initialLevelButton = levelsContainer.querySelector<HTMLElement>(
        `button[data-level="${initialExpansionDepth}"]`
      );
      if (initialLevelButton) {
        setActiveLevel(initialLevelButton);
        renderStatus.textContent = `Large JSON: showing ${initialExpansionDepth} levels first. Search covers the full document.`;
      } else {
        setActiveLevel(allBtn);
      }
    } else {
      setActiveLevel(allBtn);
    }
  }

  function setActiveLevel(active: HTMLElement) {
    levelsContainer.querySelectorAll("button").forEach((b) =>
      b.classList.remove("jv-active")
    );
    active.classList.add("jv-active");
  }

  // Applies a level selection through its button so depth, active state and
  // persistence all go through the one code path. No-op when the document is
  // shallower than the saved level.
  function clickLevelSelection(selection: number | "all"): void {
    const btn =
      selection === "all"
        ? levelsContainer.querySelector<HTMLButtonElement>('button[data-action="expand-all"]')
        : levelsContainer.querySelector<HTMLButtonElement>(
            `button[data-level="${selection}"]`
          );
    btn?.click();
  }

  // Restore this origin's saved view before the tree mounts so the default
  // view never flashes. Rendering skips while the tree is hidden; setView
  // refreshes it on the way back. A saved "table" only applies if this
  // document is tabular — the same origin can serve non-array payloads.
  if (
    originPrefs.view !== undefined &&
    originPrefs.view in views &&
    (originPrefs.view !== "table" || checkTableEligibility(data).eligible)
  ) {
    setView(originPrefs.view);
  }

  originalSearchIndex = createSearchIndexFor(model);
  await mountTree(model, originalSearchIndex);

  // Reapply this origin's saved depth (skipping the write — the payload
  // matches what was just loaded).
  if (originPrefs.level !== undefined) clickLevelSelection(originPrefs.level);

  tree.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains("jv-toggle") || target.classList.contains("jv-preview")) {
      const line = target.closest<HTMLElement>(".jv-line");
      if (line) {
        void treeView.toggleNode(Number(line.dataset.nodeId));
        levelsContainer.querySelectorAll("button").forEach((b) =>
          b.classList.remove("jv-active")
        );
      }
    }

    if (target.classList.contains("jv-action-children")) {
      const line = target.closest<HTMLElement>(".jv-line");
      if (line) {
        void treeView.toggleAllChildren(Number(line.dataset.nodeId));
      }
    }

    if (target.classList.contains("jv-action-copy-node")) {
      const line = target.closest<HTMLElement>(".jv-line");
      if (!line) return;

      const selectedValue = treeView.getNodeValue(Number(line.dataset.nodeId));
      navigator.clipboard.writeText(JSON.stringify(selectedValue, null, 2));

      const originalLabel = target.textContent;
      target.textContent = "copied!";
      setTimeout(() => {
        target.textContent = originalLabel;
      }, 1000);
    }
  });

  function ensureViewContent(name: string) {
    if (loadedViews.has(name)) return;

    if (name === "table") {
      tableView?.dispose();
      tableView = createTableView(tableEl, currentDocument() as JsonValue[], {
        scrollContainer: content,
      });
    } else if (name === "formatted") {
      formattedEl.textContent = getPrettyRaw();
    } else if (name === "raw") {
      rawEl.textContent = raw;
    } else if (name === "schema") {
      schemaEl.textContent = toJsonSchema(data);
    }

    loadedViews.add(name);
  }

  function copyLabelText(): string {
    return currentView === "schema" ? "Copy JSON Schema" : "Copy JSON";
  }

  function setView(name: string) {
    if (name === currentView) return;
    viewScrollTops[currentView] = content.scrollTop;
    currentView = name;
    ensureViewContent(name);
    copyLabel.textContent = copyLabelText();
    viewBtns.forEach((btn) => btn.classList.toggle("jv-active", btn.dataset.view === name));
    Object.entries(views).forEach(([key, el]) => {
      el.classList.toggle("jv-active", key === name);
      el.classList.toggle("jv-hidden", key !== name);
    });
    content.scrollTop = viewScrollTops[name] ?? 0;
    // Window renders are skipped while the tree is hidden, so re-render it
    // for the restored scroll position on return. Same for the table.
    if (name === "tree" && treeMounted) treeView.refresh();
    if (name === "table") tableView?.refresh();
    persistOriginPrefs();
  }

  viewBtns.forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view!));
  });

  const tableBtn = document.querySelector<HTMLButtonElement>(
    '.jv-view-btn[data-view="table"]'
  )!;

  function updateTableAvailability(): void {
    const eligibility = checkTableEligibility(currentDocument());
    tableBtn.disabled = !eligibility.eligible;
    tableBtn.title = eligibility.reason ?? "View as a sortable table";
  }

  // The table shows whichever document is on screen, so a query swap (or
  // restore) rebuilds it and re-checks whether the new root is tabular.
  function refreshTableForDocument(): void {
    loadedViews.delete("table");
    tableView?.dispose();
    tableView = null;
    delete viewScrollTops.table;
    updateTableAvailability();
    if (currentView !== "table") return;
    if (tableBtn.disabled) {
      setView("tree");
    } else {
      content.scrollTop = 0;
      ensureViewContent("table");
    }
  }

  updateTableAvailability();

  // Copy
  function copyJson(): void {
    const contentToCopy =
      currentView === "schema"
        ? schemaEl.textContent!
        : currentView === "raw"
          ? raw
          : (currentView === "tree" || currentView === "table") &&
              activeQueryResult !== null
            ? JSON.stringify(activeQueryResult.result, null, 2)
            : getPrettyRaw();

    navigator.clipboard.writeText(contentToCopy).then(() => {
      copyLabel.textContent = "Copied!";
      copyKbd.classList.add("jv-hidden");
      setTimeout(() => {
        copyLabel.textContent = copyLabelText();
        copyKbd.classList.remove("jv-hidden");
      }, 1000);
    });
  }

  copyBtn.addEventListener("click", copyJson);

  function updateSearchUi() {
    const state = treeView.getSearchState();

    if (!state.query) {
      searchStatus.textContent = "";
    } else if (state.matchCount === 0) {
      searchStatus.textContent = "0 results";
    } else {
      searchStatus.textContent = `${state.activeIndex + 1} of ${state.matchCount}`;
    }

    const hasResults = state.matchCount > 0;
    searchPrevBtn.disabled = !hasResults;
    searchNextBtn.disabled = !hasResults;
    searchClearBtn.disabled = !state.query;
  }

  async function runSearch(query: string) {
    searchTimer = null;
    await treeView.search(query);
    updateSearchUi();
  }

  async function commitSearch(query: string) {
    if (searchTimer !== null) {
      window.clearTimeout(searchTimer);
      searchTimer = null;
    }
    await runSearch(query);
  }

  searchInput.addEventListener("input", () => {
    if (searchTimer !== null) {
      window.clearTimeout(searchTimer);
    }
    searchTimer = window.setTimeout(() => {
      void runSearch(searchInput.value);
    }, 180);
  });

  const searchPanel = document.getElementById("jv-search-panel")!;
  const searchToggleBtn = document.getElementById("jv-search-toggle")!;

  // Declared before the document keydown listener below so the handler never
  // touches them in their temporal dead zone.
  const queryPanel = document.getElementById("jv-query-panel")!;
  const queryToggleBtn = document.getElementById("jv-query-toggle")!;
  const queryInput = document.getElementById("jv-query-input") as HTMLInputElement;
  const queryRunBtn = document.getElementById("jv-query-run")!;
  const queryCloseBtn = document.getElementById("jv-query-close")!;
  const queryError = document.getElementById("jv-query-error")!;
  const queryChip = document.getElementById("jv-query-chip")!;
  const queryChipText = document.getElementById("jv-query-chip-text")!;
  const queryChipClear = document.getElementById("jv-query-chip-clear")!;

  function openSearchPanel(): void {
    // The two panels occupy the same spot under the toolbar — one at a time.
    queryPanel.hidden = true;
    searchPanel.hidden = false;
    searchInput.focus();
    searchInput.select();
  }

  function closeSearchPanel(): void {
    searchPanel.hidden = true;
    if (searchTimer !== null) {
      window.clearTimeout(searchTimer);
      searchTimer = null;
    }
    if (searchInput.value || treeView.getSearchState().query) {
      searchInput.value = "";
      void treeView.clearSearch().then(updateSearchUi);
    }
  }

  searchToggleBtn.addEventListener("click", () => {
    if (searchPanel.hidden) openSearchPanel();
    else closeSearchPanel();
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const currentQuery = treeView.getSearchState().query;
      if (searchInput.value !== currentQuery) {
        void commitSearch(searchInput.value);
      } else {
        void treeView.stepSearch(e.shiftKey ? -1 : 1).then(updateSearchUi);
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSearchPanel();
    }
  });

  searchInput.addEventListener("search", () => {
    void commitSearch(searchInput.value);
  });

  searchPrevBtn.addEventListener("click", () => {
    void treeView.stepSearch(-1).then(updateSearchUi);
  });

  searchNextBtn.addEventListener("click", () => {
    void treeView.stepSearch(1).then(updateSearchUi);
  });

  searchClearBtn.addEventListener("click", () => {
    closeSearchPanel();
  });

  document.addEventListener("keydown", (e) => {
    const cmdOrCtrl = (e.metaKey || e.ctrlKey) && !e.altKey;
    const key = e.key.toLowerCase();

    if (cmdOrCtrl && !e.shiftKey && key === "f" && currentView === "tree") {
      e.preventDefault();
      openSearchPanel();
      return;
    }

    if (cmdOrCtrl && key === "g" && currentView === "tree") {
      e.preventDefault();
      if (treeView.getSearchState().matchCount === 0) {
        openSearchPanel();
        return;
      }
      void treeView.stepSearch(e.shiftKey ? -1 : 1).then(updateSearchUi);
      return;
    }

    if (e.key === "Escape" && !searchPanel.hidden) {
      e.preventDefault();
      closeSearchPanel();
      return;
    }

    if (e.key === "Escape" && !queryPanel.hidden) {
      e.preventDefault();
      closeQueryPanel();
    }
  });

  updateSearchUi();

  // JMESPath query panel
  function showQueryError(message: string): void {
    queryError.textContent = message;
    queryError.hidden = message === "";
  }

  function openQueryPanel(): void {
    // The two panels occupy the same spot under the toolbar — one at a time.
    closeSearchPanel();
    queryPanel.hidden = false;
    queryInput.focus();
    queryInput.select();
  }

  // Hides the input UI only. An active query result stays on screen — the
  // chip's ✕ (or an empty query) is what restores the original document.
  function closeQueryPanel(): void {
    queryPanel.hidden = true;
    showQueryError("");
  }

  async function restoreOriginalTree(): Promise<void> {
    if (activeQueryResult === null) return;
    activeQueryResult = null;
    queryChip.hidden = true;
    showQueryError("");
    resultSearchIndex?.dispose();
    resultSearchIndex = null;
    await mountTree(model, originalSearchIndex!);
    refreshTableForDocument();

    // Put the depth back where the user had it before the query.
    if (originalLevelSelection !== null) clickLevelSelection(originalLevelSelection);
  }

  async function runQueryExpression(): Promise<void> {
    const expression = queryInput.value.trim();
    if (!expression) {
      showQueryError("");
      await restoreOriginalTree();
      return;
    }

    const outcome = runQuery(data, expression);
    if (!outcome.ok) {
      showQueryError(outcome.error);
      return;
    }

    showQueryError("");
    activeQueryResult = { expression, result: outcome.result };
    queryChipText.textContent = `query: ${expression}`;
    queryChip.hidden = false;
    const resultModel = buildTreeModel(outcome.result);
    resultSearchIndex?.dispose();
    resultSearchIndex = createSearchIndexFor(resultModel);
    await mountTree(resultModel, resultSearchIndex);
    refreshTableForDocument();
  }

  queryToggleBtn.addEventListener("click", () => {
    if (queryPanel.hidden) openQueryPanel();
    else closeQueryPanel();
  });

  queryRunBtn.addEventListener("click", () => {
    void runQueryExpression();
  });

  queryCloseBtn.addEventListener("click", () => {
    closeQueryPanel();
  });

  queryChipClear.addEventListener("click", () => {
    void restoreOriginalTree();
  });

  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runQueryExpression();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeQueryPanel();
    }
  });

  const modeIcons: Record<ThemeMode, string> = { auto: "◐", dark: "☾", light: "☀" };
  const themeToggleBtn = document.getElementById("jv-theme-toggle")!;

  function updateModeButton(): void {
    themeToggleBtn.textContent = modeIcons[themeState.mode];
    themeToggleBtn.title = `Theme mode: ${themeState.mode}`;
  }

  themeToggleBtn.addEventListener("click", async () => {
    themeState.mode =
      themeState.mode === "auto" ? "dark" : themeState.mode === "dark" ? "light" : "auto";
    await storageSet("jv-theme-mode", themeState.mode);
    updateModeButton();
    applyTheme();
  });

  updateModeButton();

  const settingsToggle = document.getElementById("jv-settings-toggle")!;
  const settingsMenu = document.getElementById("jv-settings-menu")!;
  settingsToggle.addEventListener("click", () => {
    settingsMenu.classList.toggle("jv-open");
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("#jv-settings")) {
      settingsMenu.classList.remove("jv-open");
    }
  });

  const darkSelect = document.getElementById("jv-theme-dark-select") as HTMLSelectElement;
  const lightSelect = document.getElementById("jv-theme-light-select") as HTMLSelectElement;
  const pasteArea = document.getElementById("jv-theme-paste") as HTMLTextAreaElement;
  const addThemeBtn = document.getElementById("jv-theme-add")!;
  const themeError = document.getElementById("jv-theme-error")!;
  const customList = document.getElementById("jv-custom-list")!;

  function fillThemeSelect(
    select: HTMLSelectElement,
    variant: "dark" | "light",
    activeId: string
  ): void {
    select.innerHTML = "";
    for (const scheme of allSchemes().filter((s) => s.variant === variant)) {
      const option = document.createElement("option");
      option.value = scheme.id;
      option.textContent = scheme.name;
      option.selected = scheme.id === activeId;
      select.appendChild(option);
    }
  }

  function renderThemeControls(): void {
    fillThemeSelect(darkSelect, "dark", themeState.darkId);
    fillThemeSelect(lightSelect, "light", themeState.lightId);

    customList.innerHTML = "";
    for (const scheme of themeState.customs) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${scheme.name} (${scheme.variant})`;
      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "✕";
      deleteBtn.title = `Delete ${scheme.name}`;
      deleteBtn.addEventListener("click", () => void deleteCustomTheme(scheme.id));
      item.append(label, deleteBtn);
      customList.appendChild(item);
    }
  }

  async function saveCustomThemes(): Promise<void> {
    await storageSet("jv-custom-themes", JSON.stringify(themeState.customs));
  }

  async function deleteCustomTheme(id: string): Promise<void> {
    themeState.customs = themeState.customs.filter((s) => s.id !== id);
    if (themeState.darkId === id) {
      themeState.darkId = DEFAULT_DARK_ID;
      await storageSet("jv-theme-dark", themeState.darkId);
    }
    if (themeState.lightId === id) {
      themeState.lightId = DEFAULT_LIGHT_ID;
      await storageSet("jv-theme-light", themeState.lightId);
    }
    await saveCustomThemes();
    renderThemeControls();
    applyTheme();
  }

  darkSelect.addEventListener("change", () => {
    themeState.darkId = darkSelect.value;
    void storageSet("jv-theme-dark", themeState.darkId);
    applyTheme();
  });

  lightSelect.addEventListener("change", () => {
    themeState.lightId = lightSelect.value;
    void storageSet("jv-theme-light", themeState.lightId);
    applyTheme();
  });

  addThemeBtn.addEventListener("click", () => void addCustomTheme());

  async function addCustomTheme(): Promise<void> {
    themeError.textContent = "";
    let scheme: Base16Scheme;
    try {
      scheme = parseScheme(pasteArea.value);
    } catch (error) {
      themeError.textContent =
        error instanceof Error ? error.message : "Invalid scheme";
      return;
    }

    const existingIds = new Set(allSchemes().map((s) => s.id));
    let candidateId = scheme.id;
    let suffix = 2;
    while (existingIds.has(candidateId)) {
      candidateId = `${scheme.id}-${suffix++}`;
    }
    scheme.id = candidateId;

    themeState.customs.push(scheme);
    if (scheme.variant === "dark") {
      themeState.darkId = scheme.id;
      await storageSet("jv-theme-dark", scheme.id);
    } else {
      themeState.lightId = scheme.id;
      await storageSet("jv-theme-light", scheme.id);
    }
    await saveCustomThemes();
    pasteArea.value = "";
    renderThemeControls();
    applyTheme();
  }

  renderThemeControls();

  // Keyboard shortcuts
  const shortcuts: Record<string, () => void> = {
    c: copyJson,
    q: openQueryPanel,
  };

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const active = document.activeElement as HTMLElement | null;
    if (active?.matches('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;

    // Number keys collapse the tree to that depth (1-8); 0 expands all.
    // Reuses the level buttons' own click handlers so behavior stays in sync.
    if (/^[0-9]$/.test(e.key)) {
      const levelButton =
        e.key === "0"
          ? levelsContainer.querySelector<HTMLButtonElement>('button[data-action="expand-all"]')
          : levelsContainer.querySelector<HTMLButtonElement>(`button[data-level="${e.key}"]`);
      if (levelButton) {
        e.preventDefault();
        levelButton.click();
      }
      return;
    }

    const action = shortcuts[e.key.toLowerCase()];
    if (!action) return;

    e.preventDefault();
    action();
  });

  // Delegate so hover-path keeps working after the tree view is swapped
  // (query result / restore re-create `treeView`).
  setupHoverPath(
    tree,
    {
      getAncestorIds: (nodeId) => treeView.getAncestorIds(nodeId),
      getRowElement: (nodeId) => treeView.getRowElement(nodeId),
    },
    pathText,
    pathDisplay,
    pathCopyBtn
  );
  window.addEventListener("pagehide", () => {
    originalSearchIndex?.dispose();
    resultSearchIndex?.dispose();
  });

  injectPageData(raw);
}

function injectPageData(raw: string): void {
  try {
    const holder = document.createElement("script");
    holder.type = "application/json";
    holder.id = "jv-json-data";
    holder.textContent = raw;
    document.documentElement.appendChild(holder);

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-script.js");
    document.documentElement.appendChild(script);
  } catch {
    // Sandboxed frames block script injection — window.data won't be available
  }
}

init();
