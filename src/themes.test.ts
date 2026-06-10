import { describe, expect, test } from "vitest";

import {
  BUILTIN_SCHEMES,
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT_ID,
  guessVariant,
  parseScheme,
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

  test("maps Catppuccin Mocha palette slots to CSS vars", () => {
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

  test("emits the complete CSS var set", () => {
    expect(Object.keys(schemeToCssVars(mocha)).sort()).toEqual(
      [
        "--accent", "--bg", "--bg-hover", "--bg-toolbar", "--bg-tooltip",
        "--bool", "--border", "--bracket", "--btn-active", "--btn-bg",
        "--btn-hover", "--error", "--guide", "--guide-ancestor",
        "--guide-current", "--key", "--link", "--null", "--number",
        "--punctuation", "--string", "--text", "--text-muted",
      ].sort()
    );
  });
});

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

  test("accepts quoted hex without #", () => {
    const yaml = LATTE_YAML.replace('"#eff1f5"', '"eff1f5"');
    expect(parseScheme(yaml).palette.base00).toBe("#eff1f5");
  });

  test("accepts unquoted #-prefixed hex", () => {
    const yaml = LATTE_YAML.replace('base00: "#eff1f5"', "base00: #eff1f5");
    expect(parseScheme(yaml).palette.base00).toBe("#eff1f5");
  });

  test("accepts unquoted hex with no space after the colon", () => {
    const yaml = LATTE_YAML.replace('base00: "#eff1f5"', "base00:#eff1f5");
    expect(parseScheme(yaml).palette.base00).toBe("#eff1f5");
  });

  test("strips trailing comments after unquoted values", () => {
    const yaml = LATTE_YAML.replace('base00: "#eff1f5" # base', "base00: #eff1f5 # base");
    expect(parseScheme(yaml).palette.base00).toBe("#eff1f5");
  });
});
