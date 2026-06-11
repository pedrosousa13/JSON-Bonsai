// Per-origin viewer preferences (view mode, last explicitly chosen collapse
// level) stored in chrome.storage.local under "jv-prefs:<origin>", so
// revisiting the same API restores the last setup. Theme is intentionally
// global (see loadThemeState in content.ts) — a person's theme preference
// isn't origin-specific.

export interface OriginPrefs {
  view?: string;
  level?: number | "all";
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
    return prefs;
  } catch {
    // Storage unavailable or corrupted — fall back to defaults.
    return {};
  }
}

// Returns a debounced writer for this origin's prefs. Identical consecutive
// payloads are skipped, so reapplying loaded prefs on startup doesn't
// immediately write them back. Failures degrade silently — prefs just won't
// persist.
export function createOriginPrefsWriter(
  origin: string,
  initial: OriginPrefs = {},
  debounceMs: number = WRITE_DEBOUNCE_MS
): (prefs: OriginPrefs) => void {
  let lastQueued = JSON.stringify(initial);
  let timer: ReturnType<typeof setTimeout> | null = null;

  return (prefs) => {
    const serialized = JSON.stringify(prefs);
    if (serialized === lastQueued) return;
    lastQueued = serialized;
    if (!storageAvailable()) return;

    const snapshot = { ...prefs };
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        void chrome.storage.local.set({ [prefsKey(origin)]: snapshot }).catch(() => {});
      } catch {
        // Storage gone mid-session — degrade silently.
      }
    }, debounceMs);
  };
}
