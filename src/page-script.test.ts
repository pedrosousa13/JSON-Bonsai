// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { exposeWindowData } from "./page-script";

afterEach(() => {
  delete (window as any).data;
  document.getElementById("jv-json-data")?.remove();
  vi.restoreAllMocks();
});

function addHolder(text: string): void {
  const el = document.createElement("script");
  el.type = "application/json";
  el.id = "jv-json-data";
  el.textContent = text;
  document.documentElement.appendChild(el);
}

test("sets window.data from the holder and removes the holder", () => {
  addHolder(JSON.stringify({ a: 1, b: [2, 3] }));

  exposeWindowData();

  expect((window as any).data).toEqual({ a: 1, b: [2, 3] });
  expect(document.getElementById("jv-json-data")).toBeNull();
});

test("does nothing when there is no holder", () => {
  expect(() => exposeWindowData()).not.toThrow();
  expect((window as any).data).toBeUndefined();
});

test("malformed JSON leaves window.data unset but still removes the holder", () => {
  addHolder("{ not valid json");

  exposeWindowData();

  expect((window as any).data).toBeUndefined();
  expect(document.getElementById("jv-json-data")).toBeNull();
});

test("logs the JSON Bonsai brand, not the old fork name", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  addHolder(JSON.stringify({ ok: true }));

  exposeWindowData();

  expect(log).toHaveBeenCalled();
  const logged = log.mock.calls[0].join(" ");
  expect(logged).toContain("[JSON Bonsai]");
  expect(logged).not.toContain("Alexander");
});
