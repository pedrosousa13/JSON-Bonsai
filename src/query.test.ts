import { describe, expect, test, vi } from "vitest";

import { createScopeResolver, runQuery } from "./query";

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

describe("createScopeResolver", () => {
  const data = { users: [{ name: "Ada" }], count: 2 };

  test("resolves a valid expression to its value", () => {
    const resolve = createScopeResolver(data);
    expect(resolve("users[0]")).toEqual({ name: "Ada" });
  });

  test("returns null for a syntax error", () => {
    const resolve = createScopeResolver(data);
    expect(resolve("[invalid")).toBeNull();
  });

  test("returns null for a runtime type error", () => {
    const resolve = createScopeResolver(data);
    expect(resolve("abs(users)")).toBeNull();
  });

  test("distinct expressions resolve independently (cache keyed by expr)", () => {
    const resolve = createScopeResolver(data);
    expect(resolve("count")).toBe(2);
    expect(resolve("users[0]")).toEqual({ name: "Ada" });
    expect(resolve("count")).toBe(2);
  });

  test("evaluates an erroring expression once (item 10)", async () => {
    vi.resetModules();
    const search = vi.fn(() => {
      throw new Error("Unexpected token");
    });
    vi.doMock("jmespath", () => ({ search }));
    const { createScopeResolver: mocked } = await import("./query");
    const resolve = mocked(data);
    expect(resolve("[invalid")).toBeNull();
    expect(resolve("[invalid")).toBeNull();
    expect(resolve("[invalid")).toBeNull();
    expect(search).toHaveBeenCalledTimes(1);
    vi.doUnmock("jmespath");
    vi.resetModules();
  });

  test("each resolver caches against its own document", () => {
    expect(createScopeResolver({ count: 1 })("count")).toBe(1);
    expect(createScopeResolver({ count: 2 })("count")).toBe(2);
  });
});
