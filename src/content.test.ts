// @vitest-environment jsdom
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { DEFAULT_LIGHT_ID, DEFAULT_THEME_ID } from "./themes";
import { parseWithExactNumbers } from "./lossless-numbers";

// Reviver source access needs V8 11.4+ (Node 21+, Chrome 114+) and re-emitting
// a preserved token needs JSON.rawJSON; below either, the viewer falls back to
// today's lossy behavior, so the exact-number tests are guarded.
const hasReviverSource = parseWithExactNumbers("{}").exactNumbers !== null;
const hasRawJSON =
  typeof (JSON as { rawJSON?: unknown }).rawJSON === "function";

// Spy on collectKeyUniverse through the module so the lazy-build guard can
// observe when (and how often) content.ts builds the key universe. The rest
// of the module keeps its real implementation.
vi.mock("./query-suggest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./query-suggest")>();
  return {
    ...actual,
    collectKeyUniverse: vi.fn(actual.collectKeyUniverse),
  };
});
import { collectKeyUniverse } from "./query-suggest";

// jsdom doesn't implement scrollIntoView; the suggest list calls it to keep the
// keyboard-highlighted item in view. Stub it once for every test in this file.
Element.prototype.scrollIntoView = vi.fn();

// The NDJSON Content-Type test shadows document.contentType with an own
// property. Deleting it uncovers jsdom's prototype getter again, so the
// override cannot leak into whichever test runs next. A no-op for every other
// test, which never defines the property.
afterEach(() => {
  delete (document as any).contentType;
});

test("each view keeps its own scroll position across switches", async () => {
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (query: Record<string, string>) => query),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  // jsdom has no matchMedia; the theme engine's auto mode needs it.
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  const big = JSON.stringify({
    items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `row ${i}` })),
  });
  document.body.innerHTML = `<pre>${big}</pre>`;

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const content = document.getElementById("jv-content")!;
  const treeBtn = document.querySelector<HTMLElement>('.jv-view-btn[data-view="tree"]')!;
  const rawBtn = document.querySelector<HTMLElement>('.jv-view-btn[data-view="raw"]')!;

  // Scroll the tree, then leave for raw.
  content.scrollTop = 1000;
  content.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  rawBtn.click();

  // Raw starts at its own (fresh) position, not the tree's.
  expect(content.scrollTop).toBe(0);

  // Scroll raw somewhere else entirely.
  content.scrollTop = 4000;
  content.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Back to tree: position restored to where the tree was left.
  treeBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(content.scrollTop).toBe(1000);

  // And raw remembers its own spot too.
  rawBtn.click();
  expect(content.scrollTop).toBe(4000);
});

test("search filters table rows and follows view switches", async () => {
  vi.resetModules();
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (query: Record<string, string>) => query),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  const rows = [
    { name: "Ada", role: "admin" },
    { name: "Grace", role: "user" },
    { name: "Alan", role: "user" },
  ];
  document.body.innerHTML = `<pre>${JSON.stringify(rows)}</pre>`;

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const searchInput = document.getElementById("jv-search-input") as HTMLInputElement;
  const searchStatus = document.getElementById("jv-search-status")!;
  const tableEl = document.getElementById("jv-table")!;
  const treeBtn = document.querySelector<HTMLElement>('.jv-view-btn[data-view="tree"]')!;
  const tableBtn = document.querySelector<HTMLElement>('.jv-view-btn[data-view="table"]')!;
  const visibleTableRows = () =>
    tableEl.querySelectorAll(".jv-table-row:not([hidden])");

  async function type(query: string): Promise<void> {
    searchInput.value = query;
    searchInput.dispatchEvent(new Event("input"));
    // Outlast the 180ms debounce plus the async search itself.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // Search the tree first: tree-style match counter.
  document.getElementById("jv-search-toggle")!.click();
  await type("grace");
  expect(searchStatus.textContent).toBe("1 of 1");

  // Switching to the table turns the open search into a row filter.
  tableBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(searchStatus.textContent).toBe("1 of 3 rows");
  expect(visibleTableRows()).toHaveLength(1);
  expect(visibleTableRows()[0].textContent).toContain("Grace");

  // Typing while the table is active narrows the rows, not the tree.
  await type("user");
  expect(searchStatus.textContent).toBe("2 of 3 rows");
  expect(visibleTableRows()).toHaveLength(2);

  // Back to the tree: the query typed in the meantime is committed there.
  treeBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(searchStatus.textContent).toBe("1 of 2");
  expect(document.querySelectorAll("#jv-tree .jv-search-match").length).toBeGreaterThan(0);

  // Closing the search restores every table row.
  tableBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  document.getElementById("jv-search-clear")!.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(searchStatus.textContent).toBe("");
  expect(visibleTableRows()).toHaveLength(3);
});

test("restores this origin's saved view and level on load", async () => {
  vi.resetModules();
  const store: Record<string, unknown> = {
    [`jv-prefs:${location.origin}`]: { view: "raw", level: 1 },
  };
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (query: string | string[] | Record<string, unknown>) => {
          if (typeof query === "string") {
            return query in store ? { [query]: store[query] } : {};
          }
          if (Array.isArray(query)) {
            const out: Record<string, unknown> = {};
            for (const key of query) if (key in store) out[key] = store[key];
            return out;
          }
          return { ...query };
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  document.body.innerHTML = `<pre>${JSON.stringify({ a: { b: { c: 1 } } })}</pre>`;

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Raw view is active instead of the default tree...
  const rawBtn = document.querySelector<HTMLElement>('.jv-view-btn[data-view="raw"]')!;
  expect(rawBtn.classList.contains("jv-active")).toBe(true);
  expect(document.getElementById("jv-raw")!.classList.contains("jv-active")).toBe(true);
  expect(document.getElementById("jv-tree")!.classList.contains("jv-hidden")).toBe(true);

  // ...and the saved depth is reflected in the level select.
  expect((document.getElementById("jv-level-select") as HTMLSelectElement).value).toBe("1");
});

test("theme picker is a single grouped select with no mode toggle", async () => {
  vi.resetModules();
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (q: any) => (Array.isArray(q) ? {} : q)),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  document.body.innerHTML = `<pre>{"a":1}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(document.getElementById("jv-theme-toggle")).toBeNull();
  expect(document.getElementById("jv-theme-dark-select")).toBeNull();
  expect(document.getElementById("jv-theme-light-select")).toBeNull();

  const select = document.getElementById("jv-theme-select") as HTMLSelectElement;
  expect(select).not.toBeNull();
  const groups = Array.from(select.querySelectorAll("optgroup"));
  expect(groups.map((g) => g.label)).toEqual(["Dark", "Light"]);
  expect(select.value).toBe(DEFAULT_THEME_ID);
});

test("migrates legacy mode/dark/light keys to a single jv-theme-id", async () => {
  vi.resetModules();
  const store: Record<string, unknown> = {
    "jv-theme-mode": "dark",
    "jv-theme-dark": "nord",
    "jv-theme-light": "github-light",
  };
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (q: any) => {
          if (Array.isArray(q)) {
            const out: Record<string, unknown> = {};
            for (const k of q) if (k in store) out[k] = store[k];
            return out;
          }
          if (q && typeof q === "object") {
            const out: Record<string, unknown> = { ...q };
            for (const k of Object.keys(q)) if (k in store) out[k] = store[k];
            return out;
          }
          return {};
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const k of ([] as string[]).concat(keys)) delete store[k];
        }),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  document.body.innerHTML = `<pre>{"a":1}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(store["jv-theme-id"]).toBe("nord");
  expect("jv-theme-mode" in store).toBe(false);
  expect("jv-theme-dark" in store).toBe(false);
  expect("jv-theme-light" in store).toBe(false);

  const select = document.getElementById("jv-theme-select") as HTMLSelectElement;
  expect(select.value).toBe("nord");
});

