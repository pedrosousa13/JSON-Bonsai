# Firefox worker-hosting probe

Evidence harness for issue #84: can a content-script-injected `moz-extension://`
iframe host a Web Worker that survives ordinary page CSP and can be terminated
mid-`regex.test`?

The findings this produced are written up in
`docs/research/2026-09-03-firefox-worker-hosting.md`.

Nothing here is shipped. The probe extension under `ext/` is a throwaway; it is
not the JSON Bonsai extension and it has nothing to do with `dist/`.

## Re-running

```
node research/firefox-worker-probe/run.mjs
```

It is fully non-interactive: it starts the local server, launches Firefox once
per measurement through `npx --yes web-ext run`, waits for the probe to report
itself, kills the browser, and prints a table. It leaves no Firefox process
behind. Takes about fifteen minutes.

**Do not open Firefox while it runs.** Cleanup kills the launch's process group
first, but Firefox does not reliably stay in that group, so anything left over
that was not running when the run began is force-killed as a fallback. That pass
cannot tell a leaked browser from one you just opened. It logs a `[sweep]` line
whenever it fires.

Environment overrides:

- `PROBE_FIREFOX` — path to the Firefox binary
  (default `/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox`)
- `PROBE_PORT` — port for the local test server (default `8731`)
- `PROBE_ONLY` — comma-separated launch names, to re-run just those (for example
  `PROBE_ONLY=survey-nonebare,terminate`). For debugging one row; the committed
  results come from a full run.

A launch that times out is retried once, because Firefox occasionally fails to
start the content script on a cold profile and one flake would otherwise leave a
"no report" hole that reads like a real browser behaviour. The
`survey-json-viewer-on` launch is exempt: there, the timeout *is* the finding.

The harness turns Firefox's auto-update off for each launch and re-reads the
version when the run ends. If the binary changed mid-run it says so and the
results should not be cited — Developer Edition updates itself, and a run that
straddles two builds cannot attribute its numbers to either.

`node research/firefox-worker-probe/server.mjs [port]` serves the CSP variants on
their own, if you want to poke at them by hand.

## Files

| file | what it is |
| --- | --- |
| `run.mjs` | Orchestrator. One fresh Firefox launch per measurement, then prints and stores the result table. |
| `server.mjs` | Local HTTP server. Serves one JSON-ish page per CSP variant, collects `POST /report` and `POST /phase`, and samples Firefox process CPU across a window when the probe signals one. |
| `ext/manifest.json` | The probe extension. Firefox-only MV3 (event-page background, not a service worker). |
| `ext/background.js` | Relays every report to the local server. Reports go through here, not straight from the content script, because the page's own CSP could interfere with a content-script `fetch`. |
| `ext/content.js` | Runs the experiments on whichever CSP variant it landed on. |
| `ext/worker-host.html` / `ext/worker-host.js` | The extension-origin iframe. Constructs a same-origin, non-blob worker and relays `postMessage` both ways. |
| `ext/worker-host-dyn.html` | Same document, declared with `use_dynamic_url: true`, to see whether Firefox honours that. |
| `ext/tree-worker.js` | The worker under test. Answers a handshake and, on demand, runs the catastrophic-backtracking case. |
| `ext/config.js` | Generated each run so the background script knows the server port. Not tracked — `run.mjs` writes it, so the extension will not load from `about:debugging` until you have run the harness at least once. |
| `results/` | Per-run JSONL, summary JSON, the printed console transcript (`run-console.txt`), and each launch's `web-ext` output as `<launch>.log`. The root `.gitignore` covers `*.log`, so those were force-added (`git add -f`) — they are the evidence for launches that produced no HTTP reports at all. |

## CSP variants

Covers every policy Chrome was measured against on issue #51, so the two columns
are comparable.

| path | response |
| --- | --- |
| `/v/none` | `text/html`, no CSP |
| `/v/self` | `text/html`, `default-src 'self'` |
| `/v/nonebare` | `text/html`, `default-src 'none'` |
| `/v/nonesrc` | `text/html`, `default-src 'none'; frame-src 'none'` |
| `/v/workersrc` | `text/html`, `worker-src 'none'` |
| `/v/childsrc` | `text/html`, `child-src 'none'` |
| `/v/scriptsrc` | `text/html`, `script-src 'self'` |
| `/v/json` | `application/json`, `default-src 'self'` |

All but `nonebare` and `nonesrc` are single directives, on purpose: they are the
five policies Chrome was measured against on issue #51, plus the two frame cases
question 1 needs.

## Experiments

- **A — blob worker.** `new Worker(URL.createObjectURL(...))` straight from the
  content script. Detected by a handshake with a timeout: the failure is an async
  `onerror` whose `message` and `filename` are both `undefined`, so there is
  nothing to branch on.
- **B — extension iframe.** Inject an iframe at `runtime.getURL("worker-host.html")`
  and wait for a handshake. Reports whether the frame loaded and, separately,
  whether the frame's own `new Worker("tree-worker.js")` answered.
- **B2 — dynamic-URL iframe.** The same, for a resource declared with
  `use_dynamic_url: true`.
- **C — termination.** Runs `(z+)+.{0,24}$` against `"z"*30 + "y"*170` in the
  frame's worker. One launch terminates it, one leaves it running. Both open their
  CPU window at the same instant — freeze start — for the same 3500 ms, and the
  terminating run fires `terminate()` 500 ms in. The window is deliberately
  shorter than the ~5 s at which SpiderMonkey aborts this pattern by itself, so
  the self-abort cannot land inside either window and skew the comparison. Both
  runs then keep watching to 9 s, which is how the leaked worker is seen aborting
  on its own and the terminated one is seen never finishing. The page main thread
  is pinged every 25 ms throughout and the maximum gap recorded.
- **Soak.** The frame's worker runs a pattern to completion or to a two-minute
  deadline, one fresh process per pattern, while the page keeps being pinged.
  Three patterns, all from issue #51: `(z+)+.{0,24}$`, `(a+)+$` and
  `\w{40}(\w+)+!`. `?pattern=` and `?input=` on the page URL set them, so a new
  case needs no change to the extension.
- **D — busy spin.** An unbounded `for(;;)` in the frame's worker, with CPU
  sampled over a 6 s window while it runs and again over a 6 s window after
  `terminate()`. This is the clean CPU pair: unlike the regex case, nothing here
  stops by itself.
- **Control.** The same pattern on the page's own main thread, one fresh process,
  for the "no worker at all" baseline.

## Measurement notes

- One fresh Firefox launch per number. SpiderMonkey tiers a regexp up after
  repeated execution in one process, so a first-call cost taken from a loop comes
  out roughly six times low.
- `terminate()` returning promptly does not prove the worker stopped, so the CPU
  window is what carries the claim, not the return time.
- CPU sampling sums `ps` cumulative CPU time over every process launched from the
  Firefox app's `MacOS/` directory, excluding any Firefox PID that existed before
  the run started.
- Launch prefs: `about:welcome` is suppressed so the probe tab stays in the
  foreground (a background tab clamps timers to 1 s and the ping measurement
  would be worthless). `extensions.originControls.grantByDefault` is set on most
  launches because Firefox MV3 does not grant host permissions at install time;
  the `survey-nonesrc-default-perms` launch deliberately omits it so the results
  are not resting on a non-default pref. Timer throttling is left at its default.
- The `application/json` variant is launched twice. Firefox's built-in JSON viewer
  is on by default and the project README already tells Firefox users to turn it
  off, so the supported configuration is the launch with
  `devtools.jsonview.enabled=false`.
