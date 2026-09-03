/**
 * The virtualization the tree and the table share: the spacer, the row pool,
 * the visible window, and frame-coalesced rendering. Capping the spacer
 * compresses the scrollbar for documents taller than a browser lays out, and
 * scroll positions then map through that compression; without a cap the scale
 * is 1 and every scaled term below is its plain form.
 */

export interface VirtualScrollerOptions<Row extends { line: HTMLElement }> {
  scrollContainer: HTMLElement;
  spacer: HTMLElement;
  rowsLayer: HTMLElement;
  rowHeight: number;
  /** Rows padding either side of the viewport; a function if the spacer is capped. */
  overscan: number | ((scale: number) => number);
  getRowCount: () => number;
  createRow: () => Row;
  bindRow: (row: Row, rowIndex: number, poolIndex: number) => void;
  /**
   * Physical height for rows totalling `virtualHeight`; less compresses the
   * scrollbar by the ratio. A height, not a scale, so the spacer keeps the
   * caller's own arithmetic. Default: no cap.
   */
  spacerHeight?: (virtualHeight: number) => number;
  /** True while another view owns the scroll container: renders are skipped. */
  isPaused?: () => boolean;
  /**
   * Resolves a whole window at once, for callers whose rows are not indexable
   * one at a time. Returns how many rows are bindable (default: the window's).
   */
  prepareWindow?: (startIndex: number, endIndex: number) => number;
  onWindowRendered?: (totalRows: number) => void;
}

export interface VirtualScroller<Row> {
  render: () => void;
  /** Renders on the next frame, at most once per frame. */
  schedule: () => void;
  scrollToRow: (index: number) => void;
  /** Every pooled row, bound or hidden, for caller-side sweeps. */
  pool: () => readonly Row[];
  dispose: () => void;
}

export function createVirtualScroller<Row extends { line: HTMLElement }>(
  options: VirtualScrollerOptions<Row>
): VirtualScroller<Row> {
  const { scrollContainer, spacer, rowsLayer, rowHeight } = options;
  const pool: Row[] = [];
  let renderScheduled = false;

  function viewportHeight(): number {
    return scrollContainer.clientHeight || window.innerHeight || 800;
  }

  function measure(totalRows: number): { physicalHeight: number; scale: number } {
    const virtualHeight = totalRows * rowHeight;
    const physicalHeight = options.spacerHeight?.(virtualHeight) ?? virtualHeight;
    return {
      physicalHeight,
      scale:
        virtualHeight > physicalHeight ? virtualHeight / physicalHeight : 1,
    };
  }

  function overscanFor(scale: number): number {
    return typeof options.overscan === "number"
      ? options.overscan
      : options.overscan(scale);
  }

  function ensurePoolSize(size: number): void {
    while (pool.length < size) {
      const row = options.createRow();
      pool.push(row);
      rowsLayer.appendChild(row.line);
    }
  }

  function renderWindow(): void {
    renderScheduled = false;
    if (options.isPaused?.()) return;

    const totalRows = options.getRowCount();
    const { physicalHeight, scale } = measure(totalRows);
    spacer.style.height = `${physicalHeight}px`;

    const viewport = viewportHeight();
    // Clamp the local copy only: the browser owns the real bounds (padding
    // included), and writing this back made the last rows unreachable.
    const maxScroll = Math.max(0, physicalHeight - viewport);
    const scrollTop = Math.max(
      0,
      Math.min(scrollContainer.scrollTop, maxScroll)
    );

    const virtualScrollTop = scrollTop * scale;
    const overscan = overscanFor(scale);
    const startIndex = Math.max(
      0,
      Math.floor(virtualScrollTop / rowHeight) - overscan
    );
    // Position maps through `scale`, the window's height does not: rows render
    // at native height however compressed the spacer is.
    const endIndex = Math.min(
      totalRows,
      Math.ceil((virtualScrollTop + viewport) / rowHeight) + overscan
    );

    rowsLayer.style.transform = `translateY(${(startIndex * rowHeight) / scale}px)`;

    const windowSize = Math.max(0, endIndex - startIndex);
    const boundCount = options.prepareWindow?.(startIndex, endIndex) ?? windowSize;
    ensurePoolSize(boundCount);
    for (let i = 0; i < boundCount; i += 1) {
      const row = pool[i];
      options.bindRow(row, startIndex + i, i);
      row.line.hidden = false;
    }
    for (let i = boundCount; i < pool.length; i += 1) {
      pool[i].line.hidden = true;
    }

    options.onWindowRendered?.(totalRows);
  }

  function schedule(): void {
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(() => renderWindow());
  }

  function scrollToRow(index: number): void {
    const viewport = viewportHeight();
    const { scale } = measure(options.getRowCount());
    // renderWindow's layer formula solved for the scrollTop that centres
    // `index`, less the overscan a compressed offset carries.
    const overscanComp =
      scale === 1
        ? 0
        : (overscanFor(scale) * rowHeight * (scale - 1)) / (scale * scale);
    scrollContainer.scrollTop = Math.max(
      0,
      (index * rowHeight) / scale +
        overscanComp -
        viewport / (2 * scale) +
        rowHeight / (2 * scale)
    );
  }

  function onScroll(): void {
    schedule();
  }

  scrollContainer.addEventListener("scroll", onScroll);

  return {
    render: renderWindow,
    schedule,
    scrollToRow,
    pool: () => pool,
    dispose(): void {
      scrollContainer.removeEventListener("scroll", onScroll);
    },
  };
}
