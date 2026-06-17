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
  DEFAULT_THEME_ID,
  parseScheme,
  schemeToCssVars,
  type Base16Scheme,
} from "./themes";
import { runQuery } from "./query";
import {
  JMESPATH_FUNCTIONS,
  collectKeyUniverse,
  suggestAt,
  toJmespath,
  type KeySuggestion,
  type ValueKind,
} from "./query-suggest";
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
import {
  parseWithExactNumbers,
  stringifyWithExactNumbers,
  type ExactNumberMap,
} from "./lossless-numbers";
import "./styles/viewer.css";

const LARGE_TREE_NODE_THRESHOLD = 8000;
const LARGE_TREE_INITIAL_EXPANSION_DEPTH = 2;

function detectJSON(): {
  data: JsonValue;
  raw: string;
  exactNumbers: ExactNumberMap | null;
} | null {
  const pre = document.querySelector("body > pre");
  const isPlainBody =
    document.body.children.length === 1 && pre instanceof HTMLPreElement;
  const hasJSONContentType = (document.contentType || "").includes("json");

  if (!isPlainBody && !hasJSONContentType) return null;

  const raw = (pre ? pre.textContent : document.body.textContent || "")!.trim();
  if (!raw) return null;

  try {
    const { data, exactNumbers } = parseWithExactNumbers(raw);
    if (data === null || typeof data !== "object") return null;
    return { data, raw, exactNumbers };
  } catch {
    return null;
  }
}

async function storageSet(key: string, value: string): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

const REMEMBER_QUERY_KEY = "jv-remember-query";
const RECENT_QUERY_CAP = 10;

interface ThemeState {
  themeId: string;
  customs: Base16Scheme[];
}

async function loadThemeState(): Promise<ThemeState> {
  // One-time migration from the old { mode, darkId, lightId } model to a single
  // themeId. Also clears the older jv-theme / jv-custom-cursor keys.
  const legacy = await chrome.storage.local.get([
    "jv-theme",
    "jv-custom-cursor",
    "jv-theme-mode",
    "jv-theme-dark",
    "jv-theme-light",
    "jv-theme-id",
  ]);

  let themeId = legacy["jv-theme-id"] as string | undefined;

  if (typeof themeId !== "string") {
    // Derive the single id from whatever the old model would have shown.
    const mode =
      (legacy["jv-theme-mode"] as string | undefined) ??
      (legacy["jv-theme"] as string | undefined);
    // DEFAULT_DARK_ID / DEFAULT_LIGHT_ID are migration fallbacks only.
    const darkId = (legacy["jv-theme-dark"] as string | undefined) ?? DEFAULT_DARK_ID;
    const lightId = (legacy["jv-theme-light"] as string | undefined) ?? DEFAULT_LIGHT_ID;
    if (mode === "light") {
      themeId = lightId;
    } else if (mode === "dark") {
      themeId = darkId;
    } else {
      // auto or unset: pick by OS preference, read once.
      themeId = window.matchMedia("(prefers-color-scheme: light)").matches
        ? lightId
        : darkId;
    }
    await chrome.storage.local.set({ "jv-theme-id": themeId });
  }

  // Remove every superseded key.
  const stale = [
    "jv-theme",
    "jv-custom-cursor",
    "jv-theme-mode",
    "jv-theme-dark",
    "jv-theme-light",
  ].filter((key) => key in legacy);
  if (stale.length > 0) {
    await chrome.storage.local.remove(stale);
  }

  const stored = await chrome.storage.local.get({ "jv-custom-themes": "[]" });
  let customs: Base16Scheme[] = [];
  try {
    const parsed = JSON.parse(stored["jv-custom-themes"] as string) as unknown;
    if (Array.isArray(parsed)) customs = parsed as Base16Scheme[];
  } catch {
    // Corrupted storage — start with no custom themes.
  }

  return { themeId, customs };
}

