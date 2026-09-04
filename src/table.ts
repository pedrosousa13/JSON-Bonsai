import type { JsonValue } from "./tree-model";
import {
  exactTextUnavailable,
  ROUNDED_NUMBER_MARKER,
  ROUNDED_NUMBER_TITLE,
  type ExactNumberMap,
} from "./lossless-numbers";
import {
  serializeDelimited,
  type DelimitedField,
  type DelimitedFormat,
  type DelimitedTable,
} from "./csv";
import { truncateCodePoints } from "./truncate";
import { flashLabel } from "./flash-label";
import { createVirtualScroller } from "./virtual-scroller";

const EXPORT_FILENAMES: Record<DelimitedFormat, string> = {
  csv: "json-bonsai-export.csv",
  tsv: "json-bonsai-export.tsv",
};

const EXPORT_MIME: Record<DelimitedFormat, string> = {
  csv: "text/csv;charset=utf-8",
  tsv: "text/tab-separated-values;charset=utf-8",
};

export const TABLE_OBJECT_RATIO = 0.8;
export const TABLE_COLUMN_CAP = 30;

const TABLE_ROW_HEIGHT = 24;
const TABLE_OVERSCAN = 20;
const WIDTH_SAMPLE_ROWS = 200;
const CELL_TEXT_MAX = 200;
const MIN_COLUMN_CH = 4;
const MAX_COLUMN_CH = 48;

export type SortDirection = "asc" | "desc" | null;

export interface TableEligibility {
  eligible: boolean;
  reason: string | null;
}

function isPlainObject(
  value: JsonValue
): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads one cell by column name. A bare `row[column]` would resolve a column
 * named after an `Object.prototype` member ("constructor", "toString", …)
 * through the prototype chain, so a row missing that key would yield a
 * function instead of `undefined` and every missing-value check would fail.
 */
function cellValue(
  row: { [key: string]: JsonValue },
  column: string
): JsonValue | undefined {
  return Object.hasOwn(row, column) ? row[column] : undefined;
}

export function checkTableEligibility(data: JsonValue): TableEligibility {
  if (!Array.isArray(data)) {
    return {
      eligible: false,
      reason: "Table view needs the document root to be an array of objects.",
    };
  }
  if (data.length === 0) {
    return { eligible: false, reason: "Table view needs a non-empty array." };
  }
  let objectCount = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (isPlainObject(data[i])) objectCount += 1;
  }
  const ratio = objectCount / data.length;
  if (ratio < TABLE_OBJECT_RATIO) {
    return {
      eligible: false,
      reason: `Table view needs at least 80% object elements (this array has ${Math.round(ratio * 100)}%).`,
    };
  }
  return { eligible: true, reason: null };
}

export interface TableColumns {
  columns: string[];
  /** Total distinct keys when more than TABLE_COLUMN_CAP exist, else null. */
  truncatedFrom: number | null;
}

export function deriveColumns(rows: JsonValue[]): TableColumns {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!isPlainObject(row)) continue;
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (columns.length < TABLE_COLUMN_CAP) columns.push(key);
    }
  }
  return {
    columns,
    truncatedFrom: seen.size > TABLE_COLUMN_CAP ? seen.size : null,
  };
}

function typeRank(value: JsonValue): number {
  if (typeof value === "number") return 0;
  if (typeof value === "string") return 1;
  if (typeof value === "boolean") return 2;
  if (value === null) return 3;
  return 4; // objects and arrays keep their relative order
}

const EXACT_INTEGER_TOKEN = /^-?\d+$/;

/**
 * Orders two number tokens that round to the same double, so the sort matches
 * the exact digits the cells display. BigInt covers the integer tokens that
 * actually reach here (ids past 2^53), signs included; a fraction or an
 * exponent stays a tie, exactly as it was before.
 */
function compareExactNumbers(a: string, b: string): number {
  if (a === b) return 0;
  if (!EXACT_INTEGER_TOKEN.test(a) || !EXACT_INTEGER_TOKEN.test(b)) return 0;
  const bigA = BigInt(a);
  const bigB = BigInt(b);
  return bigA === bigB ? 0 : bigA < bigB ? -1 : 1;
}