test("search Close button closes the panel with an empty query", async () => {
  vi.resetModules();
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (q: any) => (Array.isArray(q) ? {} : q)),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  document.body.innerHTML = `<pre>[{"id":1,"name":"a"}]</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const toggle = document.getElementById("jv-search-toggle")!;
  const panel = document.getElementById("jv-search-panel")!;
  const clear = document.getElementById("jv-search-clear") as HTMLButtonElement;

  toggle.click();
  expect(panel.hidden).toBe(false);

  // The × is the Close affordance — it must stay clickable even with no query
  // (mountTree runs updateSearchUi on load, which previously disabled it).
  expect(clear.disabled).toBe(false);

  clear.click();
  expect(panel.hidden).toBe(true);
});

test("disabled Table button exposes the eligibility reason via data-tip", async () => {
  vi.resetModules();
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (q: any) => (Array.isArray(q) ? {} : q)),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  document.body.innerHTML = `<pre>{"a":1}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const tableBtn = document.querySelector<HTMLButtonElement>(
    '.jv-view-btn[data-view="table"]'
  )!;
  expect(tableBtn.disabled).toBe(true);

  const tip = tableBtn.closest<HTMLElement>(".jv-tip")!;
  expect(tip).not.toBeNull();
  expect(tip.dataset.tip).toBe(
    "Table view needs the document root to be an array of objects."
  );
});

test("eligible Table button carries no data-tip", async () => {
  vi.resetModules();
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (q: any) => (Array.isArray(q) ? {} : q)),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  document.body.innerHTML = `<pre>[{"a":1}]</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const tableBtn = document.querySelector<HTMLButtonElement>(
    '.jv-view-btn[data-view="table"]'
  )!;
  expect(tableBtn.disabled).toBe(false);

  const tip = tableBtn.closest<HTMLElement>(".jv-tip")!;
  expect(tip.dataset.tip).toBeUndefined();
});

test("static text views disable depth, search, and query controls", async () => {
  vi.resetModules();
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (q: any) => (Array.isArray(q) ? {} : q)),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  // Array of objects so the Table view is eligible too.
  document.body.innerHTML = `<pre>[{"id":1,"name":"a"}]</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const level = document.getElementById("jv-level-select") as HTMLSelectElement;
  const search = document.getElementById("jv-search-toggle") as HTMLButtonElement;
  const query = document.getElementById("jv-query-toggle") as HTMLButtonElement;
  const queryPanel = document.getElementById("jv-query-panel")!;
  const btn = (view: string) =>
    document.querySelector<HTMLElement>(`.jv-view-btn[data-view="${view}"]`)!;

  // Tree: everything enabled.
  expect(level.disabled).toBe(false);
  expect(search.disabled).toBe(false);
  expect(query.disabled).toBe(false);

  // Formatted/raw/schema: depth, search, and query all disabled.
  for (const view of ["formatted", "raw", "schema"]) {
    btn(view).click();
    expect(level.disabled, view).toBe(true);
    expect(search.disabled, view).toBe(true);
    expect(query.disabled, view).toBe(true);
  }

  // The keyboard shortcut can't bypass the guard either.
  btn("raw").click();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "q" }));
  expect(queryPanel.hidden).toBe(true);

  // Table: search + query back on; depth stays off (a table has no depth).
  btn("table").click();
  expect(level.disabled).toBe(true);
  expect(search.disabled).toBe(false);
  expect(query.disabled).toBe(false);

  // Back to tree: all on again.
  btn("tree").click();
  expect(level.disabled).toBe(false);
  expect(search.disabled).toBe(false);
  expect(query.disabled).toBe(false);
});

// A chrome.storage.local stand-in that actually persists, so query-remember
// round-trips (load → restore, toggle → save) can be observed in one process.
function statefulChrome(initial: Record<string, unknown> = {}): Map<string, unknown> {
  const store = new Map<string, unknown>(Object.entries(initial));
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (q: any) => {
          if (typeof q === "string") return store.has(q) ? { [q]: store.get(q) } : {};
          if (Array.isArray(q)) {
            const out: Record<string, unknown> = {};
            for (const k of q) if (store.has(k)) out[k] = store.get(k);
            return out;
          }
          const out: Record<string, unknown> = {};
          for (const [k, def] of Object.entries(q)) out[k] = store.has(k) ? store.get(k) : def;
          return out;
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const k of ([] as string[]).concat(keys)) store.delete(k);
        }),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  return store;
}

