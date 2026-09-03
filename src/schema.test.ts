import { describe, expect, test } from "vitest";

import { inferSchema, toJsonSchema } from "./schema";

describe("inferSchema", () => {
  test("infers simple object schema", () => {
    expect(inferSchema({ name: "Ada", age: 36, active: true })).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        active: { type: "boolean" },
      },
      required: ["name", "age", "active"],
    });
  });

  test("infers homogeneous array schema", () => {
    expect(inferSchema([1, 2, 3])).toEqual({
      type: "array",
      items: { type: "number" },
    });
  });

  test("empty array produces empty items schema", () => {
    expect(inferSchema([])).toEqual({ type: "array", items: {} });
  });

  test("keeps null as an array item variant", () => {
    expect(inferSchema([1, null, 3])).toEqual({
      type: "array",
      items: { anyOf: [{ type: "number" }, { type: "null" }] },
    });
  });

  test("all-null array produces null items schema", () => {
    expect(inferSchema([null, null])).toEqual({
      type: "array",
      items: { type: "null" },
    });
  });

  test("merges object schemas across array items", () => {
    expect(inferSchema([{ a: 1, b: "x" }, { a: 2 }])).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "string" },
        },
        required: ["a"],
      },
    });
  });

  test("merges a large array of distinct-keyed objects without O(n^2) blowup", () => {
    // Each object contributes a unique key; the previous implementation copied
    // the accumulated property set on every merge, making this O(n^2). With the
    // in-place merge it stays linear and finishes well within the test timeout.
    const items = Array.from({ length: 20_000 }, (_, i) => ({ [`k${i}`]: i }));

    const schema = inferSchema(items) as {
      type: string;
      items: { type: string; properties: Record<string, object>; required: string[] };
    };

    expect(schema.type).toBe("array");
    expect(schema.items.type).toBe("object");
    expect(Object.keys(schema.items.properties)).toHaveLength(20_000);
    // No key is present in every object, so none is required.
    expect(schema.items.required).toEqual([]);
  });

  test("handles deeply nested objects without blowing the call stack", () => {
    let value: unknown = 1;
    for (let i = 0; i < 50_000; i++) {
      value = { a: value };
    }

    const schema = inferSchema(value) as {
      type: string;
      properties: { a: object };
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.a).toMatchObject({ type: "object" });
  });

  test("merges a second object shape already held in an anyOf", () => {
    expect(inferSchema([1, { a: 1 }, { b: 2 }])).toEqual({
      type: "array",
      items: {
        anyOf: [
          { type: "number" },
          {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: [],
          },
        ],
      },
    });
  });

  test("merges the items of two array shapes", () => {
    expect(inferSchema([[1], ["a"]])).toEqual({
      type: "array",
      items: {
        type: "array",
        items: { anyOf: [{ type: "number" }, { type: "string" }] },
      },
    });
  });

  test("keeps a key required when every object variant has it", () => {
    expect(inferSchema([{ a: 1 }, 1, { a: 2 }])).toEqual({
      type: "array",
      items: {
        anyOf: [
          { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
          { type: "number" },
        ],
      },
    });
  });

  test("merges nested object shapes inside two array shapes", () => {
    expect(inferSchema([[{ a: 1 }], [{ b: 2 }]])).toEqual({
      type: "array",
      items: {
        type: "array",
        items: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: [],
        },
      },
    });
  });

  test("merges three object shapes that follow a scalar", () => {
    expect(inferSchema(["x", { a: 1 }, { b: 2 }, { c: 3 }])).toEqual({
      type: "array",
      items: {
        anyOf: [
          { type: "string" },
          {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
              c: { type: "number" },
            },
            required: [],
          },
        ],
      },
    });
  });

  test("keeps one variant per scalar type when a type repeats", () => {
    expect(inferSchema([1, "a", 2])).toEqual({
      type: "array",
      items: { anyOf: [{ type: "number" }, { type: "string" }] },
    });
  });

  test("keeps a __proto__ key as an ordinary property", () => {
    const schema = inferSchema(JSON.parse('{"__proto__":{"a":1},"x":2}')) as {
      properties: Record<string, object>;
      required: string[];
    };

    // Read it as an own property: a plain `.__proto__` access would follow the
    // prototype setter instead of the key we care about.
    expect(Object.getOwnPropertyDescriptor(schema.properties, "__proto__")?.value).toEqual({
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    });
    expect(schema.required).toEqual(["__proto__", "x"]);
  });

  test("marks a __proto__ key optional when only one object variant has it", () => {
    const schema = inferSchema(JSON.parse('[{"__proto__":{"a":1}},{"x":2}]')) as {
      items: { properties: Record<string, object>; required: string[] };
    };

    expect(Object.getOwnPropertyDescriptor(schema.items.properties, "__proto__")?.value).toEqual({
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    });
    expect(schema.items.required).toEqual([]);
  });

  test("merges a __proto__ key carried by the second object shape", () => {
    const schema = inferSchema(JSON.parse('[{"x":2},{"__proto__":{"a":1}}]')) as {
      items: { properties: Record<string, object>; required: string[] };
    };

    expect(Object.getOwnPropertyDescriptor(schema.items.properties, "__proto__")?.value).toEqual({
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    });
    expect(schema.items.required).toEqual([]);
  });

  test("leaves Object.prototype untouched when a __proto__ key is inferred", () => {
    inferSchema(JSON.parse('{"__proto__":{"sentinel":1}}'));

    expect(Object.getOwnPropertyDescriptor(Object.prototype, "sentinel")).toBeUndefined();
    expect(({} as Record<string, unknown>).sentinel).toBeUndefined();
  });

  test("merging an empty array with a populated one keeps the untyped items variant", () => {
    // An empty array infers `items: {}` ("anything"), so merging it with a
    // typed array yields `anyOf: [{}, ...]`. Pinned as-is, not endorsed.
    expect(inferSchema([[], [1]])).toEqual({
      type: "array",
      items: {
        type: "array",
        items: { anyOf: [{}, { type: "number" }] },
      },
    });
  });
});

describe("toJsonSchema", () => {
  test("wraps inferred schema with draft-07 metadata", () => {
    expect(JSON.parse(toJsonSchema({ id: 1 }))).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "Generated schema for Root",
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    });
  });

  test("serializes a __proto__ key as an ordinary property name", () => {
    const json = toJsonSchema(JSON.parse('{"__proto__":{"a":1}}'));

    expect(json).toContain('"__proto__"');
    const parsed = JSON.parse(json) as {
      properties: Record<string, object>;
      required: string[];
    };
    expect(Object.getOwnPropertyDescriptor(parsed.properties, "__proto__")?.value).toEqual({
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    });
    expect(parsed.required).toEqual(["__proto__"]);
  });
});
