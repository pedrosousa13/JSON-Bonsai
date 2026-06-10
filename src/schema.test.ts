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
});
