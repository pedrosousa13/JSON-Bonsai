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

test("remember-query is on by default; toggling off drops the saved query", async () => {
  vi.resetModules();
  const store = statefulChrome();

  document.body.innerHTML = `<pre>${JSON.stringify({
    users: [{ name: "Ada" }],
  })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const queryInput = document.getElementById("jv-query-input") as HTMLInputElement;
  const check = document.getElementById("jv-remember-query") as HTMLInputElement;
  // Default on with nothing stored.
  expect(check.checked).toBe(true);

  // Running a query persists it automatically (writer debounce ~250ms).
  document.getElementById("jv-query-toggle")!.click();
  queryInput.value = "users";
  queryInput.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const prefsKey = `jv-prefs:${location.origin}`;
  expect((store.get(prefsKey) as { query?: string }).query).toBe("users");

  // Toggling off persists the flag and drops the stored query.
  check.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(store.get("jv-remember-query")).toBe("0");
  expect((store.get(prefsKey) as { query?: string }).query).toBeUndefined();
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

test("committing a search saves it to the search-history datalist", async () => {
  vi.resetModules();
  const store = statefulChrome(); // remember on by default

  document.body.innerHTML = `<pre>${JSON.stringify({ alpha: 1, beta: 2 })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const searchInput = document.getElementById("jv-search-input") as HTMLInputElement;
  const datalist = document.getElementById("jv-search-history")!;
  document.getElementById("jv-search-toggle")!.click();

  // Enter commits the search → it lands in the datalist and in storage.
  searchInput.value = "alpha";
  searchInput.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  const opts = Array.from(datalist.querySelectorAll("option")).map((o) => o.value);
  expect(opts).toContain("alpha");
  expect(
    (store.get(`jv-prefs:${location.origin}`) as { recentSearches?: string[] }).recentSearches
  ).toContain("alpha");
});

test("a remembered search history populates the datalist on load", async () => {
  vi.resetModules();
  statefulChrome({
    "jv-remember-query": "1",
    [`jv-prefs:${location.origin}`]: { recentSearches: ["foo", "bar"] },
  });

  document.body.innerHTML = `<pre>${JSON.stringify({ a: 1 })}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const opts = Array.from(
    document.getElementById("jv-search-history")!.querySelectorAll("option")
  ).map((o) => o.value);
  expect(opts).toEqual(["foo", "bar"]);
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
