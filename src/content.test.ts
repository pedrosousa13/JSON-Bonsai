// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { DEFAULT_THEME_ID } from "./themes";

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

  // ...and the saved depth is the active level button.
  const levelBtn = document.querySelector<HTMLElement>('#jv-levels button[data-level="1"]')!;
  expect(levelBtn.classList.contains("jv-active")).toBe(true);
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

function stubChrome(): void {
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
