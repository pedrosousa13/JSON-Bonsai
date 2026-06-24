// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";

import {
  TABLE_COLUMN_CAP,
  checkTableEligibility,
  createTableView,
  deriveColumns,
  sortRowIndices,
} from "./table";
import { runQuery } from "./query";
import type { JsonValue } from "./tree-model";

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.innerHTML = "";
  document.body.appendChild(container);
  return container;
}

describe("checkTableEligibility", () => {
  test("accepts an array of plain objects", () => {
    const data: JsonValue = [{ a: 1 }, { b: 2 }, { c: 3 }];
    expect(checkTableEligibility(data)).toEqual({ eligible: true, reason: null });
  });

  test("rejects a non-array root with a reason", () => {
    const result = checkTableEligibility({ a: 1 });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/array/i);
  });

  test("rejects an empty array", () => {
    const result = checkTableEligibility([]);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/non-empty/i);
  });

  test("accepts exactly 80% objects", () => {
    const data: JsonValue = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, "stray"];
    expect(checkTableEligibility(data).eligible).toBe(true);
  });

  test("rejects below 80% objects", () => {
    const data: JsonValue = [{ a: 1 }, { a: 2 }, { a: 3 }, "x", "y"];
    const result = checkTableEligibility(data);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/80%/);
  });

  test("treats arrays and null elements as non-objects", () => {
    const data: JsonValue = [[1], null, { a: 1 }];
    expect(checkTableEligibility(data).eligible).toBe(false);
  });
});

describe("deriveColumns", () => {
  test("unions keys in first-seen order", () => {
    const rows: JsonValue[] = [
      { b: 1, a: 2 },
      { c: 3, a: 4 },
      { d: 5 },
    ];
    expect(deriveColumns(rows)).toEqual({
      columns: ["b", "a", "c", "d"],
      truncatedFrom: null,
    });
  });

  test("skips non-object elements", () => {
    const rows: JsonValue[] = [{ a: 1 }, "stray", { b: 2 }];
    expect(deriveColumns(rows).columns).toEqual(["a", "b"]);
  });

  test("caps at the column limit and reports the total", () => {
    const wide: { [key: string]: JsonValue } = {};
    for (let i = 0; i < TABLE_COLUMN_CAP + 5; i += 1) wide[`k${i}`] = i;
    const { columns, truncatedFrom } = deriveColumns([wide]);
    expect(columns).toHaveLength(TABLE_COLUMN_CAP);
    expect(truncatedFrom).toBe(TABLE_COLUMN_CAP + 5);
  });
});

describe("sortRowIndices", () => {
  test("returns original order when unsorted", () => {
    const rows: JsonValue[] = [{ n: 3 }, { n: 1 }, { n: 2 }];
    expect(sortRowIndices(rows, null, null)).toEqual([0, 1, 2]);
  });

  test("sorts numbers numerically, not lexically", () => {
    const rows: JsonValue[] = [{ n: 10 }, { n: 9 }, { n: 100 }];
    expect(sortRowIndices(rows, "n", "asc")).toEqual([1, 0, 2]);
    expect(sortRowIndices(rows, "n", "desc")).toEqual([2, 0, 1]);
  });

  test("sorts numeric strings naturally", () => {
    const rows: JsonValue[] = [{ s: "item10" }, { s: "item2" }];
    expect(sortRowIndices(rows, "s", "asc")).toEqual([1, 0]);
  });

  test("keeps missing values last in both directions", () => {
    const rows: JsonValue[] = [{ n: 2 }, {}, { n: 1 }, "stray"];
    expect(sortRowIndices(rows, "n", "asc")).toEqual([2, 0, 1, 3]);
    expect(sortRowIndices(rows, "n", "desc")).toEqual([0, 2, 1, 3]);
  });

  test("null is a present value, not a missing one", () => {
    const rows: JsonValue[] = [{}, { n: null }, { n: 1 }];
    expect(sortRowIndices(rows, "n", "asc")).toEqual([2, 1, 0]);
  });
});

