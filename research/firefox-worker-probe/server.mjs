// Local test server for the Firefox worker-hosting probe (issue #84).
//
// Serves one JSON-ish page per CSP variant, mirroring the four cases that were
// already measured in Chrome so the comparison is like-for-like. Also collects
// the probe's self-reports (POST /report) and phase signals (POST /phase), and
// samples Firefox process CPU across a fixed window when the probe asks for it.
//
// Nothing here is shipped. This file is a research artifact.

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const VARIANTS = {
  // key -> { csp, contentType, label }
  none: {
    csp: null,
    contentType: "text/html; charset=utf-8",
    label: "no CSP",
  },
  self: {
    csp: "default-src 'self'",
    contentType: "text/html; charset=utf-8",
    label: "default-src 'self'",
  },
  nonebare: {
    csp: "default-src 'none'",
    contentType: "text/html; charset=utf-8",
    label: "default-src 'none'",
  },
  nonesrc: {
    csp: "default-src 'none'; frame-src 'none'",
    contentType: "text/html; charset=utf-8",
    label: "default-src 'none'; frame-src 'none'",
  },
  workersrc: {
    csp: "worker-src 'none'",
    contentType: "text/html; charset=utf-8",
    label: "worker-src 'none'",
  },
  childsrc: {
    csp: "child-src 'none'",
    contentType: "text/html; charset=utf-8",
    label: "child-src 'none'",
  },
  scriptsrc: {
    csp: "script-src 'self'",
    contentType: "text/html; charset=utf-8",
    label: "script-src 'self'",
  },
  json: {
    csp: "default-src 'self'",
    contentType: "application/json",
    label: "application/json + default-src 'self'",
  },
};

const PAYLOAD = JSON.stringify(
  {
    note: "JSON Bonsai Firefox worker-hosting probe",
    issue: 84,
    values: ["alpha", "beta", "gamma"],
  },
  null,
  2,
);

function pageBody(variantKey) {
  const v = VARIANTS[variantKey];
  if (v.contentType.startsWith("application/json")) return PAYLOAD;
  return `<!doctype html><meta charset="utf-8"><title>probe ${variantKey}</title><pre>${PAYLOAD}</pre>`;
}

// ---------------------------------------------------------------------------
// Firefox process CPU sampling
// ---------------------------------------------------------------------------

// Parse macOS `ps -o time` output: [dd-]hh:mm:ss[.ff] or mm:ss.ff
function parseCpuTime(raw) {
  const text = String(raw).trim();
  let days = 0;
  let rest = text;
  const dash = text.indexOf("-");
  if (dash !== -1) {
    days = Number(text.slice(0, dash));
    rest = text.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return days * 86400 + seconds;
}

// Sum cumulative CPU seconds over every process launched from the Firefox app's
// MacOS directory (the parent process and every plugin-container child), skipping
// the PIDs that already existed before we started. Matching on a prefix rather
// than a substring keeps the web-ext node process — whose argv contains the
// binary path — out of the total.
export function cpuSnapshot(binaryPrefix, excludePids = new Set()) {
  const out = execFileSync("/bin/ps", ["-Ao", "pid=,time=,command="], {
    maxBuffer: 32 * 1024 * 1024,
  }).toString();
  const byPid = new Map();
  let total = 0;
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (excludePids.has(pid) || pid === process.pid) continue;
    if (!m[3].startsWith(binaryPrefix)) continue;
    const secs = parseCpuTime(m[2]);
    byPid.set(pid, secs);
    total += secs;
  }
  return { at: Date.now(), total, byPid };
}

export function cpuDelta(before, after) {
  let maxProcess = 0;
  let maxPid = null;
  for (const [pid, secs] of after.byPid) {
    const prev = before.byPid.get(pid) ?? 0;
    const d = secs - prev;
    if (d > maxProcess) {
      maxProcess = d;
      maxPid = pid;
    }
  }
  return {
    wallMs: after.at - before.at,
    totalCpuSeconds: Number((after.total - before.total).toFixed(2)),
    maxProcessCpuSeconds: Number(maxProcess.toFixed(2)),
    maxProcessPid: maxPid,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startProbeServer({
  port,
  resultsFile,
  binaryPrefix,
  excludePids = new Set(),
  onReport = () => {},
  onPhase = () => {},
}) {
  const cpuWindows = [];
  let openWindow = null;

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/v/")) {
      const key = url.pathname.slice(3);
      const variant = VARIANTS[key];
      if (!variant) {
        res.writeHead(404).end("no such variant");
        return;
      }
      const headers = {
        "content-type": variant.contentType,
        "cache-control": "no-store",
      };
      if (variant.csp) headers["content-security-policy"] = variant.csp;
      res.writeHead(200, headers);
      res.end(pageBody(key));
      return;
    }

    if (req.method === "POST" && (url.pathname === "/report" || url.pathname === "/phase")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = { parseError: body.slice(0, 500) };
        }

        if (url.pathname === "/phase") {
          // CPU sampling has to happen the moment the phase signal lands, so it
          // is done here rather than by the runner polling on a timer.
          if (parsed.name === "cpu-start") {
            openWindow = {
              tag: parsed.tag ?? "window",
              before: cpuSnapshot(binaryPrefix, excludePids),
            };
          } else if (parsed.name === "cpu-end" && openWindow) {
            const after = cpuSnapshot(binaryPrefix, excludePids);
            const measured = { tag: openWindow.tag, ...cpuDelta(openWindow.before, after) };
            cpuWindows.push(measured);
            openWindow = null;
            if (resultsFile) {
              appendFileSync(resultsFile, JSON.stringify({ kind: "cpu", ...measured }) + "\n");
            }
            console.log(`  [cpu] ${measured.tag}: +${measured.totalCpuSeconds}s total ` +
              `(max single process +${measured.maxProcessCpuSeconds}s) over ${measured.wallMs}ms`);
          }
          onPhase(parsed);
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
          return;
        }

        if (resultsFile) {
          appendFileSync(resultsFile, JSON.stringify({ kind: "report", ...parsed }) + "\n");
        }
        console.log("  [report]", JSON.stringify(parsed));
        onReport(parsed);
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      return;
    }

    res.writeHead(404).end("not found");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        cpuWindows,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Standalone mode: `node server.mjs [port]` just serves the pages so the
// variants can be inspected by hand.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8731);
  const handle = await startProbeServer({
    port,
    resultsFile: null,
    binaryPrefix: "/Applications/Firefox Developer Edition.app/Contents/MacOS/",
  });
  console.log(`probe server on http://127.0.0.1:${handle.port}`);
  for (const key of Object.keys(VARIANTS)) {
    console.log(`  http://127.0.0.1:${handle.port}/v/${key}  — ${VARIANTS[key].label}`);
  }
}
