// Theme state and everything behind the ⚙ button: the theme select, the
// custom-scheme paste/add/delete controls, the two preference checkboxes, and
// the storage reads and writes under them. The toggles' *effects* stay with the
// caller — this module persists a toggle and reports the new value.

import {
  BUILTIN_SCHEMES,
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT_ID,
  DEFAULT_THEME_ID,
  parseScheme,
  schemeToCssVars,
  type Base16Scheme,
} from "./themes";

export const REMEMBER_QUERY_KEY = "jv-remember-query";
export const EXPOSE_DATA_KEY = "jv-expose-window-data";
const THEME_ID_KEY = "jv-theme-id";
const CUSTOM_THEMES_KEY = "jv-custom-themes";

// The slice of chrome.storage.local used here, so a test can pass a plain object.
export interface SettingsStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, string>): Promise<void>;
}

export interface ThemeState {
  themeId: string;
  customs: Base16Scheme[];
}

export function defaultThemeState(): ThemeState {
  return { themeId: DEFAULT_THEME_ID, customs: [] };
}

export async function loadThemeState(storage: SettingsStorage): Promise<ThemeState> {
  // One read before first paint, both keys together.
  const stored = await storage.get([THEME_ID_KEY, CUSTOM_THEMES_KEY]);

  // No stored id — a fresh profile — takes its first paint from the OS.
  const storedId = stored[THEME_ID_KEY];
  const themeId =
    typeof storedId === "string"
      ? storedId
      : window.matchMedia("(prefers-color-scheme: light)").matches
        ? DEFAULT_LIGHT_ID
        : DEFAULT_DARK_ID;

  const storedCustoms = stored[CUSTOM_THEMES_KEY];
  let customs: Base16Scheme[] = [];
  if (typeof storedCustoms === "string") {
    try {
      const parsed = JSON.parse(storedCustoms) as unknown;
      if (Array.isArray(parsed)) customs = parsed as Base16Scheme[];
    } catch {
      // Corrupted storage — start with no custom themes.
    }
  }

  return { themeId, customs };
}

export interface ThemeSettingsOptions {
  /** The viewer root: the scheme's CSS vars go on it, the menu lives in it. */
  root: HTMLElement;
  /** Theme id and custom schemes, already read (see `loadThemeState`). */
  state: ThemeState;
  storage: SettingsStorage;
  /** Initial checkbox states; the caller reads them before it wipes the page. */
  rememberQuery: boolean;
  exposeWindowData: boolean;
  /** Fired after the matching toggle has been persisted. */
  onRememberQueryChange(enabled: boolean): void;
  onExposeWindowDataChange(enabled: boolean): void;
  /** Only one popup at a time: opening the menu closes the caller's panels. */
  onMenuOpen(): void;
}

export interface ThemeSettingsController {
  /** Paints the active scheme. Safe before the root is in the document. */
  applyTheme(): void;
  /** The active scheme's id. */
  themeId(): string;
  /** Renders the menu and wires its events. Call once, after `root` is mounted. */
  mountMenu(): void;
  /** Closes the settings menu. */
  closeMenu(): void;
}

