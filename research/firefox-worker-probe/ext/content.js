// Content script: runs every experiment on whichever CSP variant it landed on
// and reports the result over HTTP through the background page.
//
// Modes (taken from the ?mode= query on the page URL, one per browser launch):
//   survey    — experiment A (blob worker) and B (extension iframe + worker)
//   terminate — A, B, then C with terminate() called mid-freeze
//   leak      — A, B, then C with the worker deliberately left spinning
//   control   — main-thread regex freeze, for the "no worker at all" baseline
//   soak      — let the frame's worker run the pattern to completion, or to a
//               two-minute deadline, while the page keeps being pinged
//   busy      — an unbounded spin in the frame's worker: CPU sampled while it
//               runs and again after terminate(), in one launch

const PARAMS = new URLSearchParams(location.search);
const VARIANT = location.pathname.replace(/^\/v\//, "");
const MODE = PARAMS.get("mode") || "survey";

// The proven freeze case from issue #51, overridable per launch so a second
// pattern can be measured without touching the extension.
const FREEZE_PATTERN = PARAMS.get("pattern") || "(z+)+.{0,24}$";
const FREEZE_INPUT_SPEC = PARAMS.get("input") || "z:30,y:170";

// "z:30,y:170" -> 30 z's followed by 170 y's
const FREEZE_INPUT = FREEZE_INPUT_SPEC.split(",")
  .map((part) => {
    const [ch, n] = part.split(":");
    return ch.repeat(Number(n));
  })
  .join("");

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

const violations = [];
for (const target of [document, window]) {
  target.addEventListener("securitypolicyviolation", (e) => {
    violations.push({
      blockedURI: e.blockedURI,
      violatedDirective: e.violatedDirective,
      originalPolicy: e.originalPolicy,
    });
  });
}

function report(rec) {
  return browser.runtime.sendMessage({
    kind: "report",
    rec: { variant: VARIANT, mode: MODE, ...rec },
  });
}

function phase(name, extra) {
  return browser.runtime.sendMessage({ kind: "phase", name, extra: { variant: VARIANT, mode: MODE, ...extra } });
}

function describe(err) {
  if (!err) return null;
  return {
    name: err.name ?? null,
    message: err.message ?? String(err),
    constructor: err.constructor ? err.constructor.name : null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

async function withTimeout(promise, ms, timeoutValue) {
  let timer;
  const timeout = new Promise((r) => (timer = setTimeout(() => r(timeoutValue), ms)));
  const result = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  return result;
}

// Main-thread liveness tracker. A frozen main thread cannot run this interval,
// so a freeze shows up afterwards as one very large gap.
function startPing(intervalMs = 25) {
  const state = { ticks: 0, maxGapMs: 0, startedAt: performance.now(), last: performance.now() };
  state.id = setInterval(() => {
    const now = performance.now();
    const gap = now - state.last;
    if (gap > state.maxGapMs) state.maxGapMs = gap;
    state.last = now;
    state.ticks += 1;
  }, intervalMs);
  state.snapshot = () => ({
    ticks: state.ticks,
    maxGapMs: Math.round(state.maxGapMs),
    windowMs: Math.round(performance.now() - state.startedAt),
  });
  state.reset = () => {
    const snap = state.snapshot();
    state.ticks = 0;
    state.maxGapMs = 0;
    state.startedAt = performance.now();
    state.last = performance.now();
    return snap;
  };
  state.stop = () => clearInterval(state.id);
  return state;
}

// ---------------------------------------------------------------------------
// Experiment A — blob-URL worker straight from the content script
// ---------------------------------------------------------------------------

const BLOB_WORKER_SOURCE = `
self.onmessage = (e) => { if (e.data && e.data.t === "ping") self.postMessage({ t: "pong" }); };
self.postMessage({ t: "ready" });
`;

async function experimentBlob() {
  const res = {
    experiment: "A-blob-worker",
    blobUrlCreated: false,
    constructed: false,
    handshake: false,
    blobUrlScheme: null,
    syncError: null,
    asyncError: null,
  };

  let url = null;
  try {
    url = URL.createObjectURL(new Blob([BLOB_WORKER_SOURCE], { type: "text/javascript" }));
    res.blobUrlCreated = true;
    res.blobUrlScheme = url.slice(0, url.indexOf("/", 5) + 1);
  } catch (err) {
    res.syncError = { where: "createObjectURL", ...describe(err) };
    return res;
  }

  let worker;
  try {
    worker = new Worker(url);
    res.constructed = true;
  } catch (err) {
    res.syncError = { where: "new Worker", ...describe(err) };
    return res;
  }

  // Chrome's failure mode is an async onerror with message and filename both
  // undefined, so there is nothing to branch on. A timed handshake is the only
  // reliable detection, and it works whatever Firefox does.
  const got = deferred();
  worker.addEventListener("message", (e) => {
    if (e.data && (e.data.t === "ready" || e.data.t === "pong")) got.resolve(true);
  });
  worker.addEventListener("error", (e) => {
    res.asyncError = {
      type: e.type,
      message: e.message === undefined ? "undefined" : e.message,
      filename: e.filename === undefined ? "undefined" : e.filename,
      lineno: e.lineno === undefined ? "undefined" : e.lineno,
    };
  });
  worker.postMessage({ t: "ping" });

  res.handshake = (await withTimeout(got.promise, 3000, false)) === true;
  try {
    worker.terminate();
  } catch {
    /* ignore */
  }
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
  return res;
}

// ---------------------------------------------------------------------------
// Experiment B — content-script-injected extension iframe hosting a worker
// ---------------------------------------------------------------------------

const frames = new Map(); // token -> { hello: deferred, events: [], win }

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object" || typeof data.probe !== "string") return;
  const entry = frames.get(data.token);
  if (!entry) return;
  entry.events.push(data);
  if (data.probe === "frame-ready") entry.ready.resolve(data);
  if (data.probe === "frame-hello") entry.hello.resolve(data);
  if (data.probe === "ack") {
    const waiter = entry.acks.get(data.cmd);
    if (waiter) waiter.resolve(data);
  }
  if (data.probe === "busy-started") entry.busyStarted.resolve(data);
  if (data.probe === "freeze-started") entry.freezeStarted.resolve(data);
  if (data.probe === "freeze-done") entry.freezeDone.resolve(data);
});

async function injectFrame(resource, label) {
  const token = `t${Math.random().toString(36).slice(2)}`;
  const url = browser.runtime.getURL(resource) + `#${token}`;
  const entry = {
    ready: deferred(),
    hello: deferred(),
    freezeStarted: deferred(),
    freezeDone: deferred(),
    busyStarted: deferred(),
    acks: new Map(),
    events: [],
  };
  frames.set(token, entry);

  const res = {
    experiment: label,
    resource,
    url: browser.runtime.getURL(resource),
    frameLoadEvent: false,
    frameReady: false,
    frameHello: false,
    workerConstructed: false,
    workerHandshake: false,
    workerError: null,
    injectError: null,
  };

  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;border:0;opacity:0";
  frame.addEventListener("load", () => {
    res.frameLoadEvent = true;
  });
  frame.src = url;
  try {
    (document.body || document.documentElement).appendChild(frame);
  } catch (err) {
    res.injectError = describe(err);
    return { res, entry, frame: null };
  }

  res.frameReady = (await withTimeout(entry.ready.promise, 6000, null)) !== null;
  const hello = await withTimeout(entry.hello.promise, 8000, null);
  if (hello) {
    res.frameHello = true;
    res.workerConstructed = !!hello.workerConstructed;
    res.workerHandshake = !!hello.workerHandshake;
    res.workerError = hello.workerError ?? null;
    res.frameHref = hello.href;
  }
  entry.win = frame.contentWindow;
  return { res, entry, frame };
}

function sendToFrame(entry, cmd, extra = {}) {
  const waiter = deferred();
  entry.acks.set(cmd, waiter);
  entry.win.postMessage({ probe: "cmd", cmd, ...extra }, "*");
  return waiter.promise;
}

// ---------------------------------------------------------------------------
// Experiment C — termination of a frozen worker through the frame relay
// ---------------------------------------------------------------------------

async function experimentTerminate(entry, doTerminate) {
  const res = {
    experiment: doTerminate ? "C-terminate" : "C-leak",
    pattern: FREEZE_PATTERN,
    input: FREEZE_INPUT_SPEC,
    freezeStarted: false,
    terminateReturnedMs: null,
    pingWhileRunning: null,
    pingAfterTerminate: null,
    pingDuringLeak: null,
    respawnWorks: null,
    freezeFinishedOnItsOwn: false,
  };

  const ping = startPing();
  entry.win.postMessage({ probe: "cmd", cmd: "freeze", pattern: FREEZE_PATTERN, input: FREEZE_INPUT }, "*");
  res.freezeStarted = (await withTimeout(entry.freezeStarted.promise, 8000, null)) !== null;
  if (!res.freezeStarted) {
    ping.stop();
    return res;
  }

  if (doTerminate) {
    await sleep(3000);
    res.pingWhileRunning = ping.reset();

    const ack = await withTimeout(sendToFrame(entry, "terminate"), 5000, null);
    res.terminateReturnedMs = ack ? ack.ms : null;

    await phase("cpu-start", { tag: "after-terminate" });
    await sleep(6000);
    await phase("cpu-end", { tag: "after-terminate" });
    res.pingAfterTerminate = ping.reset();

    const respawn = await withTimeout(sendToFrame(entry, "respawn"), 6000, null);
    res.respawnWorks = respawn ? !!respawn.ok : false;
  } else {
    await phase("cpu-start", { tag: "worker-running" });
    await sleep(6000);
    await phase("cpu-end", { tag: "worker-running" });
    res.pingDuringLeak = ping.reset();
  }

  ping.stop();
  const done = entry.events.find((e) => e.probe === "freeze-done");
  res.freezeFinishedOnItsOwn = !!done;
  return res;
}

// ---------------------------------------------------------------------------
// Busy — an unbounded spin, so the CPU evidence does not rest on a workload that
// stops by itself. Both windows are in one launch on purpose: a counting loop has
// no first-call cost to protect, unlike a regexp.
async function experimentBusy(entry) {
  const res = { experiment: "D-busy-spin", busyStarted: false };
  const ping = startPing();

  entry.win.postMessage({ probe: "cmd", cmd: "busy" }, "*");
  res.busyStarted = (await withTimeout(entry.busyStarted.promise, 8000, null)) !== null;
  if (!res.busyStarted) {
    ping.stop();
    return res;
  }

  await phase("cpu-start", { tag: "busy-running" });
  await sleep(6000);
  await phase("cpu-end", { tag: "busy-running" });
  res.pingWhileRunning = ping.reset();

  const ack = await withTimeout(sendToFrame(entry, "terminate"), 5000, null);
  res.terminateReturnedMs = ack ? ack.ms : null;

  await phase("cpu-start", { tag: "busy-after-terminate" });
  await sleep(6000);
  await phase("cpu-end", { tag: "busy-after-terminate" });
  res.pingAfterTerminate = ping.reset();

  const respawn = await withTimeout(sendToFrame(entry, "respawn"), 6000, null);
  res.respawnWorks = respawn ? !!respawn.ok : false;

  ping.stop();
  return res;
}

// Control — the same pattern on the page's own main thread
// ---------------------------------------------------------------------------

async function experimentControl() {
  const ping = startPing();
  await phase("cpu-start", { tag: "main-thread-freeze" });
  const re = new RegExp(FREEZE_PATTERN);
  const input = FREEZE_INPUT;

  // Run from a fresh macrotask so the JS stack is shallow. SpiderMonkey's
  // backtrack limit is a stack limit, so how much stack is already in use when
  // .test() is entered changes the answer, and a promise continuation is not a
  // fair place to measure from.
  const out = await new Promise((resolve) => {
    setTimeout(() => {
      const t0 = performance.now();
      try {
        const matched = re.test(input);
        resolve({ regexTestMs: Math.round(performance.now() - t0), matched, threw: null });
      } catch (err) {
        resolve({ regexTestMs: Math.round(performance.now() - t0), matched: null, threw: describe(err) });
      }
    }, 0);
  });

  await phase("cpu-end", { tag: "main-thread-freeze" });
  const snap = ping.reset();
  ping.stop();
  return {
    experiment: "control-main-thread",
    pattern: FREEZE_PATTERN,
    input: FREEZE_INPUT_SPEC,
    ...out,
    ping: snap,
  };
}

// Soak — let the frame's worker run the same pattern to completion (or to a long
// deadline), to get SpiderMonkey's actual cost for it and to show the page stays
// responsive the whole time.
const SOAK_MS = 120_000;

async function experimentSoak(entry) {
  const ping = startPing();
  entry.win.postMessage({ probe: "cmd", cmd: "freeze", pattern: FREEZE_PATTERN, input: FREEZE_INPUT }, "*");
  const started = (await withTimeout(entry.freezeStarted.promise, 8000, null)) !== null;
  const done = started ? await withTimeout(entry.freezeDone.promise, SOAK_MS, null) : null;
  const snap = ping.reset();
  ping.stop();
  return {
    experiment: "soak-worker",
    pattern: FREEZE_PATTERN,
    input: FREEZE_INPUT_SPEC,
    freezeStarted: started,
    finished: done !== null,
    workerRegexMs: done ? done.ms : null,
    matched: done ? done.matched : null,
    threw: done ? (done.threw ?? null) : null,
    deadlineMs: SOAK_MS,
    ping: snap,
  };
}

// ---------------------------------------------------------------------------

async function main() {
  await report({
    experiment: "0-hello",
    href: location.href,
    contentType: document.contentType,
    userAgent: navigator.userAgent,
    staticResourceUrl: browser.runtime.getURL("worker-host.html"),
    dynamicResourceUrl: browser.runtime.getURL("worker-host-dyn.html"),
  });

  if (MODE === "control") {
    await report(await experimentControl());
    await report({ experiment: "done" });
    return;
  }

  await report({ ...(await experimentBlob()), violations: violations.slice() });

  const staticFrame = await injectFrame("worker-host.html", "B-extension-iframe");
  await report({ ...staticFrame.res, violations: violations.slice() });

  if (MODE === "survey") {
    const dynFrame = await injectFrame("worker-host-dyn.html", "B2-dynamic-url-iframe");
    await report({ ...dynFrame.res, violations: violations.slice() });
  }

  const needsWorker = MODE === "terminate" || MODE === "leak" || MODE === "soak" || MODE === "busy";
  if (needsWorker && !staticFrame.res.workerHandshake) {
    await report({ experiment: MODE, skipped: "no working frame worker" });
  } else if (MODE === "terminate" || MODE === "leak") {
    await report(await experimentTerminate(staticFrame.entry, MODE === "terminate"));
  } else if (MODE === "soak") {
    await report(await experimentSoak(staticFrame.entry));
  } else if (MODE === "busy") {
    await report(await experimentBusy(staticFrame.entry));
  }

  await report({ experiment: "done" });
}

main().catch(async (err) => {
  try {
    await report({ experiment: "fatal", error: describe(err) });
    await report({ experiment: "done" });
  } catch {
    /* ignore */
  }
});