describe("createTableView", () => {
  test("renders header and syntax-colored cells", () => {
    const container = createContainer();
    createTableView(container, [
      { name: "Ada", age: 36, admin: true, tags: ["a", "b"], note: null },
      { name: "Grace" },
    ]);

    const headers = Array.from(
      container.querySelectorAll(".jv-table-th[data-column]")
    ).map((th) => th.textContent);
    expect(headers).toEqual(["name", "age", "admin", "tags", "note"]);

    const rows = container.querySelectorAll(".jv-table-row");
    expect(rows).toHaveLength(2);
    const first = rows[0].querySelectorAll(".jv-table-cell");
    expect(first[1].className).toContain("jv-string");
    expect(first[2].className).toContain("jv-number");
    expect(first[3].className).toContain("jv-bool");
    expect(first[4].className).toContain("jv-preview");
    expect(first[4].textContent).toBe("[ 2 items ]");
    expect(first[5].className).toContain("jv-null");

    // Second row is missing every column but name.
    const second = rows[1].querySelectorAll(".jv-table-cell");
    expect(second[2].className).toContain("jv-table-missing");
    expect(second[2].textContent).toBe("–");
  });

  test("an empty string is marked, distinct from null and missing", () => {
    const container = createContainer();
    createTableView(container, [
      { a: "", b: null },
      {},
    ]);
    const rows = container.querySelectorAll(".jv-table-row");
    const first = rows[0].querySelectorAll(".jv-table-cell");
    // Empty string: visible marker, not a blank cell.
    expect(first[1].className).toContain("jv-table-empty");
    expect(first[1].textContent).toBe('""');
    // null stays "null", a wholly-absent key stays "–".
    expect(first[2].className).toContain("jv-null");
    expect(first[2].textContent).toBe("null");
    const second = rows[1].querySelectorAll(".jv-table-cell");
    expect(second[1].className).toContain("jv-table-missing");
    expect(second[1].textContent).toBe("–");
  });

  test("a non-object empty-string element shows the marked cell", () => {
    // Mirrors a projection like body[*].design where one element is "".
    const container = createContainer();
    createTableView(container, [{ k: 1 }, { k: 2 }, { k: 3 }, { k: 4 }, ""]);
    const rows = container.querySelectorAll(".jv-table-row");
    const last = rows[4].querySelectorAll(".jv-table-cell");
    expect(last[1].className).toContain("jv-table-empty");
    expect(last[1].textContent).toBe('""');
  });

  test("header click cycles asc, desc, none", () => {
    const container = createContainer();
    createTableView(container, [{ n: 2 }, { n: 3 }, { n: 1 }]);

    const th = container.querySelector<HTMLElement>(
      '.jv-table-th[data-column="n"]'
    )!;
    const firstCellTexts = () =>
      Array.from(container.querySelectorAll(".jv-table-row")).map(
        (row) => row.querySelectorAll(".jv-table-cell")[1].textContent
      );

    th.click();
    expect(firstCellTexts()).toEqual(["1", "2", "3"]);
    th.click();
    expect(firstCellTexts()).toEqual(["3", "2", "1"]);
    th.click();
    expect(firstCellTexts()).toEqual(["2", "3", "1"]);
  });

  test("notes the column cap when exceeded", () => {
    const wide: { [key: string]: JsonValue } = {};
    for (let i = 0; i < TABLE_COLUMN_CAP + 2; i += 1) wide[`k${i}`] = i;
    const container = createContainer();
    createTableView(container, [wide]);
    expect(container.querySelector(".jv-table-note")?.textContent).toBe(
      `Showing ${TABLE_COLUMN_CAP} of ${TABLE_COLUMN_CAP + 2} columns.`
    );
  });
});

