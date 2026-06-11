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
