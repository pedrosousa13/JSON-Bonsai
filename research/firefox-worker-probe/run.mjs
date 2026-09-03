#!/usr/bin/env node
// Runs the whole Firefox worker-hosting probe, non-interactively.
//
//   node research/firefox-worker-probe/run.mjs
//
// One Firefox launch per measurement (SpiderMonkey tiers regexps up after
// repeated execution in one process, so numbers taken from a loop inside a
// single process are meaningless here). Each launch is killed before the next
// one starts, and any stray Firefox process this script started is swept.

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startProbeServer, VARIANTS } from "./server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(HERE, "ext");
const OUT_DIR = join(HERE, "results");

const FIREFOX =
  process.env.PROBE_FIREFOX ||
  "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox";
// Prefix-match so the web-ext node process (whose argv contains the binary path)
// is never counted as a Firefox process.
const BINARY_PREFIX = FIREFOX.slice(0, FIREFOX.lastIndexOf("/") + 1);
const PORT = Number(process.env.PROBE_PORT || 8731);

const STRICTNESS = ["nonesrc", "self", "json", "none"]; // most to least restrictive

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function firefoxVersion() {
  return execFileSync(FIREFOX, ["--version"]).toString().trim();
}

function livePids(exclude) {
  const out = execFileSync("/bin/ps", ["-Ao", "pid=,command="], {
    maxBuffer: 32 * 1024 * 1024,
  }).toString();
  const pids = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    if (exclude && exclude.has(pid)) continue;
    if (m[2].startsWith(BINARY_PREFIX)) pids.push(pid);
  }
  return pids;
}

