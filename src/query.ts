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
