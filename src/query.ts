import { search } from "jmespath";
import type { JsonValue } from "./tree-model";

export type QueryOutcome =
  | { ok: true; result: JsonValue }
  | { ok: false; error: string };

export function runQuery(data: JsonValue, expression: string): QueryOutcome {
  try {
    const result = search(data, expression) as JsonValue | undefined;
    // jmespath returns undefined for some non-matches; normalize so the
    // tree always has a renderable JSON value.
    return { ok: true, result: result === undefined ? null : result };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

// A memoized evaluator for the left side of a pipe, used by the query bar's
// pipe-aware autocomplete. Returns the value `leftExpr` selects from `data`, or
// null on any error (invalid/incomplete mid-typing). Single-entry cache: the
// left side is stable while the user types the right side, so this collapses the
// per-keystroke cost to a single search.
export function createScopeResolver(
  data: JsonValue
): (leftExpr: string) => JsonValue | null {
  let cache: { expr: string; value: JsonValue } | null = null;
  return (leftExpr: string): JsonValue | null => {
    if (cache !== null && cache.expr === leftExpr) return cache.value;
    const outcome = runQuery(data, leftExpr);
    if (!outcome.ok) return null;
    cache = { expr: leftExpr, value: outcome.result };
    return outcome.result;
  };
}