function sweep(preExisting) {
  for (const pid of livePids(preExisting)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const version = firefoxVersion();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsFile = join(OUT_DIR, `results-${stamp}.jsonl`);
  writeFileSync(resultsFile, "");

  writeFileSync(
    join(EXT_DIR, "config.js"),
    "// Rewritten by run.mjs on every run so the background script knows which port\n" +
      "// the local probe server is listening on. The committed value is only a default.\n" +
      `globalThis.PROBE_CONFIG = { port: ${PORT} };\n`,
  );

  const preExisting = new Set(livePids(null));
  if (preExisting.size) {
    console.log(`note: ${preExisting.size} Firefox process(es) already running; they are excluded from CPU sampling`);
  }

  let collector = null;
  const handle = await startProbeServer({
    port: PORT,
    resultsFile,
    binaryPrefix: BINARY_PREFIX,
    excludePids: preExisting,
    onReport: (rec) => collector && collector(rec),
    onPhase: (p) => console.log("  [phase]", JSON.stringify(p)),
  });

  console.log(`probe server on http://127.0.0.1:${handle.port}`);
  console.log(`firefox: ${version}`);
  console.log(`results: ${resultsFile}\n`);

  const all = [];

  async function launch({
    name,
    variant,
    mode,
    timeoutMs,
    extraPrefs = [],
    omitGrantPref = false,
    pattern = null,
    input = null,
  }) {
    console.log(`--- launch ${name}: /v/${variant}?mode=${mode} (${VARIANTS[variant].label})`);
    let url = `http://127.0.0.1:${handle.port}/v/${variant}?mode=${mode}`;
    if (pattern) url += `&pattern=${encodeURIComponent(pattern)}`;
    if (input) url += `&input=${encodeURIComponent(input)}`;
    const records = [];
    const done = deferred();
    collector = (rec) => {
      records.push({ launch: name, ...rec });
      if (rec.experiment === "done") done.resolve("done");
    };

    const log = createWriteStream(join(OUT_DIR, `${name}.log`));
    const child = spawn(
      "npx",
      [
        "--yes",
        "web-ext",
        "run",
        "--source-dir",
        EXT_DIR,
        "--firefox",
        FIREFOX,
        "--start-url",
        url,
        "--no-reload",
        "--no-input",
        "--no-config-discovery",
        // Keep the probe tab in the foreground: an about:welcome tab would push
        // it to the background, where Firefox clamps timers to 1s and the
        // main-thread ping measurement would be worthless.
        "--pref",
        "browser.aboutwelcome.enabled=false",
        "--pref",
        "browser.startup.homepage_override.mstone=ignore",
        "--pref",
        "datareporting.policy.dataSubmissionEnabled=false",
        "--pref",
        "browser.shell.checkDefaultBrowser=false",
        // Firefox MV3 does not grant host permissions at install time. One
        // launch deliberately omits this so the results are not silently
        // resting on a non-default pref.
        ...(omitGrantPref ? [] : ["--pref", "extensions.originControls.grantByDefault=true"]),
        ...extraPrefs.flatMap((p) => ["--pref", p]),
      ],
      { cwd: HERE, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.pipe(log);
    child.stderr.pipe(log);

    let timer;
    const timeout = new Promise((r) => (timer = setTimeout(() => r("timeout"), timeoutMs)));
    const outcome = await Promise.race([done.promise, timeout]);
    clearTimeout(timer);

    collector = null;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    sweep(preExisting);
    log.end();
    await sleep(1500);

    console.log(`--- launch ${name}: ${outcome} (${records.length} records)\n`);
    all.push({ name, variant, mode, outcome, records, extraPrefs });
    return { outcome, records };
  }

  // 0. Same probe, default origin-controls behaviour. Establishes whether the
  //    results below depend on extensions.originControls.grantByDefault.
  await launch({
    name: "survey-nonesrc-default-perms",
    variant: "nonesrc",
    mode: "survey",
    timeoutMs: 60_000,
    omitGrantPref: true,
  });

  // 1. Survey every CSP variant, one fresh launch each.
  for (const variant of ["none", "self", "nonesrc"]) {
    await launch({ name: `survey-${variant}`, variant, mode: "survey", timeoutMs: 90_000 });
  }

  // The application/json variant gets two launches. Firefox's built-in JSON
  // viewer is on by default and the project's README already tells Firefox users
  // to turn it off (devtools.jsonview.enabled=false), so the supported
  // configuration is the second one. The first records what happens without it.
  await launch({ name: "survey-json-viewer-on", variant: "json", mode: "survey", timeoutMs: 60_000 });
  await launch({
    name: "survey-json",
    variant: "json",
    mode: "survey",
    timeoutMs: 90_000,
    extraPrefs: ["devtools.jsonview.enabled=false"],
  });

  // 2. Pick the strictest variant where the extension iframe hosted a working
  //    worker, and run the termination pair there.
  const worked = new Set();
  for (const run of all) {
    for (const rec of run.records) {
      if (rec.experiment === "B-extension-iframe" && rec.workerHandshake) worked.add(rec.variant);
    }
  }
  const target = STRICTNESS.find((v) => worked.has(v));

  if (!target) {
    console.log("no variant produced a working iframe-hosted worker; skipping the termination pair");
  } else {
    console.log(`termination pair will run on the strictest working variant: ${target}\n`);
    const targetPrefs = target === "json" ? ["devtools.jsonview.enabled=false"] : [];
    await launch({ name: "leak", variant: target, mode: "leak", timeoutMs: 90_000, extraPrefs: targetPrefs });
    await launch({ name: "terminate", variant: target, mode: "terminate", timeoutMs: 90_000, extraPrefs: targetPrefs });
    // What the pattern actually costs SpiderMonkey, fresh process, left to run.
    await launch({ name: "soak", variant: target, mode: "soak", timeoutMs: 150_000, extraPrefs: targetPrefs });

    // Two more catastrophic patterns from issue #51, each in its own fresh
    // process. SpiderMonkey aborts a deep backtrack with InternalError rather
    // than spinning forever, and whether that is universal or specific to one
    // pattern changes what Firefox actually needs.
    await launch({
      name: "soak-nested-a",
      variant: target,
      mode: "soak",
      timeoutMs: 150_000,
      extraPrefs: targetPrefs,
      pattern: "(a+)+$",
      input: "a:30,b:1",
    });
    // Unbounded spin: the clean CPU pair, with nothing that stops by itself.
    await launch({ name: "busy", variant: target, mode: "busy", timeoutMs: 90_000, extraPrefs: targetPrefs });

    await launch({
      name: "soak-prefix-w",
      variant: target,
      mode: "soak",
      timeoutMs: 150_000,
      extraPrefs: targetPrefs,
      pattern: "\\w{40}(\\w+)+!",
      input: "a:200",
    });
  }

  // 3. Baseline: the same pattern on the page's own main thread, fresh process.
  await launch({ name: "control", variant: "none", mode: "control", timeoutMs: 180_000 });

  await handle.close();

  const summary = {
    firefoxVersion: version,
    startedAt: stamp,
    resultsFile,
    cpuWindows: handle.cpuWindows,
    launches: all,
  };
  const summaryFile = join(OUT_DIR, `summary-${stamp}.json`);
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

  printTable(all, handle.cpuWindows);
  console.log(`\nsummary: ${summaryFile}`);
  sweep(preExisting);
}

function yn(v) {
  if (v === true) return "yes";
  if (v === false) return "no";
  return "-";
}

function printTable(all, cpuWindows) {
  console.log("\n================ RESULTS ================\n");
  const header = ["launch", "page CSP / type", "A blob", "B frame", "B worker", "B2 dyn frame"];
  const rows = [];
  for (const run of all) {
    if (run.mode !== "survey") continue;
    const blob = run.records.find((r) => r.experiment === "A-blob-worker");
    const frame = run.records.find((r) => r.experiment === "B-extension-iframe");
    const dyn = run.records.find((r) => r.experiment === "B2-dynamic-url-iframe");
    rows.push([
      run.name,
      VARIANTS[run.variant].label,
      blob ? yn(blob.handshake) : "no report",
      frame ? yn(frame.frameHello) : "no report",
      frame ? yn(frame.workerHandshake) : "no report",
      dyn ? yn(dyn.frameHello) : "no report",
    ]);
  }
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));

  console.log("\nTermination:");
  for (const run of all) {
    for (const rec of run.records) {
      if (
        rec.experiment === "C-terminate" ||
        rec.experiment === "C-leak" ||
        rec.experiment === "control-main-thread" ||
        rec.experiment === "soak-worker" ||
        rec.experiment === "D-busy-spin" ||
        rec.experiment === "fatal"
      ) {
        console.log("  " + JSON.stringify(rec));
      }
    }
  }
  console.log("\nCPU windows:");
  for (const w of cpuWindows) console.log("  " + JSON.stringify(w));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