async function init(): Promise<void> {
  const result = detectJSON();
  if (!result) return;

  const { data, raw, exactNumbers } = result;
  let prettyRaw: string | null = null;

  function getPrettyRaw(): string {
    if (prettyRaw === null) {
      prettyRaw = stringifyWithExactNumbers(data, exactNumbers, 2);
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
      <span id="jv-path-display"><span id="jv-path-text"></span><button id="jv-path-query" title="Query from here">Query</button><button id="jv-path-copy" title="Copy path">Copy</button></span>
      <div id="jv-levels"></div>
      <button id="jv-search-toggle" title="Search (⌘F)">⌕</button>
      <button id="jv-query-toggle" title="Query (JMESPath) (Q)">ƒ</button>
      <span id="jv-query-chip" hidden><span id="jv-query-chip-text" title="Edit query"></span><button id="jv-query-chip-clear" title="Clear query">✕</button></span>
      <div id="jv-view-picker">
        <button class="jv-view-btn jv-active" data-view="tree">Tree</button>
        <span class="jv-tip"><button class="jv-view-btn" data-view="table">Table</button></span>
        <button class="jv-view-btn" data-view="formatted">Formatted</button>
        <button class="jv-view-btn" data-view="raw">Raw</button>
        <button class="jv-view-btn" data-view="schema">Schema</button>
      </div>
      <span id="jv-render-status"></span>
      <button id="jv-copy"><span class="jv-copy-label">Copy JSON</span><kbd class="jv-kbd">C</kbd></button>
      <div id="jv-settings">
        <button id="jv-settings-toggle" title="Settings">⚙</button>
        <div id="jv-settings-menu">
          <div class="jv-settings-row"><span>Theme</span><select id="jv-theme-select"></select></div>
          <textarea id="jv-theme-paste" placeholder="Paste a base16 scheme (YAML or JSON)" spellcheck="false"></textarea>
          <div class="jv-settings-row">
            <a id="jv-theme-browse" href="https://github.com/tinted-theming/schemes" target="_blank" rel="noreferrer">Find more themes</a>
            <button id="jv-theme-add">Add theme</button>
          </div>
          <div id="jv-theme-error"></div>
          <ul id="jv-custom-list"></ul>
          <div class="jv-settings-row jv-settings-check">
            <label for="jv-remember-query">Remember queries</label>
            <input type="checkbox" id="jv-remember-query">
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
        <ul id="jv-query-suggest" hidden></ul>
      </div>
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
  // Whether to remember the last query per origin. Global (like theme), since
  // it's a personal preference, not a property of any one document. On by
  // default; only an explicit "0" (the user toggled it off) disables it.
  const rememberQueryStored = await chrome.storage.local.get({ [REMEMBER_QUERY_KEY]: "1" });
  let rememberQuery = rememberQueryStored[REMEMBER_QUERY_KEY] !== "0";

  function allSchemes(): Base16Scheme[] {
    return [...BUILTIN_SCHEMES, ...themeState.customs];
  }

  function resolveScheme(): Base16Scheme {
    return (
      allSchemes().find((s) => s.id === themeState.themeId) ??
      BUILTIN_SCHEMES.find((s) => s.id === DEFAULT_THEME_ID)!
    );
  }

  function applyTheme(): void {
    const scheme = resolveScheme();
    for (const [name, value] of Object.entries(schemeToCssVars(scheme))) {
      root.style.setProperty(name, value);
    }
    // Overscroll area behind the viewer follows the toolbar color.
    document.documentElement.style.background = scheme.palette.base01;
  }

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
  const pathQueryBtn = document.getElementById("jv-path-query")!;
  const searchInput = document.getElementById("jv-search-input") as HTMLInputElement;
  const searchStatus = document.getElementById("jv-search-status")!;
  const searchPrevBtn = document.getElementById("jv-search-prev") as HTMLButtonElement;
  const searchNextBtn = document.getElementById("jv-search-next") as HTMLButtonElement;
  const searchClearBtn = document.getElementById("jv-search-clear") as HTMLButtonElement;
  // Grabbed early: setView runs before the search wiring below and checks
  // whether the panel is open.
  const searchPanel = document.getElementById("jv-search-panel")!;
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
  const model = buildTreeModel(data, exactNumbers);
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
  // Recent JMESPath queries for this origin, most-recent-first. Seeded from
  // saved prefs; mutated as queries run and pruned to RECENT_QUERY_CAP.
  let recentQueries: string[] = (originPrefs.recentQueries ?? []).slice();

  // Persists the current view and last explicit level pick for this origin.
  function persistOriginPrefs(): void {
    const prefs: OriginPrefs = { view: currentView };
    if (originalLevelSelection !== null) prefs.level = originalLevelSelection;
    // Persist queries only while "remember queries" is on; turning it off
    // drops both the active query and the history on the next write.
    if (rememberQuery) {
      if (activeQueryResult !== null) prefs.query = activeQueryResult.expression;
      if (recentQueries.length > 0) prefs.recentQueries = recentQueries.slice();
    }
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

      const nodeId = Number(line.dataset.nodeId);
      // Exact source text for precision-lossy numbers; containers keep their
      // preserved descendants too since they share holders with `data`.
      const selectedValue = treeView.getNodeValue(nodeId);
      navigator.clipboard.writeText(
        treeView.getNodeNumberText(nodeId) ??
          stringifyWithExactNumbers(selectedValue, exactNumbers, 2)
      );

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
        exactNumbers,
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
    // An open search follows the active view: the table filters on whatever
    // is typed, and the tree re-syncs its matches if the query changed while
    // it was hidden. (setFilter/commitSearch no-op on an unchanged query.)
    if (!searchPanel.hidden) {
      if (name === "table" && tableView !== null) {
        tableView.setFilter(searchInput.value);
        updateSearchUi();
      } else if (name === "tree" && treeMounted) {
        if (searchInput.value !== treeView.getSearchState().query) {
          void commitSearch(searchInput.value);
        } else {
          updateSearchUi();
        }
      }
    }
    persistOriginPrefs();
  }

  viewBtns.forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view!));
  });

  const tableBtn = document.querySelector<HTMLButtonElement>(
    '.jv-view-btn[data-view="table"]'
  )!;
  const tableTip = tableBtn.closest<HTMLElement>(".jv-tip")!;

  function updateTableAvailability(): void {
    const eligibility = checkTableEligibility(currentDocument());
    tableBtn.disabled = !eligibility.eligible;
    tableBtn.title = eligibility.reason ?? "View as a sortable table";
    // Disabled buttons suppress native title + hover, so the reason is shown
    // via a CSS tooltip on the (non-disabled) wrapper instead.
    if (eligibility.reason) {
      tableTip.dataset.tip = eligibility.reason;
    } else {
      delete tableTip.dataset.tip;
    }
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
      // The rebuilt table starts unfiltered and mountTree cleared the input;
      // refresh the status so no stale row count lingers.
      updateSearchUi();
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
            ? stringifyWithExactNumbers(activeQueryResult.result, exactNumbers, 2)
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
    // Table search is a row filter, not match-jumping: no prev/next stepping,
    // and the status reads filtered/total rows.
    if (currentView === "table" && tableView !== null) {
      const state = tableView.getFilterState();
      searchStatus.textContent = state.query
        ? `${state.shown} of ${state.total} row${state.total === 1 ? "" : "s"}`
        : "";
      searchPrevBtn.disabled = true;
      searchNextBtn.disabled = true;
      return;
    }

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
  }

  async function runSearch(query: string) {
    searchTimer = null;
    if (currentView === "table" && tableView !== null) {
      tableView.setFilter(query);
    } else {
      await treeView.search(query);
    }
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
  const querySuggestList = document.getElementById("jv-query-suggest")!;

  function openSearchPanel(): void {
    // Only one popup at a time: close the query panel and settings menu.
    queryPanel.hidden = true;
    closeSettingsMenu();
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
    if (tableView !== null && tableView.getFilterState().query) {
      tableView.setFilter("");
      updateSearchUi();
    }
  }

  searchToggleBtn.addEventListener("click", () => {
    if (searchPanel.hidden) openSearchPanel();
    else closeSearchPanel();
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Filter mode has no match stepping; Enter just commits the query.
      if (currentView === "table") {
        void commitSearch(searchInput.value);
        return;
      }
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

    if (
      cmdOrCtrl &&
      !e.shiftKey &&
      key === "f" &&
      (currentView === "tree" || currentView === "table")
    ) {
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

  // Autocomplete state. The key universe is built lazily on the first panel
  // open and cached for the document's lifetime; it reflects the ORIGINAL
  // document, never a query-result swap. Suggestions are a capped prefix scan
  // over those keys plus a static function list — no jmespath parsing.
  let keyUniverse: string[] | null = null;
  // The dropdown shows either contextual key suggestions (while typing) or the
  // recent-query history (when the field is empty) — one mode at a time.
  type SuggestEntry =
    | ({ type: "key" } & KeySuggestion)
    | { type: "recent"; query: string };
  let suggestItems: SuggestEntry[] = [];
  let suggestActive = -1;
  let suggestTokenStart = 0;

  function suggestOpen(): boolean {
    return !querySuggestList.hidden;
  }

  function hideSuggest(): void {
    querySuggestList.hidden = true;
    querySuggestList.replaceChildren();
    suggestItems = [];
    suggestActive = -1;
  }

  function renderKeyItem(item: HTMLLIElement, entry: { name: string; kind: ValueKind }): void {
    const name = document.createElement("span");
    name.className = "jv-query-suggest-name";
    name.textContent = entry.name;
    item.appendChild(name);
    if (entry.kind === "array") {
      // A badge marks array-valued keys so the user knows to bracket in.
      const badge = document.createElement("span");
      badge.className = "jv-query-suggest-badge";
      badge.textContent = "[ ]";
      item.appendChild(badge);
    }
  }

  function renderRecentItem(item: HTMLLIElement, query: string): void {
    item.classList.add("jv-query-suggest-recent");
    const glyph = document.createElement("span");
    glyph.className = "jv-query-suggest-glyph";
    glyph.textContent = "↺";
    glyph.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "jv-query-suggest-name";
    text.textContent = query;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "jv-query-suggest-del";
    del.title = "Remove from history";
    del.setAttribute("aria-label", `Remove ${query} from history`);
    del.textContent = "×";
    del.addEventListener("mousedown", (e) => {
      // Stop the item's own mousedown (which would run the query) and the
      // input blur, then drop just this entry.
      e.preventDefault();
      e.stopPropagation();
      removeRecent(query);
    });
    item.append(glyph, text, del);
  }

  function renderSuggest(): void {
    querySuggestList.replaceChildren();
    const recentsMode = suggestItems[0]?.type === "recent";
    if (recentsMode) {
      const header = document.createElement("li");
      header.className = "jv-query-suggest-section";
      header.textContent = "Recent queries";
      querySuggestList.appendChild(header);
    }
    suggestItems.forEach((entry, i) => {
      const item = document.createElement("li");
      item.className = "jv-query-suggest-item";
      if (i === suggestActive) item.classList.add("jv-active");
      if (entry.type === "recent") renderRecentItem(item, entry.query);
      else renderKeyItem(item, entry);
      item.addEventListener("mousedown", (e) => {
        // mousedown (not click) so the input never loses focus first.
        e.preventDefault();
        acceptSuggest(i);
      });
      querySuggestList.appendChild(item);
    });
    querySuggestList.hidden = suggestItems.length === 0;
  }

  function updateSuggest(): void {
    if (keyUniverse === null) return;
    const value = queryInput.value;
    // Empty field: surface the recent-query history (when remembering is on).
    if (value.trim() === "") {
      if (!rememberQuery || recentQueries.length === 0) {
        hideSuggest();
        return;
      }
      suggestTokenStart = 0;
      suggestItems = recentQueries.map((query) => ({ type: "recent", query }));
      suggestActive = 0;
      renderSuggest();
      return;
    }
    const caret = queryInput.selectionStart ?? value.length;
    // Resolve suggestions against the ORIGINAL document, contextual to the path
    // typed so far; keyUniverse is the flat fallback for unresolvable paths.
    const { items, start } = suggestAt(value, caret, data, keyUniverse, JMESPATH_FUNCTIONS);
    if (items.length === 0) {
      hideSuggest();
      return;
    }
    suggestTokenStart = start;
    suggestItems = items.map((i) => ({ type: "key", name: i.name, kind: i.kind }));
    suggestActive = 0;
    renderSuggest();
  }

  function moveSuggest(delta: number): void {
    if (suggestItems.length === 0) return;
    suggestActive =
      (suggestActive + delta + suggestItems.length) % suggestItems.length;
    renderSuggest();
  }

  function acceptSuggest(index: number): void {
    const entry = suggestItems[index];
    if (entry === undefined) return;
    if (entry.type === "recent") {
      // Re-run a past query: fill the input and execute it straight away.
      queryInput.value = entry.query;
      const end = entry.query.length;
      queryInput.setSelectionRange(end, end);
      hideSuggest();
      queryInput.focus();
      void runQueryExpression();
      return;
    }
    const chosen = entry.name;
    const caret = queryInput.selectionStart ?? queryInput.value.length;
    const before = queryInput.value.slice(0, suggestTokenStart);
    const after = queryInput.value.slice(caret);
    // Functions get an open paren; array keys get a `[*]` projection so the
    // user can immediately descend (`.`) or swap the `*` for an index/filter;
    // plain keys go in as-is. The caret lands right after the insertion.
    let insertion: string;
    if (JMESPATH_FUNCTIONS.includes(chosen)) insertion = `${chosen}(`;
    else if (entry.kind === "array") insertion = `${chosen}[*]`;
    else insertion = chosen;
    queryInput.value = before + insertion + after;
    const newCaret = before.length + insertion.length;
    queryInput.setSelectionRange(newCaret, newCaret);
    hideSuggest();
    queryInput.focus();
  }

  // History maintenance: most-recent-first, deduped, capped. Pushing is gated
  // on the toggle; removing curates the list and re-renders the dropdown.
  function pushRecentQuery(expression: string): void {
    if (!rememberQuery) return;
    recentQueries = [
      expression,
      ...recentQueries.filter((q) => q !== expression),
    ].slice(0, RECENT_QUERY_CAP);
  }

  function removeRecent(query: string): void {
    recentQueries = recentQueries.filter((q) => q !== query);
    persistOriginPrefs();
    updateSuggest();
  }

  function openQueryPanel(): void {
    // Only one popup at a time: close the search panel and settings menu.
    closeSearchPanel();
    closeSettingsMenu();
    // Build the key universe once, from the ORIGINAL document, on first open.
    if (keyUniverse === null) keyUniverse = collectKeyUniverse(model);
    queryPanel.hidden = false;
    queryInput.focus();
    queryInput.select();
  }

  // Hides the input UI only. An active query result stays on screen — the
  // chip's ✕ (or an empty query) is what restores the original document.
  function closeQueryPanel(): void {
    queryPanel.hidden = true;
    hideSuggest();
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
    // Cleared query: drop it from this origin's saved prefs.
    persistOriginPrefs();

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
    // Query results reuse holders from `data` where JMESPath passed them
    // through, so preserved numbers survive in unprojected subtrees.
    const resultModel = buildTreeModel(outcome.result, exactNumbers);
    resultSearchIndex?.dispose();
    resultSearchIndex = createSearchIndexFor(resultModel);
    await mountTree(resultModel, resultSearchIndex);
    refreshTableForDocument();
    // Remember this query (and add it to history) for the origin when on.
    pushRecentQuery(expression);
    persistOriginPrefs();
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

  // Clicking the chip's text reopens the panel seeded with the active query so
  // it can be edited and re-run (the ✕ button still clears).
  queryChipText.addEventListener("click", () => {
    if (activeQueryResult === null) return;
    queryInput.value = activeQueryResult.expression;
    openQueryPanel();
    const end = queryInput.value.length;
    queryInput.setSelectionRange(end, end);
  });

  // "Query from here": translate the shown node path to JMESPath, seed the
  // input, open the panel and reuse the existing run path to render the result.
  pathQueryBtn.addEventListener("click", () => {
    const path = pathText.textContent;
    if (!path) return;
    queryInput.value = toJmespath(path);
    openQueryPanel();
    const end = queryInput.value.length;
    queryInput.setSelectionRange(end, end);
    void runQueryExpression();
  });

  queryInput.addEventListener("input", () => {
    updateSuggest();
  });

  queryInput.addEventListener("focus", () => {
    // Surface recent queries when the field is empty; typing switches to keys.
    if (queryInput.value.trim() === "") updateSuggest();
  });

  queryInput.addEventListener("blur", () => {
    hideSuggest();
  });

  queryInput.addEventListener("keydown", (e) => {
    // While the dropdown is open it owns the arrows, Enter/Tab (accept) and
    // Escape (close just the dropdown). Closed, the original bindings stand.
    if (suggestOpen()) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSuggest(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSuggest(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptSuggest(suggestActive);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        hideSuggest();
        return;
      }
    }

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

  const settingsToggle = document.getElementById("jv-settings-toggle")!;
  const settingsMenu = document.getElementById("jv-settings-menu")!;
  function closeSettingsMenu(): void {
    settingsMenu.classList.remove("jv-open");
  }
  settingsToggle.addEventListener("click", () => {
    const willOpen = !settingsMenu.classList.contains("jv-open");
    settingsMenu.classList.toggle("jv-open");
    // Only one popup at a time: opening settings closes the search/query panels.
    if (willOpen) {
      closeSearchPanel();
      closeQueryPanel();
    }
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("#jv-settings")) {
      closeSettingsMenu();
    }
  });

  const rememberQueryCheck = document.getElementById(
    "jv-remember-query"
  ) as HTMLInputElement;
  rememberQueryCheck.checked = rememberQuery;
  rememberQueryCheck.addEventListener("change", () => {
    rememberQuery = rememberQueryCheck.checked;
    void storageSet(REMEMBER_QUERY_KEY, rememberQuery ? "1" : "0");
    // Persist now so toggling on saves the current query and toggling off
    // drops it immediately.
    persistOriginPrefs();
  });

  const themeSelect = document.getElementById("jv-theme-select") as HTMLSelectElement;
  const pasteArea = document.getElementById("jv-theme-paste") as HTMLTextAreaElement;
  const addThemeBtn = document.getElementById("jv-theme-add")!;
  const themeError = document.getElementById("jv-theme-error")!;
  const customList = document.getElementById("jv-custom-list")!;

  function fillThemeGroup(variant: "dark" | "light", label: string): HTMLOptGroupElement {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const scheme of allSchemes().filter((s) => s.variant === variant)) {
      const option = document.createElement("option");
      option.value = scheme.id;
      option.textContent = scheme.name;
      option.selected = scheme.id === themeState.themeId;
      group.appendChild(option);
    }
    return group;
  }

  function renderThemeControls(): void {
    themeSelect.innerHTML = "";
    themeSelect.appendChild(fillThemeGroup("dark", "Dark"));
    themeSelect.appendChild(fillThemeGroup("light", "Light"));

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
    if (themeState.themeId === id) {
      themeState.themeId = DEFAULT_THEME_ID;
      await storageSet("jv-theme-id", themeState.themeId);
    }
    await saveCustomThemes();
    renderThemeControls();
    applyTheme();
  }

  themeSelect.addEventListener("change", () => {
    themeState.themeId = themeSelect.value;
    void storageSet("jv-theme-id", themeState.themeId);
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
    themeState.themeId = scheme.id;
    await storageSet("jv-theme-id", scheme.id);
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

  // Restore a remembered query for this origin: seed the input and run it. If
  // it errors against changed data, the original document stays on screen.
  if (rememberQuery && originPrefs.query) {
    queryInput.value = originPrefs.query;
    await runQueryExpression();
  }

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
