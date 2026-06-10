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
