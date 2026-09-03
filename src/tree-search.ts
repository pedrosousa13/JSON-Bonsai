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

// Rejection reason for a search that ran out of its time budget, either because
// the scan outlived it or because the pattern itself was too expensive to run.
// Callers surface it as a "Search timed out" state; the index stays usable, so
// the next search runs normally.
export class SearchTimeoutError extends Error {
  constructor(message = "Search timed out") {
    super(message);
    this.name = "SearchTimeoutError";
  }
}

// Nodes scanned per event-loop task. Search runs on the main thread, so the
// scan is chunked to keep any single task short enough to leave frames free.
const SEARCH_SCAN_BATCH_SIZE = 500;

// Time one search may spend scanning. A scan that outlives it rejects with
// SearchTimeoutError instead of holding the main thread indefinitely. It sits
// under the point where a frozen tab feels broken and still leaves two orders
// of magnitude of headroom: a 100k-node document scans in about 10 ms.
const SEARCH_TIME_BUDGET_MS = 1000;

// Characters of a long raw string value that a regex is tested against.
// Values are truncated rather than chunked into windows: a window boundary
// would let `^` and `$` match mid-value and would miss any match straddling two
// windows, so a cap is the honest bound. 4096 keeps one test cheap even for a
// pattern with quadratic backtracking (~16M steps, tens of milliseconds) while
// covering string values far longer than anything a person reads in a row.
const REGEX_VALUE_TEST_LIMIT = 4096;

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

// Compiles a regex query with the case-insensitive flag, returning null when
// the pattern is invalid so callers can degrade gracefully instead of throwing.
// Text reaches the pattern lowercased. Keys and paths are whole, but values are
// bounded: the index stores them truncated to 200 chars (see
// SEARCH_VALUE_PREVIEW_LIMIT in tree-model.ts) and the longer originals are read
// only up to REGEX_VALUE_TEST_LIMIT (see valueMatchesRegex).
export function compileSearchRegex(query: string): RegExp | null {
  try {
    return new RegExp(query, "i");
  } catch {
    return null;
  }
}

// Longest probe string handed to the cost probe below. A backtracking engine's
// worst case grows exponentially with input length, so probe length is the only
// thing bounding the probe itself. Measured on V8, `(a+)+$` costs ~60 ms at 21
// characters and ~16 s at 29, and the budget check between probes stops the
// climb long before the longest one, so 32 is affordable and long enough to
// expose patterns that only blow up on slightly longer input.
const REGEX_PROBE_MAX_CHARS = 32;

// Total time the probes may spend. Ordinary patterns finish every probe in well
// under a millisecond, so the threshold sits two orders of magnitude away from
// normal and is not sensitive to machine speed or CI load.
const REGEX_PROBE_BUDGET_MS = 40;

// Distinct repeated characters probed. Capped so a long pattern cannot turn the
// probe into a scan of its own.
const REGEX_PROBE_UNIT_LIMIT = 11;

// Appended to every probe so a pattern anchored with `$` cannot match at the
// end of the probe and short-circuit the backtracking being measured. NUL is
// outside `\w`, `\s`, `\d` and every plausible hand-written character class.
const REGEX_PROBE_SENTINEL = "\u0000";

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

// Answers whether a pattern backtracks catastrophically, by timing it against
// short synthetic inputs before it is ever let loose on the document.
//
// This is the only guard that can stop a pattern like `(a+)+$` in time: a
// single regex.test call cannot be interrupted once it starts, and its cost is
// driven by the length of a repeated run rather than by the length of the
// input, so no cap on the tested text bounds it (29 characters already cost
// ~16 s). Probing on bounded input, and re-checking the budget after every
// probe, keeps the whole check to a few tens of milliseconds.
//
// It errs by measurement, not by syntax: a nested quantifier that stays cheap
// is allowed through. It can still miss a pattern that only explodes on input
// no probe generates (`(x+y+)+z` needs interleaved runs), which is what
// SEARCH_TIME_BUDGET_MS is the backstop for.
function regexExceedsCostBudget(regex: RegExp): boolean {
  const deadline = Date.now() + REGEX_PROBE_BUDGET_MS;

  for (const unit of regexProbeUnits(regex.source)) {
    for (let length = 1; length <= REGEX_PROBE_MAX_CHARS; length += 1) {
      regex.test(unit.repeat(length) + REGEX_PROBE_SENTINEL);
      if (Date.now() > deadline) return true;
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

  // Only the head of the original value: see REGEX_VALUE_TEST_LIMIT. Substring
  // matching (valueMatches) still reads it whole, because includes() is linear.
  const raw = node.rawStringValue;
  return regex.test(
    raw.length > REGEX_VALUE_TEST_LIMIT ? raw.slice(0, REGEX_VALUE_TEST_LIMIT) : raw
  );
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
function matchScoreRegex(node: TreeSearchNode, regex: RegExp): number | null {
  if (node.searchKey && regex.test(node.searchKey)) return 0;
  if (regex.test(node.searchPath)) return 0;
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
    if (Date.now() > deadline) throw new SearchTimeoutError();

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
      // refused up front and reported as a timeout. The probe carries its own
      // budget, so it runs before the scan's clock starts.
      if (prepared.regex !== null && regexExceedsCostBudget(prepared.regex)) {
        throw new SearchTimeoutError();
      }

      const matches: TreeSearchMatch[] = [];
      const total = searchNodes.length;
      // Scanning time only. The waits between batches are the point of the
      // chunking, so charging them to the budget would make a big document
      // time out for being polite rather than for being slow.
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
