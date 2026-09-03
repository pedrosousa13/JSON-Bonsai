import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("manifest exposes only extension assets needed by content scripts", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../manifest.json"), "utf8")
  ) as {
    web_accessible_resources?: Array<{ resources?: string[] }>;
  };

  const resources = manifest.web_accessible_resources?.flatMap(
    (entry) => entry.resources ?? []
  );

  expect(resources).toEqual(["page-script.js", "content.css"]);
});