describe("table filter", () => {
  function visibleRows(container: HTMLElement): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(".jv-table-row:not([hidden])")
    );
  }

  function visibleCellTexts(container: HTMLElement, column: number): string[] {
    return visibleRows(container).map(
      (row) => row.querySelectorAll(".jv-table-cell")[column].textContent!
    );
  }

  test("narrows rows to matching cell values, case-insensitively", () => {
    const container = createContainer();
    const view = createTableView(container, [
      { name: "Ada", age: 36 },
      { name: "Grace", age: 45 },
      { name: "Alan", age: 33 },
    ]);

    const state = view.setFilter("ADA");
    expect(state).toEqual({ query: "ada", shown: 1, total: 3 });
    expect(visibleCellTexts(container, 1)).toEqual(["Ada"]);
  });

  test("matches column key names for rows that have the key", () => {
    const container = createContainer();
    const view = createTableView(container, [
      { name: "Ada", city: "London" },
      { name: "Grace" },
    ]);

    const state = view.setFilter("city");
    expect(state.shown).toBe(1);
    expect(visibleCellTexts(container, 1)).toEqual(["Ada"]);

    // The header explains the key match; the value cell itself didn't match.
    const th = container.querySelector('.jv-table-th[data-column="city"]')!;
    expect(th.className).toContain("jv-search-match");
    const cityCell = visibleRows(container)[0].querySelectorAll(".jv-table-cell")[2];
    expect(cityCell.className).not.toContain("jv-search-match");
  });

  test("highlights matching cells and clears on filter clear", () => {
    const container = createContainer();
    const view = createTableView(container, [
      { name: "Ada", role: "admin" },
      { name: "Grace", role: "user" },
    ]);

    view.setFilter("ad");
    const cells = visibleRows(container)[0].querySelectorAll(".jv-table-cell");
    expect(cells[1].className).toContain("jv-search-match"); // "Ada"
    expect(cells[2].className).toContain("jv-search-match"); // "admin"

    const cleared = view.setFilter("");
    expect(cleared).toEqual({ query: "", shown: 2, total: 2 });
    expect(visibleRows(container)).toHaveLength(2);
    for (const cell of container.querySelectorAll(".jv-table-cell")) {
      expect(cell.className).not.toContain("jv-search-match");
    }
  });

  test("preserves the active sort through filter and clear", () => {
    const container = createContainer();
    const view = createTableView(container, [
      { n: 3 },
      { n: 10 },
      { n: 1 },
      { n: 2 },
    ]);

    container.querySelector<HTMLElement>('.jv-table-th[data-column="n"]')!.click();
    expect(visibleCellTexts(container, 1)).toEqual(["1", "2", "3", "10"]);

    // "1" matches 1 and 10; the ascending order survives the filter.
    view.setFilter("1");
    expect(visibleCellTexts(container, 1)).toEqual(["1", "10"]);

    // Sorting while filtered re-orders the filtered subset.
    container.querySelector<HTMLElement>('.jv-table-th[data-column="n"]')!.click();
    expect(visibleCellTexts(container, 1)).toEqual(["10", "1"]);

    // Clearing restores all rows, still in the active (descending) sort.
    view.setFilter("");
    expect(visibleCellTexts(container, 1)).toEqual(["10", "3", "2", "1"]);
  });

  test("renders and matches the exact source text of imprecise numbers", () => {
    const container = createContainer();
    const row = { big: 123456789012345678901234567890 };
    const exactNumbers = new WeakMap<object, Map<string, string>>();
    exactNumbers.set(row, new Map([["big", "123456789012345678901234567890"]]));
    const view = createTableView(container, [row], { exactNumbers });

    expect(visibleCellTexts(container, 1)).toEqual([
      "123456789012345678901234567890",
    ]);

    // Matches the displayed source text...
    expect(view.setFilter("67890123").shown).toBe(1);
    // ...not the lossy double's stringification ("1.2345678901234568e+29").
    expect(view.setFilter("e+29").shown).toBe(0);
  });
});

