// The worker under test. Stands in for the real search worker: it answers a
// handshake and, on demand, runs the proven catastrophic-backtracking case.

self.addEventListener("message", (e) => {
  const d = e.data;
  if (!d) return;
  if (d.t === "ping") {
    self.postMessage({ t: "pong" });
    return;
  }
  if (d.t === "busy") {
    // Unbounded spin. Nothing but terminate() stops this, so it is the clean
    // case for the CPU evidence: no self-limiting workload involved.
    self.postMessage({ t: "busy-started" });
    let n = 0;
    for (;;) n += 1;
  }
  if (d.t === "freeze") {
    // Built from a string so nothing can constant-fold it away.
    const re = new RegExp(d.pattern || "(z+)+.{0,24}$");
    const input = d.input || "z".repeat(30) + "y".repeat(170);
    self.postMessage({ t: "freeze-started" });
    const t0 = Date.now();
    try {
      const matched = re.test(input);
      self.postMessage({ t: "freeze-done", ms: Date.now() - t0, matched, threw: null });
    } catch (err) {
      // SpiderMonkey can abort a deep backtrack with InternalError rather than
      // running forever. That is a different failure from a freeze and has to be
      // reported as such.
      self.postMessage({
        t: "freeze-done",
        ms: Date.now() - t0,
        matched: null,
        threw: { name: err.name ?? null, message: err.message ?? String(err) },
      });
    }
  }
});

self.postMessage({ t: "ready" });
