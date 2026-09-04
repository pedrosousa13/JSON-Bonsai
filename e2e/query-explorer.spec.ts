// Query explorer: autocomplete dropdown in the JMESPath panel, and the
// "Query from here" affordance on the path chip.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension, serveJson, type FixtureServer } from "./helpers";

// Deliberately awkward source: tabs, ragged inner spacing, and keys out of
// alphabetical order. A re-serialization would flatten every bit of it, so
// the raw-view assertion below can tell source text from a rebuilt string.
const payload = `{
\t"users": [
\t\t{ "name": "Ada",   "role": "admin" },
\t\t{ "name": "Grace", "role": "user" }
\t],
\t"settings": { "theme": "dark",  "accent": "teal" }
}`;

let context: BrowserContext;
let page: Page;
let server: FixtureServer;

test.beforeAll(async () => {
  server = await serveJson(payload);
  context = await launchWithExtension();
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`http://127.0.0.1:${server.port}/data.json`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#jv-root .jv-line", { timeout: 20000 });
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  await context.close();
  server.close();
});

test.describe.configure({ mode: "serial" });

test("autocomplete shows matching keys and accepting inserts the token", async () => {
  await page.click("#jv-query-toggle");
  await expect(page.locator("#jv-query-panel")).toBeVisible();

  await page.fill("#jv-query-input", "se");
  await expect(page.locator("#jv-query-suggest")).toBeVisible();
  const items = page.locator(".jv-query-suggest-item");
  await expect(items.filter({ hasText: "settings" })).toHaveCount(1);

  // Accept with Enter while the dropdown is open.
  await page.click(".jv-query-suggest-item", { force: true });
  await expect(page.locator("#jv-query-input")).toHaveValue("settings");
  await expect(page.locator("#jv-query-suggest")).toBeHidden();

  // Close the panel for the next test.
  await page.click("#jv-query-close");
});

test("a dot after an array projection suggests the element keys, in view", async () => {
  await page.click("#jv-query-toggle");
  await expect(page.locator("#jv-query-panel")).toBeVisible();

  // Contextual: only the array element's keys, not every key in the document.
  await page.fill("#jv-query-input", "users[*].");
  await expect(page.locator("#jv-query-suggest")).toBeVisible();
  await expect(page.locator(".jv-query-suggest-name")).toHaveText([
    "name",
    "role",
  ]);

  // The dropdown sits inside the viewport — guards the panel-layout regression
  // (toBeVisible alone can't catch an off-screen element).
  const box = await page.locator("#jv-query-suggest").boundingBox();
  expect(box).not.toBeNull();
  const vh = page.viewportSize()!.height;
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh);

  // The array-valued key carries a badge at top level.
  await page.fill("#jv-query-input", "us");
  await expect(
    page
      .locator(".jv-query-suggest-item")
      .filter({ hasText: "users" })
      .locator(".jv-query-suggest-badge")
  ).toHaveCount(1);

  // Accepting the array key inserts a [*] projection; a dot then descends.
  await page.click(".jv-query-suggest-item", { force: true });
  await expect(page.locator("#jv-query-input")).toHaveValue("users[*]");
  await page.locator("#jv-query-input").press(".");
  await expect(page.locator(".jv-query-suggest-name")).toHaveText([
    "name",
    "role",
  ]);

  await page.click("#jv-query-close");
});

test("query-from-here seeds the input and runs the query", async () => {
  // Pin a node's path by clicking its line, then trigger Query from here.
  const userLine = page
    .locator('#jv-tree .jv-line')
    .filter({ hasText: "users" })
    .first();
  await userLine.click();
  await expect(page.locator("#jv-path-display")).toHaveClass(/jv-visible/);

  await page.click("#jv-path-query");
  await expect(page.locator("#jv-query-panel")).toBeVisible();
  await expect(page.locator("#jv-query-input")).toHaveValue("users");
  // The query ran: the chip reflects the active query.
  await expect(page.locator("#jv-query-chip")).toBeVisible();
  await expect(page.locator("#jv-query-chip-text")).toContainText("users");
});

test("recent queries surface in the dropdown and re-run on pick", async () => {
  await page.click("#jv-settings-toggle");
  const remember = page.locator("#jv-remember-query");
  await expect(remember).toBeChecked();
  await page.click("#jv-settings-toggle");

  // Earlier tests may leave the panel open; only toggle it when hidden.
  if (await page.locator("#jv-query-panel").isHidden()) {
    await page.click("#jv-query-toggle");
  }
  await expect(page.locator("#jv-query-panel")).toBeVisible();
  await page.fill("#jv-query-input", "settings.theme");
  await page.locator("#jv-query-input").press("Escape"); // close key suggestions
  await page.click("#jv-query-run");
  await expect(page.locator("#jv-query-chip-text")).toContainText("settings.theme");

  // Clearing the field and focusing it surfaces the history section.
  await page.fill("#jv-query-input", "");
  await page.locator("#jv-query-input").focus();
  await expect(page.locator(".jv-query-suggest-section")).toHaveText("Recent queries");
  const recent = page
    .locator(".jv-query-suggest-recent")
    .filter({ hasText: "settings.theme" });
  await expect(recent).toHaveCount(1);

  // Picking it refills the input and re-runs the query.
  await recent.click({ force: true });
  await expect(page.locator("#jv-query-input")).toHaveValue("settings.theme");
  await expect(page.locator("#jv-query-chip-text")).toContainText("settings.theme");

  await page.click("#jv-query-close");
});

