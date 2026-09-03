# Firefox worker hosting under page CSP

Answers issue #84, which blocks the architecture decision on #51. Chrome's side of
this was already measured and is recorded on #51; this document is the Firefox
column, produced with the harness in `research/firefox-worker-probe/`.

## Short answers

1. **Does a content-script-injected `moz-extension://` iframe load in Firefox
   when the page sends `frame-src 'none'` or `default-src 'none'`? Yes.** It
   loads, and the worker it hosts works. Verified against eight page responses,
   including both of those.
2. **Can that frame host a terminable worker? Yes.** It constructs a same-origin
   `new Worker("tree-worker.js")`, relays over `postMessage`, and `terminate()`
   interrupts `regex.test` part-way through — confirmed by process CPU over two
   symmetric windows, not by `terminate()` returning promptly.
3. **Do blob-URL workers work from a Firefox content script under page CSP? No.**
   Blocked by all five policies Chrome was measured against, always reported as a
   `worker-src` violation.
4. **Do the `web_accessible_resources` entries need a different shape? No.** One
   entry serves both browsers. `use_dynamic_url` is accepted by the Firefox
   linter but has no runtime effect there.

**Recommendation: one shared architecture, no per-browser branch.** Details at
the end.

## Environment

| | |
| --- | --- |
| Browser | Mozilla Firefox 156.0b2 (Firefox Developer Edition) |
| Platform | macOS, Darwin 25.6.0, arm64 |
| Tooling | `web-ext` 10.6.0 via `npx`, Node 24.16.0 |
| Date | 2026-09-03 |

**Every number below comes from one run on 156.0b2.** That is worth stating
because it was not true of an earlier draft. Firefox Developer Edition
auto-updates, and it updated from 154.0b3 to 156.0b2 partway through this
investigation. A run whose recorded version was 154.0b3 finished on a machine
where the binary was already 156.0b2, so its numbers could not all be attributed
to one build and were discarded. The harness now switches auto-update off for
each launch and re-reads the version when the run ends, printing both:

```
firefox at start: Mozilla Firefox 156.0b2
firefox at end:   Mozilla Firefox 156.0b2
```

If those two ever differ the run says so loudly and should not be cited.

**Version gap, stated plainly.** `manifest.json` sets
`browser_specific_settings.gecko.strict_min_version` to `115.0`. Everything below
was measured on 156.0b2, and 156.0b2 is a beta. There is no other Firefox on this
machine, so nothing between 115 and 155 was tested, and neither was any release
build. The behaviour being relied on — extension frames exempt from page CSP,
same-origin workers inside them — is long-standing, but "long-standing" is not a
measurement. If #51 ships on this, either raise `strict_min_version` to a version
that has actually been tested, or re-run this harness against an older Firefox
before release.

## What was automated and what was not

Everything in the result tables came from `node research/firefox-worker-probe/run.mjs`,
which is fully non-interactive: it starts a local server, launches Firefox once
per measurement, waits for the probe extension to report itself over HTTP, kills
the browser and prints the tables. No result below was read off a browser window
by hand.

One thing was run by hand: `npx web-ext lint --source-dir ext`, once, to see
whether the Firefox linter objects to `use_dynamic_url`. It reported 0 errors, 0
notices and 1 warning, and the warning was about a missing
`data_collection_permissions` key, unrelated to this question.

## Result table: one row per page response

Each row is its own Firefox launch against a fresh profile. "A blob" is a
blob-URL worker created directly by the content script. "B frame" is an iframe at
`runtime.getURL("worker-host.html")` injected by the content script. "B worker"
is that frame's own `new Worker("tree-worker.js")`. "B2 dyn" is the same frame
test against a resource declared `use_dynamic_url: true`.

