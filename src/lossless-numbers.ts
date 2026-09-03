import type { JsonValue } from "./tree-model";

// Maps a parsed container (object/array) to the exact source text of any
// number children that JSON.parse could not represent losslessly. Keyed by
// holder identity because the reviver hands us the holder, not the path.
export type ExactNumberMap = WeakMap<object, Map<string, string>>;

interface ReviverContext {
  source?: string;
}

// `JSON.parse` source access (Chrome 114+, Firefox 137+) and `JSON.rawJSON`
// aren't in the TS lib yet; type them locally instead of using `any`.
type SourceReviver = (
  this: object,
  key: string,
  value: unknown,
  context?: ReviverContext
) => unknown;
function parseWithSource(text: string, reviver?: SourceReviver): JsonValue {
  return (JSON.parse as (t: string, r?: SourceReviver) => JsonValue)(
    text,
    reviver
  );
}
const rawJSON = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;

let reviverSourceSupport: boolean | null = null;

export function supportsReviverSource(): boolean {
  if (reviverSourceSupport === null) {
    let seen: string | undefined;
    parseWithSource("0", (_key, value, context) => {
      seen = context?.source;
      return value;
    });
    reviverSourceSupport = seen === "0";
  }
  return reviverSourceSupport;
}

// Reduces a JSON number token to a canonical `<sign><digits>e<exp>` form so
// textually different spellings of the same value compare equal ("1e3" vs
// "1000", "1.0" vs "1"). The sign of zero is kept: JSON.stringify(-0) is "0",
// so "-0" genuinely doesn't round-trip.
function canonicalNumber(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return text;
  const sign = match[1];
  let digits = match[2] + (match[3] ?? "");
  let exp = (match[4] ? parseInt(match[4], 10) : 0) - (match[3]?.length ?? 0);

  let end = digits.length;
  while (end > 1 && digits[end - 1] === "0") {
    end -= 1;
    exp += 1;
  }
  digits = digits.slice(0, end);

  let start = 0;
  while (start < digits.length - 1 && digits[start] === "0") start += 1;
  digits = digits.slice(start);

  if (digits === "0") return `${sign}0`;
  return `${sign}${digits}e${exp}`;
}

// True when parsing `source` to a JS number and serializing it back would not
// reproduce the same numeric value (precision loss, overflow, or -0).
export function numberLosesPrecision(source: string, value: number): boolean {
  if (!Number.isFinite(value)) return true;
  return canonicalNumber(source) !== canonicalNumber(String(value));
}

