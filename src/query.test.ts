import { describe, expect, test, vi } from "vitest";

import { runQuery } from "./query";

describe("runQuery", () => {
  test("evaluates a simple path expression", () => {
    const outcome = runQuery({ user: { name: "Ada" } }, "user.name");
    expect(outcome).toEqual({ ok: true, result: "Ada" });
  });

  test("evaluates a filter projection", () => {
    const data = {
      items: [
        { name: "cheap", price: 5 },
        { name: "mid", price: 15 },
        { name: "pricey", price: 30 },
      ],
    };
    const outcome = runQuery(data, "items[?price > `10`].name");
    expect(outcome).toEqual({ ok: true, result: ["mid", "pricey"] });
  });

  test("returns scalar results", () => {
    const outcome = runQuery({ items: [1, 2, 3] }, "length(items)");
    expect(outcome).toEqual({ ok: true, result: 3 });
  });

  test("maps a missing path to null", () => {
    const outcome = runQuery({ a: 1 }, "missing.path");
    expect(outcome).toEqual({ ok: true, result: null });
  });

  test("maps an undefined search result to null", async () => {
    vi.resetModules();
    vi.doMock("jmespath", () => ({ search: () => undefined }));
    const { runQuery: mockedRunQuery } = await import("./query");
    expect(mockedRunQuery({}, "anything")).toEqual({ ok: true, result: null });
    vi.doUnmock("jmespath");
    vi.resetModules();
  });

  test("returns ok:false with a message for syntax errors", () => {
    const outcome = runQuery({}, "[invalid");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.length).toBeGreaterThan(0);
    }
  });

  test("returns ok:false for runtime type errors", () => {
    const outcome = runQuery({ a: "not-a-number" }, "abs(a)");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("abs()");
    }
  });
});