describe("table export", () => {
  function exportButton(container: HTMLElement, label: string): HTMLButtonElement {
    const button = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".jv-table-export-btn")
    ).find((b) => b.textContent === label);
    if (!button) throw new Error(`missing export button: ${label}`);
    return button;
  }

  function stubClipboard(): { last: () => string | undefined } {
    let text: string | undefined;
    const writeText = vi.fn((value: string) => {
      text = value;
      return Promise.resolve();
    });
    Object.assign(navigator, { clipboard: { writeText } });
    return { last: () => text };
  }

  test("renders copy/download buttons for CSV and TSV", () => {
    const container = createContainer();
    createTableView(container, [{ a: 1 }]);
    const labels = Array.from(
      container.querySelectorAll(".jv-table-export-btn")
    ).map((b) => b.textContent);
    expect(labels).toEqual(["Copy CSV", "Download CSV", "Copy TSV", "Download TSV"]);
  });

  test("Copy CSV writes RFC 4180 CSV reflecting the current columns", async () => {
    const clipboard = stubClipboard();
    const container = createContainer();
    createTableView(container, [
      { name: "Smith, John", note: 'said "hi"' },
      { name: "plain", note: null },
    ]);
    exportButton(container, "Copy CSV").click();
    await Promise.resolve();
    expect(clipboard.last()).toBe(
      'name,note\r\n"Smith, John","said ""hi"""\r\nplain,null'
    );
  });

  test("Copy TSV uses tabs as the delimiter", async () => {
    const clipboard = stubClipboard();
    const container = createContainer();
    createTableView(container, [{ a: "1", b: "2" }]);
    exportButton(container, "Copy TSV").click();
    await Promise.resolve();
    expect(clipboard.last()).toBe("a\tb\r\n1\t2");
  });

  test("export reflects the active sort and row filter", async () => {
    const clipboard = stubClipboard();
    const container = createContainer();
    const view = createTableView(container, [
      { name: "alpha", n: 3 },
      { name: "beta", n: 1 },
      { name: "alphabet", n: 2 },
    ]);

    // Sort ascending by n.
    container.querySelector<HTMLElement>('.jv-table-th[data-column="n"]')!.click();
    // Filter to the "alp" rows.
    view.setFilter("alp");

    exportButton(container, "Copy CSV").click();
    await Promise.resolve();
    // Only alphabet(2) and alpha(3) survive the filter, in ascending-n order.
    expect(clipboard.last()).toBe("name,n\r\nalphabet,2\r\nalpha,3");
  });

  test("serializes nested object and array cells as JSON", async () => {
    const clipboard = stubClipboard();
    const container = createContainer();
    createTableView(container, [{ obj: { a: 1 }, arr: [1, 2] }]);
    exportButton(container, "Copy CSV").click();
    await Promise.resolve();
    expect(clipboard.last()).toBe('obj,arr\r\n"{""a"":1}","[1,2]"');
  });

  test("Download CSV builds a blob anchor with a sensible filename", () => {
    stubClipboard();
    const createObjectURL = vi.fn(() => "blob:stub");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicks: string[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    };

    const container = createContainer();
    createTableView(container, [{ a: 1 }]);
    exportButton(container, "Download CSV").click();

    HTMLAnchorElement.prototype.click = realClick;
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clicks).toEqual(["json-bonsai-export.csv"]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stub");
  });
});

describe("query swap re-evaluation", () => {
  test("eligibility flips as JMESPath results swap the document", () => {
    const data: JsonValue = {
      users: [
        { name: "Ada", role: "admin" },
        { name: "Grace", role: "user" },
      ],
    };

    // Root object: no table.
    expect(checkTableEligibility(data).eligible).toBe(false);

    // Query projecting an array of objects: table becomes available.
    const projected = runQuery(data, "users[?role == 'admin']");
    expect(projected).toMatchObject({ ok: true });
    if (!projected.ok) throw new Error("unreachable");
    expect(checkTableEligibility(projected.result).eligible).toBe(true);

    // Query yielding an array of strings: table unavailable again.
    const names = runQuery(data, "users[].name");
    if (!names.ok) throw new Error("unreachable");
    expect(checkTableEligibility(names.result).eligible).toBe(false);
  });
});
