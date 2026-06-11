import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Each spec launches its own persistent context with the extension loaded;
  // serial keeps CI memory predictable.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
});
