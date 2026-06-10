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
// gruvbox-dark/-light use the "medium" contrast variants (gruvbox-dark-medium.yaml,
// gruvbox-light-medium.yaml).
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

// Muted/guide colors are derived from palette slots (base04, base0A) rather than
// copied from the old hand-tuned CSS values, so every scheme themes them consistently.
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
    // Unquoted values may start with # (bare hex); a comment only starts at
    // whitespace-then-#, so `base00: #1d1f21 # note` parses as value + comment.
    const match =
      /^\s*([A-Za-z0-9_]+):\s*(?:"([^"]*)"|'([^']*)'|(\S.*?))\s*(?:\s#.*)?$/.exec(line);
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
