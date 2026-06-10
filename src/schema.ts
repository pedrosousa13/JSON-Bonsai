// Iterative (explicit stack) so deeply nested JSON can't blow the call stack.
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
      const properties: Record<string, object> = {};
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

function mergeObjectSchemas(a: any, b: any): object {
  const properties: Record<string, object> = { ...a.properties };
  const aReq = new Set<string>(a.required ?? []);
  const bReq = new Set<string>(b.required ?? []);

  for (const [k, v] of Object.entries(b.properties ?? {})) {
    properties[k] = k in properties
      ? mergeSchemas(properties[k] as object, v as object)
      : (v as object);
  }

  const required = [...aReq].filter(k => bReq.has(k));
  return { type: "object", properties, required };
}

function mergeSchemas(a: object, b: object): object {
  const ta = (a as any).type;
  const tb = (b as any).type;

  if (ta === "object" && tb === "object") return mergeObjectSchemas(a, b);

  // Flatten existing anyOf to avoid nesting
  const variantsA: object[] = (a as any).anyOf ?? [a];
  const variantsB: object[] = (b as any).anyOf ?? [b];

  const merged = [...variantsA];
  for (const v of variantsB) {
    const vt = (v as any).type;
    if (!merged.some(m => (m as any).type === vt)) merged.push(v);
  }

  return merged.length === 1 ? merged[0] : { anyOf: merged };
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
