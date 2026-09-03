# Firefox worker hosting under page CSP

Answers issue #84, which blocks the architecture decision on #51. Chrome's side of
this was already measured and is recorded on #51; this document is the Firefox
column, produced with the harness in `research/firefox-worker-probe/`.

## Short answers

1. **Does a content-script-injected `moz-extension://` iframe load in Firefox
   when the page sends `frame-src 'none'` or `default-src 'none'`? Yes.** It
   loads, and the worker it hosts works. Firefox exempts the frame the same way
   Chrome does.
2. **Can that frame host a terminable worker? Yes.** It constructs a same-origin
   `new Worker("tree-worker.js")`, relays over `postMessage`, and `terminate()`
   genuinely stops the thread — confirmed by process CPU, not just by
   `terminate()` returning.
3. **Do blob-URL workers work from a Firefox content script under page CSP? No.**
   Blocked by `default-src 'self'` and by `default-src 'none'`, exactly as in
   Chrome, and reported as a `worker-src` violation.
4. **Do the `web_accessible_resources` entries need a different shape? No.** One
   entry serves both browsers. `use_dynamic_url` is accepted by the Firefox
   linter but has no runtime effect there.

**Recommendation: one shared architecture, no per-browser branch.** Details at
the end.

## Environment

| | |
| --- | --- |
| Browser | Mozilla Firefox 154.0b3 (Firefox Developer Edition) |
| User agent | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:154.0) Gecko/20100101 Firefox/154.0` |
| Platform | macOS, Darwin 25.6.0, arm64 |
| Tooling | `web-ext` 10.6.0 via `npx`, Node 24.16.0 |
| Date | 2026-09-03 |

**Version gap, stated plainly.** `manifest.json` sets
`browser_specific_settings.gecko.strict_min_version` to `115.0`. Everything below
was measured on 154.0b3, and 154.0b3 is a beta. There is no other Firefox on this
machine, so nothing between 115 and 153 was tested, and neither was a release
build of 154. The behaviour being relied on — extension frames exempt from page
CSP, same-origin workers inside them — is long-standing, but "long-standing" is
not a measurement. If #51 ships on this, either raise `strict_min_version` to a
version that has actually been tested, or re-run this harness against an older
Firefox before release.

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

## Result table: one row per CSP variant

Each row is its own Firefox launch against a fresh profile. "A blob" is a
blob-URL worker created directly by the content script. "B frame" is an iframe at
`runtime.getURL("worker-host.html")` injected by the content script. "B worker"
is that frame's own `new Worker("tree-worker.js")`. "B2 dyn" is the same frame
test against a resource declared `use_dynamic_url: true`.

| Page response | A blob | B frame | B worker | B2 dyn |
| --- | --- | --- | --- | --- |
| no CSP | works | loads | works | loads |
| `default-src 'self'` | **blocked** | loads | works | loads |
| `default-src 'none'; frame-src 'none'` | **blocked** | loads | works | loads |
| `application/json` + `default-src 'self'` (JSON viewer off) | **blocked** | loads | works | loads |
| `application/json` + `default-src 'self'` (JSON viewer on, Firefox default) | content script never ran | — | — | — |
| `default-src 'none'; frame-src 'none'`, default origin controls | **blocked** | loads | works | loads |

Two rows need explanation.

**The JSON viewer row.** Firefox ships a built-in JSON viewer, on by default. On
that document the probe's content script never ran at all — the launch timed out
with zero reports. This is not new and not caused by anything here: the project
README already tells Firefox users to set `devtools.jsonview.enabled` to `false`
before the extension will take over JSON pages. The supported configuration is
the row above it, which works. Worth knowing that the failure mode is "no content
script", not "content script with a broken worker".

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

The page's CSP report is where the reason actually appears:

```json
{"blockedURI":"blob","violatedDirective":"worker-src","originalPolicy":"default-src 'self'"}
```

This matches Chrome exactly, including the useless error event. Detection has to
be a handshake with a timeout in both browsers. Firefox's expanded content-script
principal does not buy an exemption here.

## Termination evidence

All of this ran on the strictest variant, `default-src 'none'; frame-src 'none'`.
The workload is the proven freeze case from #51: `(z+)+.{0,24}$` against 30 `z`
characters followed by 170 `y` characters. The page main thread was pinged every
25 ms throughout, and the largest gap between ticks recorded. Process CPU was
sampled by summing `ps` cumulative CPU time across every Firefox process, over a
fixed 6-second window opened by a signal from the probe itself.

| Measurement | CPU over the window | Largest single process | Main-thread max ping gap |
| --- | --- | --- | --- |
| Worker left running | **+5.39 s** over 6056 ms | +5.00 s | 31 ms (208 ticks) |
| After `terminate()` | **+1.01 s** over 6059 ms | +0.91 s | 31 ms (213 ticks) |
| Unbounded spin, running | **+6.42 s** over 6043 ms | +6.07 s | 37 ms (185 ticks) |
| Unbounded spin, after `terminate()` | **+0.24 s** over 6093 ms | +0.14 s | 36 ms (194 ticks) |

`terminate()` returned in 0 ms, and a worker spawned in the frame afterwards
answered its handshake normally.

The unbounded-spin pair is the cleaner of the two, and it is there for a reason.
The regex workload stops by itself after about five seconds (see below), so part
of the "worker left running" window is the worker already having finished — which
also inflates the after-terminate figure with unrelated browser work. The spin
case is a plain `for(;;)` that nothing but `terminate()` can stop: one core
pegged for the entire six seconds while running, effectively nothing after
terminating. That is the claim, measured directly.

**The page never stalled.** Across every worker measurement the largest gap
between 25 ms pings was 38 ms. There is no point at which a user would have
noticed.

### The main-thread baseline

Same pattern, same input, on the page's own main thread, in a fresh Firefox
process:

- `regex.test` occupied the thread for **6717 ms** and then threw.
- The ping interval managed **3 ticks**, with a **6740 ms** gap. The page was
  frozen for the whole of it.
- CPU over that window: +9.39 s total, +6.71 s on the busiest process.

So the bug #51 exists to fix is real on Firefox too. A catastrophic pattern
freezes the page.

### An important Firefox-specific finding

Firefox does not run these patterns forever. All three catastrophic patterns from
#51, each in its own fresh process, aborted with
`InternalError: too much recursion`:

| Pattern | Input | Where | Time to abort |
| --- | --- | --- | --- |
| `(z+)+.{0,24}$` | `z`×30 + `y`×170 | worker | 5009 ms |
| `(a+)+$` | `a`×30 + `b` | worker | 4984 ms |
| `\w{40}(\w+)+!` | `a`×200 | worker | 4991 ms |
| `(z+)+.{0,24}$` | `z`×30 + `y`×170 | page main thread | 6717 ms |

Chrome ran the first of these for **69,935 ms** before returning. Firefox stops
at roughly five seconds.

Three cautions before anyone treats that as a safety property:

- **The mechanism was not determined.** Three unrelated patterns aborting within
  30 ms of each other looks more like a time-based abort than the stack
  exhaustion the error message names, but that was not established, and a
  five-second budget is not documented anywhere as an API guarantee.
- **It is not a general limit on worker runtime.** The unbounded `for(;;)` in the
  same worker ran the full six-second window at 100% of a core with no abort at
  all. Firefox will happily let a worker spin forever; only this regex path
  stopped.
- **Six and a half seconds of frozen page is still a bug.** It is two orders of
  magnitude better than Chrome's seventy seconds, but it is not acceptable
  behaviour, and it is measured on one browser version.

The conclusion for #51 is unchanged: run the regex where it can be terminated.
The Firefox number just means the symptom is less catastrophic there, not that it
is absent.

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
  `browser.runtime.getURL("worker-host-dyn.html")` returned
  `moz-extension://9f5f9486-…/worker-host-dyn.html` — the ordinary static URL,
  identical in shape to the non-dynamic resource — and the frame loaded from it
  normally. There is no dynamic token.
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
  browsers.** Verified 4/4 in Chrome, and 4/4 here — including
  `default-src 'none'; frame-src 'none'`, and including `application/json` pages
  in the configuration the project already requires of Firefox users.
- **Blob workers are dead on both.** `default-src 'self'` is common on real JSON
  endpoints, and Firefox blocks blob workers exactly as Chrome does. Firefox's
  expanded content-script principal changes nothing here, so the hoped-for
  simpler Firefox branch does not exist.
- **Termination works identically on both.** Both browsers genuinely interrupt
  the thread, confirmed by CPU on each.
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

- **One Firefox version.** 154.0b3, a beta, against a declared
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
  worker were verified on all four; the CPU and ping numbers come from
  `default-src 'none'; frame-src 'none'`.
- **The five-second regex abort was observed, not explained.** See the cautions
  above. It should not be built on.

## Reproducing

```
node research/firefox-worker-probe/run.mjs
```

Roughly fifteen minutes, non-interactive, leaves no browser process behind. See
`research/firefox-worker-probe/README.md` for what each file does and which
environment variables override the browser path and port. Raw per-run output is
under `research/firefox-worker-probe/results/`.
