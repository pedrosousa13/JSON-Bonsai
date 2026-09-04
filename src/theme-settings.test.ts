// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";
import {
  createThemeSettings,
  defaultThemeState,
  loadThemeState,
  type SettingsStorage,
  type ThemeSettingsController,
  type ThemeSettingsOptions,
} from "./theme-settings";
import { watchUnhandledRejections } from "./test-helpers";
import {
  BUILTIN_SCHEMES,
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT_ID,
  DEFAULT_THEME_ID,
} from "./themes";

// jsdom ships no matchMedia, and the fresh-profile default reads it.
function stubPrefersLight(matches: boolean): void {
  window.matchMedia = vi.fn(() => ({ matches })) as unknown as typeof window.matchMedia;
}

const PALETTE_KEYS = [
  "base00", "base01", "base02", "base03", "base04", "base05", "base06", "base07",
  "base08", "base09", "base0A", "base0B", "base0C", "base0D", "base0E", "base0F",
];

// A SettingsStorage over a plain Map — the whole point of the injected port.
function fakeStorage(initial: Record<string, string> = {}): {
  storage: SettingsStorage;
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    storage: {
      async get(keys) {
        const out: Record<string, unknown> = {};
        for (const key of keys) if (store.has(key)) out[key] = store.get(key);
        return out;
      },
      async set(items) {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      },
    },
  };
}

// An invalidated extension context breaks a write in both shapes: the promise
// rejects, or `set` throws before it ever returns one.
function failingStorage(mode: "rejects" | "throws"): SettingsStorage {
  return {
    async get() {
      return {};
    },
    set() {
      const error = new Error("Extension context invalidated.");
      if (mode === "throws") throw error;
      return Promise.reject(error);
    },
  };
}

// The markup createThemeSettings looks up, matching the content script's.
const MENU_HTML = `
  <div id="jv-settings">
    <button id="jv-settings-toggle"></button>
    <div id="jv-settings-menu">
      <select id="jv-theme-select"></select>
      <textarea id="jv-theme-paste"></textarea>
      <button id="jv-theme-add"></button>
      <div id="jv-theme-error"></div>
      <ul id="jv-custom-list"></ul>
      <input type="checkbox" id="jv-remember-query">
      <input type="checkbox" id="jv-expose-data">
    </div>
  </div>`;

function mountRoot(): HTMLElement {
  const root = document.createElement("div");
  root.id = "jv-root";
  root.innerHTML = MENU_HTML;
  document.body.replaceChildren(root);
  return root;
}

beforeEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
});

test("loadThemeState reads a stored id and custom schemes", async () => {
  const { storage } = fakeStorage({
    "jv-theme-id": "nord",
    "jv-custom-themes": JSON.stringify([
      { id: "mine", name: "Mine", variant: "dark", palette: {} },
    ]),
  });

  const state = await loadThemeState(storage);

  expect(state.themeId).toBe("nord");
  expect(state.customs.map((s) => s.id)).toEqual(["mine"]);
});

test("loadThemeState takes a fresh profile's theme from the OS, writing nothing", async () => {
  for (const [prefersLight, expected] of [
    [true, DEFAULT_LIGHT_ID],
    [false, DEFAULT_DARK_ID],
  ] as const) {
    stubPrefersLight(prefersLight);
    const { storage, store } = fakeStorage();

    const state = await loadThemeState(storage);

    expect(state.themeId).toBe(expected);
    expect(state.customs).toEqual([]);
    expect(store.size).toBe(0);
  }
});

test("loadThemeState reads storage exactly once", async () => {
  const { storage } = fakeStorage({ "jv-theme-id": "nord" });
  const get = vi.spyOn(storage, "get");

  await loadThemeState(storage);

  expect(get).toHaveBeenCalledTimes(1);
});

test("loadThemeState falls back to no customs when the stored list is corrupt", async () => {
  const { storage } = fakeStorage({
    "jv-theme-id": DEFAULT_THEME_ID,
    "jv-custom-themes": "{not json",
  });

  expect((await loadThemeState(storage)).customs).toEqual([]);
});

test("applyTheme paints the scheme's variables on the injected root", () => {
  const root = mountRoot();
  const { storage } = fakeStorage();
  const scheme = BUILTIN_SCHEMES.find((s) => s.id === DEFAULT_THEME_ID)!;

  const settings = createThemeSettings({
    root,
    state: defaultThemeState(),
    storage,
    rememberQuery: true,
    exposeWindowData: false,
    onRememberQueryChange: vi.fn(),
    onExposeWindowDataChange: vi.fn(),
    onMenuOpen: vi.fn(),
  });

  // Nothing painted until the caller asks — init needs to control the moment.
  expect(root.style.getPropertyValue("--bg")).toBe("");

  settings.applyTheme();

  expect(root.style.getPropertyValue("--bg")).toBe(scheme.palette.base00);
  expect(document.documentElement.style.background).not.toBe("");
  expect(settings.themeId()).toBe(DEFAULT_THEME_ID);
});

