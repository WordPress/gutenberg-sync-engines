# Gutenberg sync engines

An exploratory WordPress plugin for trying out **server-aware** real-time
collaboration in Gutenberg. It provides three candidate sync **engines**
(how the server merges edits from several people) and several
**transports** (how updates move between the editor and WordPress). Each
can be selected from a settings screen, so they can be compared on the
same site under the same conditions.

**This plugin is a decision tool, not a solution.** Real-time
collaboration was removed from WordPress 7.0, and the concerns behind
that decision call for a change in direction: collaboration should run
through WordPress, with Core in control. The reasoning is explored in
[Moving to a server-aware approach for collaboration](https://make.wordpress.org/core/2026/09/18/moving-to-a-server-aware-approach-for-collaboration/).

This repository is where candidates are built, measured, and compared so
that one can be chosen. The eventual goal is to package the preferred
engine as a feature plugin for wider testing.

## What it provides

### Engines

- **intent-log**: the editor sends short descriptions of what changed,
  such as "move this block". The server keeps an ordered log of these
  and works out how to combine edits that overlap (an operational
  transform engine). Genuine conflicts are set aside for someone to
  review, so no work is silently lost.
- **yjs-server**: a PHP implementation of Yjs. The server holds a shared
  document for each post in a format built to merge automatically (a
  CRDT), merges every update into it, compacts it by itself, and produces
  the post content from it.
- **de-rtc** (Distributed Editing): the server compares three versions
  of the post, the latest saved version, the editor's proposed version,
  and the version the editor started from, and combines the changes (a
  three-way merge). Sync happens on save or autosave, not on every
  change. Genuine conflicts are flagged for someone to review instead of
  silently merging.

### Transports

- **http-polling**: the editor asks the server for updates on a short
  timer (`POST /wp-sync/v1/updates`). Every host can run it (default).
- **sse**: one long-lived response per tab that the server writes each
  change to (server-sent events), woken by Redis when a Redis address is
  configured and by half-second storage checks otherwise. Needs a proxy
  that passes streams through unbuffered.
- **websocket**: the server pushes updates over a persistent connection
  served by a bundled PHP daemon (`wp collaboration sync-server`). For
  local dev, `npm run rtc:ws` starts everything in one command (and
  `npm run rtc:http` switches back).

**The advisory channel.** Polling is the universal base transport, but
frequent polling costs the server and infrequent polling feels slow. An
advisory channel connects peers and exchanges only who is present and 
announcements of new updates (never content). With the channel open, a peer
polls when there is something to fetch and otherwise idles. The channel
runs over a direct WebRTC link between browsers or over a WebSocket.

### Storage

- Two plugin-owned tables, `wp_sync_updates` (the update log) and
  `wp_sync_room_meta` (which engine created the room, who is
  present, engine bookkeeping),
  substituted for Gutenberg's default post-meta storage. No collaboration
  write touches post caches. On a site with a persistent object cache
  (Redis, Memcached), who is present in a room is kept in the cache
  rather than the database, the storage strategy the WordPress hosting
  performance tests recommended; a poll that changes nothing writes
  nothing. Activating the plugin creates the tables;
  deactivating it leaves them and every room in place; deleting the
  plugin (`uninstall.php`) or running `wp collaboration storage drop`
  removes them. `wp collaboration storage status` shows what a site has.

The active engine, and how editors get each other's changes (polling,
polling with an advisory channel over WebRTC or a WebSocket,
server-sent events, or WebSocket), are chosen on the plugin's **Settings →
Collaboration** screen (or via `wp_sync_engine` / the
`WP_COLLABORATION_TRANSPORT` config value).

## Comparing the engines

Moving merge work to the server has a cost, and the point of this
repository is to measure it: run `npm run bench` for a report of what the
plugin adds to a server on your own hardware, and `npm run bench -- --suite=engines`
for the full engine-decision numbers.

## Maintainers

This plugin is maintained by the WordPress Core team, with contributions from
the community. See the [CODEOWNERS](.github/CODEOWNERS) file for the current list
of maintainers.

## Feedback

