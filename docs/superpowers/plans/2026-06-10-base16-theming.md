# Base16 Theming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **DO NOT COMMIT this plan file or the spec file** (`docs/superpowers/specs/2026-06-10-base16-theming-design.md`). User rule: plans/specs stay local. Never `git add docs/`.

**Goal:** Remove the custom cursor option and add a base16-standard theming system: 13 bundled famous schemes, dark+light pairing with OS-follow auto mode, and paste-in custom schemes.

**Architecture:** New pure module `src/themes.ts` holds bundled base16 palettes, the slot→CSS-var mapping, and the scheme parser/validator. `src/content.ts` owns state (mode, dark scheme id, light scheme id, custom schemes) persisted in `chrome.storage.local`, applies themes by setting inline CSS vars on `#jv-root`, and renders the settings-menu UI. `viewer.css` keeps its current var declarations as pre-JS fallback; its light/auto blocks are deleted because JS owns theming.

**Tech Stack:** TypeScript, Vite (3 build modes), vitest (pure-function tests, no jsdom needed for new tests), chrome.storage.local.

**Working directory:** `/Users/pedrosousa/Documents/projects/experiments/JSON-Alexander-theming` (git worktree, branch `feat/base16-theming`). Run everything from there.

---

### Task 0: Worktree setup

**Files:** none (environment only)

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/pedrosousa/Documents/projects/experiments/JSON-Alexander-theming
npm install
```

Expected: completes without errors (node >= 20 required).

- [ ] **Step 2: Verify baseline is green**

```bash
npm test && npm run typecheck
```

Expected: all existing tests PASS, typecheck clean. If not, STOP — baseline broken, report it.

---

### Task 1: Remove custom cursor

**Files:**
- Modify: `src/content.ts` (settings-menu HTML ~line 109, `applyCustomCursor` block ~lines 130–140, checkbox wiring ~lines 468–473)
- Modify: `src/styles/viewer.css` (cursor rule ~lines 49–52, orphaned checkbox style ~line 579)
- Modify: `vite.config.ts` (~line 33)
- Modify: `manifest.json` (`web_accessible_resources`)
- Delete: `src/pointer.png`, `src/pointer-32.png`

- [ ] **Step 1: Remove cursor checkbox from settings menu HTML in `src/content.ts`**

Find in the `root.innerHTML` template:

```html
      <div id="jv-settings">
        <button id="jv-settings-toggle" title="Settings">⚙</button>
        <div id="jv-settings-menu">
          <label><input type="checkbox" id="jv-cursor-toggle"> Custom cursor</label>
        </div>
      </div>
```

Replace with (menu left empty — Task 5 fills it):

```html
      <div id="jv-settings">
        <button id="jv-settings-toggle" title="Settings">⚙</button>
        <div id="jv-settings-menu"></div>
      </div>
```

- [ ] **Step 2: Remove `applyCustomCursor` block from `src/content.ts`**

Delete these lines (just after `body.appendChild(root);`):

```ts
  const cursorUrl = chrome.runtime.getURL("pointer-32.png");
  function applyCustomCursor(enabled: boolean) {
    if (enabled) {
      root.style.setProperty("--cursor-custom", `url(${cursorUrl}), default`);
      root.dataset.customCursor = "true";
    } else {
      root.style.removeProperty("--cursor-custom");
      delete root.dataset.customCursor;
    }
  }
  applyCustomCursor(await storageGet("jv-custom-cursor", "false") === "true");
```

- [ ] **Step 3: Remove checkbox wiring from `src/content.ts`**

Delete these lines (after the settings-menu open/close handlers):

```ts
  const cursorCheckbox = document.getElementById("jv-cursor-toggle") as HTMLInputElement;
  cursorCheckbox.checked = await storageGet("jv-custom-cursor", "false") === "true";
  cursorCheckbox.addEventListener("change", async () => {
    await storageSet("jv-custom-cursor", String(cursorCheckbox.checked));
    applyCustomCursor(cursorCheckbox.checked);
  });
```

- [ ] **Step 4: Remove cursor CSS from `src/styles/viewer.css`**

Delete:

```css
#jv-root[data-custom-cursor="true"],
#jv-root[data-custom-cursor="true"] * {
  cursor: var(--cursor-custom, default) !important;
}
```

Also delete the now-orphaned checkbox style:

```css
#jv-settings-menu input[type="checkbox"] {
  accent-color: var(--accent);
}
```

- [ ] **Step 5: Remove asset from `vite.config.ts`**

Delete the line:

```ts
                { src: "src/pointer-32.png", dest: "." },
```

- [ ] **Step 6: Remove asset from `manifest.json`**

Change:

```json
      "resources": ["page-script.js", "tree-worker.js", "pointer-32.png", "content.css"],
