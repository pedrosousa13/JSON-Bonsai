// @vitest-environment jsdom
import { expect, test, vi } from "vitest";

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
  expect(select.value).toBe("catppuccin-mocha");
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
