// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createOriginPrefsWriter, loadOriginPrefs } from "./prefs";

// In-memory chrome.storage.local stand-in shared by writer and loader.
function installMockStorage(): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) =>
          key in store ? { [key]: store[key] } : {}
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
      },
    },
  };
  return store;
}

function mockSet(): ReturnType<typeof vi.fn> {
  return (globalThis as any).chrome.storage.local.set;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).chrome;
});

test("prefs round-trip: written prefs load back for the same origin", async () => {
  installMockStorage();
  const write = createOriginPrefsWriter("https://api.example.com");

  write({ view: "raw", level: 3 });
  await vi.runAllTimersAsync();

  expect(await loadOriginPrefs("https://api.example.com")).toEqual({
    view: "raw",
    level: 3,
  });
});

test("query round-trips and a non-string query is ignored", async () => {
  const store = installMockStorage();
  const write = createOriginPrefsWriter("https://api.example.com");

  write({ view: "tree", query: "users[*].name" });
  await vi.runAllTimersAsync();
  expect(await loadOriginPrefs("https://api.example.com")).toEqual({
    view: "tree",
    query: "users[*].name",
  });

  // A corrupted (non-string) query is dropped, not surfaced.
  store["jv-prefs:https://api.example.com"] = { view: "tree", query: 42 };
  expect(await loadOriginPrefs("https://api.example.com")).toEqual({
    view: "tree",
  });
});

test("recentQueries round-trip; non-string entries are filtered out", async () => {
  const store = installMockStorage();
  const write = createOriginPrefsWriter("https://api.example.com");

  write({ view: "tree", recentQueries: ["a", "b[*].c"] });
  await vi.runAllTimersAsync();
  expect(await loadOriginPrefs("https://api.example.com")).toEqual({
    view: "tree",
    recentQueries: ["a", "b[*].c"],
  });

  // Mixed/garbage arrays keep only the strings; an all-garbage array is dropped.
  store["jv-prefs:https://api.example.com"] = {
    view: "tree",
    recentQueries: ["ok", 5, null, "fine"],
  };
  expect(await loadOriginPrefs("https://api.example.com")).toEqual({
    view: "tree",
    recentQueries: ["ok", "fine"],
  });
});

test("recentSearches round-trip; non-string entries are filtered out", async () => {
  const store = installMockStorage();
  const write = createOriginPrefsWriter("https://api.example.com");

  write({ view: "tree", recentSearches: ["ada", "grace"] });
  await vi.runAllTimersAsync();
  expect(await loadOriginPrefs("https://api.example.com")).toEqual({
    view: "tree",
    recentSearches: ["ada", "grace"],
  });

  store["jv-prefs:https://api.example.com"] = {
    view: "tree",
    recentSearches: ["ok", 0, false, "fine"],
  };
  expect(await loadOriginPrefs("https://api.example.com")).toEqual({
    view: "tree",
    recentSearches: ["ok", "fine"],
  });
});

test("prefs are keyed per origin", async () => {
  const store = installMockStorage();
  const writeA = createOriginPrefsWriter("https://a.example.com");
  const writeB = createOriginPrefsWriter("https://b.example.com");

  writeA({ view: "schema", level: "all" });
  writeB({ view: "tree", level: 2 });
  await vi.runAllTimersAsync();

  expect(Object.keys(store).sort()).toEqual([
    "jv-prefs:https://a.example.com",
    "jv-prefs:https://b.example.com",
  ]);
  expect(await loadOriginPrefs("https://a.example.com")).toEqual({
    view: "schema",
    level: "all",
  });
  expect(await loadOriginPrefs("https://b.example.com")).toEqual({
    view: "tree",
    level: 2,
  });
});

test("missing storage API degrades silently", async () => {
  delete (globalThis as any).chrome;

  expect(await loadOriginPrefs("https://api.example.com")).toEqual({});

  const write = createOriginPrefsWriter("https://api.example.com");
  expect(() => write({ view: "raw" })).not.toThrow();
  await vi.runAllTimersAsync();
});

test("rapid writes are debounced into the last payload", async () => {
  installMockStorage();
  const write = createOriginPrefsWriter("https://api.example.com");

  write({ view: "formatted" });
  write({ view: "raw" });
  write({ view: "raw", level: 4 });
  await vi.runAllTimersAsync();

  expect(mockSet()).toHaveBeenCalledTimes(1);
  expect(await loadOriginPrefs("https://api.example.com")).toEqual({
    view: "raw",
    level: 4,
  });
});

test("reapplying the loaded prefs does not write them back", async () => {
  installMockStorage();
  const initial = { view: "raw", level: 3 } as const;
  const write = createOriginPrefsWriter("https://api.example.com", initial);

  write({ view: "raw", level: 3 });
  await vi.runAllTimersAsync();

  expect(mockSet()).not.toHaveBeenCalled();
});

test("corrupted stored values fall back to empty prefs", async () => {
  const store = installMockStorage();
  store["jv-prefs:https://api.example.com"] = "not an object";
  expect(await loadOriginPrefs("https://api.example.com")).toEqual({});

  store["jv-prefs:https://api.example.com"] = { view: 42, level: -1 };
  expect(await loadOriginPrefs("https://api.example.com")).toEqual({});
});
