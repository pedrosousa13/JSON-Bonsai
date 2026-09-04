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

// Boots the viewer over `json` in a fresh module instance and returns the
// clipboard spy. Same stubs as the tests above, factored out because the
// rounded-number tests below mount several documents.
async function mountViewer(json: string): Promise<ReturnType<typeof vi.fn>> {
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

  document.body.innerHTML = `<pre>${json}</pre>`;
  await import("./content");
  await new Promise((resolve) => setTimeout(resolve, 150));
  return writeText;
}

async function runViewerQuery(expression: string): Promise<void> {
  const queryInput = document.getElementById("jv-query-input") as HTMLInputElement;
  document.getElementById("jv-query-toggle")!.click();
  queryInput.value = expression;
  queryInput.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  document.getElementById("jv-query-close")!.click();
}

function showView(name: string): void {
  document
    .querySelector<HTMLElement>(`.jv-view-btn[data-view="${name}"]`)!
    .click();
}

function roundedValues(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("#jv-tree .jv-number-rounded")
  ).map((span) => span.textContent!);
}

function roundedNoteShown(): boolean {
  return !document.getElementById("jv-rounded-note")!.hidden;
}

const LOSSY_DOC = '{"items": [{"id": 9007199254740993}, {"id": 9007199254740995}]}';

test.runIf(hasReviverSource)(
  "a projecting query marks the numbers whose source text it lost",
  async () => {
    const writeText = await mountViewer(LOSSY_DOC);

    // Unqueried: every id still resolves to its source text, so nothing is
    // marked and the text views say nothing.
    expect(roundedValues()).toEqual([]);
    showView("formatted");
    expect(roundedNoteShown()).toBe(false);

    showView("tree");
    await runViewerQuery("items[*].id");

    expect(roundedValues()).toEqual([
      "9007199254740992 ⚠",
      "9007199254740996 ⚠",
    ]);
    expect(
      document.querySelector<HTMLElement>("#jv-tree .jv-number-rounded")!.title
    ).toContain("exact source text");

    // The text views cannot mark a value inline without corrupting the JSON,
    // so they carry one note for the document instead.
    for (const view of ["formatted", "raw", "schema"]) {
      showView(view);
      expect(roundedNoteShown()).toBe(true);
      const text = document.getElementById(`jv-${view}`)!.textContent!;
      expect(text).not.toContain("⚠");
      expect(() => JSON.parse(text)).not.toThrow();
    }

    // Copy stays valid JSON with no marker in it, in every text view.
    for (const view of ["raw", "formatted", "schema"]) {
      showView(view);
      document.getElementById("jv-copy")!.click();
      const copied = writeText.mock.lastCall?.[0] as string;
      expect(copied).not.toContain("⚠");
      expect(() => JSON.parse(copied)).not.toThrow();
    }
    showView("raw");
    document.getElementById("jv-copy")!.click();
    expect(JSON.parse(writeText.mock.lastCall?.[0] as string)).toEqual([
      9007199254740992, 9007199254740996,
    ]);

    // Per-node copy of a marked number: no source text to copy, so it falls
    // back to serializing the value — the marker is a view affordance only.
    showView("tree");
    document
      .querySelector<HTMLElement>('[data-path="data[0]"]')!
      .querySelector<HTMLElement>(".jv-action-copy-node")!
      .click();
    expect(writeText).toHaveBeenLastCalledWith("9007199254740992");
  }
);

test.runIf(hasReviverSource)(
  "clearing the query takes the rounded note away with it",
  async () => {
    await mountViewer(LOSSY_DOC);

    await runViewerQuery("items[*].id");
    showView("formatted");
    expect(roundedNoteShown()).toBe(true);

    // An empty expression restores the original document, whose ids resolve to
    // their source text again.
    await runViewerQuery("");

    expect(roundedNoteShown()).toBe(false);
    showView("tree");
    expect(roundedValues()).toEqual([]);
  }
);

test.runIf(hasReviverSource)(
  "a bare projected number is marked, and a pass-through query is not",
  async () => {
    await mountViewer(LOSSY_DOC);

    // A selected number reaches the tree through a holder that was never
    // parsed, so its source text is gone.
    await runViewerQuery("items[0].id");
    expect(roundedValues()).toEqual(["9007199254740992 ⚠"]);
    showView("formatted");
    expect(roundedNoteShown()).toBe(true);

    // These two pass the parsed objects through, so their source text still
    // resolves: exact, unmarked, and no note.
    for (const expression of ["items[0]", "items"]) {
      showView("tree");
      await runViewerQuery(expression);
      expect(roundedValues()).toEqual([]);
      expect(
        document.querySelector<HTMLElement>("#jv-tree .jv-number-exact")!.textContent
      ).toBe("9007199254740993");
      showView("formatted");
      expect(roundedNoteShown()).toBe(false);
    }
  }
);

test.runIf(hasReviverSource)(
  "the table marks a projected row's rounded number",
  async () => {
    await mountViewer(LOSSY_DOC);

    // A multiselect hash builds new row objects: same numbers, no source text.
    await runViewerQuery("items[*].{id: id}");
    showView("table");

    const cells = Array.from(
      document.querySelectorAll<HTMLElement>("#jv-table .jv-number-rounded")
    );
    expect(cells.map((cell) => cell.textContent)).toEqual([
      "9007199254740992 ⚠",
      "9007199254740996 ⚠",
    ]);
    expect(cells[0].title).toContain("exact source text");
  }
);
