// Runs inside the moz-extension:// iframe that the content script injects.
// Constructs a same-origin, non-blob worker and relays between it and the page.

const TOKEN = location.hash.slice(1);
const HANDSHAKE_MS = 3000;

function toParent(msg) {
  parent.postMessage({ token: TOKEN, ...msg }, "*");
}

let worker = null;

function spawn() {
  const state = { constructed: false, handshake: false, error: null, worker: null };
  try {
    state.worker = new Worker("tree-worker.js");
    state.constructed = true;
  } catch (err) {
    state.error = { name: err.name ?? null, message: err.message ?? String(err) };
    return Promise.resolve(state);
  }
  state.worker.addEventListener("error", (e) => {
    state.error = {
      type: e.type,
      message: e.message === undefined ? "undefined" : e.message,
      filename: e.filename === undefined ? "undefined" : e.filename,
    };
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(state), HANDSHAKE_MS);
    state.worker.addEventListener("message", (e) => {
      const d = e.data;
      if (!d) return;
      if (d.t === "ready" || d.t === "pong") {
        if (!state.handshake) {
          state.handshake = true;
          clearTimeout(timer);
          resolve(state);
        }
        return;
      }
      if (d.t === "busy-started") toParent({ probe: "busy-started" });
      if (d.t === "freeze-started") toParent({ probe: "freeze-started" });
      if (d.t === "freeze-done") {
        toParent({ probe: "freeze-done", ms: d.ms, matched: d.matched, threw: d.threw ?? null });
      }
    });
    state.worker.postMessage({ t: "ping" });
  });
}

window.addEventListener("message", async (event) => {
  const d = event.data;
  if (!d || d.probe !== "cmd") return;
  if (d.cmd === "freeze") {
    if (worker) worker.postMessage({ t: "freeze", pattern: d.pattern, input: d.input });
    return;
  }
  if (d.cmd === "busy") {
    if (worker) worker.postMessage({ t: "busy" });
    return;
  }
  if (d.cmd === "terminate") {
    let ms = null;
    if (worker) {
      const t0 = performance.now();
      worker.terminate();
      ms = Math.round(performance.now() - t0);
      worker = null;
    }
    toParent({ probe: "ack", cmd: "terminate", ms });
    return;
  }
  if (d.cmd === "respawn") {
    const state = await spawn();
    worker = state.handshake ? state.worker : null;
    toParent({ probe: "ack", cmd: "respawn", ok: state.handshake, error: state.error });
  }
});

toParent({ probe: "frame-ready", href: location.href });

spawn().then((state) => {
  worker = state.handshake ? state.worker : null;
  toParent({
    probe: "frame-hello",
    href: location.href,
    origin: location.origin,
    workerConstructed: state.constructed,
    workerHandshake: state.handshake,
    workerError: state.error,
  });
});
