import { type TreeModel, isContainerNode } from "./tree-model";

interface TreeSearchNode {
  id: number;
  searchValue: string;
  hasLongSearchValue: boolean;
  rawStringValue?: string;
  searchKey: string;
  searchPath: string;
  isContainer: boolean;
}

interface TreeSearchMatch {
  nodeId: number;
  score: number;
}

export interface TreeSearchOptions {
  regex?: boolean;
}

export interface TreeSearchIndex {
  search(query: string, options?: TreeSearchOptions): Promise<number[]>;
  dispose(): void;
}

// Why a search stopped short of reading the whole document. The two are
// different events and callers report them differently: "timeout" means the
// scan started, read part of the document and outlived SEARCH_TIME_BUDGET_MS,
// while "pattern-too-slow" means the cost probe refused the pattern and no node
// was ever tested.
export type SearchLimitReason = "timeout" | "pattern-too-slow";

const SEARCH_LIMIT_MESSAGES: Record<SearchLimitReason, string> = {
  timeout: "search scan outlived its time budget",
  "pattern-too-slow": "search pattern refused by the cost probe",
};

// Rejection for a search that stopped short. The index stays usable whichever
// reason it carries, so the next search runs normally. The message is for
// stack traces: the user-facing wording lives with the search UI, which is
// what has to tell the two reasons apart.
export class SearchLimitError extends Error {
  readonly reason: SearchLimitReason;

  constructor(reason: SearchLimitReason) {
    super(SEARCH_LIMIT_MESSAGES[reason]);
    this.name = "SearchLimitError";
    this.reason = reason;
  }
}

// Nodes scanned per event-loop task. Search runs on the main thread, so the
// scan is chunked to keep any single task short enough to leave frames free.
const SEARCH_SCAN_BATCH_SIZE = 500;

// Time one search may spend scanning. A scan that outlives it rejects with the
// "timeout" reason instead of holding the main thread indefinitely. It sits
// under the point where a frozen tab feels broken and still leaves two orders
// of magnitude of headroom: a 100k-node document scans in about 10 ms.
//
// It bounds a pattern that is merely slow, not one that backtracks
// catastrophically: the budget is read between nodes and a single regex.test
// call cannot be interrupted, so one test over one node can overrun it without
// limit. Refusing such a pattern up front is the only thing that bounds it,
// which is what regexExceedsCostBudget is for.
const SEARCH_TIME_BUDGET_MS = 1000;

// Characters of any text a regex is tested against — a raw string value, a key
// or a path. Text is truncated rather than chunked into windows: a window
// boundary would let `^` and `$` match mid-text and would miss any match
// straddling two windows, so a cap is the honest bound. 4096 keeps one test
// cheap even for a pattern with quadratic backtracking (~16M steps, tens of
// milliseconds) while covering text far longer than anything a person reads in
// a row. Keys and paths need it as much as values do: a deeply nested document
// has paths thousands of characters long.
const REGEX_TEST_LIMIT = 4096;

