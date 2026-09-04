import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const watch = process.argv.includes("--watch");

// One IIFE bundle per entry. content.ts imports viewer.css, so esbuild emits
// dist/content.css alongside dist/content.js (manifest references both).
// worker-host is the script of the extension-origin iframe the content script
// injects; tree-worker is the search worker that frame spawns.
const entries = ["content", "page-script", "worker-host", "tree-worker"];

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

// Only the icons the manifest references — icons/ also holds README branding
// images that must not ship in store zips.
const icons = ["icon16.png", "icon48.png", "icon128.png"];

function copyStatic() {
  cpSync(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
  cpSync(resolve(root, "worker-host.html"), resolve(dist, "worker-host.html"));
  mkdirSync(resolve(dist, "icons"), { recursive: true });
  for (const icon of icons) {
    cpSync(resolve(root, "icons", icon), resolve(dist, "icons", icon));
  }
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