test("mountMenu fills the theme select, and picking one persists and repaints", () => {
  const root = mountRoot();
  const { storage, store } = fakeStorage();
  const settings = createThemeSettings({
    root,
    state: defaultThemeState(),
    storage,
    rememberQuery: true,
    exposeWindowData: false,
    onRememberQueryChange: vi.fn(),
    onExposeWindowDataChange: vi.fn(),
    onMenuOpen: vi.fn(),
  });

  settings.mountMenu();

  const select = root.querySelector<HTMLSelectElement>("#jv-theme-select")!;
  expect(select.querySelectorAll("optgroup").length).toBe(2);
  expect(select.value).toBe(DEFAULT_THEME_ID);

  const other = BUILTIN_SCHEMES.find(
    (s) => s.variant === "light" && s.id !== DEFAULT_THEME_ID
  )!;
  select.value = other.id;
  select.dispatchEvent(new Event("change"));

  expect(settings.themeId()).toBe(other.id);
  expect(store.get("jv-theme-id")).toBe(other.id);
  expect(root.style.getPropertyValue("--bg")).toBe(other.palette.base00);
});

test("a pasted scheme is added, selected, listed and deletable", async () => {
  const root = mountRoot();
  const { storage, store } = fakeStorage();
  const settings = createThemeSettings({
    root,
    state: defaultThemeState(),
    storage,
    rememberQuery: true,
    exposeWindowData: false,
    onRememberQueryChange: vi.fn(),
    onExposeWindowDataChange: vi.fn(),
    onMenuOpen: vi.fn(),
  });
  settings.mountMenu();

  const paste = root.querySelector<HTMLTextAreaElement>("#jv-theme-paste")!;
  paste.value = JSON.stringify({
    name: "Pasted",
    variant: "dark",
    palette: Object.fromEntries(
      PALETTE_KEYS.map((key) => [key, "#101010"])
    ),
  });
  root.querySelector<HTMLButtonElement>("#jv-theme-add")!.click();
  await vi.waitFor(() =>
    expect(root.querySelectorAll("#jv-custom-list li").length).toBe(1)
  );

  expect(settings.themeId()).toBe("custom-pasted");
  expect(paste.value).toBe("");
  expect(JSON.parse(store.get("jv-custom-themes")!)).toHaveLength(1);
  expect(root.style.getPropertyValue("--bg")).toBe("#101010");

  // Deleting the selected custom scheme falls back to the default theme.
  root.querySelector<HTMLButtonElement>("#jv-custom-list li button")!.click();
  await vi.waitFor(() =>
    expect(root.querySelectorAll("#jv-custom-list li").length).toBe(0)
  );
  expect(settings.themeId()).toBe(DEFAULT_THEME_ID);
});

test("an unparseable paste reports the error and adds nothing", () => {
  const root = mountRoot();
  const { storage } = fakeStorage();
  createThemeSettings({
    root,
    state: defaultThemeState(),
    storage,
    rememberQuery: true,
    exposeWindowData: false,
    onRememberQueryChange: vi.fn(),
    onExposeWindowDataChange: vi.fn(),
    onMenuOpen: vi.fn(),
  }).mountMenu();

  root.querySelector<HTMLTextAreaElement>("#jv-theme-paste")!.value = "nonsense";
  root.querySelector<HTMLButtonElement>("#jv-theme-add")!.click();

  expect(root.querySelector("#jv-theme-error")!.textContent).not.toBe("");
  expect(root.querySelectorAll("#jv-custom-list li").length).toBe(0);
});

test("the toggles start from the injected values, then persist and report", () => {
  const root = mountRoot();
  const { storage, store } = fakeStorage();
  const onRememberQueryChange = vi.fn();
  const onExposeWindowDataChange = vi.fn();
  createThemeSettings({
    root,
    state: defaultThemeState(),
    storage,
    rememberQuery: true,
    exposeWindowData: false,
    onRememberQueryChange,
    onExposeWindowDataChange,
    onMenuOpen: vi.fn(),
  }).mountMenu();

  const remember = root.querySelector<HTMLInputElement>("#jv-remember-query")!;
  const expose = root.querySelector<HTMLInputElement>("#jv-expose-data")!;
  expect(remember.checked).toBe(true);
  expect(expose.checked).toBe(false);

  remember.click();
  expect(onRememberQueryChange).toHaveBeenCalledWith(false);
  expect(store.get("jv-remember-query")).toBe("0");

  expose.click();
  expect(onExposeWindowDataChange).toHaveBeenCalledWith(true);
  expect(store.get("jv-expose-window-data")).toBe("1");
});