| Page response | A blob | B frame | B worker | B2 dyn |
| --- | --- | --- | --- | --- |
| no CSP | works | loads | works | loads |
| `default-src 'self'` | **blocked** | loads | works | loads |
| `default-src 'none'` | **blocked** | loads | works | loads |
| `default-src 'none'; frame-src 'none'` | **blocked** | loads | works | loads |
| `worker-src 'none'` | **blocked** | loads | works | loads |
| `child-src 'none'` | **blocked** | loads | works | loads |
| `script-src 'self'` | **blocked** | loads | works | loads |
| `application/json` + `default-src 'self'` (JSON viewer off) | **blocked** | loads | works | loads |
| `application/json` + `default-src 'self'` (JSON viewer on, Firefox default) | content script never ran | — | — | — |
| `default-src 'none'; frame-src 'none'`, default origin controls | **blocked** | loads | works | loads |

The five single-directive policies are the ones Chrome was measured against on
#51, so the two columns now cover the same ground. `default-src 'none'; frame-src 'none'`
is the extra case question 1 needs.

Two rows need explanation.

**The JSON viewer row.** Firefox ships a built-in JSON viewer, on by default. On
that document the probe's content script never ran at all — the launch timed out
with zero reports, and `results/survey-json-viewer-on.log` shows the extension
installed cleanly first ("Installed … as a temporary add-on"), so this is the
content script not running rather than the extension failing to load. This is not
new and not caused by anything here: the project README already tells Firefox
users to set `devtools.jsonview.enabled` to `false` before the extension will
take over JSON pages. The supported configuration is the row above it, which
works.

**The default-origin-controls row.** Firefox MV3 does not grant host permissions
at install time. The other launches set
`extensions.originControls.grantByDefault` to `true`; this one deliberately did
not, and produced identical results. So the findings do not rest on a
non-default pref.

### Blob workers: how they fail

The blob failure is not a synchronous throw. `URL.createObjectURL` succeeded,
`new Worker(blobUrl)` returned an object without throwing, and the failure
arrived later as an `error` event whose fields carry nothing to branch on:

```json
{"type":"error","message":"undefined","filename":"undefined","lineno":"undefined"}
```

The page's CSP report is where the reason appears. Every blocking policy names
`worker-src` as the violated directive, whatever the fallback chain it took to
get there:

| Page policy | recorded violation |
| --- | --- |
| `default-src 'self'` | `worker-src`, blockedURI `blob` |
| `default-src 'none'` | `worker-src`, blockedURI `blob` |
| `default-src 'none'; frame-src 'none'` | `worker-src`, blockedURI `blob` |
| `worker-src 'none'` | `worker-src`, blockedURI `blob` |
| `child-src 'none'` | `worker-src`, blockedURI `blob` |
| `script-src 'self'` | `worker-src`, blockedURI `blob` |

This matches Chrome, including the useless error event. Detection has to be a
handshake with a timeout in both browsers. Firefox's expanded content-script
principal does not buy an exemption anywhere.

## Termination evidence

All of this ran on `default-src 'none'; frame-src 'none'`. The workload is the
proven freeze case from #51: `(z+)+.{0,24}$` against 30 `z` characters followed
by 170 `y` characters. The page main thread was pinged every 25 ms throughout.
Process CPU was sampled by summing `ps` cumulative CPU time across every Firefox
process, over a window opened and closed by signals from the probe itself.

### The regex pair

This is the measurement that matters, because #51's architecture rests on
`terminate()` interrupting the regex engine specifically, not on it stopping some
other kind of loop.

The two runs are built to be directly comparable. Both open their CPU window at
the same instant — the moment the worker reports the regex has started — and both
close it 3500 ms later. The terminating run fires `terminate()` 500 ms in. The
window is deliberately shorter than the ~5 s at which SpiderMonkey aborts this
pattern by itself, so the self-abort cannot land inside either window and skew
the comparison.

| | CPU over the window | Largest single process | Window |
| --- | --- | --- | --- |
| Left running | +3.63 s | **+3.56 s** | 3542 ms |
| `terminate()` at 500 ms | +0.68 s | **+0.53 s** | 3551 ms |

Read the second row against its own design: terminate fired 500 ms into the
window, and 0.53 s of CPU is what 500 ms of regex costs. The regex stopped when
it was told to, and burned essentially nothing for the remaining three seconds.
Uninterrupted, the same window is 3.56 s — a core saturated end to end.