export function createThemeSettings(options: ThemeSettingsOptions): ThemeSettingsController {
  const { root, state, storage } = options;
  let rememberQuery = options.rememberQuery;
  let exposeWindowData = options.exposeWindowData;

  // Fire-and-forget: a lost preference write is the right outcome when storage
  // is gone (see createOriginPrefsWriter in prefs.ts). An invalidated extension
  // context both rejects and throws synchronously, so both are swallowed here —
  // that keeps every caller free to carry on rendering.
  function storageSet(key: string, value: string): void {
    try {
      void storage.set({ [key]: value }).catch(() => {});
    } catch {
      // Storage gone mid-session — degrade silently.
    }
  }

  function allSchemes(): Base16Scheme[] {
    return [...BUILTIN_SCHEMES, ...state.customs];
  }

  function resolveScheme(): Base16Scheme {
    return (
      allSchemes().find((s) => s.id === state.themeId) ??
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

  // Assigned by mountMenu; closeMenu is only ever called from handlers the
  // mounted menu makes reachable, so the pre-mount no-op never fires.
  let settingsMenu: HTMLElement | null = null;

  function closeMenu(): void {
    settingsMenu?.classList.remove("jv-open");
  }

  function pick<T extends HTMLElement>(id: string): T {
    return root.querySelector<T>(`#${id}`)!;
  }

  function mountMenu(): void {
    const settingsToggle = pick("jv-settings-toggle");
    settingsMenu = pick("jv-settings-menu");
    const menu = settingsMenu;
    settingsToggle.addEventListener("click", () => {
      const willOpen = !menu.classList.contains("jv-open");
      menu.classList.toggle("jv-open");
      // Only one popup at a time: opening settings closes the search/query panels.
      if (willOpen) options.onMenuOpen();
    });
    document.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest("#jv-settings")) {
        closeMenu();
      }
    });

    const rememberQueryCheck = pick<HTMLInputElement>("jv-remember-query");
    rememberQueryCheck.checked = rememberQuery;
    rememberQueryCheck.addEventListener("change", () => {
      rememberQuery = rememberQueryCheck.checked;
      storageSet(REMEMBER_QUERY_KEY, rememberQuery ? "1" : "0");
      options.onRememberQueryChange(rememberQuery);
    });

    const exposeDataCheck = pick<HTMLInputElement>("jv-expose-data");
    exposeDataCheck.checked = exposeWindowData;
    exposeDataCheck.addEventListener("change", () => {
      exposeWindowData = exposeDataCheck.checked;
      storageSet(EXPOSE_DATA_KEY, exposeWindowData ? "1" : "0");
      options.onExposeWindowDataChange(exposeWindowData);
    });

    const themeSelect = pick<HTMLSelectElement>("jv-theme-select");
    const pasteArea = pick<HTMLTextAreaElement>("jv-theme-paste");
    const addThemeBtn = pick("jv-theme-add");
    const themeError = pick("jv-theme-error");
    const customList = pick("jv-custom-list");

    function fillThemeGroup(variant: "dark" | "light", label: string): HTMLOptGroupElement {
      const group = document.createElement("optgroup");
      group.label = label;
      for (const scheme of allSchemes().filter((s) => s.variant === variant)) {
        const option = document.createElement("option");
        option.value = scheme.id;
        option.textContent = scheme.name;
        option.selected = scheme.id === state.themeId;
        group.appendChild(option);
      }
      return group;
    }

    function renderThemeControls(): void {
      themeSelect.innerHTML = "";
      themeSelect.appendChild(fillThemeGroup("dark", "Dark"));
      themeSelect.appendChild(fillThemeGroup("light", "Light"));

      customList.innerHTML = "";
      for (const scheme of state.customs) {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = `${scheme.name} (${scheme.variant})`;
        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "✕";
        deleteBtn.title = `Delete ${scheme.name}`;
        deleteBtn.addEventListener("click", () => deleteCustomTheme(scheme.id));
        item.append(label, deleteBtn);
        customList.appendChild(item);
      }
    }

    function saveCustomThemes(): void {
      storageSet(CUSTOM_THEMES_KEY, JSON.stringify(state.customs));
    }

    function deleteCustomTheme(id: string): void {
      state.customs = state.customs.filter((s) => s.id !== id);
      if (state.themeId === id) {
        state.themeId = DEFAULT_THEME_ID;
        storageSet(THEME_ID_KEY, state.themeId);
      }
      saveCustomThemes();
      renderThemeControls();
      applyTheme();
    }

    themeSelect.addEventListener("change", () => {
      state.themeId = themeSelect.value;
      storageSet(THEME_ID_KEY, state.themeId);
      applyTheme();
    });

    addThemeBtn.addEventListener("click", () => addCustomTheme());

    function addCustomTheme(): void {
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

      state.customs.push(scheme);
      state.themeId = scheme.id;
      storageSet(THEME_ID_KEY, scheme.id);
      saveCustomThemes();
      pasteArea.value = "";
      renderThemeControls();
      applyTheme();
    }

    renderThemeControls();
  }

  return { applyTheme, themeId: () => state.themeId, mountMenu, closeMenu };
}
