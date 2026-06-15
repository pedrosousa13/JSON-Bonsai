import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const watch = process.argv.includes("--watch");

// One IIFE bundle per entry. content.ts imports viewer.css, so esbuild emits
// dist/content.css alongside dist/content.js (manifest references both).
const entries = ["content", "page-script", "tree-worker"];

const options = (name) => ({
  entryPoints: [resolve(root, `src/${name}.ts`)],
  outfile: resolve(dist, `${name}.js`),
  bundle: true,
  format: "iife",
  target: ["chrome111", "firefox115"],
  minify: !watch,
  legalComments: "none",
  logLevel: "info",
});

function copyStatic() {
  cpSync(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
  cpSync(resolve(root, "icons"), resolve(dist, "icons"), { recursive: true });
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

if (watch) {
  for (const name of entries) {
    const ctx = await esbuild.context(options(name));
    await ctx.watch();
  }
  copyStatic();
  console.log("esbuild: watching for changes…");
} else {
  await Promise.all(entries.map((name) => esbuild.build(options(name))));
  copyStatic();
}