// A write that fails costs only that write: nothing reaches the console
// unhandled, and no UI update is abandoned halfway.
for (const mode of ["rejects", "throws"] as const) {
  type ToggleCallbacks = Pick<
    ThemeSettingsOptions,
    "onRememberQueryChange" | "onExposeWindowDataChange"
  >;

  function settingsOverFailingStorage(
    root: HTMLElement,
    callbacks: Partial<ToggleCallbacks> = {}
  ): ThemeSettingsController {
    return createThemeSettings({
      root,
      state: defaultThemeState(),
      storage: failingStorage(mode),
      rememberQuery: true,
      exposeWindowData: false,
      onRememberQueryChange: callbacks.onRememberQueryChange ?? vi.fn(),
      onExposeWindowDataChange: callbacks.onExposeWindowDataChange ?? vi.fn(),
      onMenuOpen: vi.fn(),
    });
  }

  function pasteCustomScheme(root: HTMLElement): void {
    root.querySelector<HTMLTextAreaElement>("#jv-theme-paste")!.value = JSON.stringify({
      name: "Pasted",
      variant: "dark",
      palette: Object.fromEntries(PALETTE_KEYS.map((key) => [key, "#101010"])),
    });
    root.querySelector<HTMLButtonElement>("#jv-theme-add")!.click();
  }

  test(`the toggles and the theme select still work when storage ${mode}`, async () => {
    const root = mountRoot();
    const watch = watchUnhandledRejections();
    const onRememberQueryChange = vi.fn();
    const onExposeWindowDataChange = vi.fn();
    const settings = settingsOverFailingStorage(root, {
      onRememberQueryChange,
      onExposeWindowDataChange,
    });
    settings.mountMenu();

    root.querySelector<HTMLInputElement>("#jv-remember-query")!.click();
    root.querySelector<HTMLInputElement>("#jv-expose-data")!.click();

    const other = BUILTIN_SCHEMES.find(
      (s) => s.variant === "light" && s.id !== DEFAULT_THEME_ID
    )!;
    const select = root.querySelector<HTMLSelectElement>("#jv-theme-select")!;
    select.value = other.id;
    select.dispatchEvent(new Event("change"));

    // Each handler runs past the failed write: the toggles report, the theme
    // repaints.
    expect(onRememberQueryChange).toHaveBeenCalledWith(false);
    expect(onExposeWindowDataChange).toHaveBeenCalledWith(true);
    expect(settings.themeId()).toBe(other.id);
    expect(root.style.getPropertyValue("--bg")).toBe(other.palette.base00);

    // Give a rejection the turn it needs to be reported as unhandled.
    await new Promise((resolve) => setTimeout(resolve, 10));
    watch.stop();
    expect(watch.reasons).toEqual([]);
  });

  test(`a pasted scheme is listed and painted when storage ${mode}`, async () => {
    const root = mountRoot();
    const watch = watchUnhandledRejections();
    const settings = settingsOverFailingStorage(root);
    settings.mountMenu();

    pasteCustomScheme(root);

    expect(root.querySelectorAll("#jv-custom-list li").length).toBe(1);
    expect(settings.themeId()).toBe("custom-pasted");
    expect(root.style.getPropertyValue("--bg")).toBe("#101010");

    await new Promise((resolve) => setTimeout(resolve, 10));
    watch.stop();
    expect(watch.reasons).toEqual([]);
  });

  test(`deleting the selected custom scheme falls back when storage ${mode}`, async () => {
    const root = mountRoot();
    const settings = settingsOverFailingStorage(root);
    settings.mountMenu();
    pasteCustomScheme(root);

    const watch = watchUnhandledRejections();
    root.querySelector<HTMLButtonElement>("#jv-custom-list li button")!.click();

    expect(root.querySelectorAll("#jv-custom-list li").length).toBe(0);
    expect(settings.themeId()).toBe(DEFAULT_THEME_ID);
    const fallback = BUILTIN_SCHEMES.find((s) => s.id === DEFAULT_THEME_ID)!;
    expect(root.style.getPropertyValue("--bg")).toBe(fallback.palette.base00);

    await new Promise((resolve) => setTimeout(resolve, 10));
    watch.stop();
    expect(watch.reasons).toEqual([]);
  });
}

test("the toggle opens the menu once, and an outside click or closeMenu shuts it", () => {
  const root = mountRoot();
  const { storage } = fakeStorage();
  const onMenuOpen = vi.fn();
  const settings = createThemeSettings({
    root,
    state: defaultThemeState(),
    storage,
    rememberQuery: true,
    exposeWindowData: false,
    onRememberQueryChange: vi.fn(),
    onExposeWindowDataChange: vi.fn(),
    onMenuOpen,
  });
  settings.mountMenu();

  const menu = root.querySelector("#jv-settings-menu")!;
  root.querySelector<HTMLButtonElement>("#jv-settings-toggle")!.click();
  expect(menu.classList.contains("jv-open")).toBe(true);
  // Only the opening edge tells the caller to close its own popups.
  expect(onMenuOpen).toHaveBeenCalledTimes(1);

  settings.closeMenu();
  expect(menu.classList.contains("jv-open")).toBe(false);

  root.querySelector<HTMLButtonElement>("#jv-settings-toggle")!.click();
  document.body.click();
  expect(menu.classList.contains("jv-open")).toBe(false);
  expect(onMenuOpen).toHaveBeenCalledTimes(2);
});