function compareValues(
  a: JsonValue,
  b: JsonValue,
  exactA?: string,
  exactB?: string
): number {
  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA - rankB;
  if (typeof a === "number" && typeof b === "number") {
    if (a !== b) return a < b ? -1 : 1;
    // Rounding is monotonic, so differing doubles already answered. Equal ones
    // may still be distinct source numbers: fall back to the exact text, or to
    // the double's own digits for a cell that never lost precision.
    if (exactA === undefined && exactB === undefined) return 0;
    return compareExactNumbers(exactA ?? String(a), exactB ?? String(b));
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b, undefined, { numeric: true });
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b ? 0 : a ? 1 : -1;
  }
  return 0;
}

/**
 * Returns original-array indices in display order. Missing values (key absent
 * or element not an object) always sort last regardless of direction.
 */
export function sortRowIndices(
  rows: JsonValue[],
  column: string | null,
  direction: SortDirection,
  exactNumbers?: ExactNumberMap | null
): number[] {
  const indices = rows.map((_, i) => i);
  if (column === null || direction === null) return indices;
  const dir = direction === "asc" ? 1 : -1;
  indices.sort((a, b) => {
    const rowA = rows[a];
    const rowB = rows[b];
    const valueA = isPlainObject(rowA) ? cellValue(rowA, column) : undefined;
    const valueB = isPlainObject(rowB) ? cellValue(rowB, column) : undefined;
    const missingA = valueA === undefined;
    const missingB = valueB === undefined;
    if (missingA || missingB) {
      return missingA === missingB ? 0 : missingA ? 1 : -1;
    }
    // Both rows are plain objects past the missing check, so they are valid
    // holders for the exact-number map.
    return (
      compareValues(
        valueA,
        valueB,
        exactNumbers?.get(rowA as object)?.get(column),
        exactNumbers?.get(rowB as object)?.get(column)
      ) * dir
    );
  });
  return indices;
}

function containerPreview(value: JsonValue[] | { [key: string]: JsonValue }): string {
  if (Array.isArray(value)) {
    const n = value.length;
    return n === 0 ? "[]" : `[ ${n} item${n === 1 ? "" : "s"} ]`;
  }
  const n = Object.keys(value).length;
  return n === 0 ? "{}" : `{ ${n} key${n === 1 ? "" : "s"} }`;
}

function truncateCell(text: string): string {
  return text.length > CELL_TEXT_MAX
    ? `${truncateCodePoints(text, CELL_TEXT_MAX)}…`
    : text;
}

function cellText(value: JsonValue | undefined): string {
  if (value === undefined) return "–";
  if (value === null) return "null";
  if (typeof value === "object") return containerPreview(value);
  // An empty string is a real value, distinct from missing ("–"): mark it so
  // the cell isn't a confusing blank.
  if (value === "") return '""';
  return truncateCell(String(value));
}

// Untruncated cell value for export. Scalars become their plain string form;
// objects and arrays are JSON-serialized; absent cells become empty strings.
// Exact source text (lossless numbers) overrides the scalar form when present.
// Numbers are flagged so the serializer leaves a genuine leading "-" alone.
function exportCellValue(
  value: JsonValue | undefined,
  exact: string | undefined
): DelimitedField {
  if (exact !== undefined) return { text: exact, numeric: true };
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number") return { text: String(value), numeric: true };
  return String(value);
}

function cellClass(value: JsonValue | undefined, isRounded = false): string {
  if (value === undefined) return "jv-table-cell jv-table-missing";
  if (value === null) return "jv-table-cell jv-null";
  if (value === "") return "jv-table-cell jv-table-empty";
  if (typeof value === "string") return "jv-table-cell jv-string";
  if (typeof value === "number") {
    return isRounded
      ? "jv-table-cell jv-number jv-number-rounded"
      : "jv-table-cell jv-number";
  }
  if (typeof value === "boolean") return "jv-table-cell jv-bool";
  return "jv-table-cell jv-preview";
}

/**
 * Estimates grid column widths (in ch) from the header names and a sample of
 * rows, so virtualized rows can share one grid template without measuring
 * every cell.
 */
function computeColumnTemplate(rows: JsonValue[], columns: string[]): string {
  const widths = columns.map((column) => column.length);
  const sampleSize = Math.min(rows.length, WIDTH_SAMPLE_ROWS);
  for (let i = 0; i < sampleSize; i += 1) {
    const row = rows[i];
    if (!isPlainObject(row)) continue;
    for (let c = 0; c < columns.length; c += 1) {
      const value = cellValue(row, columns[c]);
      if (value === undefined) continue;
      const length = cellText(value).length;
      if (length > widths[c]) widths[c] = length;
    }
  }
  const indexWidth = Math.max(2, String(rows.length - 1).length) + 2;
  // Fixed ch widths keep the grid stable while virtualized rows come and go.
  const cols = widths.map((w) => {
    const ch = Math.min(Math.max(w, MIN_COLUMN_CH), MAX_COLUMN_CH);
    return `${ch + 3}ch`;
  });
  return `${indexWidth}ch ${cols.join(" ")}`;
}

