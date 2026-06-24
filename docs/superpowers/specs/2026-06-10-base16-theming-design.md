# Base16 Theming + Custom Cursor Removal — Design

**Date:** 2026-06-10
**Status:** Approved (do not commit this file — local working artifact)

## Goal

Remove the custom cursor option (quirk, not needed). Replace it with a robust theming
system built on the base16 (Tinted Theming) standard: bundled famous schemes out of the
box, plus user-supplied custom schemes.

## Why base16

- A base16 scheme is 16 named colors (`base00`–`base0F`) with fixed semantic roles.
  ~290 community schemes exist in the official
  [tinted-theming/schemes](https://github.com/tinted-theming/schemes) repo
  (Catppuccin, Dracula, Nord, Gruvbox, Solarized, GitHub, Tokyo Night, …).
- JSON Bonsai's current dark theme **is already Catppuccin Mocha** — every CSS var in
  `viewer.css` matches a base16 slot exactly. The mapping is proven.
- Custom themes become "paste any base16 scheme" instead of a bespoke format.

## Part 1: Custom cursor removal

Delete:

- Settings-menu checkbox `#jv-cursor-toggle` (`content.ts`)
- `applyCustomCursor()` + `cursorUrl` + change listener (`content.ts`)
- `#jv-root[data-custom-cursor]` CSS rule (`viewer.css`)
- `pointer-32.png` entry in `vite.config.ts` static copy
- `pointer-32.png` in `manifest.json` `web_accessible_resources`
- Files `src/pointer.png`, `src/pointer-32.png`
- Storage key `jv-custom-cursor` (removed once on init)

## Part 2: Theme engine

New module `src/themes.ts`:

### Bundled schemes

13 base16 palettes compiled in as TS data (sourced from tinted-theming/schemes
spec-0.11 branch), each `{ id, name, variant, palette: { base00…base0F } }`:

- **Dark:** Catppuccin Mocha (default), Dracula, Nord, Gruvbox Dark (medium),
  Solarized Dark, OneDark, Tokyo Night Dark, GitHub Dark, Monokai
- **Light:** Catppuccin Latte (default), Gruvbox Light (medium), Solarized Light,
  GitHub (light)

### Slot → CSS var mapping

One function maps a palette to the existing `#jv-root` CSS vars:

| base16 slot | CSS vars |
|---|---|
| base00 | `--bg` |
| base01 | `--bg-toolbar` |
| base02 | `--bg-hover`, `--bg-tooltip`, `--guide` |
| base03 | `--border`, `--btn-hover` |
| base04 | `--bracket`, `--punctuation`, `--null`, `--text-muted`, `--btn-active` |
| base05 | `--text` |
| base08 | `--error` (new var, used by custom-theme error message) |
| base09 | `--number` |
| base0A | `--guide-current` (35% alpha), `--guide-ancestor` (12% alpha) |
| base0B | `--string`, `--link` |
| base0D | `--key`, `--accent` |
| base0E | `--bool` |

`--btn-bg` stays `transparent`. Applied via `style.setProperty` on `#jv-root`;
existing CSS var declarations in `viewer.css` remain as pre-JS fallback defaults.
The hardcoded `html:has(#jv-root) { background: #181825 }` also becomes themed
(set to base01 from JS) so light themes don't get a dark overscroll area.

The `[data-theme="light"]` and `prefers-color-scheme` CSS blocks are removed —
JS owns theming after init.

### Custom scheme parser

Accepts pasted base16 **YAML** (flat official format — parsed with a small
line-based parser, no YAML dependency) or **JSON** (either
`{ name, variant, palette: {...} }` or a flat `{ base00: ..., ... }` object).
Validation:

- All 16 `base00`–`base0F` keys present, each a valid hex color (`#` optional,
  3 or 6 digits, normalized to lowercase 6-digit `#rrggbb`)
- `name` optional (defaults to "Custom")
- `variant` optional — guessed from base00 relative luminance when absent

Invalid paste → inline error message, nothing saved.

## Part 3: Mode + pairing

- Mode: `auto | dark | light`. User picks one **dark scheme** and one **light
  scheme**; auto follows the OS via a `matchMedia("(prefers-color-scheme: light)")`
  listener (live switching).
- Defaults Mocha + Latte → current behavior preserved exactly.
- Toolbar ◐/☾/☀ button keeps cycling mode.

## Part 4: Settings menu UI

Gear menu (vacated by cursor toggle) gains:

- Dark theme `<select>` (dark bundled + dark customs)
- Light theme `<select>` (light bundled + light customs)
- Paste textarea + "Add theme" button for custom schemes; adding a scheme
  selects it for its variant slot immediately
- Help link next to the paste area: "Find more themes" →
  <https://github.com/tinted-theming/schemes> (opens in new tab)
- List of saved customs, each deletable

## Part 5: Storage

`chrome.storage.local` keys:

| Key | Value | Notes |
|---|---|---|
| `jv-theme-mode` | `auto\|dark\|light` | migrated from old `jv-theme` value |
| `jv-theme-dark` | scheme id | default `catppuccin-mocha` |
| `jv-theme-light` | scheme id | default `catppuccin-latte` |
| `jv-custom-themes` | JSON array of schemes | corrupted value → reset to `[]` |

Unknown stored scheme id (e.g. deleted custom) → fall back to default for that slot.

## Error handling

- Invalid custom scheme paste → inline error (uses `--error`), no save
- Missing/unknown scheme id in storage → default scheme for that variant
- Deleting a custom theme currently in use → affected slot reverts to default
- Corrupted `jv-custom-themes` JSON → treated as empty list

## Testing (vitest, pure functions, no jsdom needed)

- Parser: valid YAML (real Catppuccin Latte file), valid JSON (both shapes),
  missing slots, bad hex, empty input, variant guessing
- Mapping function: palette in → expected CSS var map out (incl. alpha-derived guides)
- Luminance-based variant guess (dark base00 → dark, light base00 → light)
- Bundled schemes: 13 entries, unique ids, defaults present, all hex values valid
