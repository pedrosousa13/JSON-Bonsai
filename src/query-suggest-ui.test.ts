// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";
import {
  createQuerySuggestUi,
  type QuerySuggestUi,
  type SuggestBatch,
  type SuggestEntry,
} from "./query-suggest-ui";

// jsdom doesn't implement scrollIntoView; the dropdown calls it to keep the
// keyboard-highlighted row in view.
Element.prototype.scrollIntoView = vi.fn();

interface Harness {
  ui: QuerySuggestUi;
  input: HTMLInputElement;
  list: HTMLUListElement;
  suggest: ReturnType<typeof vi.fn>;
  onRemoveRecent: ReturnType<typeof vi.fn>;
  onAccept: ReturnType<typeof vi.fn>;
  rows(): string[];
}

function harness(batch: SuggestBatch | null): Harness {
  const input = document.createElement("input");
  const list = document.createElement("ul");
  list.hidden = true;
  document.body.replaceChildren(input, list);

  const suggest = vi.fn(() => batch);
  const onRemoveRecent = vi.fn();
  const onAccept = vi.fn();
  const ui = createQuerySuggestUi({
    input,
    list,
    suggest,
    onRemoveRecent,
    onAccept,
  });
  return {
    ui,
    input,
    list,
    suggest,
    onRemoveRecent,
    onAccept,
    rows: () =>
      Array.from(
        list.querySelectorAll(".jv-query-suggest-item .jv-query-suggest-name")
      ).map((el) => el.textContent!),
  };
}

function keys(...names: [string, "array" | "object" | "scalar"][]): SuggestEntry[] {
  return names.map(([name, kind]) => ({ type: "key", name, kind }));
}

beforeEach(() => {
  document.body.replaceChildren();
});

test("typing renders the provider's rows and highlights the first", () => {
  const h = harness({
    entries: keys(["users", "array"], ["updatedAt", "scalar"]),
    start: 0,
  });

  h.input.value = "u";
  h.input.dispatchEvent(new Event("input"));

  expect(h.suggest).toHaveBeenCalledWith("u", 1);
  expect(h.ui.isOpen()).toBe(true);
  expect(h.rows()).toEqual(["users", "updatedAt"]);
  // An array-valued key is badged so the user knows to bracket in.
  expect(h.list.querySelector(".jv-query-suggest-badge")!.textContent).toBe("[ ]");
  expect(h.list.querySelectorAll(".jv-active").length).toBe(1);
  expect(h.list.querySelector(".jv-active .jv-query-suggest-name")!.textContent).toBe(
    "users"
  );
});

test("an empty batch hides the dropdown; a null batch leaves it alone", () => {
  const rows = keys(["users", "array"]);
  const input = document.createElement("input");
  const list = document.createElement("ul");
  list.hidden = true;
  document.body.replaceChildren(input, list);

  let batch: SuggestBatch | null = { entries: rows, start: 0 };
  const ui = createQuerySuggestUi({
    input,
    list,
    suggest: () => batch,
    onRemoveRecent: vi.fn(),
    onAccept: vi.fn(),
  });

  input.value = "u";
  input.dispatchEvent(new Event("input"));
  expect(ui.isOpen()).toBe(true);

  // null = "no answer yet": the open dropdown is left exactly as it was.
  batch = null;
  input.dispatchEvent(new Event("input"));
  expect(ui.isOpen()).toBe(true);
  expect(list.querySelectorAll(".jv-query-suggest-item").length).toBe(1);

  batch = { entries: [], start: 0 };
  input.dispatchEvent(new Event("input"));
  expect(ui.isOpen()).toBe(false);
  expect(list.children.length).toBe(0);
});

test("arrows wrap through the rows and Enter accepts the highlighted one", () => {
  const h = harness({
    entries: keys(["users", "scalar"], ["updatedAt", "scalar"]),
    start: 0,
  });
  h.input.value = "u";
  h.input.dispatchEvent(new Event("input"));

  const send = (key: string): boolean => {
    const event = new KeyboardEvent("keydown", { key, cancelable: true });
    return h.ui.handleKeyDown(event);
  };

  expect(send("ArrowDown")).toBe(true);
  expect(h.list.querySelector(".jv-active .jv-query-suggest-name")!.textContent).toBe(
    "updatedAt"
  );
  // Wraps back round to the first row.
  expect(send("ArrowDown")).toBe(true);
  expect(h.list.querySelector(".jv-active .jv-query-suggest-name")!.textContent).toBe(
    "users"
  );
  expect(send("ArrowUp")).toBe(true);
  expect(h.list.querySelector(".jv-active .jv-query-suggest-name")!.textContent).toBe(
    "updatedAt"
  );

  expect(send("Enter")).toBe(true);
  expect(h.input.value).toBe("updatedAt");
  expect(h.ui.isOpen()).toBe(false);
  expect(h.onAccept).toHaveBeenCalledWith({
    type: "key",
    name: "updatedAt",
    kind: "scalar",
  });
});