test("an active query drives the raw view, its copy, and clears back", async () => {
  // Run a fresh query from the tree, where the query control is enabled.
  await page.click('.jv-view-btn[data-view="tree"]');
  if (await page.locator("#jv-query-panel").isHidden()) {
    await page.click("#jv-query-toggle");
  }
  await page.fill("#jv-query-input", "users[0].name");
  await page.locator("#jv-query-input").press("Escape"); // close key suggestions
  await page.click("#jv-query-run");
  await expect(page.locator("#jv-query-chip-text")).toHaveText("users[0].name");
  await page.click("#jv-query-close");

  // Raw shows a serialization of the result, says so, and copies it.
  await page.click('.jv-view-btn[data-view="raw"]');
  await expect(page.locator("#jv-raw")).toHaveText('"Ada"');
  await expect(page.locator("#jv-raw-note")).toBeVisible();
  await page.click("#jv-copy");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('"Ada"');

  // Formatted agrees, and the chip reads the same outside the tree.
  await page.click('.jv-view-btn[data-view="formatted"]');
  await expect(page.locator("#jv-formatted")).toHaveText('"Ada"');
  await expect(page.locator("#jv-query-chip-text")).toHaveText("users[0].name");

  // Clearing the chip puts the document's own source text back in raw.
  await page.click("#jv-query-chip-clear");
  await page.click('.jv-view-btn[data-view="raw"]');
  // Byte for byte, not toHaveText's whitespace-normalized compare: the
  // fixture's tabs and ragged spacing are exactly what a re-serializing raw
  // view would lose, and normalization would hide the difference.
  await expect
    .poll(() => page.locator("#jv-raw").textContent())
    .toBe(payload);
  await expect(page.locator("#jv-raw-note")).toBeHidden();
});

test("editing and rerunning a query from Raw stays in Raw", async () => {
  // Query-free in Raw, panel closed, from the previous test's teardown.
  await page.click('.jv-view-btn[data-view="raw"]');
  await expect(page.locator('.jv-view-btn[data-view="raw"]')).toHaveClass(/jv-active/);

  // The ƒ button is enabled here and opens the panel (no active query).
  await expect(page.locator("#jv-query-toggle")).toBeEnabled();
  await page.click("#jv-query-toggle");
  await expect(page.locator("#jv-query-panel")).toBeVisible();

  // Running a query from Raw re-renders Raw from the result and stays there.
  await page.fill("#jv-query-input", "users[0].name");
  await page.locator("#jv-query-input").press("Escape"); // close key suggestions
  await page.click("#jv-query-run");
  await expect(page.locator('.jv-view-btn[data-view="raw"]')).toHaveClass(/jv-active/);
  await expect(page.locator("#jv-raw")).toHaveText('"Ada"');
  await expect(page.locator("#jv-query-chip")).toBeVisible();

  // Clicking the chip reopens the panel, seeded, without leaving Raw.
  await page.click("#jv-query-close");
  await page.click("#jv-query-chip-text");
  await expect(page.locator("#jv-query-panel")).toBeVisible();
  await expect(page.locator("#jv-query-input")).toHaveValue("users[0].name");
  await expect(page.locator('.jv-view-btn[data-view="raw"]')).toHaveClass(/jv-active/);

  // Editing and re-running updates Raw to the new result, still in Raw.
  await page.fill("#jv-query-input", "users[1].name");
  await page.locator("#jv-query-input").press("Escape");
  await page.click("#jv-query-run");
  await expect(page.locator('.jv-view-btn[data-view="raw"]')).toHaveClass(/jv-active/);
  await expect(page.locator("#jv-raw")).toHaveText('"Grace"');
  await expect(page.locator("#jv-query-chip-text")).toHaveText("users[1].name");
  await page.click("#jv-query-close");

  // Clearing via the chip's ✕ restores the source text, still in Raw.
  await page.click("#jv-query-chip-clear");
  await expect(page.locator('.jv-view-btn[data-view="raw"]')).toHaveClass(/jv-active/);
  await expect
    .poll(() => page.locator("#jv-raw").textContent())
    .toBe(payload);
  await expect(page.locator("#jv-query-chip")).toBeHidden();
});