// A double reproduces any decimal of 15 significant digits or fewer exactly
// (that is what DBL_DIG = 15 means), so a token can only lose something if it
// carries 16 significant digits or more, overflows to Infinity, underflows to
// zero, or is -0 — whose sign JSON.stringify drops. All four are visible in
// the raw text, which is far cheaper to look at than it is to parse the
// document twice:
//
//   [eE][+-]?\d{3,}    an exponent of 100 or more, the only way a mantissa
//                      short enough to pass the other rules can still leave
//                      the range of a double. 15 digits shifted 99 places is
//                      1e114, nowhere near the limits.
//   -0+(?:\.0*)?       negative zero. The lookahead keeps "-0.5" and "-0.05"
//                      out — only an all-zero mantissa is -0 — and the
//                      lookbehind keeps out the "-0" that ends a string, since
//                      a real number token only ever follows [ , : or space.
//                      Leading zeros are illegal in JSON, but the scan runs
//                      before anything has validated the text, so "-000.0"
//                      has to count too.
//   \.\d{8} and        16 digits or more straddling a decimal point. Split at
//   (?<=\d{8})\.       the dot: if both sides held 7 digits or fewer the token
//                      could not reach 16, so one side must reach 8. Anchoring
//                      both halves on the dot matters — dots are rare, and a
//                      rule the engine can only try at every digit costs
//                      several times more.
//   (?<!\d)\d{16}      16 digits or more with no decimal point at all. The
//                      lookbehind starts the attempt at the front of a digit
//                      run instead of inside it.
//
// Both halves of the straddle rule are wider than the exact condition (they
// flag "1234567890.12345678", which is fine), and the scan is deliberately
// blind to string literals, so a 20-digit order id inside a string trips it
// and the document takes the slow path for nothing. Tokenizing strings to
// avoid that would cost more than it saves. Being wrong that way is the only
// direction allowed: a false positive costs parse time, while a false negative
// would parse a lossy token plainly and corrupt it in silence.
//
// Kept as separate patterns rather than one alternation on purpose. V8 runs
// each of these several times faster than the single regex that ORs them
// together, because an alternation gives up the "skip ahead to the next
// character that could start a match" optimization.
const LOSSY_NUMBER_SHAPES = [
  /[eE][+-]?\d{3,}/,
  /(?<![^\s,:[])-0+(?:\.0*)?(?![.\d])/,
  /\.\d{8}|(?<=\d{8})\./,
  /(?<!\d)\d{16}/,
];

// True when `raw` might contain a number token that JSON.parse cannot
// represent exactly — see LOSSY_NUMBER_SHAPES for what "might" covers. The
// patterns run cheapest first so a document that does hold one stops early.
export function mayContainLossyNumbers(raw: string): boolean {
  return LOSSY_NUMBER_SHAPES.some((shape) => shape.test(raw));
}

// Where a lossy *root-level* number should be recorded. The holder the reviver
// hands us for the root is JSON.parse's throwaway `{"": value}` wrapper, which
// the caller can never look up again, so a caller that splices roots into a
// container of its own (NDJSON lines into a synthetic array) names that slot
// instead.
export interface RootSlot {
  holder: object;
  key: string;
}

// Parses `raw` (assuming reviver source support), recording lossy number
// tokens into `into`. Keyed by holder identity, so writing several independent
// parses into one shared map never collides — distinct parses produce distinct
// holders.
export function parseIntoExactNumbers(
  raw: string,
  into: ExactNumberMap,
  rootSlot?: RootSlot
): JsonValue {
  function record(holder: object, key: string, source: string): void {
    let perHolder = into.get(holder);
    if (!perHolder) {
      perHolder = new Map();
      into.set(holder, perHolder);
    }
    perHolder.set(key, source);
  }

  // The reviver walks bottom-up, so its last call is always the root wrapper's
  // — which makes the token it carries the root's. Tracking the last call is
  // how we tell the root apart from a member literally named "" (`{"": 1}`
  // reaches the reviver with key "" too, but not last).
  let rootSource: string | undefined;
  const data = parseWithSource(raw, function (key, value, context) {
    rootSource =
      typeof context?.source === "string" ? context.source : undefined;
    if (
      typeof value === "number" &&
      typeof context?.source === "string" &&
      numberLosesPrecision(context.source, value)
    ) {
      record(this, key, context.source);
    }
    return value;
  });

  if (
    rootSlot &&
    typeof data === "number" &&
    rootSource !== undefined &&
    numberLosesPrecision(rootSource, data)
  ) {
    record(rootSlot.holder, rootSlot.key, rootSource);
  }
  return data;
}

// JSON.parse that also reports which number tokens lost precision, keyed by
// their holder so callers can resolve them while walking the parsed data. On
// engines without reviver source access this degrades to a plain parse
// (exactNumbers: null). Throws on invalid JSON, exactly like JSON.parse.
export function parseWithExactNumbers(raw: string): {
  data: JsonValue;
  exactNumbers: ExactNumberMap | null;
} {
  if (!supportsReviverSource()) {
    return { data: JSON.parse(raw) as JsonValue, exactNumbers: null };
  }

  // Handing JSON.parse a reviver switches the engine off its fast parser —
  // measured at ~7x on a 16 MB document. When the text holds nothing that can
  // lose precision there is nothing for the reviver to record, so pay the
  // scan (one linear pass) instead. The map comes back empty rather than null,
  // because null means "this engine cannot do exact numbers at all" and
  // callers branch on it.
  if (!mayContainLossyNumbers(raw)) {
    return { data: JSON.parse(raw) as JsonValue, exactNumbers: new WeakMap() };
  }

  const exactNumbers: ExactNumberMap = new WeakMap();
  const data = parseIntoExactNumbers(raw, exactNumbers);
  return { data, exactNumbers };
}

// JSON.stringify that re-emits preserved number tokens verbatim via
// JSON.rawJSON. Falls back to plain stringify when there is nothing to
// preserve or the engine lacks rawJSON.
export function stringifyWithExactNumbers(
  data: JsonValue,
  exactNumbers: ExactNumberMap | null,
  space?: number
): string {
  if (exactNumbers === null || typeof rawJSON !== "function") {
    return JSON.stringify(data, null, space);
  }
  return JSON.stringify(
    data,
    function (key, value) {
      const source = exactNumbers.get(this as object)?.get(key);
      return source === undefined ? value : rawJSON(source);
    },
    space
  );
}
