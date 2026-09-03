// @vitest-environment jsdom

import { describe, expect, test } from "vitest";

import { createVirtualScroller, type VirtualScroller } from "./virtual-scroller";

const ROW_HEIGHT = 24;
const VIEWPORT = 240; // ten rows
const MAX_SPACER = 1_000_000;

interface TestRow {
  line: HTMLDivElement;
  boundIndex: number;
}

interface Harness {
  scroller: VirtualScroller<TestRow>;
  scrollContainer: HTMLElement;
  spacer: HTMLElement;
  rowsLayer: HTMLElement;
  /** Row indices bound to visible pooled rows, in DOM order. */
  visible: () => number[];
  poolSize: () => number;
  createdRows: () => number;
}

function setup(options: {
  totalRows: number;
  overscan: number | ((scale: number) => number);
  capSpacer?: boolean;
}): Harness {
  const scrollContainer = document.createElement("div");
  // jsdom lays nothing out, so stand in for the measured viewport.
  Object.defineProperty(scrollContainer, "clientHeight", {
    value: VIEWPORT,
    configurable: true,
  });
  const spacer = document.createElement("div");
  const rowsLayer = document.createElement("div");
  scrollContainer.append(spacer, rowsLayer);
  document.body.innerHTML = "";
  document.body.appendChild(scrollContainer);

  let created = 0;
  const scroller = createVirtualScroller<TestRow>({
    scrollContainer,
    spacer,
    rowsLayer,
    rowHeight: ROW_HEIGHT,
    overscan: options.overscan,
    spacerHeight: options.capSpacer
      ? (virtualHeight) => Math.min(virtualHeight, MAX_SPACER)
      : undefined,
    getRowCount: () => options.totalRows,
    createRow(): TestRow {
      created += 1;
      const line = document.createElement("div");
      return { line, boundIndex: -1 };
    },
    bindRow(row: TestRow, rowIndex: number): void {
      row.boundIndex = rowIndex;
    },
  });

  return {
    scroller,
    scrollContainer,
    spacer,
    rowsLayer,
    visible: () =>
      scroller
        .pool()
        .filter((row) => !row.line.hidden)
        .map((row) => row.boundIndex),
    poolSize: () => scroller.pool().length,
    createdRows: () => created,
  };
}

describe("createVirtualScroller window computation", () => {
  test("at the top of the list the window starts at the first row", () => {
    const h = setup({ totalRows: 100, overscan: 2 });

    h.scroller.render();

    // Ten rows fit the viewport; the overscan only pads the far side.
    expect(h.visible()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(h.rowsLayer.style.transform).toBe("translateY(0px)");
    expect(h.spacer.style.height).toBe("2400px");
  });

  test("in the middle of the list the window is padded either side", () => {
    const h = setup({ totalRows: 100, overscan: 2 });

    h.scrollContainer.scrollTop = 50 * ROW_HEIGHT;
    h.scroller.render();

    expect(h.visible()[0]).toBe(48);
    expect(h.visible().at(-1)).toBe(61);
    // The layer is offset by the window's start, so row 50 lands where the
    // scroll position says it should.
    expect(h.rowsLayer.style.transform).toBe(`translateY(${48 * ROW_HEIGHT}px)`);
  });

  test("at the end of the list the window stops at the last row", () => {
    const h = setup({ totalRows: 100, overscan: 2 });

    // Past the scrollable range: the browser owns the real bounds (padding
    // included), so the window math clamps its own copy instead.
    h.scrollContainer.scrollTop = 999_999;
    h.scroller.render();

    expect(h.visible().at(-1)).toBe(99);
    expect(h.visible()).toContain(90);
    expect(h.scrollContainer.scrollTop).toBe(999_999);
  });

  test("a list shorter than the viewport renders every row", () => {
    const h = setup({ totalRows: 3, overscan: 2 });

    h.scroller.render();

    expect(h.visible()).toEqual([0, 1, 2]);
    expect(h.spacer.style.height).toBe("72px");
  });
});

describe("createVirtualScroller pool", () => {
  test("grows to the largest window and is never rebuilt", () => {
    const h = setup({ totalRows: 100, overscan: 2 });

    h.scroller.render();
    expect(h.poolSize()).toBe(12);

    // A window in the middle needs the overscan on both sides.
    h.scrollContainer.scrollTop = 50 * ROW_HEIGHT;
    h.scroller.render();
    expect(h.poolSize()).toBe(14);
    expect(h.createdRows()).toBe(14);

    h.scrollContainer.scrollTop = 51 * ROW_HEIGHT;
    h.scroller.render();
    expect(h.createdRows()).toBe(14);
  });

  test("hides the pooled rows past the window's end", () => {
    const h = setup({ totalRows: 100, overscan: 2 });

    h.scrollContainer.scrollTop = 50 * ROW_HEIGHT;
    h.scroller.render();
    expect(h.visible().length).toBe(14);

    // Back to the top: a two-row-shorter window, so two pooled rows go idle
    // rather than showing what they last held.
    h.scrollContainer.scrollTop = 0;
    h.scroller.render();
    expect(h.poolSize()).toBe(14);
    expect(h.visible().length).toBe(12);
    expect(h.scroller.pool().filter((row) => row.line.hidden).length).toBe(2);
  });
});

describe("createVirtualScroller with a compressed spacer", () => {
  // The tree's rule: shrink the pad with the compression, but never below one
  // pixel's worth of rows, since a browser snaps scrollTop to whole pixels.
  function overscan(scale: number): number {
    if (scale === 1) return 30;
    return Math.max(Math.round(30 / scale), Math.ceil(scale / ROW_HEIGHT));
  }

  const TOTAL = 1_000_000; // 24,000,000px of rows, compressed 24x

  test("caps the spacer and still pools only a viewport's worth of rows", () => {
    const h = setup({ totalRows: TOTAL, overscan, capSpacer: true });

    h.scrollContainer.scrollTop = MAX_SPACER / 2;
    h.scroller.render();

    expect(h.spacer.style.height).toBe(`${MAX_SPACER}px`);
    // Sized by the viewport, not by the compression: 10 visible rows plus the
    // pad, against the 24 x viewport a scale-sized window would have built.
    expect(h.visible().length).toBeLessThanOrEqual(14);
    // Half the spacer scrolled past is half the rows scrolled past.
    expect(h.visible()).toContain(TOTAL / 2);
    // The layer offset is in spacer pixels, so it carries the compression.
    expect(h.rowsLayer.style.transform).toBe(
      `translateY(${(h.visible()[0] * ROW_HEIGHT) / 24}px)`
    );
  });

  test("scrollToRow lands its target in the window despite pixel snapping", () => {
    const h = setup({ totalRows: TOTAL, overscan, capSpacer: true });

    h.scroller.scrollToRow(750_000);
    // One compressed pixel is 24 rows, and browsers snap scrollTop to whole
    // device pixels: the overscan is what absorbs the rounding.
    h.scrollContainer.scrollTop = Math.round(h.scrollContainer.scrollTop);
    h.scroller.render();

    expect(h.visible()).toContain(750_000);
  });

  test("an uncompressed list keeps the flat overscan", () => {
    const h = setup({ totalRows: 100, overscan, capSpacer: true });

    h.scroller.render();

    expect(h.spacer.style.height).toBe("2400px");
    // scale 1, so the whole 100-row list sits inside viewport + 30.
    expect(h.visible().length).toBe(40);
  });
});