Open GitHub issues or discuss in `#feature-realtime-collaboration` channel in
[WordPress Slack](https://make.wordpress.org/chat/).

## Architecture

Both axes are independent registries with a client/server handshake: the
server announces the active engine + transport, the client negotiates
against what it has registered, and any mismatch degrades to a post lock
rather than corruption. See Gutenberg's
`prototypes/sync/ARCHITECTURE.md` for the full picture.

The plugin registers via:

- PHP: the `wp_sync_engines` and `wp_sync_transports` filters.
- JS: `registerSyncEngine` / `registerSyncTransport`, unlocked from
  `@wordpress/sync`'s private APIs.

## Development

The framework is maintained in a separate Gutenberg branch and checked out
at `gutenberg/` as a **Git submodule**. Each plugin commit pins one exact
framework commit. The plugin loads this bundled copy when no standalone
Gutenberg plugin is active.

### Setup

```bash
git submodule update --init --recursive
composer install          # PHP tooling
npm install               # Plugin dependencies
cd gutenberg && npm ci --ignore-scripts && npm run build && cd ..
npm run build             # Plugin client bundle
```

A fresh clone can use `git clone --recurse-submodules`. After switching
plugin branches or creating a plugin worktree, run the submodule update
command again, then rebuild if its pin changed. Save any local framework
edits before updating its checkout.

Framework development, rebasing, and updating the pin are described in
[docs/gutenberg-submodule.md](docs/gutenberg-submodule.md).

### Environment

```bash
npm run env start         # Start WordPress (Gutenberg submodule + this plugin)
npm run env stop          # Stop it
```

Alternatively, try it using WordPress Playground. Note: On the official
WordPress playground, every browser tab is its own WordPress site, so a second
tab cannot join the first tab's editing session. Instead, use a local
Playground instance:

```bash
npm run playground
```

### Tests

```bash
npm run test:js           # Jest — engines/providers + frozen-core vectors
npm run test:php          # PHPUnit in the wp-env tests container (loads the
                          # Gutenberg submodule as the framework, then the plugin)
npm run test:e2e          # Playwright — two-browser collaboration against the
                          # running env (needs `npx playwright install chromium`)
```

### Benchmarks and tools

- `tests/benchmarks/` — a server-side engine benchmark harness: it drives any
  registered engine through the production ingest/read seam and reports
  service-time percentiles, payload and storage growth, and (for intent-log)
  merge-quality metrics; `compare.js` renders multiple runs side by side.
  See `tests/benchmarks/README.md` for how to run it and how to read the
  numbers.
- `tests/benchmarks/transport/` — a transport experience benchmark: two real
  browser clients measure edit-to-visible propagation latency and wire
  traffic (editing + idle) per transport. See its README.
- `tests/tools/` — Node CLI utilities: a long-running intent-log simulator
  sweep (`node tests/tools/sweep.js`), a manual two-tab sync observer against
  a live environment (`node tests/tools/observe-two-tab-sync.mjs`), and the
  frozen-core test-vector generators.

### Testing by yourself

If you need to test behavior by yourself, you can open a separate browser and use this script in the console.

```
(async () => { const { subscribe, select } = wp.data; const clientId = await new Promise((resolve) => { const initial = select('core/block-editor').getSelectedBlockClientId(); if (initial) { resolve(initial); return; } const unsubscribe = subscribe(() => { const id = select('core/block-editor').getSelectedBlockClientId(); if (id) { unsubscribe(); resolve(id); } }); }); const doc = document.querySelector('iframe[name="editor-canvas"]')?.contentDocument ?? document; const blockEl = doc.querySelector(`[data-block="${clientId}"]`); const editable = blockEl?.querySelector('[contenteditable="true"]') ?? blockEl; if (!editable) { console.warn('No editable element found for block', clientId); return; } editable.focus(); const sel = doc.defaultView.getSelection(); if (!sel.rangeCount || !editable.contains(sel.anchorNode)) { const r = doc.createRange(); r.selectNodeContents(editable); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); } let i = 0; const intervalId = setInterval(() => { const char = String(i % 10); const keyInit = { key: char, code: `Digit${char}`, keyCode: 48 + Number(char), which: 48 + Number(char), bubbles: true, cancelable: true }; editable.dispatchEvent(new KeyboardEvent('keydown', keyInit)); const notCancelled = editable.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true, cancelable: true })); if (notCancelled) { const s = doc.defaultView.getSelection(); if (s.rangeCount) { const r = s.getRangeAt(0); r.deleteContents(); const t = doc.createTextNode(char); r.insertNode(t); r.setStartAfter(t); r.setEndAfter(t); s.removeAllRanges(); s.addRange(r); } editable.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true })); } editable.dispatchEvent(new KeyboardEvent('keyup', keyInit)); i++; }, 60); window.__stopTyping = () => { clearInterval(intervalId); console.log('Stopped.'); }; console.log('Typing started on block', clientId, '— run window.__stopTyping() to stop.'); })();
```

It will keep typing and let you test different scenarios. You can stop it by entering `window.__stopTyping()` in the same console you ran the original command.
