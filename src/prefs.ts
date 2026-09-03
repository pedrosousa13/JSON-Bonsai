// Per-origin viewer preferences (view mode, last explicitly chosen collapse
// level) stored in chrome.storage.local under "jv-prefs:<origin>", so
// revisiting the same API restores the last setup. Theme is intentionally
// global (see loadThemeState in theme-settings.ts) — a person's theme
// preference isn't origin-specific.

export interface OriginPrefs {
  view?: string;
  level?: number | "all";
  /** Last JMESPath query, persisted only when "remember queries" is enabled. */
  query?: string;
  /** Recent JMESPath queries, most-recent-first; persisted with the toggle. */
  recentQueries?: string[];
  /** Recent search terms, most-recent-first; persisted with the toggle. */
  recentSearches?: string[];
}

const KEY_PREFIX = "jv-prefs:";
const WRITE_DEBOUNCE_MS = 250;

function prefsKey(origin: string): string {
  return `${KEY_PREFIX}${origin}`;
}

function storageAvailable(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

export async function loadOriginPrefs(origin: string): Promise<OriginPrefs> {
  if (!storageAvailable()) return {};
  try {
    const key = prefsKey(origin);
    const stored = await chrome.storage.local.get(key);
    const raw = stored[key] as Record<string, unknown> | undefined;
    if (typeof raw !== "object" || raw === null) return {};

    const prefs: OriginPrefs = {};
    if (typeof raw.view === "string") prefs.view = raw.view;
    if (
      raw.level === "all" ||
      (typeof raw.level === "number" && Number.isInteger(raw.level) && raw.level >= 1)
    ) {
      prefs.level = raw.level as number | "all";
    }
    if (typeof raw.query === "string") prefs.query = raw.query;
    if (Array.isArray(raw.recentQueries)) {
      const recents = raw.recentQueries.filter(
        (q): q is string => typeof q === "string"
      );
      if (recents.length > 0) prefs.recentQueries = recents;
    }
    if (Array.isArray(raw.recentSearches)) {
      const recents = raw.recentSearches.filter(
        (q): q is string => typeof q === "string"
      );
      if (recents.length > 0) prefs.recentSearches = recents;
    }
    return prefs;
  } catch {
    // Storage unavailable or corrupted — fall back to defaults.
    return {};
  }
}

export interface OriginPrefsWriter {
  /** Queues a debounced write of `prefs`. */
  save(prefs: OriginPrefs): void;
  /** Writes any debounced payload now; a no-op when nothing is pending. */
  flush(): void;
}

// Returns a debounced writer for this origin's prefs. Identical consecutive
// payloads are skipped, so reapplying loaded prefs on startup doesn't
// immediately write them back. Failures degrade silently — prefs just won't
// persist. Call `flush` when the page is going away, or the last 250 ms of
// changes are lost.
export function createOriginPrefsWriter(
  origin: string,
  initial: OriginPrefs = {},
  debounceMs: number = WRITE_DEBOUNCE_MS
): OriginPrefsWriter {
  let lastQueued = JSON.stringify(initial);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: OriginPrefs | null = null;

  function write(): void {
    if (pending === null) return;
    const snapshot = pending;
    pending = null;
    try {
      void chrome.storage.local.set({ [prefsKey(origin)]: snapshot }).catch(() => {});
    } catch {
      // Storage gone mid-session — degrade silently.
    }
  }

  return {
    save(prefs) {
      const serialized = JSON.stringify(prefs);
      if (serialized === lastQueued) return;
      lastQueued = serialized;
      if (!storageAvailable()) return;

      pending = { ...prefs };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        write();
      }, debounceMs);
    },

    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      write();
    },
  };
}
