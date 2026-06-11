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
const parseWithSource = JSON.parse as (
  text: string,
  reviver?: SourceReviver
) => JsonValue;
const rawJSON = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;

let reviverSourceSupport: boolean | null = null;

function supportsReviverSource(): boolean {
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

  const exactNumbers: ExactNumberMap = new WeakMap();
  const data = parseWithSource(raw, function (key, value, context) {
    if (
      typeof value === "number" &&
      typeof context?.source === "string" &&
      numberLosesPrecision(context.source, value)
    ) {
      let perHolder = exactNumbers.get(this);
      if (!perHolder) {
        perHolder = new Map();
        exactNumbers.set(this, perHolder);
      }
      perHolder.set(key, context.source);
    }
    return value;
  });
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