The two runs also disagree about whether the work ever finished, which is the
same conclusion from a different direction. Both watched for 9 seconds:

- **Left running:** `freezeFinishedOnItsOwn: true`, `freezeSelfAbortMs: 4984`.
  The worker was still alive at 5 s and reported its own abort.
- **Terminated:** `freezeFinishedOnItsOwn: false`. Nothing was ever heard from
  it again. It did not complete, and it did not self-abort — it was killed.

`terminate()` returned in 0 ms, and a worker spawned in the frame afterwards
answered its handshake normally (`respawnWorks: true`).

### The unbounded-spin pair

Corroboration for the general claim, with a different workload: a plain
`for(;;) n += 1` in the frame's worker, which nothing but `terminate()` can stop.
Both windows are 6 s, taken in a single launch — acceptable here because a
counting loop has no first-call cost to protect, unlike a regexp.

| | CPU over the window | Largest single process | Window |
| --- | --- | --- | --- |
| Spinning | +6.34 s | +5.96 s | 6043 ms |
| After `terminate()` | +0.59 s | +0.54 s | 6057 ms |

This is a JS loop, not the regex engine, so it does not by itself answer the
question #51 asks. It does establish that Firefox will let a worker spin without
limit and that `terminate()` ends it.

### The page never stalled

Across every worker measurement the largest gap between 25 ms pings was **34 ms**.
There is no point at which a user would have noticed anything.

### The main-thread baseline

Same pattern, same input, on the page's own main thread, in a fresh Firefox
process:

- `regex.test` occupied the thread for **6653 ms** and then threw.
- The ping interval managed **5 ticks**, with a **6655 ms** gap. The page was
  frozen for the whole of it.
- CPU over that window: +8.78 s total, +6.64 s on the busiest process.

So the bug #51 exists to fix is real on Firefox too. A catastrophic pattern
freezes the page.

### An important Firefox-specific finding

Firefox does not run these patterns forever. All three catastrophic patterns from
#51, each in its own fresh process, aborted with
`InternalError: too much recursion`:

| Pattern | Input | Where | Time to abort |
| --- | --- | --- | --- |
| `(z+)+.{0,24}$` | `z`×30 + `y`×170 | worker | 4995 ms |
| `(a+)+$` | `a`×30 + `b` | worker | 5019 ms |
| `\w{40}(\w+)+!` | `a`×200 | worker | 4981 ms |
| `(z+)+.{0,24}$` | `z`×30 + `y`×170 | page main thread | 6653 ms |

Chrome ran the first of these for **69,935 ms** before returning. Firefox stops
at roughly five seconds.

Three cautions before anyone treats that as a safety property:

- **The mechanism was not determined.** Three unrelated patterns aborting within
  40 ms of each other looks more like a time-based abort than the stack
  exhaustion the error message names, but that was not established, and a
  five-second budget is not documented anywhere as an API guarantee.
- **It is not a general limit on worker runtime.** The unbounded `for(;;)` in the
  same worker ran its full six-second window at essentially 100% of a core with
  no abort at all. Firefox will happily let a worker spin forever; only this
  regex path stopped.
- **Six and a half seconds of frozen page is still a bug.** It is an order of
  magnitude better than Chrome's seventy seconds, but it is not acceptable
  behaviour, and it is measured on one browser version.

The conclusion for #51 is unchanged: run the regex where it can be terminated.
The Firefox number just means the symptom is less catastrophic there, not absent.

## `web_accessible_resources`

The probe declared both shapes and both worked:

```json
"web_accessible_resources": [
  { "resources": ["worker-host.html", "worker-host.js", "tree-worker.js"],
    "matches": ["http://127.0.0.1/*"] },
  { "resources": ["worker-host-dyn.html"],
    "matches": ["http://127.0.0.1/*"], "use_dynamic_url": true }
]
```

Findings:

- **The v3 object form with `matches` is honoured by Firefox**, and is the same
  shape Chrome needs. No branch required.
