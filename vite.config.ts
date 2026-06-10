import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { resolve } from "path";

const entries = new Set(["content", "page-script", "tree-worker"]);

export default defineConfig(({ mode }) => {
  const entry = entries.has(mode) ? mode : "content";

  return {
    test: {
      // Agent/tool worktrees under .claude/ contain repo copies; without this
      // vitest picks up their test files too and runs everything twice.
      exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
    },
    build: {
      outDir: "dist",
      emptyOutDir: entry === "content",
      lib: {
        entry: resolve(__dirname, `src/${entry}.ts`),
        name: entry.replace(/-/g, "_"),
        formats: ["iife"],
        fileName: () => `${entry}.js`,
      },
      rollupOptions: {
        output: {
          assetFileNames: "content.[ext]",
        },
      },
    },
    plugins: [
      ...(entry === "content"
        ? [
            viteStaticCopy({
              targets: [
                { src: "manifest.json", dest: "." },
                { src: "icons/*", dest: "icons" },
                { src: "src/pointer-32.png", dest: "." },
              ],
            }),
          ]
        : []),
    ],
  };
});
