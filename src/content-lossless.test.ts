// @vitest-environment jsdom
import { expect, test, vi } from "vitest";

import { parseWithExactNumbers } from "./lossless-numbers";

// The full pipeline needs JSON.parse source access (Node 21+ / Chrome 114+);
// on older engines the viewer falls back to today's lossy behavior.
const hasReviverSource = parseWithExactNumbers("{}").exactNumbers !== null;
// Re-emitting a preserved token in a serialization additionally needs
// JSON.rawJSON.
const hasRawJSON = typeof (JSON as { rawJSON?: unknown }).rawJSON === "function";

test.runIf(hasReviverSource)(
  "tree shows exact big numbers and copy actions use the source text",
  async () => {
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (query: Record<string, string>) => query),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
      },
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    };
    // jsdom has no matchMedia; the theme engine's auto mode needs it.
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    document.body.innerHTML = "<pre>{\"id\": 9007199254740993, \"ok\": 1}</pre>";

    await import("./content");
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The corrupted parsed value (…992) never reaches the tree.
    const idValue = document
      .querySelector<HTMLElement>('[data-path="data.id"]')!
      .querySelector<HTMLElement>(".jv-number")!;
    expect(idValue.textContent).toBe("9007199254740993");
    expect(idValue.classList.contains("jv-number-exact")).toBe(true);

    // Per-node copy uses the exact source text.
    document
      .querySelector<HTMLElement>('[data-path="data.id"]')!
      .querySelector<HTMLElement>(".jv-action-copy-node")!
      .click();
    expect(writeText).toHaveBeenLastCalledWith("9007199254740993");

    // "Copy JSON" re-emits the preserved token (needs JSON.rawJSON).
    if (typeof (JSON as { rawJSON?: unknown }).rawJSON === "function") {
      document.getElementById("jv-copy")!.click();
      expect(writeText.mock.lastCall?.[0]).toContain("9007199254740993");
    }
  }
);

test.runIf(hasReviverSource && hasRawJSON)(
  "a query result keeps exact numbers in the formatted and raw views",
  async () => {
    vi.resetModules();
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (query: Record<string, string>) => query),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
      },
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    };
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    document.body.innerHTML =
      '<pre>{"items": [{"id": 9007199254740993}]}</pre>';
    await import("./content");
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Query down to the element holding the big integer.
    const queryInput = document.getElementById("jv-query-input") as HTMLInputElement;
    document.getElementById("jv-query-toggle")!.click();
    queryInput.value = "items[0]";
    queryInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    document.getElementById("jv-query-close")!.click();

    const view = (name: string) =>
      document.querySelector<HTMLElement>(`.jv-view-btn[data-view="${name}"]`)!;

    // Only the queried element, and the corrupted parsed value (…992) never
    // reaches it.
    view("formatted").click();
    expect(document.getElementById("jv-formatted")!.textContent).toBe(
      '{\n  "id": 9007199254740993\n}'
    );
    document.getElementById("jv-copy")!.click();
    expect(writeText.mock.lastCall?.[0]).toContain("9007199254740993");

    view("raw").click();
    expect(document.getElementById("jv-raw")!.textContent).toBe(
      '{"id":9007199254740993}'
    );
    document.getElementById("jv-copy")!.click();
    expect(writeText.mock.lastCall?.[0]).toBe('{"id":9007199254740993}');
  }
);
