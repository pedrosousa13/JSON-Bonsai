# JSON Bonsai

Prune, shape, and navigate giant JSON trees — a browser extension JSON viewer built to stay smooth on 100k+ node payloads.

> **Note:** JSON Bonsai is a fork of [JSON Alexander](https://github.com/wesbos/JSON-Alexander) by [Wes Bos](https://github.com/wesbos). Original work © Wes Bos, MIT licensed — see [LICENSE](LICENSE).

![JSON Bonsai](icons/json-bonsai.webp)

![Preview Chrome](src/preview-chrome.png)

![Preview Firefox](src/preview-firefox.png)

## Features

- Virtualized tree rendering — smooth scrolling and interaction on 100k+ node payloads
- JMESPath query bar (`Q`) — filter and reshape the JSON; the result renders as a fully interactive tree
- Content search in a web worker with match navigation (`⌘F` / `⌘G`, `Enter` / `Shift+Enter`)
- Four view modes: Tree, Formatted, Raw, and Schema (inferred JSON Schema, draft-07)
- Syntax highlighting for keys, strings, numbers, booleans, and null; URLs become clickable links
- Collapsible/expandable tree view with level controls — press `1`–`8` to set depth, `0` to expand all
- Hover any property to see its full JSON path — click to pin, then copy
- Per-node actions: copy any subtree's value, expand/collapse all children
- Copy JSON to clipboard (`C`) — copies what the active view shows (raw, pretty, schema, or query result)
- JSON payload available in the console as `window.data`
- Light, dark, and auto (system) themes
- Indent guide lines with hover highlighting
- Optional custom cursor (via settings)
- Cross-platform builds (Windows/macOS/Linux) and a single package that works in both Chrome and Firefox

## Installation

Prebuilt `.zip` packages are attached to each [GitHub Release](https://github.com/pedrosousa13/JSON-Bonsai/releases). To run from source, build it first — the `dist/` folder is not committed:

```bash
npm install
npm run build
```

### Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the **`dist`** folder inside this project

### Firefox

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select the `manifest.json` file inside **`dist`**

#### Disable Firefox's Native JSON Viewer

Firefox has a built-in JSON viewer that can prevent this add-on from taking over JSON pages. Disable it first:

1. Open a new tab and go to `about:config`
2. Accept the warning prompt if shown
3. Search for `devtools.jsonview.enabled`
4. Set it to `false`
5. Reload any JSON page

## Development

```bash
npm run dev      # watch mode — rebuilds on file changes
npm run build    # production build
npm run zip      # build and create json-bonsai.zip
npm run package  # build and create per-store zips (Chrome + Firefox)
```

Releases are automated: pushing a `v*` tag runs `.github/workflows/release.yml`, which builds, packages, attaches the zips to a GitHub Release, and (when store credentials are configured as repository secrets) publishes to the Chrome Web Store and Firefox Add-ons.

After making changes, reload the extension in your browser.

## Usage

Navigate to any URL that returns JSON (e.g. `https://jsonplaceholder.typicode.com/users`). The extension automatically detects JSON responses and replaces the page with an interactive viewer.

- **Level buttons** (1, 2, 3... All) — collapse/expand the tree to a specific depth
- **View picker** (Tree / Formatted / Raw / Schema) — switch between interactive tree, pretty-printed JSON, raw JSON, and an inferred JSON Schema
- **Query** (ƒ or `Q`) — run a [JMESPath](https://jmespath.org) expression, e.g. `items[?price > \`10\`].name`; the result replaces the tree, ✕ on the chip restores the document
- **Search** (⌕ or `⌘F`) — find keys, values, and paths; `Enter` / `Shift+Enter` step through matches
- **Theme toggle** — cycle between auto, dark, and light
- **Copy JSON** (`C`) — copy what the active view shows
- **Click any line** — pins the JSON path in the toolbar, click Copy to copy it
- **Keyboard** — `1`–`8` set tree depth, `0` expands all, `C` copies, `Q` queries, `⌘F` searches
- **Console** — the parsed JSON is available as `window.data`
- **Settings** (⚙) — toggle custom cursor

> **Privacy note:** the `window.data` convenience exposes the parsed payload to the page's main-world JavaScript (including any other extensions running there) on the page's own origin. It is not reachable by a remote attacker, but if you view authenticated API responses on a page that also runs scripts, be aware the payload is visible to them.
