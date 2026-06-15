import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent/tool worktrees under .claude/ contain repo copies; without this
    // vitest picks up their test files too and runs everything twice.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", "e2e/**"],
  },
});