// The head of one text, bounded for a regex. Substring matching does not go
// through here: includes() is linear, so it still reads everything whole.
function boundRegexInput(text: string): string {
  return text.length > REGEX_TEST_LIMIT ? text.slice(0, REGEX_TEST_LIMIT) : text;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

// Compiles a regex query with the case-insensitive flag, returning null when
// the pattern is invalid so callers can degrade gracefully instead of throwing.
// Text reaches the pattern lowercased, and every text it sees is bounded to
// REGEX_TEST_LIMIT characters — values, keys and paths alike. Values are
// bounded twice: the index stores a 200-char preview (see
// SEARCH_VALUE_PREVIEW_LIMIT in tree-model.ts) and reads the longer original
// only up to the same limit.
export function compileSearchRegex(query: string): RegExp | null {
  try {
    return new RegExp(query, "i");
  } catch {
    return null;
  }
}

// Longest repeated run a probe input contains. A backtracking engine's worst
// case grows with the length of a run its quantifiers can partition, so run
// length is what the probe sweeps. Measured on V8, `(a+)+$` costs ~60 ms at a
// run of 21 and ~16 s at 29; the per-test ceiling below stops the sweep in the
// teens, so 32 is affordable and long enough to expose a pattern that only
// starts growing after a dozen characters.
const REGEX_PROBE_MAX_RUN = 32;

// What one probe test may cost before the pattern is refused. Probe input never
// exceeds REGEX_PROBE_MAX_RUN plus the wall below, so this reads growth rather
// than absolute cost: over input that short a linear or polynomial pattern
// stays in the microseconds on any machine, while one that backtracks
// catastrophically doubles per character and crosses this within a few of them.
// Measured over the patterns people actually type, the worst single test was
// 0.05 ms, with outliers to 0.3 ms under scheduler noise.
const REGEX_PROBE_TEST_CEILING_MS = 4;

// Total time all the probes for one pattern may spend, read *before* each test
// rather than after it, so the test that finds the budget gone cannot be the
// one that blew it. An ordinary pattern finishes the whole sweep — up to seven
// hundred tests — in under a millisecond, so this sits two orders of magnitude
// from normal and is not sensitive to machine speed or CI load. Running out of
// it refuses the pattern: at that point the probe has learned nothing, and
// guessing in the pattern's favour is the one guess that cannot be undone.
const REGEX_PROBE_BUDGET_MS = 40;

// Distinct repeated characters probed. Capped so a long pattern cannot turn the
// probe into a scan of its own.
const REGEX_PROBE_UNIT_LIMIT = 11;

// What every probe input ends with. A single trailing sentinel character is
// worthless, because a sentinel is matchable: any pattern whose tail can
// consume one — `\W$`, `[^b]$`, `.{0,2}$` — matches the probe in microseconds,
// and a successful match measures nothing, because only a failing match makes
// a backtracking engine explore its partitions. So the probe ends in a run
// long enough to overrun a bounded tail: a tail that eats one NUL still finds
// fifteen more standing between it and `$`. NUL is outside `\w`, `\s`, `\d`
// and every plausible hand-written character class.
const REGEX_PROBE_WALL = "\u0000".repeat(16);

const REGEX_METACHARACTERS = new Set("\\^$.|?*+()[]{}".split(""));

// Characters worth repeating in a probe: the ones the pattern spells out
// literally, plus a letter, a digit and a space so patterns written entirely
// with classes (`\w`, `\d`, `[a-z]`) still meet input they can chew on.
function regexProbeUnits(pattern: string): string[] {
  const units = new Set(["a", "0", " "]);
  for (const character of pattern) {
    if (REGEX_METACHARACTERS.has(character)) continue;
    units.add(character);
    if (units.size >= REGEX_PROBE_UNIT_LIMIT) break;
  }
  return [...units];
}

// The probe inputs for one run length: every unit repeated, once on its own
// and once followed by the pattern's whole alphabet. The second shape exists
// for a prerequisite a single repeated character cannot satisfy — the lookahead
// in `(?=.*x)(a+)+$` needs an `x` somewhere before the quantifiers behind it
// get to backtrack at all — and costs nothing on a pattern with no such
// prerequisite.
function regexProbeInputs(units: readonly string[], length: number): string[] {
  const alphabet = units.join("");
  const inputs = new Set<string>();
  for (const unit of units) {
    const run = unit.repeat(length);
    inputs.add(run + REGEX_PROBE_WALL);
    inputs.add(run + alphabet + REGEX_PROBE_WALL);
  }
  return [...inputs];
}

// Answers whether a pattern backtracks catastrophically, by timing it against
// short synthetic inputs before it is ever let loose on the document.
//
// This is the only guard that can stop a pattern like `(a+)+$` in time. A
// single regex.test call cannot be interrupted once it starts, and its cost is
// driven by the length of a repeated run rather than by the length of the text,
// so no cap on the tested text bounds it: a run of 30 characters — inside the
// 200-character preview the index stores — already costs a minute.
//
// The probe also has to bound its own cost, because a heavily branching pattern
// makes a single test expensive: `(a|a|…|a)+$` with 160 alternatives explores
// 160^n paths over a run of n. So run length is the outer loop and grows one
// character at a time, and no test runs until every probe one character shorter
// came back under the ceiling. That caps a single test at the pattern's
// branching factor times a measurement that was already cheap — measured worst
// decision times are 22 ms for that alternation and 7 ms for
// `((((a+)+)+)+)+$`, against 3.5 s and 143 ms for a probe that read its budget
// after each test instead of before.
//
// It errs by measurement, not by syntax: nested quantifiers that stay cheap go
// through, unanchored `(a+)+` included. It still misses a pattern that only
// explodes on input no probe generates — a run interleaved with a second
// character, as `(x+y+)+z` needs — and nothing downstream bounds that, because
// SEARCH_TIME_BUDGET_MS cannot interrupt a test already under way. Measured,
// `(x+y+)+z` costs under a millisecond even at 46 characters, so the miss is
// narrower than the shape suggests, but it is a miss.
function regexExceedsCostBudget(regex: RegExp): boolean {
  const units = regexProbeUnits(regex.source);
  const deadline = performance.now() + REGEX_PROBE_BUDGET_MS;

  for (let length = 1; length <= REGEX_PROBE_MAX_RUN; length += 1) {
    for (const input of regexProbeInputs(units, length)) {
      if (performance.now() >= deadline) return true;

      const started = performance.now();
      regex.test(input);
      const cost = performance.now() - started;

      // A run of one character gives the quantifiers nothing to partition, so
      // the shortest probes only pay V8's lazy code generation for the pattern.
      // Timing them would measure the compiler, not the backtracking.
      if (length > 1 && cost > REGEX_PROBE_TEST_CEILING_MS) return true;
    }
  }

  return false;
}

function valueMatches(node: TreeSearchNode, query: string): boolean {
  if (!node.searchValue) return false;
  if (node.searchValue.includes(query)) return true;
  return node.hasLongSearchValue && typeof node.rawStringValue === "string"
    ? node.rawStringValue.includes(query)
    : false;
}

function valueMatchesRegex(node: TreeSearchNode, regex: RegExp): boolean {
  if (!node.searchValue) return false;
  if (regex.test(node.searchValue)) return true;
  if (!node.hasLongSearchValue || typeof node.rawStringValue !== "string") return false;

  // Only the head of the original value: see REGEX_TEST_LIMIT.
  return regex.test(boundRegexInput(node.rawStringValue));
}

function matchScore(node: TreeSearchNode, query: string): number | null {
  if (node.searchKey === query || node.searchPath === query) return 0;
  if (!node.isContainer && node.searchValue === query) return 1;
  if (!node.isContainer && valueMatches(node, query)) return 2;
  if (node.searchKey && node.searchKey.includes(query)) return 3;
  if (node.searchPath.includes(query)) return 4;
  return null;
}

// Regex matches don't carry a meaningful ranking the way substring matches do,
// so every hit shares one score and the node id breaks ties (see
// sortTreeSearchMatches). Key/path/value are tested in that priority order.
//
// Keys and paths are bounded like values are: a path grows with the depth of
// the document, so an unbounded one hands a polynomial pattern an input as long
// as the document is deep.
function matchScoreRegex(node: TreeSearchNode, regex: RegExp): number | null {
  if (node.searchKey && regex.test(boundRegexInput(node.searchKey))) return 0;
  if (regex.test(boundRegexInput(node.searchPath))) return 0;
  if (!node.isContainer && valueMatchesRegex(node, regex)) return 0;
  return null;
}

function createTreeSearchNodes(model: TreeModel): TreeSearchNode[] {
  return model.nodes.map((node) => ({
    id: node.id,
    searchValue: node.searchValue,
    hasLongSearchValue: node.hasLongSearchValue,
    rawStringValue:
      node.hasLongSearchValue && typeof node.value === "string"
        ? node.value.toLowerCase()
        : undefined,
    searchKey: node.searchKey,
    searchPath: node.searchPath,
    isContainer: isContainerNode(node),
  }));
}

type NodeMatcher = (node: TreeSearchNode) => number | null;

interface PreparedSearch {
  match: NodeMatcher;
  // The compiled pattern in regex mode, so the caller can budget it before the
  // scan starts; null in substring mode.
  regex: RegExp | null;
}

// Prepares the per-node test for one search, or returns null when the query
// cannot match anything: an empty substring query, or an invalid pattern. The
// regex is compiled once here rather than once per batch.
function prepareSearch(query: string, options?: TreeSearchOptions): PreparedSearch | null {
  if (options?.regex) {
    // The raw query is used verbatim — trimming/lowercasing it would corrupt
    // regex metacharacters and escapes. Invalid patterns yield no matches.
    const regex = compileSearchRegex(query);
    if (regex === null) return null;
    return { match: (node) => matchScoreRegex(node, regex), regex };
  }

  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return null;
  return { match: (node) => matchScore(node, normalizedQuery), regex: null };
}

function collectTreeSearchMatches(
  nodes: readonly TreeSearchNode[],
  matcher: NodeMatcher,
  start: number,
  end: number,
  deadline: number
): TreeSearchMatch[] {
  const matches: TreeSearchMatch[] = [];
  for (let index = start; index < end; index += 1) {
    // Checked per node rather than per batch: one regex test over a long value
    // can outlast the whole budget by itself, so the budget has to be re-read
    // before every node. Date.now() costs ~27 ns, under a tenth of the work of
    // matching one node.
    if (Date.now() > deadline) throw new SearchLimitError("timeout");

    const node = nodes[index];
    const score = matcher(node);
    if (score !== null) matches.push({ nodeId: node.id, score });
  }
  return matches;
}

function sortTreeSearchMatches(matches: readonly TreeSearchMatch[]): number[] {
  return [...matches]
    .sort((left, right) =>
      left.score === right.score ? left.nodeId - right.nodeId : left.score - right.score
    )
    .map((match) => match.nodeId);
}

// Hands control back to the event loop. A MessageChannel task is used rather
// than setTimeout because chained timers are clamped to 4 ms once nested,
// which would add hundreds of milliseconds to a scan of a large document.
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export function createLocalTreeSearchIndex(model: TreeModel): TreeSearchIndex {
  const searchNodes = createTreeSearchNodes(model);
  let disposed = false;

  return {
    async search(query: string, options?: TreeSearchOptions): Promise<number[]> {
      // An empty substring query, or an invalid pattern, has no matches; skip
      // iterating every batch.
      const prepared = prepareSearch(query, options);
      if (prepared === null) return [];

      // Budget the pattern before it touches the document: a catastrophically
      // backtracking one cannot be stopped once a test is under way, so it is
      // refused up front. It rejects with its own reason, not as a timeout —
      // nothing was scanned and nothing ran out of time. The probe carries its
      // own budget, so it runs before the scan's clock starts.
      if (prepared.regex !== null && regexExceedsCostBudget(prepared.regex)) {
        throw new SearchLimitError("pattern-too-slow");
      }

      const matches: TreeSearchMatch[] = [];
      const total = searchNodes.length;
      // Scanning time only. The budget is there to bound how long the search
      // holds the main thread, and the waits between batches are time it is
      // not holding it, so charging them would measure the wrong thing. They
      // are cheap either way: 2000 MessageChannel round-trips cost ~19 ms in
      // Chromium and ~30 ms in node, so excluding them is about what the budget
      // means, not about the size of the charge.
      let spent = 0;

      for (let start = 0; start < total; start += SEARCH_SCAN_BATCH_SIZE) {
        // Disposal during a chunked scan abandons the remaining batches and
        // resolves empty: the caller is tearing this index down, and the
        // viewer discards a superseded search's ids anyway. Resolving rather
        // than rejecting keeps dispose() safe on the ordinary replace path.
        if (disposed) return [];

        const end = Math.min(start + SEARCH_SCAN_BATCH_SIZE, total);
        const batchStart = Date.now();
        const batch = collectTreeSearchMatches(
          searchNodes,
          prepared.match,
          start,
          end,
          batchStart + (SEARCH_TIME_BUDGET_MS - spent)
        );
        spent += Date.now() - batchStart;
        matches.push(...batch);

        if (end < total) await nextTask();
      }

      return sortTreeSearchMatches(matches);
    },

    dispose(): void {
      disposed = true;
    },
  };
}
