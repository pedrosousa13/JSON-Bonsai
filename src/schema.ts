// Iterative (explicit stack), for both walking and merging, so deeply nested
// JSON can't blow the call stack.
export function inferSchema(value: unknown): object {
  let rootSchema: object = {};

  type Task =
    | { kind: "visit"; value: unknown; assign: (schema: object) => void }
    | { kind: "finalize"; finalize: () => void };

  const stack: Task[] = [
    { kind: "visit", value, assign: (schema) => { rootSchema = schema; } },
  ];

  while (stack.length > 0) {
    const task = stack.pop()!;

    if (task.kind === "finalize") {
      task.finalize();
      continue;
    }

    const v = task.value;
    if (v === null) { task.assign({ type: "null" }); continue; }
    if (typeof v === "boolean") { task.assign({ type: "boolean" }); continue; }
    if (typeof v === "number") { task.assign({ type: "number" }); continue; }
    if (typeof v === "string") { task.assign({ type: "string" }); continue; }

    if (Array.isArray(v)) {
      if (v.length === 0) { task.assign({ type: "array", items: {} }); continue; }
      const itemSchemas: object[] = new Array(v.length);
      // Runs after every item below has been visited (stack discipline).
      stack.push({
        kind: "finalize",
        finalize: () => {
          task.assign({ type: "array", items: itemSchemas.reduce(mergeSchemas) });
        },
      });
      for (let i = v.length - 1; i >= 0; i--) {
        stack.push({ kind: "visit", value: v[i], assign: (schema) => { itemSchemas[i] = schema; } });
      }
      continue;
    }

    if (typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      // Null-prototype so a `__proto__` key lands as a plain property instead
      // of retargeting the map's prototype. It still serializes as an object.
      const properties: Record<string, object> = Object.create(null);
      const required = entries.map(([k]) => k);
      // Children fill `properties` in place, so we can assign immediately.
      task.assign({ type: "object", properties, required });
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, child] = entries[i];
        stack.push({ kind: "visit", value: child, assign: (schema) => { properties[k] = schema; } });
      }
      continue;
    }

    task.assign({});
  }

  return rootSchema;
}

// A pending merge of `a` into `b`, to be applied by writing the result into
// whatever slot it came from (a property, an array's `items`, ...).
type MergeTask = { a: object; b: object; assign: (merged: object) => void };

// Merges `b` into `a` in place and returns `a`. Mutating `a` is safe because
// every caller replaces the slot it came from with the result: the reduce above
// overwrites the accumulator, and `mergeSchemas` rebuilds its `anyOf` wrapper on
// every merge, carrying the mutated variant forward. In-place merging avoids
// copying the accumulated properties on every merge — that copy made schema
// inference O(n^2) over arrays of objects with many distinct keys.
//
// Handles one level of properties; a property whose value needs merging is
// queued onto `stack` rather than merged recursively, so a chain of nested
// objects doesn't grow the call stack.
function mergeObjectSchemas(a: any, b: any, stack: MergeTask[]): object {
  const properties: Record<string, object> = a.properties ?? (a.properties = Object.create(null));
  const bReq = new Set<string>(b.required ?? []);

  for (const [k, v] of Object.entries(b.properties ?? {})) {
    if (Object.prototype.hasOwnProperty.call(properties, k)) {
      stack.push({ a: properties[k], b: v as object, assign: (merged) => { properties[k] = merged; } });
    } else {
      properties[k] = v as object;
    }
  }

  a.required = (a.required ?? []).filter((k: string) => bReq.has(k));
  return a;
}

// A work queue of (a, b, assign) tasks stands in for recursive descent here,
// matching `inferSchema`'s walker.
function mergeSchemas(aRoot: object, bRoot: object): object {
  let result: object = aRoot;
  const stack: MergeTask[] = [
    { a: aRoot, b: bRoot, assign: (merged) => { result = merged; } },
  ];

  while (stack.length > 0) {
    const { a, b, assign } = stack.pop()!;
    const ta = (a as any).type;
    const tb = (b as any).type;

    if (ta === "object" && tb === "object") {
      assign(mergeObjectSchemas(a, b, stack));
      continue;
    }

    // Flatten existing anyOf to avoid nesting
    const variantsA: object[] = (a as any).anyOf ?? [a];
    const variantsB: object[] = (b as any).anyOf ?? [b];

    const merged = [...variantsA];
    for (const v of variantsB) {
      const vt = (v as any).type;
      const existing: any = merged.find(m => (m as any).type === vt);
      if (!existing) { merged.push(v); continue; }
      // Same type: fold the newcomer into the variant already there, so a second
      // object or array shape widens it instead of being dropped. Scalars (and
      // the untyped `{}` fallback) carry nothing to merge, so they dedupe.
      if (vt === "object") {
        // `existing` is mutated in place by the object merge, so there's
        // nothing to write back.
        stack.push({ a: existing, b: v, assign: () => {} });
      } else if (vt === "array") {
        const bItems = (v as any).items;
        if (bItems !== undefined) {
          if (existing.items !== undefined) {
            stack.push({ a: existing.items, b: bItems, assign: (result) => { existing.items = result; } });
          } else {
            existing.items = bItems;
          }
        }
      }
    }

    assign(merged.length === 1 ? merged[0] : { anyOf: merged });
  }

  return result;
}

export function toJsonSchema(data: unknown): string {
  return JSON.stringify(
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "Generated schema for Root",
      ...inferSchema(data),
    },
    null,
    2
  );
}