```

to:

```json
      "resources": ["page-script.js", "tree-worker.js", "content.css"],
```

- [ ] **Step 7: Delete image files**

```bash
git rm src/pointer.png src/pointer-32.png
```

- [ ] **Step 8: Verify**

```bash
npm run typecheck && npm test && npm run build
```

Expected: all PASS, build succeeds. `grep -ri cursor-toggle src/` returns nothing.

Note: the `jv-custom-cursor` storage key is cleaned up in Task 4's migration code.

- [ ] **Step 9: Commit**

```bash
git add src/content.ts src/styles/viewer.css vite.config.ts manifest.json
git commit -m "feat: remove custom cursor option"
```

(`git rm` already staged the deletions.)

---

### Task 2: `src/themes.ts` — bundled schemes + CSS var mapping

**Files:**
- Create: `src/themes.ts`
- Create: `src/themes.test.ts`

- [ ] **Step 1: Write failing tests in `src/themes.test.ts`**

```ts
import { describe, expect, test } from "vitest";

import {
  BUILTIN_SCHEMES,
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT_ID,
  schemeToCssVars,
} from "./themes";

describe("BUILTIN_SCHEMES", () => {
  test("contains 13 schemes with unique ids", () => {
    expect(BUILTIN_SCHEMES).toHaveLength(13);
    const ids = BUILTIN_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(13);
  });

  test("includes both defaults", () => {
    const ids = BUILTIN_SCHEMES.map((s) => s.id);
    expect(ids).toContain(DEFAULT_DARK_ID);
    expect(ids).toContain(DEFAULT_LIGHT_ID);
  });

  test("every palette slot is a normalized 6-digit hex color", () => {
    for (const scheme of BUILTIN_SCHEMES) {
      for (const [slot, value] of Object.entries(scheme.palette)) {
        expect(value, `${scheme.id} ${slot}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  test("has 9 dark and 4 light schemes", () => {
    expect(BUILTIN_SCHEMES.filter((s) => s.variant === "dark")).toHaveLength(9);
    expect(BUILTIN_SCHEMES.filter((s) => s.variant === "light")).toHaveLength(4);
  });
});

describe("schemeToCssVars", () => {
  const mocha = BUILTIN_SCHEMES.find((s) => s.id === "catppuccin-mocha")!;

  test("maps Catppuccin Mocha to the current dark theme values", () => {
    const vars = schemeToCssVars(mocha);
    expect(vars["--bg"]).toBe("#1e1e2e");
    expect(vars["--bg-toolbar"]).toBe("#181825");
    expect(vars["--bg-hover"]).toBe("#313244");
    expect(vars["--border"]).toBe("#45475a");
    expect(vars["--text"]).toBe("#cdd6f4");
    expect(vars["--key"]).toBe("#89b4fa");
    expect(vars["--accent"]).toBe("#89b4fa");
    expect(vars["--string"]).toBe("#a6e3a1");
    expect(vars["--link"]).toBe("#a6e3a1");
    expect(vars["--number"]).toBe("#fab387");
    expect(vars["--bool"]).toBe("#cba6f7");
  });

  test("derives guide highlight colors from base0A with alpha", () => {
    const vars = schemeToCssVars(mocha);
    // base0A = #f9e2af → rgb(249, 226, 175)
    expect(vars["--guide-current"]).toBe("rgba(249, 226, 175, 0.35)");
    expect(vars["--guide-ancestor"]).toBe("rgba(249, 226, 175, 0.12)");
  });

  test("maps base08 to --error and keeps --btn-bg transparent", () => {
    const vars = schemeToCssVars(mocha);
    expect(vars["--error"]).toBe("#f38ba8");
    expect(vars["--btn-bg"]).toBe("transparent");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run src/themes.test.ts
```

Expected: FAIL — `Cannot find module './themes'` (or similar).

- [ ] **Step 3: Create `src/themes.ts` with types, data, and mapping**

```ts
export type ThemeMode = "auto" | "dark" | "light";

export interface Base16Palette {
  base00: string;
  base01: string;
  base02: string;
  base03: string;
  base04: string;
  base05: string;
  base06: string;
  base07: string;
  base08: string;
  base09: string;
  base0A: string;
  base0B: string;
  base0C: string;
  base0D: string;
  base0E: string;
  base0F: string;
}

export interface Base16Scheme {
  id: string;
  name: string;
  variant: "dark" | "light";
  palette: Base16Palette;
}

export const DEFAULT_DARK_ID = "catppuccin-mocha";
export const DEFAULT_LIGHT_ID = "catppuccin-latte";

// Palettes sourced verbatim from https://github.com/tinted-theming/schemes
// (spec-0.11 branch, base16/ directory), hex lowercased.
export const BUILTIN_SCHEMES: Base16Scheme[] = [
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    variant: "dark",
    palette: {
      base00: "#1e1e2e", base01: "#181825", base02: "#313244", base03: "#45475a",
      base04: "#585b70", base05: "#cdd6f4", base06: "#f5e0dc", base07: "#b4befe",
      base08: "#f38ba8", base09: "#fab387", base0A: "#f9e2af", base0B: "#a6e3a1",
      base0C: "#94e2d5", base0D: "#89b4fa", base0E: "#cba6f7", base0F: "#f2cdcd",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    variant: "dark",
    palette: {
      base00: "#282a36", base01: "#21222c", base02: "#44475a", base03: "#6272a4",
      base04: "#9ea8c7", base05: "#f8f8f2", base06: "#f8f8f2", base07: "#ffffff",
      base08: "#ff5555", base09: "#ffb86c", base0A: "#f1fa8c", base0B: "#50fa7b",
      base0C: "#8be9fd", base0D: "#bd93f9", base0E: "#ff79c6", base0F: "#993333",
    },
  },
  {
    id: "nord",
    name: "Nord",
    variant: "dark",
    palette: {
      base00: "#2e3440", base01: "#3b4252", base02: "#434c5e", base03: "#4c566a",
      base04: "#d8dee9", base05: "#e5e9f0", base06: "#eceff4", base07: "#8fbcbb",
      base08: "#bf616a", base09: "#d08770", base0A: "#ebcb8b", base0B: "#a3be8c",
      base0C: "#88c0d0", base0D: "#81a1c1", base0E: "#b48ead", base0F: "#5e81ac",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    variant: "dark",
    palette: {
      base00: "#282828", base01: "#3c3836", base02: "#504945", base03: "#665c54",
      base04: "#bdae93", base05: "#d5c4a1", base06: "#ebdbb2", base07: "#fbf1c7",
      base08: "#fb4934", base09: "#fe8019", base0A: "#fabd2f", base0B: "#b8bb26",
      base0C: "#8ec07c", base0D: "#83a598", base0E: "#d3869b", base0F: "#d65d0e",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    variant: "dark",
    palette: {
      base00: "#002b36", base01: "#073642", base02: "#586e75", base03: "#657b83",
      base04: "#839496", base05: "#93a1a1", base06: "#eee8d5", base07: "#fdf6e3",
      base08: "#dc322f", base09: "#cb4b16", base0A: "#b58900", base0B: "#859900",
      base0C: "#2aa198", base0D: "#268bd2", base0E: "#6c71c4", base0F: "#d33682",
    },
  },
  {
    id: "onedark",
    name: "OneDark",
    variant: "dark",
    palette: {
      base00: "#282c34", base01: "#353b45", base02: "#3e4451", base03: "#545862",
      base04: "#565c64", base05: "#abb2bf", base06: "#b6bdca", base07: "#c8ccd4",
      base08: "#e06c75", base09: "#d19a66", base0A: "#e5c07b", base0B: "#98c379",
      base0C: "#56b6c2", base0D: "#61afef", base0E: "#c678dd", base0F: "#be5046",
    },
  },
  {
    id: "tokyo-night-dark",
    name: "Tokyo Night Dark",
    variant: "dark",
    palette: {
      base00: "#1a1b26", base01: "#16161e", base02: "#2f3549", base03: "#444b6a",
      base04: "#787c99", base05: "#a9b1d6", base06: "#cbccd1", base07: "#d5d6db",
      base08: "#c0caf5", base09: "#a9b1d6", base0A: "#0db9d7", base0B: "#9ece6a",
      base0C: "#b4f9f8", base0D: "#2ac3de", base0E: "#bb9af7", base0F: "#f7768e",
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    variant: "dark",
    palette: {
      base00: "#161b22", base01: "#30363d", base02: "#484f58", base03: "#6e7681",
      base04: "#8b949e", base05: "#c9d1d9", base06: "#f0f6fc", base07: "#ffffff",
      base08: "#f85149", base09: "#db6d28", base0A: "#bb8009", base0B: "#2ea043",
      base0C: "#2a9d9a", base0D: "#388bfd", base0E: "#a371f7", base0F: "#3d2f00",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    variant: "dark",
    palette: {
      base00: "#272822", base01: "#383830", base02: "#49483e", base03: "#75715e",
      base04: "#a59f85", base05: "#f8f8f2", base06: "#f5f4f1", base07: "#f9f8f5",
      base08: "#f92672", base09: "#fd971f", base0A: "#f4bf75", base0B: "#a6e22e",
      base0C: "#a1efe4", base0D: "#66d9ef", base0E: "#ae81ff", base0F: "#cc6633",
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    variant: "light",
    palette: {
      base00: "#eff1f5", base01: "#e6e9ef", base02: "#ccd0da", base03: "#bcc0cc",
      base04: "#acb0be", base05: "#4c4f69", base06: "#dc8a78", base07: "#7287fd",
      base08: "#d20f39", base09: "#fe640b", base0A: "#df8e1d", base0B: "#40a02b",
      base0C: "#179299", base0D: "#1e66f5", base0E: "#8839ef", base0F: "#dd7878",
    },
  },
  {
    id: "gruvbox-light",
    name: "Gruvbox Light",
    variant: "light",
    palette: {
      base00: "#fbf1c7", base01: "#ebdbb2", base02: "#d5c4a1", base03: "#bdae93",
      base04: "#665c54", base05: "#504945", base06: "#3c3836", base07: "#282828",
      base08: "#9d0006", base09: "#af3a03", base0A: "#b57614", base0B: "#79740e",
      base0C: "#427b58", base0D: "#076678", base0E: "#8f3f71", base0F: "#d65d0e",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    variant: "light",
    palette: {
      base00: "#fdf6e3", base01: "#eee8d5", base02: "#93a1a1", base03: "#839496",
      base04: "#657b83", base05: "#586e75", base06: "#073642", base07: "#002b36",
      base08: "#dc322f", base09: "#cb4b16", base0A: "#b58900", base0B: "#859900",
      base0C: "#2aa198", base0D: "#268bd2", base0E: "#6c71c4", base0F: "#d33682",
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    variant: "light",
    palette: {
      base00: "#eaeef2", base01: "#d0d7de", base02: "#afb8c1", base03: "#8c959f",
      base04: "#6e7781", base05: "#424a53", base06: "#32383f", base07: "#1f2328",
      base08: "#fa4549", base09: "#e16f24", base0A: "#bf8700", base0B: "#2da44e",
      base0C: "#339d9b", base0D: "#218bff", base0E: "#a475f9", base0F: "#4d2d00",
    },
  },
];

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value.split("").map((c) => c + c).join("")
      : value;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function schemeToCssVars(scheme: Base16Scheme): Record<string, string> {
  const p = scheme.palette;
  return {
    "--bg": p.base00,
    "--bg-toolbar": p.base01,
    "--bg-hover": p.base02,
    "--bg-tooltip": p.base02,
    "--guide": p.base02,
    "--border": p.base03,
    "--btn-hover": p.base03,
    "--bracket": p.base04,
    "--punctuation": p.base04,
    "--null": p.base04,
    "--text-muted": p.base04,
    "--btn-active": p.base04,
    "--text": p.base05,
    "--error": p.base08,
    "--number": p.base09,
    "--guide-current": hexToRgba(p.base0A, 0.35),
    "--guide-ancestor": hexToRgba(p.base0A, 0.12),
    "--string": p.base0B,
    "--link": p.base0B,
    "--key": p.base0D,
    "--accent": p.base0D,
    "--bool": p.base0E,
    "--btn-bg": "transparent",
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run src/themes.test.ts
```

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/themes.ts src/themes.test.ts
git commit -m "feat: add base16 scheme data and CSS var mapping"
```

---

### Task 3: `src/themes.ts` — scheme parser + variant guessing

**Files:**
- Modify: `src/themes.ts` (append)
- Modify: `src/themes.test.ts` (append)

- [ ] **Step 1: Append failing tests to `src/themes.test.ts`**

Add `guessVariant` and `parseScheme` to the existing import from `./themes`, then append:

```ts
const LATTE_YAML = `system: "base16"
name: "Catppuccin Latte"
author: "https://github.com/catppuccin/catppuccin"
variant: "light"
palette:
  base00: "#eff1f5" # base
  base01: "#e6e9ef" # mantle
  base02: "#ccd0da" # surface0
  base03: "#bcc0cc" # surface1
  base04: "#acb0be" # surface2
  base05: "#4c4f69" # text
  base06: "#dc8a78" # rosewater
  base07: "#7287fd" # lavender
  base08: "#d20f39" # red
  base09: "#fe640b" # peach
  base0A: "#df8e1d" # yellow
  base0B: "#40a02b" # green
  base0C: "#179299" # teal
  base0D: "#1e66f5" # blue
  base0E: "#8839ef" # mauve
  base0F: "#dd7878" # flamingo
`;

describe("guessVariant", () => {
  test("dark background → dark", () => {
    expect(guessVariant("#1e1e2e")).toBe("dark");
  });

  test("light background → light", () => {
    expect(guessVariant("#eff1f5")).toBe("light");
  });
});

describe("parseScheme", () => {
  test("parses an official base16 YAML file", () => {
    const scheme = parseScheme(LATTE_YAML);
    expect(scheme.name).toBe("Catppuccin Latte");
    expect(scheme.variant).toBe("light");
    expect(scheme.id).toBe("custom-catppuccin-latte");
    expect(scheme.palette.base00).toBe("#eff1f5");
    expect(scheme.palette.base0F).toBe("#dd7878");
  });

  test("parses JSON with a palette wrapper", () => {
    const json = JSON.stringify({
      name: "My Theme",
      variant: "dark",
      palette: {
        base00: "1e1e2e", base01: "#181825", base02: "#313244", base03: "#45475a",
        base04: "#585b70", base05: "#cdd6f4", base06: "#f5e0dc", base07: "#b4befe",
        base08: "#f38ba8", base09: "#fab387", base0A: "#f9e2af", base0B: "#a6e3a1",
        base0C: "#94e2d5", base0D: "#89b4fa", base0E: "#cba6f7", base0F: "#f2cdcd",
      },
    });
    const scheme = parseScheme(json);
    expect(scheme.name).toBe("My Theme");
    expect(scheme.variant).toBe("dark");
    // "#" was missing on base00 — normalized
    expect(scheme.palette.base00).toBe("#1e1e2e");
  });

  test("parses a flat JSON palette, guessing name and variant", () => {
    const json = JSON.stringify({
      base00: "#eff1f5", base01: "#e6e9ef", base02: "#ccd0da", base03: "#bcc0cc",
      base04: "#acb0be", base05: "#4c4f69", base06: "#dc8a78", base07: "#7287fd",
      base08: "#d20f39", base09: "#fe640b", base0A: "#df8e1d", base0B: "#40a02b",
      base0C: "#179299", base0D: "#1e66f5", base0E: "#8839ef", base0F: "#dd7878",
    });
    const scheme = parseScheme(json);
    expect(scheme.name).toBe("Custom");
    expect(scheme.variant).toBe("light");
  });

  test("accepts lowercase slot keys (base0a)", () => {
    const yaml = LATTE_YAML.replace("base0A:", "base0a:");
    expect(parseScheme(yaml).palette.base0A).toBe("#df8e1d");
  });

  test("rejects a scheme missing a slot", () => {
    const yaml = LATTE_YAML.replace(/^\s*base0F:.*$/m, "");
    expect(() => parseScheme(yaml)).toThrow(/base0F/);
  });

  test("rejects invalid hex values", () => {
    const yaml = LATTE_YAML.replace('"#eff1f5"', '"#zzzzzz"');
    expect(() => parseScheme(yaml)).toThrow(/base00/);
  });

  test("rejects empty input", () => {
    expect(() => parseScheme("   ")).toThrow();
  });

  test("rejects invalid JSON starting with {", () => {
    expect(() => parseScheme("{not json")).toThrow(/JSON/);
  });
});
```

- [ ] **Step 2: Run tests, verify the new ones fail**

```bash
npx vitest run src/themes.test.ts
```

Expected: FAIL — `parseScheme`/`guessVariant` not exported.

- [ ] **Step 3: Append parser implementation to `src/themes.ts`**

```ts
const PALETTE_KEYS = [
  "base00", "base01", "base02", "base03", "base04", "base05", "base06", "base07",
  "base08", "base09", "base0A", "base0B", "base0C", "base0D", "base0E", "base0F",
] as const;

const HEX_RE = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

function normalizeHex(value: string): string | null {
  const match = HEX_RE.exec(value.trim());
  if (!match) return null;
  const hex = match[1].toLowerCase();
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  return `#${full}`;
}

export function guessVariant(base00: string): "dark" | "light" {
  const hex = normalizeHex(base00) ?? "#000000";
  const { r, g, b } = hexToRgb(hex);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.5 ? "light" : "dark";
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "theme";
}

function normalizeSlotKey(key: string): string {
  // base0a → base0A so lowercase keys are accepted
  return key.slice(0, 5) + key.slice(5).toUpperCase();
}

interface RawScheme {
  name?: string;
  variant?: string;
  palette: Record<string, string>;
}

function parseYamlScheme(text: string): RawScheme {
  const palette: Record<string, string> = {};
  let name: string | undefined;
  let variant: string | undefined;

  for (const line of text.split("\n")) {
    const match =
      /^\s*([A-Za-z0-9_]+):\s*(?:"([^"]*)"|'([^']*)'|([^#\s][^#]*?))\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (/^base0[0-9A-Fa-f]$/.test(key)) {
      palette[normalizeSlotKey(key)] = value;
    } else if (key === "name") {
      name = value;
    } else if (key === "variant") {
      variant = value;
    }
  }

  return { name, variant, palette };
}

function parseJsonScheme(text: string): RawScheme {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON");
  }
  if (typeof data !== "object" || data === null) {
    throw new Error("Scheme must be a JSON object");
  }
  const obj = data as Record<string, unknown>;
  const source =
    typeof obj.palette === "object" && obj.palette !== null
      ? (obj.palette as Record<string, unknown>)
      : obj;

  const palette: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && /^base0[0-9A-Fa-f]$/.test(key)) {
      palette[normalizeSlotKey(key)] = value;
    }
  }

  return {
    name: typeof obj.name === "string" ? obj.name : undefined,
    variant: typeof obj.variant === "string" ? obj.variant : undefined,
    palette,
  };
}

export function parseScheme(text: string): Base16Scheme {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste a base16 scheme first");

  const raw = trimmed.startsWith("{")
    ? parseJsonScheme(trimmed)
    : parseYamlScheme(trimmed);

  const palette = {} as Record<(typeof PALETTE_KEYS)[number], string>;
  for (const key of PALETTE_KEYS) {
    const value = raw.palette[key];
    const hex = value === undefined ? null : normalizeHex(value);
    if (!hex) throw new Error(`Missing or invalid color for ${key}`);
    palette[key] = hex;
  }

  const name = raw.name?.trim() || "Custom";
  const variant =
    raw.variant === "dark" || raw.variant === "light"
      ? raw.variant
      : guessVariant(palette.base00);

  return {
    id: `custom-${slugify(name)}`,
    name,
    variant,
    palette: palette as Base16Palette,
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run src/themes.test.ts && npm run typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/themes.ts src/themes.test.ts
git commit -m "feat: add base16 scheme parser and variant guessing"
```

---

### Task 4: Theme engine in `src/content.ts` + CSS cleanup

**Files:**
- Modify: `src/content.ts`
- Modify: `src/styles/viewer.css`

- [ ] **Step 1: Replace old theme functions in `src/content.ts`**

Delete `getTheme`, `setTheme`, `cycleTheme`, `updateThemeButton` (the four functions between `storageSet` and `init`). Add the import at the top of the file:

```ts
import {
  BUILTIN_SCHEMES,
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT_ID,
  parseScheme,
  schemeToCssVars,
  type Base16Scheme,
  type ThemeMode,
} from "./themes";
```

Then add where the old functions were:

```ts
interface ThemeState {
  mode: ThemeMode;
  darkId: string;
  lightId: string;
  customs: Base16Scheme[];
}

async function loadThemeState(): Promise<ThemeState> {
  // One-time migration: jv-theme used to hold the mode; jv-custom-cursor is gone.
  const legacy = await chrome.storage.local.get("jv-theme");
  if (typeof legacy["jv-theme"] === "string") {
    await chrome.storage.local.set({ "jv-theme-mode": legacy["jv-theme"] });
  }
  await chrome.storage.local.remove(["jv-theme", "jv-custom-cursor"]);

  const stored = await chrome.storage.local.get({
    "jv-theme-mode": "auto",
    "jv-theme-dark": DEFAULT_DARK_ID,
    "jv-theme-light": DEFAULT_LIGHT_ID,
    "jv-custom-themes": "[]",
  });

  let customs: Base16Scheme[] = [];
  try {
    const parsed = JSON.parse(stored["jv-custom-themes"] as string) as unknown;
    if (Array.isArray(parsed)) customs = parsed as Base16Scheme[];
  } catch {
    // Corrupted storage — start with no custom themes.
  }

  const mode = stored["jv-theme-mode"] as string;
  return {
    mode: mode === "dark" || mode === "light" ? mode : "auto",
    darkId: stored["jv-theme-dark"] as string,
    lightId: stored["jv-theme-light"] as string,
    customs,
  };
}
```

- [ ] **Step 2: Wire the theme engine inside `init()`**

In `init()`, replace the line `root.dataset.theme = await getTheme();` with nothing (delete it — the root no longer carries a theme attribute). Then, right after `body.appendChild(root);`, add:

```ts
  const themeState = await loadThemeState();
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)");

  function allSchemes(): Base16Scheme[] {
    return [...BUILTIN_SCHEMES, ...themeState.customs];
  }

  function findScheme(id: string, variant: "dark" | "light"): Base16Scheme {
    const fallbackId = variant === "dark" ? DEFAULT_DARK_ID : DEFAULT_LIGHT_ID;
    return (
      allSchemes().find((s) => s.id === id) ??
      BUILTIN_SCHEMES.find((s) => s.id === fallbackId)!
    );
  }

  function resolveScheme(): Base16Scheme {
    const variant =
      themeState.mode === "auto"
        ? prefersLight.matches
          ? "light"
          : "dark"
        : themeState.mode;
    return variant === "dark"
      ? findScheme(themeState.darkId, "dark")
      : findScheme(themeState.lightId, "light");
  }

  function applyTheme(): void {
    const scheme = resolveScheme();
    for (const [name, value] of Object.entries(schemeToCssVars(scheme))) {
      root.style.setProperty(name, value);
    }
    // Overscroll area behind the viewer follows the toolbar color.
    document.documentElement.style.background = scheme.palette.base01;
  }

  prefersLight.addEventListener("change", () => {
    if (themeState.mode === "auto") applyTheme();
  });

  applyTheme();
```

- [ ] **Step 3: Replace the theme button wiring in `init()`**

Replace:

```ts
  await updateThemeButton();
  document.getElementById("jv-theme-toggle")!.addEventListener("click", cycleTheme);
```

with:

```ts
  const modeIcons: Record<ThemeMode, string> = { auto: "◐", dark: "☾", light: "☀" };
  const themeToggleBtn = document.getElementById("jv-theme-toggle")!;

  function updateModeButton(): void {
    themeToggleBtn.textContent = modeIcons[themeState.mode];
    themeToggleBtn.title = `Theme mode: ${themeState.mode}`;
  }

  themeToggleBtn.addEventListener("click", async () => {
    themeState.mode =
      themeState.mode === "auto" ? "dark" : themeState.mode === "dark" ? "light" : "auto";
    await storageSet("jv-theme-mode", themeState.mode);
    updateModeButton();
    applyTheme();
  });

  updateModeButton();
```

- [ ] **Step 4: Remove the light/auto CSS blocks from `src/styles/viewer.css`**

Delete both blocks entirely (JS now owns theming; the base `#jv-root` vars remain as the pre-JS fallback):

```css
#jv-root[data-theme="light"] {
  /* ...the whole block... */
}

@media (prefers-color-scheme: light) {
  #jv-root[data-theme="auto"] {
    /* ...the whole block... */
  }
}
```

Add `--error` to the base `#jv-root` var declarations (after `--btn-active: #585b70;`):

```css
  --error: #f38ba8;
```

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm test && npm run build
```

Expected: PASS. `grep -n "data-theme" src/` returns nothing.

- [ ] **Step 6: Commit**

```bash
git add src/content.ts src/styles/viewer.css
git commit -m "feat: drive theming from base16 schemes with dark/light pairing"
```

---

### Task 5: Settings menu UI for themes

**Files:**
- Modify: `src/content.ts` (settings menu HTML + wiring)
- Modify: `src/styles/viewer.css` (menu styles)

- [ ] **Step 1: Fill the settings menu HTML in `src/content.ts`**

Replace the empty menu from Task 1:

```html
      <div id="jv-settings">
        <button id="jv-settings-toggle" title="Settings">⚙</button>
        <div id="jv-settings-menu"></div>
      </div>
```

with:

```html
      <div id="jv-settings">
        <button id="jv-settings-toggle" title="Settings">⚙</button>
        <div id="jv-settings-menu">
          <div class="jv-settings-row"><span>Dark theme</span><select id="jv-theme-dark-select"></select></div>
          <div class="jv-settings-row"><span>Light theme</span><select id="jv-theme-light-select"></select></div>
          <textarea id="jv-theme-paste" placeholder="Paste a base16 scheme (YAML or JSON)" spellcheck="false"></textarea>
          <div class="jv-settings-row">
            <a id="jv-theme-browse" href="https://github.com/tinted-theming/schemes" target="_blank" rel="noreferrer">Find more themes</a>
            <button id="jv-theme-add">Add theme</button>
          </div>
          <div id="jv-theme-error"></div>
          <ul id="jv-custom-list"></ul>
        </div>
      </div>
```

- [ ] **Step 2: Wire the controls in `init()`**

Add after the existing settings open/close handlers (where the cursor checkbox wiring used to be):

```ts
  const darkSelect = document.getElementById("jv-theme-dark-select") as HTMLSelectElement;
  const lightSelect = document.getElementById("jv-theme-light-select") as HTMLSelectElement;
  const pasteArea = document.getElementById("jv-theme-paste") as HTMLTextAreaElement;
  const addThemeBtn = document.getElementById("jv-theme-add")!;
  const themeError = document.getElementById("jv-theme-error")!;
  const customList = document.getElementById("jv-custom-list")!;

  function fillThemeSelect(
    select: HTMLSelectElement,
    variant: "dark" | "light",
    activeId: string
  ): void {
    select.innerHTML = "";
    for (const scheme of allSchemes().filter((s) => s.variant === variant)) {
      const option = document.createElement("option");
      option.value = scheme.id;
      option.textContent = scheme.name;
      option.selected = scheme.id === activeId;
      select.appendChild(option);
    }
  }

  function renderThemeControls(): void {
    fillThemeSelect(darkSelect, "dark", themeState.darkId);
    fillThemeSelect(lightSelect, "light", themeState.lightId);

    customList.innerHTML = "";
    for (const scheme of themeState.customs) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${scheme.name} (${scheme.variant})`;
      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "✕";
      deleteBtn.title = `Delete ${scheme.name}`;
      deleteBtn.addEventListener("click", () => void deleteCustomTheme(scheme.id));
      item.append(label, deleteBtn);
      customList.appendChild(item);
    }
  }

  async function saveCustomThemes(): Promise<void> {
    await storageSet("jv-custom-themes", JSON.stringify(themeState.customs));
  }

  async function deleteCustomTheme(id: string): Promise<void> {
    themeState.customs = themeState.customs.filter((s) => s.id !== id);
    if (themeState.darkId === id) {
      themeState.darkId = DEFAULT_DARK_ID;
      await storageSet("jv-theme-dark", themeState.darkId);
    }
    if (themeState.lightId === id) {
      themeState.lightId = DEFAULT_LIGHT_ID;
      await storageSet("jv-theme-light", themeState.lightId);
    }
    await saveCustomThemes();
    renderThemeControls();
    applyTheme();
  }

  darkSelect.addEventListener("change", async () => {
    themeState.darkId = darkSelect.value;
    await storageSet("jv-theme-dark", themeState.darkId);
    applyTheme();
  });

  lightSelect.addEventListener("change", async () => {
    themeState.lightId = lightSelect.value;
    await storageSet("jv-theme-light", themeState.lightId);
    applyTheme();
  });

  addThemeBtn.addEventListener("click", async () => {
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

    themeState.customs.push(scheme);
    if (scheme.variant === "dark") {
      themeState.darkId = scheme.id;
      await storageSet("jv-theme-dark", scheme.id);
    } else {
      themeState.lightId = scheme.id;
      await storageSet("jv-theme-light", scheme.id);
    }
    await saveCustomThemes();
    pasteArea.value = "";
    renderThemeControls();
    applyTheme();
  });

  renderThemeControls();
```

- [ ] **Step 3: Add menu styles to `src/styles/viewer.css`**

After the `#jv-settings-menu.jv-open` rule, replace the old label rule:

```css
#jv-settings-menu label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text);
}
```

with:

```css
.jv-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--text);
  margin-bottom: 8px;
}

#jv-settings-menu select {
  font-family: inherit;
  font-size: 12px;
  max-width: 170px;
  padding: 2px 4px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
}

#jv-theme-paste {
  display: block;
  width: 260px;
  height: 72px;
  margin-bottom: 8px;
  padding: 4px 6px;
  font-family: inherit;
  font-size: 11px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  resize: vertical;
}

#jv-theme-browse {
  font-size: 11px;
  color: var(--accent);
}

#jv-theme-error {
  max-width: 260px;
  white-space: normal;
  font-size: 11px;
  color: var(--error);
}

#jv-custom-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  font-size: 12px;
  color: var(--text);
}

#jv-custom-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
}

#jv-custom-list button {
  font-family: inherit;
  font-size: 10px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--btn-bg);
  color: var(--text-muted);
  cursor: pointer;
}

#jv-custom-list button:hover {
  background: var(--btn-hover);
  color: var(--text);
}
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm test && npm run build
```

Expected: all PASS, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/content.ts src/styles/viewer.css
git commit -m "feat: add theme picker and custom scheme import to settings menu"
```

---

### Task 6: README theming section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Theming" section to `README.md`**

Read the existing README first and match its tone/structure. Add a section covering:

- Mode toggle (◐ auto follows OS / ☾ dark / ☀ light) via the toolbar button
- Dark + light theme pairing — picked in the ⚙ settings menu, auto mode switches between them
- 13 bundled schemes (list them)
- Custom themes: paste any base16 scheme (YAML or JSON) in the settings menu
- Where to find more: link to <https://github.com/tinted-theming/schemes>

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document theming in README"
```

---

### Task 7: Manual smoke test

**Files:** none

- [ ] **Step 1: Build and load the extension**

```bash
npm run build
```

Load `dist/` as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked), then open any JSON URL (e.g. `https://api.github.com/repos/wesbos/JSON-Alexander`).

- [ ] **Step 2: Verify checklist**

- Default look identical to before (Catppuccin Mocha dark / Latte in light OS mode)
- ◐/☾/☀ button cycles modes; theme follows
- Gear menu: dark select shows 9 themes, light select shows 4
- Picking Dracula (dark mode) restyles instantly; survives reload
- Pasting the Nord YAML from https://raw.githubusercontent.com/tinted-theming/schemes/spec-0.11/base16/nord.yaml adds "Nord (dark)" custom, applies it
- Pasting garbage shows inline error, nothing saved
- Deleting the custom theme reverts to Catppuccin Mocha
- No custom cursor option anywhere; `dist/` contains no `pointer-32.png`

- [ ] **Step 3: Done — report results**

Do not merge or PR without user instruction. Plan/spec files stay uncommitted.