- **`use_dynamic_url` is accepted but inert in Firefox.** `web-ext lint` raised
  no complaint about the key. At runtime,
  `browser.runtime.getURL("worker-host-dyn.html")` returned the ordinary static
  `moz-extension://<uuid>/worker-host-dyn.html` — identical in shape to the
  non-dynamic resource — and the frame loaded from it normally. There is no
  dynamic token.
- **Firefox does not need it.** The `moz-extension://` UUID is already randomised
  per installation, which is the fingerprinting protection `use_dynamic_url`
  exists to provide in Chrome. Setting the flag for Chrome's benefit costs
  Firefox nothing.
- **`new Worker("tree-worker.js")` inside the frame does not depend on
  `web_accessible_resources` at all.** That is a same-origin load from within the
  extension's own document; the entries only gate what the page can reach.

Implementation note for whoever picks up #51: `src/manifest.test.ts` currently
asserts `web_accessible_resources` is exactly `["page-script.js", "content.css"]`,
so it will need updating alongside the manifest.

## Recommendation

**Ship one architecture to both browsers. Do not branch.**

The content script injects a single iframe at
`runtime.getURL("worker-host.html")`. That document runs at the extension origin
under the extension's own CSP, constructs a real same-origin worker, and relays
search requests and results over `postMessage`. A runaway pattern is killed by
terminating the worker through the frame.

The reasoning:

- **It is the only path that survives real page CSP, and it survives it on both
  browsers.** Verified 4/4 in Chrome, and on all eight page responses here —
  including every single-directive policy Chrome was measured against, and
  including `application/json` pages in the configuration the project already
  requires of Firefox users.
- **Blob workers are dead on both.** `default-src 'self'` is common on real JSON
  endpoints, and Firefox blocks blob workers under every policy Chrome does.
  Firefox's expanded content-script principal changes nothing, so the hoped-for
  simpler Firefox branch does not exist.
- **Termination works on both, on the regex specifically.** Chrome interrupts
  Irregexp mid-`test`; so does Firefox, on symmetric windows.
- **The manifest needs no per-browser difference.** One
  `web_accessible_resources` entry covers both; `use_dynamic_url` is a Chrome
  nicety Firefox ignores harmlessly.
- **The repo ships byte-identical code to both targets** — one `dist/`, zipped
  twice by `npm run package`. A shared architecture keeps that property, which a
  branch would cost.

Reuse one frame for the life of the page rather than spawning per search. The
frame handshake latency was not measured here; Chrome's was 80–120 ms, and there
is no reason to pay it repeatedly.

## Limits of this investigation

- **One Firefox version.** 156.0b2, a beta, against a declared
  `strict_min_version` of 115.0. Nothing between was tested and nothing else was
  available on this machine. Re-running `run.mjs` with `PROBE_FIREFOX` pointed at
  an older build would answer it.
- **Temporary add-on, not a signed install.** Loaded by `web-ext`. The
  `moz-extension://` UUID is per-install in both cases, so this is unlikely to
  matter, but it was not verified against an AMO-signed build.
- **macOS only.** CPU sampling is `ps`-based and macOS-specific.
- **`Content-Security-Policy: sandbox` was not tested.** The same gap exists in
  the Chrome results on #51. A sandboxed page gets an opaque origin, which could
  plausibly change the frame's behaviour.
- **Termination was measured on the strictest variant only.** The frame and its
  worker were verified on all eight; the CPU and ping numbers come from
  `default-src 'none'; frame-src 'none'`.
- **Each half of the regex pair comes from a different process.** That is forced
  by the one-fresh-process-per-regex-measurement rule, so the "largest single
  process" column compares different PIDs. The whole-browser totals in the same
  table are not affected by that, and they tell the same story.
- **The five-second regex abort was observed, not explained.** See the cautions
  above. It should not be built on.

## Reproducing

```
node research/firefox-worker-probe/run.mjs
```

Roughly fifteen minutes, non-interactive, leaves no browser process behind. Do
not open Firefox while it runs — see the README for why. Raw per-run output,
including each launch's `web-ext` log, is under
`research/firefox-worker-probe/results/`.