interface TablePoolRow {
  line: HTMLDivElement;
  indexCell: HTMLDivElement;
  cells: HTMLDivElement[];
  lastRowIndex: number;
}

export interface TableFilterState {
  query: string;
  shown: number;
  total: number;
}

export interface TableViewController {
  refresh: () => void;
  setFilter: (query: string) => TableFilterState;
  getFilterState: () => TableFilterState;
  dispose: () => void;
}

export function createTableView(
  container: HTMLElement,
  data: JsonValue[],
  options?: { scrollContainer?: HTMLElement; exactNumbers?: ExactNumberMap | null }
): TableViewController {
  const scrollContainer = options?.scrollContainer ?? container;
  const exactNumbers = options?.exactNumbers ?? null;
  const { columns, truncatedFrom } = deriveColumns(data);

  container.innerHTML = "";
  container.style.setProperty(
    "--jv-table-cols",
    computeColumnTemplate(data, columns)
  );

  if (truncatedFrom !== null) {
    const note = document.createElement("div");
    note.className = "jv-table-note";
    note.textContent = `Showing ${TABLE_COLUMN_CAP} of ${truncatedFrom} columns.`;
    container.appendChild(note);
  }

  const exportBar = document.createElement("div");
  exportBar.className = "jv-table-export";
  const copyCsvBtn = createExportButton("Copy CSV", "copy", "csv");
  const downloadCsvBtn = createExportButton("Download CSV", "download", "csv");
  const copyTsvBtn = createExportButton("Copy TSV", "copy", "tsv");
  const downloadTsvBtn = createExportButton("Download TSV", "download", "tsv");
  exportBar.append(copyCsvBtn, downloadCsvBtn, copyTsvBtn, downloadTsvBtn);
  container.appendChild(exportBar);

  const header = document.createElement("div");
  header.className = "jv-table-header";
  const indexHead = document.createElement("div");
  indexHead.className = "jv-table-th jv-table-index";
  indexHead.textContent = "#";
  header.appendChild(indexHead);

  const headerCells: HTMLDivElement[] = [];
  for (const column of columns) {
    const th = document.createElement("div");
    th.className = "jv-table-th";
    th.dataset.column = column;
    th.title = `Sort by ${column}`;
    const label = document.createElement("span");
    label.className = "jv-table-th-label";
    label.textContent = column;
    const arrow = document.createElement("span");
    arrow.className = "jv-table-sort";
    th.append(label, arrow);
    headerCells.push(th);
    header.appendChild(th);
  }
  container.appendChild(header);

  const body = document.createElement("div");
  body.className = "jv-table-body";
  const spacer = document.createElement("div");
  spacer.className = "jv-table-spacer";
  const rowsLayer = document.createElement("div");
  rowsLayer.className = "jv-table-rows";
  body.append(spacer, rowsLayer);
  container.appendChild(body);

  let sortColumn: string | null = null;
  let sortDirection: SortDirection = null;
  // `baseOrder` is the sorted index array; `order` is what renders — the same
  // array, or its filtered subset while a search query is active.
  let baseOrder = sortRowIndices(data, null, null);
  let order = baseOrder;
  let filterQuery = "";
  let matchedColumns = new Set<number>();
  // Lowercased untruncated cell text per row, built lazily on first filter.
  // Object rows hold one entry per column ("" = key absent); non-object rows
  // hold the single value they display in the first column.
  let searchTexts: Array<string[] | string> | null = null;

  const scroller = createVirtualScroller<TablePoolRow>({
    scrollContainer,
    spacer,
    rowsLayer,
    rowHeight: TABLE_ROW_HEIGHT,
    overscan: TABLE_OVERSCAN,
    getRowCount: () => order.length,
    createRow: createPoolRow,
    bindRow: (poolRow, rowIndex) => applyPoolRow(poolRow, order[rowIndex]),
    isPaused: () => container.classList.contains("jv-hidden"),
  });

  function exactNumberText(
    holder: object,
    key: string,
    value: JsonValue | undefined
  ): string | undefined {
    return typeof value === "number"
      ? exactNumbers?.get(holder)?.get(key)
      : undefined;
  }

  function displayText(holder: object, key: string, value: JsonValue | undefined): string {
    if (value === undefined) return "–";
    const exact = exactNumberText(holder, key, value);
    return exact !== undefined ? truncateCell(exact) : cellText(value);
  }

  // Writes one cell: the display text, its syntax class, and — for a number
  // whose exact source text is unavailable — the ⚠ affix and an explaining
  // title. The title is removed rather than blanked on reuse, so a pooled cell
  // never carries the previous row's tooltip. Export and the filter text read
  // the value itself and never see the affix.
  function applyCell(
    cell: HTMLDivElement,
    holder: object,
    key: string,
    value: JsonValue | undefined,
    rowIndex: number,
    columnIndex: number
  ): void {
    const isRounded = exactTextUnavailable(
      value,
      exactNumberText(holder, key, value),
      exactNumbers
    );
    const text = displayText(holder, key, value);
    cell.className = cellMatchClass(cellClass(value, isRounded), rowIndex, columnIndex);
    cell.textContent = isRounded ? `${text} ${ROUNDED_NUMBER_MARKER}` : text;
    if (isRounded) cell.title = ROUNDED_NUMBER_TITLE;
    else if (cell.title !== "") cell.removeAttribute("title");
  }

  function searchTextFor(holder: object, key: string, value: JsonValue): string {
    const exact = exactNumberText(holder, key, value);
    if (exact !== undefined) return exact.toLowerCase();
    if (value === null) return "null";
    if (typeof value === "object") return containerPreview(value).toLowerCase();
    return String(value).toLowerCase();
  }

  // Builds the export rows from the on-screen state: current columns, and the
  // current filtered + sorted order (`order` is what the table renders).
  // Non-object elements contribute their value in the first column only.
  function collectExportTable(): DelimitedTable {
    const rows = order.map((rowIndex) => {
      const row = data[rowIndex];
      if (!isPlainObject(row)) {
        const cells = new Array<DelimitedField>(columns.length).fill("");
        if (columns.length > 0) {
          cells[0] = exportCellValue(
            row,
            exactNumberText(data, String(rowIndex), row)
          );
        }
        return cells;
      }
      return columns.map((column) => {
        const value = cellValue(row, column);
        return exportCellValue(value, exactNumberText(row, column, value));
      });
    });
    return { columns, rows };
  }

  function exportText(format: DelimitedFormat): string {
    return serializeDelimited(collectExportTable(), format);
  }

  function downloadExport(format: DelimitedFormat): void {
    const blob = new Blob([exportText(format)], { type: EXPORT_MIME[format] });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = EXPORT_FILENAMES[format];
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function createExportButton(
    label: string,
    action: "copy" | "download",
    format: DelimitedFormat
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "jv-table-export-btn";
    button.textContent = label;
    button.addEventListener("click", () => {
      if (action === "copy") {
        void navigator.clipboard
          .writeText(exportText(format))
          .then(() => flashLabel(button, "Copied!"));
      } else {
        downloadExport(format);
      }
    });
    return button;
  }

  function buildSearchTexts(): Array<string[] | string> {
    const texts: Array<string[] | string> = new Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      const row = data[i];
      if (!isPlainObject(row)) {
        texts[i] = searchTextFor(data, String(i), row);
        continue;
      }
      const rowTexts = new Array<string>(columns.length);
      for (let c = 0; c < columns.length; c += 1) {
        const value = cellValue(row, columns[c]);
        rowTexts[c] = value === undefined ? "" : searchTextFor(row, columns[c], value);
      }
      texts[i] = rowTexts;
    }
    return texts;
  }

  // A row matches when any present cell's text contains the query, or a
  // matching column name has a value in that row (same case-insensitive
  // substring semantics as tree search).
  function rowMatches(rowIndex: number): boolean {
    const texts = searchTexts![rowIndex];
    if (typeof texts === "string") return texts.includes(filterQuery);
    for (let c = 0; c < texts.length; c += 1) {
      if (texts[c] === "") continue;
      if (matchedColumns.has(c) || texts[c].includes(filterQuery)) return true;
    }
    return false;
  }

  function cellTextMatches(rowIndex: number, columnIndex: number): boolean {
    if (filterQuery === "") return false;
    const texts = searchTexts![rowIndex];
    if (typeof texts === "string") {
      return columnIndex === 0 && texts.includes(filterQuery);
    }
    return texts[columnIndex] !== "" && texts[columnIndex].includes(filterQuery);
  }

  function createPoolRow(): TablePoolRow {
    const line = document.createElement("div");
    line.className = "jv-table-row";
    const indexCell = document.createElement("div");
    indexCell.className = "jv-table-cell jv-table-index";
    line.appendChild(indexCell);
    const cells: HTMLDivElement[] = [];
    for (let i = 0; i < columns.length; i += 1) {
      const cell = document.createElement("div");
      cell.className = "jv-table-cell";
      cells.push(cell);
      line.appendChild(cell);
    }
    return { line, indexCell, cells, lastRowIndex: -1 };
  }

  function applyPoolRow(poolRow: TablePoolRow, rowIndex: number): void {
    if (poolRow.lastRowIndex === rowIndex) return;
    poolRow.lastRowIndex = rowIndex;
    poolRow.indexCell.textContent = String(rowIndex);
    const row = data[rowIndex];
    if (!isPlainObject(row)) {
      // Non-object element in a mostly-object array: show its value in the
      // first column and dashes for the rest.
      for (let c = 0; c < columns.length; c += 1) {
        const cell = poolRow.cells[c];
        if (c === 0) {
          applyCell(cell, data, String(rowIndex), row, rowIndex, 0);
        } else {
          cell.className = "jv-table-cell jv-table-missing";
          cell.textContent = "–";
          if (cell.title !== "") cell.removeAttribute("title");
        }
      }
      return;
    }
    for (let c = 0; c < columns.length; c += 1) {
      const cell = poolRow.cells[c];
      applyCell(cell, row, columns[c], cellValue(row, columns[c]), rowIndex, c);
    }
  }

  function cellMatchClass(base: string, rowIndex: number, columnIndex: number): string {
    return cellTextMatches(rowIndex, columnIndex) ? `${base} jv-search-match` : base;
  }

  function invalidatePool(): void {
    for (const poolRow of scroller.pool()) {
      poolRow.lastRowIndex = -1;
    }
  }

  function updateSortIndicators(): void {
    for (const th of headerCells) {
      const arrow = th.querySelector<HTMLElement>(".jv-table-sort")!;
      if (th.dataset.column === sortColumn && sortDirection !== null) {
        th.classList.add("jv-table-sorted");
        arrow.textContent = sortDirection === "asc" ? "▲" : "▼";
      } else {
        th.classList.remove("jv-table-sorted");
        arrow.textContent = "";
      }
    }
  }

  header.addEventListener("click", (e) => {
    const th = (e.target as HTMLElement).closest<HTMLElement>(
      ".jv-table-th[data-column]"
    );
    if (!th) return;
    const column = th.dataset.column!;
    if (sortColumn === column) {
      sortDirection =
        sortDirection === "asc" ? "desc" : sortDirection === "desc" ? null : "asc";
      if (sortDirection === null) sortColumn = null;
    } else {
      sortColumn = column;
      sortDirection = "asc";
    }
    baseOrder = sortRowIndices(data, sortColumn, sortDirection, exactNumbers);
    updateSortIndicators();
    applyFilter();
  });

  // Recomputes `order` from `baseOrder` and the active query, syncs header
  // highlights, and re-renders. Sorting and filtering both funnel through
  // here so each survives the other.
  function applyFilter(): void {
    if (filterQuery === "") {
      matchedColumns = new Set();
      order = baseOrder;
    } else {
      if (searchTexts === null) searchTexts = buildSearchTexts();
      matchedColumns = new Set<number>();
      for (let c = 0; c < columns.length; c += 1) {
        if (columns[c].toLowerCase().includes(filterQuery)) matchedColumns.add(c);
      }
      order = baseOrder.filter(rowMatches);
    }
    for (let c = 0; c < headerCells.length; c += 1) {
      headerCells[c].classList.toggle("jv-search-match", matchedColumns.has(c));
    }
    invalidatePool();
    scroller.render();
  }

  function currentFilterState(): TableFilterState {
    return { query: filterQuery, shown: order.length, total: data.length };
  }

  scroller.render();

  return {
    refresh(): void {
      scroller.schedule();
    },
    setFilter(query: string): TableFilterState {
      const normalized = query.trim().toLowerCase();
      if (normalized !== filterQuery) {
        filterQuery = normalized;
        // New result set: start from the top. Skipped while hidden so a
        // filter applied in the background never moves another view's scroll.
        if (!container.classList.contains("jv-hidden")) {
          scrollContainer.scrollTop = 0;
        }
        applyFilter();
      }
      return currentFilterState();
    },
    getFilterState(): TableFilterState {
      return currentFilterState();
    },
    dispose(): void {
      scroller.dispose();
      container.innerHTML = "";
    },
  };
}
