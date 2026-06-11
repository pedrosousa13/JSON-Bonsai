// @vitest-environment jsdom

import { describe, expect, test } from "vitest";

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
