import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("manifest exposes only extension assets needed by content scripts", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../manifest.json"), "utf8")
  ) as {
    web_accessible_resources?: Array<{
      resources?: string[];
      matches?: string[];
      use_dynamic_url?: boolean;
    }>;
  };

  // One manifest ships to both stores, so `use_dynamic_url` can't be
  // Chrome-only. On Chrome it rotates the resource URL per session, which stops
  // any site probing chrome-extension://<fixed-id>/page-script.js to fingerprint
  // the extension. On Firefox it costs nothing: verified on 156.0b2 that
  // web-ext lint accepts it and it is inert at runtime — getURL() returns the
  // ordinary static URL and the resource loads — because Firefox already
  // randomises the extension UUID per install. Don't "fix" this back.
  // See docs/research/2026-09-03-firefox-worker-hosting.md.
  // worker-host.html is the iframe the content script injects to host the
  // search worker, so the page has to be able to load it. Its own subresources
  // — worker-host.js and tree-worker.js — are deliberately absent: they are
  // same-origin loads made from inside an extension document, which these
  // entries do not gate. Verified on Firefox 156.0b2 in the research above.
  expect(manifest.web_accessible_resources).toEqual([
    {
      resources: ["page-script.js", "content.css", "worker-host.html"],
      matches: ["<all_urls>"],
      use_dynamic_url: true,
    },
  ]);
});