// `rejectStorage` stands in for a storage layer that is gone — the extension
// was reloaded while the tab loaded, or the context was invalidated — so every
// read and write rejects instead of resolving. `onGet` runs synchronously at
// the top of every read, before it settles, so a caller can observe the live
// document at the moment content.ts asks for a preference.
function stubChrome({
  rejectStorage = false,
  onGet,
}: { rejectStorage?: boolean; onGet?: () => void } = {}): void {
  const rejected = () => Promise.reject(new Error("Extension context invalidated."));
  (globalThis as any).chrome = {
    storage: {
      local: rejectStorage
        ? {
            get: vi.fn(() => {
              onGet?.();
              return rejected();
            }),
            set: vi.fn(rejected),
            remove: vi.fn(rejected),
          }
        : {
            get: vi.fn(async (q: any) => {
              onGet?.();
              return Array.isArray(q) ? {} : q;
            }),
            set: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
          },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

test("query autocomplete is lazy, shows matches, accepts, and Escape closes", async () => {
  vi.resetModules();
  stubChrome();
  const collectSpy = collectKeyUniverse as unknown as ReturnType<typeof vi.fn>;
  collectSpy.mockClear();

  document.body.innerHTML = `<pre>${JSON.stringify({
    users: [{ name: "Ada", role: "admin" }],
    settings: { theme: "dark" },
  })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Lazy: the key universe is not built until the query panel opens.
  expect(collectSpy).not.toHaveBeenCalled();

  const queryInput = document.getElementById("jv-query-input") as HTMLInputElement;
  const dropdown = document.getElementById("jv-query-suggest")!;

  // Opening the query panel builds the universe exactly once.
  document.getElementById("jv-query-toggle")!.click();
  expect(collectSpy).toHaveBeenCalledTimes(1);

  // Typing a prefix shows matching suggestions.
  queryInput.value = "se";
  queryInput.selectionStart = 2;
  queryInput.dispatchEvent(new Event("input"));
  const items = dropdown.querySelectorAll(".jv-query-suggest-item");
  expect(items.length).toBeGreaterThan(0);
  expect(Array.from(items).map((el) => el.textContent)).toContain("settings");

  // Clicking a suggestion replaces the token. The handler is on mousedown so
  // the input keeps focus; dispatch mousedown to match.
  (
    Array.from(items).find((el) => el.textContent === "settings") as HTMLElement
  ).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  expect(queryInput.value).toBe("settings");
  expect(dropdown.hidden).toBe(true);

  // Reopening reuses the cached universe (no rebuild).
  document.getElementById("jv-query-toggle")!.click(); // close
  document.getElementById("jv-query-toggle")!.click(); // open
  expect(collectSpy).toHaveBeenCalledTimes(1);

  // Typing then Escape closes the dropdown without closing the panel.
  queryInput.value = "us";
  queryInput.selectionStart = 2;
  queryInput.dispatchEvent(new Event("input"));
  expect(dropdown.hidden).toBe(false);
  queryInput.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  expect(dropdown.hidden).toBe(true);
  expect(document.getElementById("jv-query-panel")!.hidden).toBe(false);
});

test("query-from-here seeds the input with JMESPath and runs the query", async () => {
  vi.resetModules();
  stubChrome();

  document.body.innerHTML = `<pre>${JSON.stringify({
    users: [
      { name: "Ada", role: "admin" },
      { name: "Grace", role: "user" },
    ],
  })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Hover a node so the path chip shows; then click it to pin the path.
  const tree = document.getElementById("jv-tree")!;
  const lines = tree.querySelectorAll<HTMLElement>(".jv-line");
  // Find a line whose path points into the users array (e.g. data.users[0]).
  const target = Array.from(lines).find((l) =>
    (l.dataset.path ?? "").startsWith("data.users")
  )!;
  expect(target).toBeDefined();
  target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

  const pathDisplay = document.getElementById("jv-path-display")!;
  const queryFromHere = document.getElementById("jv-path-query") as HTMLButtonElement;
  expect(queryFromHere).not.toBeNull();
  queryFromHere.click();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const queryInput = document.getElementById("jv-query-input") as HTMLInputElement;
  const queryPanel = document.getElementById("jv-query-panel")!;
  const queryChip = document.getElementById("jv-query-chip")!;

  // The panel opened, the input is seeded with the JMESPath form, and the
  // query ran (chip is showing the active query).
  expect(queryPanel.hidden).toBe(false);
  expect(queryInput.value.startsWith("users")).toBe(true);
  expect(queryChip.hidden).toBe(false);
  expect(document.getElementById("jv-query-chip-text")!.textContent).toContain(
    queryInput.value
  );
  // Path display reference kept alive (chip lives in the toolbar, path bottom-left).
  expect(pathDisplay).not.toBeNull();
});

test("clicking the query chip reopens the editor seeded with the active query", async () => {
  vi.resetModules();
  stubChrome();

  document.body.innerHTML = `<pre>${JSON.stringify({
    users: [{ name: "Ada" }],
  })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const queryInput = document.getElementById("jv-query-input") as HTMLInputElement;
  const queryPanel = document.getElementById("jv-query-panel")!;
  const chip = document.getElementById("jv-query-chip")!;
  const chipText = document.getElementById("jv-query-chip-text")!;

  // Run a query, then close the panel.
  document.getElementById("jv-query-toggle")!.click();
  queryInput.value = "users";
  queryInput.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(chip.hidden).toBe(false);
  document.getElementById("jv-query-close")!.click();
  expect(queryPanel.hidden).toBe(true);

  // Clicking the chip text reopens the panel with the query ready to edit.
  chipText.click();
  expect(queryPanel.hidden).toBe(false);
  expect(queryInput.value).toBe("users");
});

// Runs `expression` through the query panel and waits for the result to mount.
async function runQuery(expression: string): Promise<void> {
  const queryInput = document.getElementById("jv-query-input") as HTMLInputElement;
  document.getElementById("jv-query-toggle")!.click();
  queryInput.value = expression;
  queryInput.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  document.getElementById("jv-query-close")!.click();
}

const viewBtn = (view: string) =>
  document.querySelector<HTMLElement>(`.jv-view-btn[data-view="${view}"]`)!;

test("an active query drives the formatted, raw, and schema views", async () => {
  vi.resetModules();
  stubChrome();
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });

  // Deliberately odd spacing: a re-serialization of the original would not
  // reproduce it, so the restore assertions below can tell the two apart.
  const source = `{"items": [{"id": 1,   "name": "a"}, {"id": 2, "name": "b"}]}`;
  document.body.innerHTML = `<pre>${source}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const formattedEl = document.getElementById("jv-formatted")!;
  const rawEl = document.getElementById("jv-raw")!;
  const schemaEl = document.getElementById("jv-schema")!;
  const rawNote = document.getElementById("jv-raw-note")!;
  const copy = document.getElementById("jv-copy")!;
  const element = { id: 1, name: "a" };

  // Visit every text view first, so each one caches the original document
  // and the query has stale content to invalidate.
  for (const view of ["formatted", "raw", "schema"]) viewBtn(view).click();
  expect(rawEl.textContent).toBe(source);
  expect(rawNote.hidden).toBe(true);

  viewBtn("tree").click();
  await runQuery("items[0]");

  // Formatted: the result, pretty-printed — and Copy agrees with it.
  viewBtn("formatted").click();
  expect(formattedEl.textContent).toBe(JSON.stringify(element, null, 2));
  copy.click();
  expect(writeText).toHaveBeenLastCalledWith(JSON.stringify(element, null, 2));

  // Raw: a serialization of the result, flagged as such since a derived
  // value has no source text of its own.
  viewBtn("raw").click();
  expect(rawEl.textContent).toBe(JSON.stringify(element));
  expect(rawNote.hidden).toBe(false);
  copy.click();
  expect(writeText).toHaveBeenLastCalledWith(JSON.stringify(element));

  // Schema: inferred from the result, not from the whole document.
  viewBtn("schema").click();
  expect(schemaEl.textContent).toContain(`"name"`);
  expect(schemaEl.textContent).not.toContain(`"items"`);
  copy.click();
  expect(writeText).toHaveBeenLastCalledWith(schemaEl.textContent);
});

test("clearing the query restores every view, raw to its source text", async () => {
  vi.resetModules();
  stubChrome();
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });

  const source = `{"items": [{"id": 1,   "name": "a"}, {"id": 2, "name": "b"}]}`;
  document.body.innerHTML = `<pre>${source}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const rawEl = document.getElementById("jv-raw")!;
  const formattedEl = document.getElementById("jv-formatted")!;
  const schemaEl = document.getElementById("jv-schema")!;
  const rawNote = document.getElementById("jv-raw-note")!;

  await runQuery("items[0]");

  // Clear the query from inside the raw view — the chip's ✕ lives in the
  // toolbar, so it is reachable from every view.
  viewBtn("raw").click();
  expect(rawEl.textContent).toBe(JSON.stringify({ id: 1, name: "a" }));
  document.getElementById("jv-query-chip-clear")!.click();
  await new Promise((resolve) => setTimeout(resolve, 80));

  // The original source text, byte for byte — not a re-serialization, which
  // would silently reformat the document.
  expect(rawEl.textContent).toBe(source);
  expect(rawNote.hidden).toBe(true);
  document.getElementById("jv-copy")!.click();
  expect(writeText).toHaveBeenLastCalledWith(source);

  viewBtn("formatted").click();
  expect(formattedEl.textContent).toContain(`"items"`);
  viewBtn("schema").click();
  expect(schemaEl.textContent).toContain(`"items"`);
});

test("a query on NDJSON serializes the result and restores the lines", async () => {
  vi.resetModules();
  stubChrome();

  const source = `{"a":1}\n{"a":2}`;
  document.body.innerHTML = `<pre>${source}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const rawEl = document.getElementById("jv-raw")!;
  const rawNote = document.getElementById("jv-raw-note")!;

  viewBtn("raw").click();
  expect(rawEl.textContent).toBe(source);

  viewBtn("tree").click();
  await runQuery("[1]");
  viewBtn("raw").click();
  expect(rawEl.textContent).toBe(`{"a":2}`);
  expect(rawNote.hidden).toBe(false);

  document.getElementById("jv-query-chip-clear")!.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(rawEl.textContent).toBe(source);
  expect(rawNote.hidden).toBe(true);
});

test("a remembered query is restored and re-run on load", async () => {
  vi.resetModules();
  statefulChrome({
    "jv-remember-query": "1",
    [`jv-prefs:${location.origin}`]: { query: "users" },
  });

  document.body.innerHTML = `<pre>${JSON.stringify({
    users: [{ name: "Ada" }],
  })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect((document.getElementById("jv-remember-query") as HTMLInputElement).checked).toBe(true);
  // The saved query ran automatically: chip shows it, input holds it.
  expect(document.getElementById("jv-query-chip")!.hidden).toBe(false);
  expect(document.getElementById("jv-query-chip-text")!.textContent).toBe("users");
  expect((document.getElementById("jv-query-input") as HTMLInputElement).value).toBe("users");
});

test("remember-query is on by default; toggling off disables future query persistence", async () => {
  vi.resetModules();
  const store = statefulChrome();

  document.body.innerHTML = `<pre>${JSON.stringify({
    users: [{ name: "Ada" }],
  })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const queryInput = document.getElementById("jv-query-input") as HTMLInputElement;
  const check = document.getElementById("jv-remember-query") as HTMLInputElement;
  // Default on with nothing stored, preserving query persistence for fresh users.
  expect(check.checked).toBe(true);

  // Running a query persists it unless the user opts out.
  document.getElementById("jv-query-toggle")!.click();
  queryInput.value = "users";
  queryInput.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const prefsKey = `jv-prefs:${location.origin}`;
  expect((store.get(prefsKey) as { query?: string }).query).toBe("users");

  // Toggling off persists the opt-out and prevents later queries from being remembered.
  check.click();
  queryInput.value = "users[*].name";
  queryInput.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(store.get("jv-remember-query")).toBe("0");
  expect((store.get(prefsKey) as { query?: string } | undefined)?.query).toBeUndefined();
});

test("recent queries appear in the dropdown on empty focus and re-run on pick", async () => {
  vi.resetModules();
  statefulChrome({
    "jv-remember-query": "1",
    [`jv-prefs:${location.origin}`]: {
      recentQueries: ["users[*].name", "settings"],
    },
  });

  document.body.innerHTML = `<pre>${JSON.stringify({
    users: [{ name: "Ada" }],
    settings: { theme: "dark" },
  })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const queryInput = document.getElementById("jv-query-input") as HTMLInputElement;
  const dropdown = document.getElementById("jv-query-suggest")!;
  document.getElementById("jv-query-toggle")!.click();

  // Focusing the empty field surfaces the history (most-recent-first) under a
  // "Recent queries" section header.
  queryInput.value = "";
  queryInput.dispatchEvent(new FocusEvent("focus"));
  expect(dropdown.querySelector(".jv-query-suggest-section")!.textContent).toBe(
    "Recent queries"
  );
  const recents = Array.from(
    dropdown.querySelectorAll(".jv-query-suggest-recent .jv-query-suggest-name")
  ).map((el) => el.textContent);
  expect(recents).toEqual(["users[*].name", "settings"]);

  // Picking a recent fills the input and runs it (chip reflects the query).
  (dropdown.querySelector(".jv-query-suggest-recent") as HTMLElement).dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true })
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(queryInput.value).toBe("users[*].name");
  expect(document.getElementById("jv-query-chip-text")!.textContent).toBe(
    "users[*].name"
  );
});

test("the remove button drops a single query from history", async () => {
  vi.resetModules();
  const store = statefulChrome({
    "jv-remember-query": "1",
    [`jv-prefs:${location.origin}`]: { recentQueries: ["keep", "drop"] },
  });

  document.body.innerHTML = `<pre>${JSON.stringify({ keep: 1, drop: 2 })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const queryInput = document.getElementById("jv-query-input") as HTMLInputElement;
  const dropdown = document.getElementById("jv-query-suggest")!;
  document.getElementById("jv-query-toggle")!.click();
  queryInput.dispatchEvent(new FocusEvent("focus"));

  const dropBtn = Array.from(dropdown.querySelectorAll(".jv-query-suggest-recent"))
    .find((li) => li.textContent?.includes("drop"))!
    .querySelector(".jv-query-suggest-del") as HTMLElement;
  dropBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Removed from the live list and from storage; the kept one stays.
  const names = Array.from(
    dropdown.querySelectorAll(".jv-query-suggest-recent .jv-query-suggest-name")
  ).map((el) => el.textContent);
  expect(names).toEqual(["keep"]);
  expect(
    (store.get(`jv-prefs:${location.origin}`) as { recentQueries?: string[] }).recentQueries
  ).toEqual(["keep"]);
});

test("autocomplete is contextual: a dot lists element keys, arrays get a badge", async () => {
  vi.resetModules();
  stubChrome();

  document.body.innerHTML = `<pre>${JSON.stringify({
    users: [{ name: "Ada", role: "admin" }],
    settings: { theme: "dark" },
  })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const queryInput = document.getElementById("jv-query-input") as HTMLInputElement;
  const dropdown = document.getElementById("jv-query-suggest")!;
  document.getElementById("jv-query-toggle")!.click();

  // A dot after an array projection lists ONLY the element keys, not the
  // whole document — proof the suggestions are contextual.
  queryInput.value = "users[*].";
  queryInput.selectionStart = queryInput.value.length;
  queryInput.dispatchEvent(new Event("input"));
  const names = Array.from(
    dropdown.querySelectorAll(".jv-query-suggest-name")
  ).map((el) => el.textContent);
  expect(names).toEqual(["name", "role"]);

  // At top level, the array-valued key carries a [ ] badge; a scalar/object
  // key does not.
  queryInput.value = "us";
  queryInput.selectionStart = 2;
  queryInput.dispatchEvent(new Event("input"));
  const usersItem = dropdown.querySelector(".jv-query-suggest-item")!;
  expect(usersItem.querySelector(".jv-query-suggest-name")!.textContent).toBe(
    "users"
  );
  expect(usersItem.querySelector(".jv-query-suggest-badge")).not.toBeNull();

  // Accepting an array key inserts a [*] projection with the caret after it,
  // ready to descend. (Accepting an object key inserts just the name.)
  usersItem.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true })
  );
  expect(queryInput.value).toBe("users[*]");
  expect(queryInput.selectionStart).toBe("users[*]".length);
});

test("depth select lists levels + All, and number keys and the dropdown drive it", async () => {
  vi.resetModules();
  stubChrome();

  document.body.innerHTML = `<pre>${JSON.stringify({ a: { b: { c: 1 } } })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const select = document.getElementById("jv-level-select") as HTMLSelectElement;
  const values = Array.from(select.options).map((o) => o.value);
  // Numbered depths first (1..maxDepth), then All.
  expect(values[0]).toBe("1");
  expect(values[values.length - 1]).toBe("all");
  // A small doc starts fully expanded.
  expect(select.value).toBe("all");

  // A number key sets the depth; the select reflects it.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
  expect(select.value).toBe("1");

  // Choosing from the dropdown applies that depth.
  select.value = "2";
  select.dispatchEvent(new Event("change"));
  expect(select.value).toBe("2");

  // 0 expands all again.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
  expect(select.value).toBe("all");
});

test("the large-doc note lives in a dismissible bar, not the toolbar", async () => {
  vi.resetModules();
  stubChrome();

  // Exceed the large-tree threshold so the partial-expansion note fires.
  const big = {
    items: Array.from({ length: 3000 }, (_, i) => ({ id: i, nested: { x: i } })),
  };
  document.body.innerHTML = `<pre>${JSON.stringify(big)}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 250));

  const notice = document.getElementById("jv-notice")!;
  const status = document.getElementById("jv-render-status")!;
  const toolbar = document.getElementById("jv-toolbar")!;
  expect(notice.hidden).toBe(false);
  expect(status.textContent).toContain("Large JSON");
  // The status moved out of the toolbar control row.
  expect(toolbar.contains(notice)).toBe(false);

  // ✕ dismisses the bar.
  document.getElementById("jv-notice-close")!.click();
  expect(notice.hidden).toBe(true);
});

test("committing a search saves history by default and respects the opt-out", async () => {
  vi.resetModules();
  const store = statefulChrome();

  document.body.innerHTML = `<pre>${JSON.stringify({ alpha: 1, beta: 2 })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const searchInput = document.getElementById("jv-search-input") as HTMLInputElement;
  const historyToggle = document.getElementById(
    "jv-search-history-toggle"
  ) as HTMLButtonElement;
  const check = document.getElementById("jv-remember-query") as HTMLInputElement;
  document.getElementById("jv-search-toggle")!.click();
  expect(check.checked).toBe(true);
  // No history yet, so the opener stays out of the way.
  expect(historyToggle.hidden).toBe(true);

  // Enter commits the search and default-on history stores it.
  searchInput.value = "alpha";
  searchInput.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  expect(historyToggle.hidden).toBe(false);
  historyToggle.click();
  expect(historyTerms()).toContain("alpha");
  historyToggle.click();
  expect(
    (store.get(`jv-prefs:${location.origin}`) as { recentSearches?: string[] }).recentSearches
  ).toContain("alpha");

  // Once the user opts out, committed searches stop landing in storage and the
  // opener disappears with the history it would have shown.
  check.click();
  expect(historyToggle.hidden).toBe(true);
  searchInput.value = "beta";
  searchInput.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  expect(historyToggle.hidden).toBe(true);
  expect(store.get("jv-remember-query")).toBe("0");
  expect(
    (store.get(`jv-prefs:${location.origin}`) as { recentSearches?: string[] } | undefined)
      ?.recentSearches
  ).toBeUndefined();
});

// The rendered terms of the search-history popover, in order.
function historyTerms(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("#jv-search-history .jv-search-history-item")
  ).map((el) => el.textContent!);
}

test("the search input carries no native clear or datalist controls", async () => {
  vi.resetModules();
  stubChrome();

  document.body.innerHTML = `<pre>${JSON.stringify({ a: 1 })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const searchInput = document.getElementById("jv-search-input") as HTMLInputElement;
  // type="search" is what draws Chrome's unthemed cancel button, and `list`
  // its datalist indicator; neither is reachable by keyboard.
  expect(searchInput.getAttribute("type")).toBe("text");
  expect(searchInput.hasAttribute("list")).toBe(false);
  expect(document.querySelector("datalist")).toBeNull();
});

test("the clear button appears with text, clears the search and refocuses", async () => {
  vi.resetModules();
  stubChrome();

  document.body.innerHTML = `<pre>${JSON.stringify({ alpha: 1, beta: 2 })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  document.getElementById("jv-search-toggle")!.click();
  const searchInput = document.getElementById("jv-search-input") as HTMLInputElement;
  const clearInput = document.getElementById(
    "jv-search-input-clear"
  ) as HTMLButtonElement;

  expect(clearInput.getAttribute("aria-label")).toBe("Clear search");
  expect(clearInput.hidden).toBe(true);

  searchInput.value = "alpha";
  searchInput.dispatchEvent(new Event("input"));
  expect(clearInput.hidden).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(
    document.querySelectorAll("#jv-tree .jv-search-match").length
  ).toBeGreaterThan(0);

  clearInput.click();
  await new Promise((resolve) => setTimeout(resolve, 300));

  expect(searchInput.value).toBe("");
  expect(clearInput.hidden).toBe(true);
  expect(document.querySelectorAll("#jv-tree .jv-search-match").length).toBe(0);
  expect(document.activeElement).toBe(searchInput);
  // Clearing the field must not take the panel down with it.
  expect(document.getElementById("jv-search-panel")!.hidden).toBe(false);
});

test("a remembered search history feeds the popover, newest first", async () => {
  vi.resetModules();
  statefulChrome({
    "jv-remember-query": "1",
    [`jv-prefs:${location.origin}`]: { recentSearches: ["foo", "bar"] },
  });

  document.body.innerHTML = `<pre>${JSON.stringify({ foo: 1, bar: 2 })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  document.getElementById("jv-search-toggle")!.click();
  const searchInput = document.getElementById("jv-search-input") as HTMLInputElement;
  const popover = document.getElementById("jv-search-history")!;
  const historyToggle = document.getElementById(
    "jv-search-history-toggle"
  ) as HTMLButtonElement;

  expect(historyToggle.hidden).toBe(false);
  expect(historyToggle.getAttribute("aria-label")).toBe("Recent searches");
  expect(historyToggle.getAttribute("aria-expanded")).toBe("false");
  expect(popover.hidden).toBe(true);

  historyToggle.click();
  expect(popover.hidden).toBe(false);
  expect(historyToggle.getAttribute("aria-expanded")).toBe("true");
  expect(historyTerms()).toEqual(["foo", "bar"]);
  // Focus lands in the popover so the arrows have somewhere to move from.
  const items = document.querySelectorAll<HTMLElement>(".jv-search-history-item");
  expect(document.activeElement).toBe(items[0]);

  // ArrowDown walks to the second term; Enter picks it and runs the search.
  items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(document.activeElement).toBe(items[1]);
  items[1].click();
  await new Promise((resolve) => setTimeout(resolve, 300));

  expect(searchInput.value).toBe("bar");
  expect(popover.hidden).toBe(true);
  expect(document.activeElement).toBe(searchInput);
  expect(
    document.querySelectorAll("#jv-tree .jv-search-match").length
  ).toBeGreaterThan(0);
});

test("Escape in the history popover closes only the popover", async () => {
  vi.resetModules();
  statefulChrome({
    "jv-remember-query": "1",
    [`jv-prefs:${location.origin}`]: { recentSearches: ["foo"] },
  });

  document.body.innerHTML = `<pre>${JSON.stringify({ foo: 1 })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  document.getElementById("jv-search-toggle")!.click();
  const panel = document.getElementById("jv-search-panel")!;
  const popover = document.getElementById("jv-search-history")!;
  const historyToggle = document.getElementById(
    "jv-search-history-toggle"
  ) as HTMLButtonElement;

  historyToggle.click();
  expect(popover.hidden).toBe(false);

  const item = document.querySelector<HTMLElement>(".jv-search-history-item")!;
  item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  expect(popover.hidden).toBe(true);
  expect(panel.hidden).toBe(false);
  expect(document.activeElement).toBe(historyToggle);

  // A second Escape — now with no popover in the way — closes the panel.
  historyToggle.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  expect(panel.hidden).toBe(true);
});

test("Escape closes only the popover when focus has left the menu", async () => {
  vi.resetModules();
  statefulChrome({
    "jv-remember-query": "1",
    [`jv-prefs:${location.origin}`]: { recentSearches: ["foo"] },
  });

  document.body.innerHTML = `<pre>${JSON.stringify({ foo: 1 })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  document.getElementById("jv-search-toggle")!.click();
  const panel = document.getElementById("jv-search-panel")!;
  const popover = document.getElementById("jv-search-history")!;
  const searchInput = document.getElementById("jv-search-input") as HTMLInputElement;
  const historyToggle = document.getElementById(
    "jv-search-history-toggle"
  ) as HTMLButtonElement;

  // Items are tabIndex=-1, so Shift+Tab out of the open menu lands on the
  // toggle and then the input, both of which keep the popover open.
  historyToggle.click();
  historyToggle.focus();
  expect(popover.hidden).toBe(false);

  historyToggle.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );

  expect(popover.hidden).toBe(true);
  expect(panel.hidden).toBe(false);
  expect(document.activeElement).toBe(historyToggle);

  // Same again, one stop further out: focus on the input itself.
  historyToggle.click();
  searchInput.focus();
  expect(popover.hidden).toBe(false);

  searchInput.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );

  expect(popover.hidden).toBe(true);
  expect(panel.hidden).toBe(false);
  expect(document.activeElement).toBe(historyToggle);
});

test("history vanishing under an open popover parks focus on the search input", async () => {
  vi.resetModules();
  statefulChrome({
    "jv-remember-query": "1",
    [`jv-prefs:${location.origin}`]: { recentSearches: ["foo"] },
  });

  document.body.innerHTML = `<pre>${JSON.stringify({ foo: 1 })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  document.getElementById("jv-search-toggle")!.click();
  const popover = document.getElementById("jv-search-history")!;
  const searchInput = document.getElementById("jv-search-input") as HTMLInputElement;
  const historyToggle = document.getElementById(
    "jv-search-history-toggle"
  ) as HTMLButtonElement;

  historyToggle.click();
  expect(popover.hidden).toBe(false);

  // Opting out of remembering drops the history, which takes the popover and
  // its opener with it while focus is still on a menu item.
  (document.getElementById("jv-remember-query") as HTMLInputElement).click();

  expect(popover.hidden).toBe(true);
  expect(historyToggle.hidden).toBe(true);
  expect(document.activeElement).toBe(searchInput);
});

test("only one popup is open at a time across search, query, and settings", async () => {
  vi.resetModules();
  stubChrome();

  document.body.innerHTML = `<pre>${JSON.stringify({ a: 1 })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const searchPanel = document.getElementById("jv-search-panel")!;
  const queryPanel = document.getElementById("jv-query-panel")!;
  const settingsMenu = document.getElementById("jv-settings-menu")!;
  const searchToggle = document.getElementById("jv-search-toggle")!;
  const queryToggle = document.getElementById("jv-query-toggle")!;
  const settingsToggle = document.getElementById("jv-settings-toggle")!;

  // Open the query panel.
  queryToggle.click();
  expect(queryPanel.hidden).toBe(false);

  // Opening settings closes the query panel.
  settingsToggle.click();
  expect(settingsMenu.classList.contains("jv-open")).toBe(true);
  expect(queryPanel.hidden).toBe(true);

  // Opening search closes the settings menu.
  searchToggle.click();
  expect(searchPanel.hidden).toBe(false);
  expect(settingsMenu.classList.contains("jv-open")).toBe(false);

  // Opening query closes the search panel.
  queryToggle.click();
  expect(queryPanel.hidden).toBe(false);
  expect(searchPanel.hidden).toBe(true);
});

test("does not expose window.data by default (no holder injected)", async () => {
  vi.resetModules();
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (query: string | string[] | Record<string, unknown>) => {
          if (typeof query === "string") return {};
          if (Array.isArray(query)) return {};
          return { ...query };
        }),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  document.body.innerHTML = `<pre>${JSON.stringify({ a: 1 })}</pre>`;

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(document.getElementById("jv-json-data")).toBeNull();
  expect(document.getElementById("jv-page-script")).toBeNull();
  expect((document.getElementById("jv-expose-data") as HTMLInputElement).checked).toBe(false);
});

test("injects the payload holder and page-script when opted in", async () => {
  vi.resetModules();
  const store: Record<string, unknown> = { "jv-expose-window-data": "1" };
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (query: string | string[] | Record<string, unknown>) => {
          if (typeof query === "string") return query in store ? { [query]: store[query] } : {};
          if (Array.isArray(query)) {
            const out: Record<string, unknown> = {};
            for (const key of query) if (key in store) out[key] = store[key];
            return out;
          }
          return Object.fromEntries(
            Object.entries(query).map(([k, def]) => [k, k in store ? store[k] : def])
          );
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  document.body.innerHTML = `<pre>${JSON.stringify({ a: 1 })}</pre>`;

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const holder = document.getElementById("jv-json-data");
  const script = document.getElementById("jv-page-script") as HTMLScriptElement | null;
  expect(holder).not.toBeNull();
  expect(holder!.textContent).toBe(JSON.stringify({ a: 1 }));
  expect(script).not.toBeNull();
  expect(script!.src).toBe("chrome-extension://test/page-script.js");
  expect((document.getElementById("jv-expose-data") as HTMLInputElement).checked).toBe(true);
});

test("toggling the expose-data checkbox persists the key and injects live", async () => {
  vi.resetModules();
  const store: Record<string, unknown> = {};
  const set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(store, items);
  });
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (query: string | string[] | Record<string, unknown>) => {
          if (typeof query === "string") return query in store ? { [query]: store[query] } : {};
          if (Array.isArray(query)) {
            const out: Record<string, unknown> = {};
            for (const key of query) if (key in store) out[key] = store[key];
            return out;
          }
          return Object.fromEntries(
            Object.entries(query).map(([k, def]) => [k, k in store ? store[k] : def])
          );
        }),
        set,
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  document.body.innerHTML = `<pre>${JSON.stringify({ a: 1 })}</pre>`;

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const check = document.getElementById("jv-expose-data") as HTMLInputElement;
  expect(check.checked).toBe(false);
  expect(document.getElementById("jv-json-data")).toBeNull();

  check.checked = true;
  check.dispatchEvent(new Event("change"));
  expect(set).toHaveBeenCalledWith({ "jv-expose-window-data": "1" });
  expect(document.getElementById("jv-json-data")).not.toBeNull();
  expect(document.getElementById("jv-page-script")).not.toBeNull();

  check.checked = false;
  check.dispatchEvent(new Event("change"));
  expect(set).toHaveBeenCalledWith({ "jv-expose-window-data": "0" });
  expect(document.getElementById("jv-json-data")).toBeNull();
  expect(document.getElementById("jv-page-script")).toBeNull();
});

// Only the detection tests below use this. Every other test in the file seeds
// its page with document.body.innerHTML, which is enough when the assertion is
// about the tree content.ts renders. It is not enough here: these tests assert
// the page is left *unchanged*, which needs a document.body that really is the
// one on screen. Earlier tests leave a rebuilt document behind — content.ts
// wipes <html> and appends its own head/body, and jsdom's fragment parser adds
// a second empty pair — so after them document.body can be a stray node that
// content.ts never looks at, and an innerHTML assignment to it would "pass"
// without proving anything. So build the document outright instead.
function resetDocumentWithBody(bodyHtml: string, headHtml = ""): void {
  const head = document.createElement("head");
  head.innerHTML = headHtml;
  const body = document.createElement("body");
  body.innerHTML = bodyHtml;
  document.documentElement.replaceChildren(head, body);
}

function setContentType(value: string): void {
  // The file-level afterEach deletes this again.
  Object.defineProperty(document, "contentType", {
    value,
    configurable: true,
  });
}

test("leaves a scalar-only plain-text page untouched", async () => {
  vi.resetModules();
  stubChrome();

  resetDocumentWithBody("<pre>1\n2\n3</pre>");

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  // No explicit NDJSON Content-Type and no container line: not ours.
  expect(document.getElementById("jv-root")).toBeNull();
  expect(document.querySelector("body > pre")?.textContent).toBe("1\n2\n3");
});

test("still detects object-per-line NDJSON in a plain-text page", async () => {
  vi.resetModules();
  stubChrome();

  resetDocumentWithBody('<pre>{"a":1}\n{"a":2}</pre>');

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(document.getElementById("jv-root")).not.toBeNull();
  expect(document.querySelector('[data-path="data[0]"]')).not.toBeNull();
  expect(document.querySelector('[data-path="data[1]"]')).not.toBeNull();
});

test("an explicit NDJSON Content-Type still renders scalar lines as an array", async () => {
  vi.resetModules();
  stubChrome();
  setContentType("application/x-ndjson");

  resetDocumentWithBody("<pre>1\n2</pre>");

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(document.getElementById("jv-root")).not.toBeNull();
  expect(
    document.querySelector('[data-path="data[0]"] .jv-number')?.textContent
  ).toBe("1");
  expect(
    document.querySelector('[data-path="data[1]"] .jv-number')?.textContent
  ).toBe("2");
});

test.runIf(hasReviverSource)(
  "an NDJSON Content-Type keeps a bare number line and an object line exact",
  async () => {
    vi.resetModules();
    stubChrome();
    setContentType("application/x-ndjson");

    resetDocumentWithBody(
      '<pre>9007199254740993\n{"id": 9007199254740993}</pre>'
    );

    await import("./content");
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The bare line and the object line both render the source token, and both
    // carry the exact marker the viewer styles.
    const bare = document.querySelector<HTMLElement>(
      '[data-path="data[0]"] .jv-number'
    )!;
    const nested = document.querySelector<HTMLElement>(
      '[data-path="data[1].id"] .jv-number'
    )!;
    expect(bare.textContent).toBe("9007199254740993");
    expect(bare.classList.contains("jv-number-exact")).toBe(true);
    expect(nested.textContent).toBe("9007199254740993");
    expect(nested.classList.contains("jv-number-exact")).toBe(true);
  }
);

test.runIf(hasReviverSource && hasRawJSON)(
  "Copy JSON of an NDJSON document emits both big numbers exactly",
  async () => {
    vi.resetModules();
    stubChrome();
    setContentType("application/x-ndjson");
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    // jsdom has no clipboard of its own, so uncover undefined again rather
    // than leave a stub behind for whichever test runs next.
    onTestFinished(() => {
      delete (window.navigator as any).clipboard;
    });

    resetDocumentWithBody(
      '<pre>9007199254740993\n{"id": 9007199254740993}</pre>'
    );

    await import("./content");
    await new Promise((resolve) => setTimeout(resolve, 150));

    document.getElementById("jv-copy")!.click();
    expect(writeText).toHaveBeenLastCalledWith(
      '[\n  9007199254740993,\n  {\n    "id": 9007199254740993\n  }\n]'
    );
  }
);

test("leaves an authored text/html page with a populated head untouched", async () => {
  vi.resetModules();
  stubChrome();
  setContentType("text/html");

  resetDocumentWithBody(
    '<pre>{"a":1}</pre>',
    '<title>x</title><script src="app.js"></script>'
  );

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  // A real page that happens to print JSON keeps its own head and body.
  expect(document.getElementById("jv-root")).toBeNull();
  expect(document.querySelector("head > title")?.textContent).toBe("x");
  expect(document.querySelector('head > script[src="app.js"]')).not.toBeNull();
  expect(document.querySelector("body > pre")?.textContent).toBe('{"a":1}');
});

test("still detects a text/plain page whose body is a lone pre", async () => {
  vi.resetModules();
  stubChrome();
  setContentType("text/plain");

  resetDocumentWithBody('<pre>{"a":1}</pre>');

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(document.getElementById("jv-root")).not.toBeNull();
  expect(document.querySelector('[data-path="data.a"]')).not.toBeNull();
});

test("still detects an application/json document whatever its shape and head", async () => {
  vi.resetModules();
  stubChrome();
  setContentType("application/json");

  resetDocumentWithBody(
    '<div>{"a":1}</div><div></div>',
    '<title>x</title><script src="app.js"></script>'
  );

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(document.getElementById("jv-root")).not.toBeNull();
  expect(document.querySelector('[data-path="data.a"]')).not.toBeNull();
});

test("still detects a text/html page whose head holds only a meta element", async () => {
  vi.resetModules();
  stubChrome();
  setContentType("text/html");

  resetDocumentWithBody(
    '<pre>{"a":1}</pre>',
    '<meta name="color-scheme" content="light dark">'
  );

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(document.getElementById("jv-root")).not.toBeNull();
  expect(document.querySelector('[data-path="data.a"]')).not.toBeNull();
});

test("still detects a text/html page with an empty head", async () => {
  vi.resetModules();
  stubChrome();
  setContentType("text/html");

  resetDocumentWithBody('<pre>{"a":1}</pre>');

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(document.getElementById("jv-root")).not.toBeNull();
  expect(document.querySelector('[data-path="data.a"]')).not.toBeNull();
});

// Node reports a floating promise nobody handled through `process`, not through
// jsdom's window — a rejection raised inside content.ts is created in the Node
// realm, so window.onunhandledrejection never sees it.
function watchUnhandledRejections(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = [];
  const handler = (reason: unknown) => reasons.push(reason);
  process.on("unhandledRejection", handler);
  return { reasons, stop: () => process.off("unhandledRejection", handler) };
}

// buildTreeModel is the first thing init calls after it has cleared the page,
// so making it throw reproduces "wiped, then failed" without any test-only
// seam in production code. Every other export keeps its real implementation.
// The unmock is registered here so no caller can leak the mock into the next
// test by forgetting it.
function mockFailingMount(): void {
  onTestFinished(() => vi.doUnmock("./tree-model"));
  vi.doMock("./tree-model", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./tree-model")>();
    return {
      ...actual,
      buildTreeModel: () => {
        throw new Error("mount failed");
      },
    };
  });
}

test("reads storage before the page is wiped", async () => {
  vi.resetModules();
  const raw = '{"a":1}';
  // Each observation is taken synchronously inside the stub, at call time.
  // Holding on to the node instead would prove nothing: after the wipe it is
  // detached, so it still reports the original text whenever it is read.
  const observations: { originalPre: boolean; viewerMounted: boolean }[] = [];
  stubChrome({
    onGet: () => {
      observations.push({
        originalPre: document.querySelector("body > pre")?.textContent === raw,
        viewerMounted: document.getElementById("jv-root") !== null,
      });
    },
  });

  resetDocumentWithBody(`<pre>${raw}</pre>`);

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  // The first preference read happened while the response was still on screen.
  expect(observations.length).toBeGreaterThan(0);
  expect(observations[0]).toEqual({ originalPre: true, viewerMounted: false });

  // And init did not simply bail out before the wipe: the viewer did mount.
  expect(document.getElementById("jv-root")).not.toBeNull();
  expect(document.querySelector('[data-path="data.a"]')).not.toBeNull();
});

test("still mounts with default theme and prefs when every storage read rejects", async () => {
  vi.resetModules();
  stubChrome({ rejectStorage: true });

  resetDocumentWithBody('<pre>{"a":1}</pre>');

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(document.getElementById("jv-root")).not.toBeNull();
  expect(document.querySelector('[data-path="data.a"]')).not.toBeNull();

  // The defaults are really applied, not merely "something rendered".
  expect((document.getElementById("jv-theme-select") as HTMLSelectElement).value).toBe(
    DEFAULT_THEME_ID
  );
  expect(document.querySelectorAll("#jv-custom-list li").length).toBe(0);
  expect(
    (document.getElementById("jv-remember-query") as HTMLInputElement).checked
  ).toBe(true);
  expect((document.getElementById("jv-expose-data") as HTMLInputElement).checked).toBe(
    false
  );
});

test("emits no unhandled rejection when every storage read rejects", async () => {
  vi.resetModules();
  stubChrome({ rejectStorage: true });
  const watch = watchUnhandledRejections();

  resetDocumentWithBody('<pre>{"a":1}</pre>');

  try {
    await import("./content");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(watch.reasons).toEqual([]);
  } finally {
    watch.stop();
  }
});

test("restores the raw text into a pre when init throws after the wipe", async () => {
  vi.resetModules();
  stubChrome();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mockFailingMount();

  const raw = '{"a":1}';
  resetDocumentWithBody(`<pre>${raw}</pre>`);

  try {
    await import("./content");
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The half-built viewer is gone and the original response is back, as one
    // plain <pre> — not the toolbar's several.
    expect(document.getElementById("jv-root")).toBeNull();
    const pres = document.querySelectorAll("pre");
    expect(pres.length).toBe(1);
    expect(pres[0].textContent).toBe(raw);
    expect(consoleError).toHaveBeenCalled();
    // applyTheme paints <html> with the theme's toolbar color before the
    // failure point. Left behind, it would render the recovered text dark on
    // dark — as good as blank.
    expect(document.documentElement.style.background).toBe("");
  } finally {
    consoleError.mockRestore();
  }
});

test("the recovery pre holds the raw text as text, not as markup", async () => {
  vi.resetModules();
  stubChrome();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mockFailingMount();

  const raw = '{"a":"<img src=x onerror=alert(1)>"}';
  resetDocumentWithBody(`<pre>${raw.replace(/</g, "&lt;")}</pre>`);

  try {
    await import("./content");
    await new Promise((resolve) => setTimeout(resolve, 150));

    const pre = document.querySelector("pre")!;
    expect(pre.textContent).toBe(raw);
    expect(pre.querySelector("img")).toBeNull();
  } finally {
    consoleError.mockRestore();
  }
});

test("emits no unhandled rejection when init throws after the wipe", async () => {
  vi.resetModules();
  stubChrome();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mockFailingMount();
  const watch = watchUnhandledRejections();

  resetDocumentWithBody('<pre>{"a":1}</pre>');

  try {
    await import("./content");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(watch.reasons).toEqual([]);
  } finally {
    watch.stop();
    consoleError.mockRestore();
  }
});

test("a resolving storage load still mounts with the stored theme and prefs", async () => {
  vi.resetModules();
  statefulChrome({
    "jv-theme-id": DEFAULT_LIGHT_ID,
    "jv-remember-query": "0",
  });

  resetDocumentWithBody('<pre>{"a":1}</pre>');

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(document.getElementById("jv-root")).not.toBeNull();
  expect(document.querySelector('[data-path="data.a"]')).not.toBeNull();
  expect((document.getElementById("jv-theme-select") as HTMLSelectElement).value).toBe(
    DEFAULT_LIGHT_ID
  );
  expect(
    (document.getElementById("jv-remember-query") as HTMLInputElement).checked
  ).toBe(false);
});

test("a catastrophic regex reports a timeout and leaves search working", async () => {
  vi.resetModules();
  statefulChrome();

  // The value from issue #51: a 28-character run a nested quantifier can
  // partition 2^27 ways, then a character that makes the match fail.
  const payload = {
    long: `${"a".repeat(28)}b${"c".repeat(271)}`,
    plain: "findable",
  };
  resetDocumentWithBody(`<pre>${JSON.stringify(payload)}</pre>`);

  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const searchInput = document.getElementById("jv-search-input") as HTMLInputElement;
  const searchStatus = document.getElementById("jv-search-status")!;
  const searchNext = document.getElementById("jv-search-next") as HTMLButtonElement;

  async function type(query: string): Promise<void> {
    searchInput.value = query;
    searchInput.dispatchEvent(new Event("input"));
    // Outlast the 180ms debounce plus the search itself.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  document.getElementById("jv-search-toggle")!.click();
  const regexToggle = document.getElementById("jv-search-regex")!;
  // Regex mode reads only the head of a long value; the toggle says so rather
  // than narrowing what regex search finds in silence.
  expect(regexToggle.title).toContain("4096 characters");
  regexToggle.click();

  const started = Date.now();
  await type("(a+)+$");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(searchStatus.textContent).toBe("Search timed out");
  expect(searchStatus.classList.contains("jv-search-error")).toBe(true);
  expect(searchNext.disabled).toBe(true);

  // The viewer is still alive, and the next search behaves normally.
  document.getElementById("jv-search-regex")!.click();
  await type("findable");
  expect(searchStatus.textContent).toBe("1 of 1");
  expect(searchStatus.classList.contains("jv-search-error")).toBe(false);
});
