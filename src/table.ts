import type { JsonValue } from "./tree-model";
import type { ExactNumberMap } from "./lossless-numbers";

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

function compareValues(a: JsonValue, b: JsonValue): number {
  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA - rankB;
  if (typeof a === "number" && typeof b === "number") {
    return a === b ? 0 : a < b ? -1 : 1;
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
  direction: SortDirection
): number[] {
  const indices = rows.map((_, i) => i);
  if (column === null || direction === null) return indices;
  const dir = direction === "asc" ? 1 : -1;
  indices.sort((a, b) => {
    const rowA = rows[a];
    const rowB = rows[b];
    const valueA = isPlainObject(rowA) ? rowA[column] : undefined;
    const valueB = isPlainObject(rowB) ? rowB[column] : undefined;
    const missingA = valueA === undefined;
    const missingB = valueB === undefined;
    if (missingA || missingB) {
      return missingA === missingB ? 0 : missingA ? 1 : -1;
    }
    return compareValues(valueA, valueB) * dir;
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
  return text.length > CELL_TEXT_MAX ? `${text.slice(0, CELL_TEXT_MAX)}…` : text;
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

function cellClass(value: JsonValue | undefined): string {
  if (value === undefined) return "jv-table-cell jv-table-missing";
  if (value === null) return "jv-table-cell jv-null";
  if (value === "") return "jv-table-cell jv-table-empty";
  if (typeof value === "string") return "jv-table-cell jv-string";
  if (typeof value === "number") return "jv-table-cell jv-number";
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
      const value = row[columns[c]];
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
  let renderScheduled = false;

  const rowPool: TablePoolRow[] = [];

  function exactNumberText(holder: object, key: string, value: JsonValue): string | undefined {
    return typeof value === "number"
      ? exactNumbers?.get(holder)?.get(key)
      : undefined;
  }

  function displayText(holder: object, key: string, value: JsonValue | undefined): string {
    if (value === undefined) return "–";
    const exact = exactNumberText(holder, key, value);
    return exact !== undefined ? truncateCell(exact) : cellText(value);
  }

  function searchTextFor(holder: object, key: string, value: JsonValue): string {
    const exact = exactNumberText(holder, key, value);
    if (exact !== undefined) return exact.toLowerCase();
    if (value === null) return "null";
    if (typeof value === "object") return containerPreview(value).toLowerCase();
    return String(value).toLowerCase();
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
        const value = row[columns[c]];
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

  function ensurePoolSize(size: number): void {
    while (rowPool.length < size) {
      const row = createPoolRow();
      rowPool.push(row);
      rowsLayer.appendChild(row.line);
    }
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
          cell.className = cellMatchClass(cellClass(row), rowIndex, 0);
          cell.textContent = displayText(data, String(rowIndex), row);
        } else {
          cell.className = "jv-table-cell jv-table-missing";
          cell.textContent = "–";
        }
      }
      return;
    }
    for (let c = 0; c < columns.length; c += 1) {
      const cell = poolRow.cells[c];
      const value = row[columns[c]];
      cell.className = cellMatchClass(cellClass(value), rowIndex, c);
      cell.textContent = displayText(row, columns[c], value);
    }
  }

  function cellMatchClass(base: string, rowIndex: number, columnIndex: number): string {
    return cellTextMatches(rowIndex, columnIndex) ? `${base} jv-search-match` : base;
  }

  function renderWindow(): void {
    renderScheduled = false;
    // Another view owns the shared scroll container while the table is
    // hidden; rendering would react to that view's scroll position.
    if (container.classList.contains("jv-hidden")) return;

    const totalRows = order.length;
    spacer.style.height = `${totalRows * TABLE_ROW_HEIGHT}px`;

    const viewportHeight =
      scrollContainer.clientHeight || window.innerHeight || 800;
    const scrollTop = Math.max(
      0,
      Math.min(scrollContainer.scrollTop, totalRows * TABLE_ROW_HEIGHT)
    );
    const startIndex = Math.max(
      0,
      Math.floor(scrollTop / TABLE_ROW_HEIGHT) - TABLE_OVERSCAN
    );
    const endIndex = Math.min(
      totalRows,
      Math.ceil((scrollTop + viewportHeight) / TABLE_ROW_HEIGHT) + TABLE_OVERSCAN
    );

    rowsLayer.style.transform = `translateY(${startIndex * TABLE_ROW_HEIGHT}px)`;

    const windowSize = Math.max(0, endIndex - startIndex);
    ensurePoolSize(windowSize);
    for (let i = 0; i < windowSize; i += 1) {
      const poolRow = rowPool[i];
      applyPoolRow(poolRow, order[startIndex + i]);
      poolRow.line.hidden = false;
    }
    for (let i = windowSize; i < rowPool.length; i += 1) {
      rowPool[i].line.hidden = true;
    }
  }

  function scheduleWindowRender(): void {
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(() => renderWindow());
  }

  function invalidatePool(): void {
    for (let i = 0; i < rowPool.length; i += 1) {
      rowPool[i].lastRowIndex = -1;
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
    baseOrder = sortRowIndices(data, sortColumn, sortDirection);
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
    renderWindow();
  }

  function currentFilterState(): TableFilterState {
    return { query: filterQuery, shown: order.length, total: data.length };
  }

  function onScroll(): void {
    scheduleWindowRender();
  }

  scrollContainer.addEventListener("scroll", onScroll);
  renderWindow();

  return {
    refresh(): void {
      scheduleWindowRender();
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
      scrollContainer.removeEventListener("scroll", onScroll);
      container.innerHTML = "";
    },
  };
}