test("handleKeyDown consumes keys only while the dropdown is open", () => {
  const h = harness({ entries: keys(["users", "scalar"]), start: 0 });

  // Closed: every key falls through to the caller's own bindings.
  for (const key of ["ArrowDown", "Enter", "Tab", "Escape"]) {
    expect(
      h.ui.handleKeyDown(new KeyboardEvent("keydown", { key, cancelable: true }))
    ).toBe(false);
  }

  h.input.value = "u";
  h.input.dispatchEvent(new Event("input"));
  // Open, but a key the dropdown has no use for still falls through.
  expect(
    h.ui.handleKeyDown(new KeyboardEvent("keydown", { key: "a", cancelable: true }))
  ).toBe(false);
  // Escape closes just the dropdown, and is consumed.
  expect(
    h.ui.handleKeyDown(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }))
  ).toBe(true);
  expect(h.ui.isOpen()).toBe(false);
});

test("accepting replaces the token from `start`, bracketing arrays and opening functions", () => {
  const cases: [SuggestEntry, string, string][] = [
    [{ type: "key", name: "name", kind: "scalar" }, "name", "users[*].name"],
    [{ type: "key", name: "tags", kind: "array" }, "tags[*]", "users[*].tags[*]"],
    [{ type: "key", name: "sort_by", kind: "scalar" }, "sort_by(", "users[*].sort_by("],
  ];

  for (const [entry, , expected] of cases) {
    const h = harness({ entries: [entry], start: "users[*].".length });
    h.input.value = "users[*].na";
    h.input.setSelectionRange(11, 11);
    h.input.dispatchEvent(new Event("input"));

    h.ui.handleKeyDown(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));

    expect(h.input.value).toBe(expected);
    expect(h.input.selectionStart).toBe(expected.length);
  }
});

test("an empty field lists recent queries under a header, and clicking one accepts it", () => {
  const h = harness({
    entries: [
      { type: "recent", query: "a.b" },
      { type: "recent", query: "c[0]" },
    ],
    start: 0,
  });

  h.input.dispatchEvent(new Event("focus"));

  expect(h.list.querySelector(".jv-query-suggest-section")!.textContent).toBe(
    "Recent queries"
  );
  expect(h.rows()).toEqual(["a.b", "c[0]"]);

  const second = h.list.querySelectorAll<HTMLElement>(".jv-query-suggest-recent")[1];
  second.dispatchEvent(new MouseEvent("mousedown", { cancelable: true, bubbles: true }));

  // The dropdown fills the input; re-running it is the caller's job.
  expect(h.input.value).toBe("c[0]");
  expect(h.onAccept).toHaveBeenCalledWith({ type: "recent", query: "c[0]" });
  expect(h.ui.isOpen()).toBe(false);
});

test("the ✕ on a recent row reports the removal and re-renders without accepting", () => {
  const remaining: SuggestEntry[] = [
    { type: "recent", query: "a.b" },
    { type: "recent", query: "c[0]" },
  ];
  const input = document.createElement("input");
  const list = document.createElement("ul");
  list.hidden = true;
  document.body.replaceChildren(input, list);

  const onAccept = vi.fn();
  const onRemoveRecent = vi.fn((query: string) => {
    const i = remaining.findIndex((e) => e.type === "recent" && e.query === query);
    remaining.splice(i, 1);
  });
  createQuerySuggestUi({
    input,
    list,
    suggest: () => ({ entries: [...remaining], start: 0 }),
    onRemoveRecent,
    onAccept,
  });

  input.dispatchEvent(new Event("focus"));
  const del = list.querySelector<HTMLElement>(
    ".jv-query-suggest-recent .jv-query-suggest-del"
  )!;
  del.dispatchEvent(new MouseEvent("mousedown", { cancelable: true, bubbles: true }));

  expect(onRemoveRecent).toHaveBeenCalledWith("a.b");
  // The row's own mousedown must not also run the query.
  expect(onAccept).not.toHaveBeenCalled();
  expect(
    Array.from(list.querySelectorAll(".jv-query-suggest-name")).map(
      (el) => el.textContent
    )
  ).toEqual(["c[0]"]);
  expect(input.value).toBe("");
});

test("hide() closes the dropdown, and so does losing focus", () => {
  const h = harness({ entries: keys(["users", "scalar"]), start: 0 });

  h.input.value = "u";
  h.input.dispatchEvent(new Event("input"));
  h.ui.hide();
  expect(h.ui.isOpen()).toBe(false);
  expect(h.list.children.length).toBe(0);

  h.input.dispatchEvent(new Event("input"));
  expect(h.ui.isOpen()).toBe(true);
  h.input.dispatchEvent(new Event("blur"));
  expect(h.ui.isOpen()).toBe(false);
});
