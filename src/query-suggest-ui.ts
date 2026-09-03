// The query autocomplete dropdown: the DOM and keyboard layer over the
// suggestion logic in ./query-suggest. It renders rows, tracks the highlighted
// one, owns the input's text and caret while accepting a row, and reports the
// acceptance. It resolves nothing itself — the caller supplies the rows.

import { JMESPATH_FUNCTIONS, type KeySuggestion } from "./query-suggest";

// The dropdown shows either contextual key suggestions (while typing) or the
// recent-query history (when the field is empty) — one mode at a time.
export type SuggestEntry =
  | ({ type: "key" } & KeySuggestion)
  | { type: "recent"; query: string };

export interface SuggestBatch {
  entries: SuggestEntry[];
  /** Offset in the input where an accepted key entry starts replacing text. */
  start: number;
}

export interface QuerySuggestUiOptions {
  input: HTMLInputElement;
  /** The <ul> the rows are rendered into. */
  list: HTMLElement;
  /**
   * Rows for the input's current text and caret. `null` means "no answer yet"
   * and leaves the dropdown exactly as it is; an empty `entries` hides it.
   */
  suggest(value: string, caret: number): SuggestBatch | null;
  /** The ✕ on a recent-query row. The list re-renders straight after. */
  onRemoveRecent(query: string): void;
  /** A row was accepted; the input's text and caret already reflect it. */
  onAccept(entry: SuggestEntry): void;
}

export interface QuerySuggestUi {
  /** True while the dropdown is showing rows. */
  isOpen(): boolean;
  /** Hides the dropdown and drops its rows. */
  hide(): void;
  /**
   * Arrow/Enter/Tab/Escape while the dropdown is open. Returns true when the
   * key was consumed, so the caller's own bindings stand only when closed.
   */
  handleKeyDown(event: KeyboardEvent): boolean;
}

export function createQuerySuggestUi(
  options: QuerySuggestUiOptions
): QuerySuggestUi {
  const { input, list } = options;
  let items: SuggestEntry[] = [];
  let activeIndex = -1;
  let tokenStart = 0;

  function isOpen(): boolean {
    return !list.hidden;
  }

  function hide(): void {
    list.hidden = true;
    list.replaceChildren();
    items = [];
    activeIndex = -1;
  }

  function renderKeyItem(item: HTMLLIElement, entry: KeySuggestion): void {
    const name = document.createElement("span");
    name.className = "jv-query-suggest-name";
    name.textContent = entry.name;
    item.appendChild(name);
    if (entry.kind === "array") {
      // A badge marks array-valued keys so the user knows to bracket in.
      const badge = document.createElement("span");
      badge.className = "jv-query-suggest-badge";
      badge.textContent = "[ ]";
      item.appendChild(badge);
    }
  }

  function renderRecentItem(item: HTMLLIElement, query: string): void {
    item.classList.add("jv-query-suggest-recent");
    const glyph = document.createElement("span");
    glyph.className = "jv-query-suggest-glyph";
    glyph.textContent = "↺";
    glyph.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "jv-query-suggest-name";
    text.textContent = query;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "jv-query-suggest-del";
    del.title = "Remove from history";
    del.setAttribute("aria-label", `Remove ${query} from history`);
    del.textContent = "×";
    del.addEventListener("mousedown", (e) => {
      // Stop the item's own mousedown (which would run the query) and the
      // input blur, then drop just this entry.
      e.preventDefault();
      e.stopPropagation();
      options.onRemoveRecent(query);
      update();
    });
    item.append(glyph, text, del);
  }

  function render(): void {
    list.replaceChildren();
    const recentsMode = items[0]?.type === "recent";
    if (recentsMode) {
      const header = document.createElement("li");
      header.className = "jv-query-suggest-section";
      header.textContent = "Recent queries";
      list.appendChild(header);
    }
    items.forEach((entry, i) => {
      const item = document.createElement("li");
      item.className = "jv-query-suggest-item";
      if (i === activeIndex) item.classList.add("jv-active");
      if (entry.type === "recent") renderRecentItem(item, entry.query);
      else renderKeyItem(item, entry);
      item.addEventListener("mousedown", (e) => {
        // mousedown (not click) so the input never loses focus first.
        e.preventDefault();
        accept(i);
      });
      list.appendChild(item);
    });
    list.hidden = items.length === 0;
    // replaceChildren() above resets scrollTop, so keyboard nav past the visible
    // window would leave the highlight off-screen; pull it back into view.
    list.querySelector(".jv-active")?.scrollIntoView({ block: "nearest" });
  }

  function update(): void {
    const value = input.value;
    const caret = input.selectionStart ?? value.length;
    const batch = options.suggest(value, caret);
    if (batch === null) return;
    if (batch.entries.length === 0) {
      hide();
      return;
    }
    tokenStart = batch.start;
    items = batch.entries;
    activeIndex = 0;
    render();
  }

  function move(delta: number): void {
    if (items.length === 0) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    render();
  }

  function accept(index: number): void {
    const entry = items[index];
    if (entry === undefined) return;
    if (entry.type === "recent") {
      // Re-running a past query is the caller's job; fill the input for it.
      input.value = entry.query;
      const end = entry.query.length;
      input.setSelectionRange(end, end);
    } else {
      const chosen = entry.name;
      const caret = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, tokenStart);
      const after = input.value.slice(caret);
      // Functions get an open paren; array keys get a `[*]` projection so the
      // user can immediately descend (`.`) or swap the `*` for an index/filter;
      // plain keys go in as-is. The caret lands right after the insertion.
      let insertion: string;
      if (JMESPATH_FUNCTIONS.includes(chosen)) insertion = `${chosen}(`;
      else if (entry.kind === "array") insertion = `${chosen}[*]`;
      else insertion = chosen;
      input.value = before + insertion + after;
      const newCaret = before.length + insertion.length;
      input.setSelectionRange(newCaret, newCaret);
    }
    hide();
    input.focus();
    options.onAccept(entry);
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (!isOpen()) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(activeIndex);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hide();
      return true;
    }
    return false;
  }

  input.addEventListener("input", () => {
    update();
  });

  input.addEventListener("focus", () => {
    // Surface recent queries when the field is empty; typing switches to keys.
    if (input.value.trim() === "") update();
  });

  input.addEventListener("blur", () => {
    hide();
  });

  return { isOpen, hide, handleKeyDown };
}
