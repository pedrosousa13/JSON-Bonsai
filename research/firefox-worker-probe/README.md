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
behind. Takes about six minutes.

Environment overrides:

- `PROBE_FIREFOX` — path to the Firefox binary
  (default `/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox`)
- `PROBE_PORT` — port for the local test server (default `8731`)

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
| `ext/config.js` | Generated each run so the background script knows the server port. |
| `results/` | Per-run JSONL, summary JSON, and the printed console transcript (`run-console.txt`). Each launch's `web-ext` output lands here too as `<launch>.log`, but the repo's root `.gitignore` covers `*.log`, so those stay local. |

## CSP variants

Mirrors exactly the four cases already measured in Chrome on issue #51, so the
two columns are comparable.

| path | response |
| --- | --- |
| `/v/none` | `text/html`, no CSP |
| `/v/self` | `text/html`, `Content-Security-Policy: default-src 'self'` |
| `/v/nonesrc` | `text/html`, `Content-Security-Policy: default-src 'none'; frame-src 'none'` |
| `/v/json` | `application/json`, `Content-Security-Policy: default-src 'self'` |

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
  frame's worker. One launch terminates it mid-run, one deliberately leaves it
  spinning, and process CPU is sampled over a fixed 6 s window in both. The page
  main thread is pinged every 25 ms throughout and the maximum gap recorded.
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
