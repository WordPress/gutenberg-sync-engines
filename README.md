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

## Requirements

WordPress 7.0 and the
[Presence API](https://wordpress.org/plugins/presence-api/) plugin, which
must be active before this plugin can be activated. The wp-env
environments and both Playground blueprints install it.

## Install and try it

1. Install and activate the Presence API.
2. Install the [latest release zip](https://github.com/WordPress/gutenberg-sync-engines/releases/latest)
   and activate it. Activation creates the storage tables and turns the
   Gutenberg "Real-time collaboration" experiment on.
3. Open the same post in two browsers as two users and type. Changes
   appear in the other window within seconds.

The defaults (the intent-log engine, polling with a WebRTC advisory
channel) need nothing from the host. The step-by-step page, including
the development environment and WordPress Playground, is
[docs/getting-started.md](docs/getting-started.md); every option is in
[docs/settings.md](docs/settings.md).

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

To choose one, and see what each gives up, read
[docs/engine-comparison.md](docs/engine-comparison.md).

### Transports

- **http-polling**: the editor asks the server for updates on a short
  timer. Every host can run it (default). Beside it, an **advisory
  channel** links the browser tabs on one post. It tells each tab who
  else is here and when to fetch new changes, and it never carries
  content, so a tab polls only when there is something to fetch. It runs
  over WebRTC between browsers or over a WebSocket.
- **sse**: one long-lived response per tab that the server writes each
  change to (server-sent events), woken by Redis when a Redis address is
  configured and by half-second storage checks otherwise. Needs a proxy
  that passes streams through unbuffered.
- **sse-daemon**: the same stream, written by the sync daemon that the
  websocket transport runs, on the same port. It holds no PHP worker per
  tab, and it works where a proxy blocks the WebSocket upgrade.
- **websocket**: the server pushes updates over a persistent connection
  served by a bundled PHP daemon (`wp collaboration sync-server`).

[docs/transports.md](docs/transports.md) compares them;
[docs/operations.md](docs/operations.md) says what each needs from a
host.

### Storage

Collaboration sessions live in two plugin-owned tables instead of post
meta, so no collaboration write touches post caches. Who is present
lives in the Presence API's table. Deactivating the plugin keeps the
tables and every session; deleting it drops them. See
[docs/storage.md](docs/storage.md).

## Architecture

The plugin registers engines and transports with the collaboration
framework in Gutenberg (the `@wordpress/sync` package and the
`lib/experimental/collaboration/` server) through the `wp_sync_engines`
and `wp_sync_transports` PHP filters and the `registerSyncEngine` and
`registerSyncTransport` JavaScript functions. The server says which
engine and transport to use, and the browser checks that it has them.
If they do not match, the editor uses the classic post lock instead, so
nothing is corrupted. The framework ships no engines and no transports
of its own; without this plugin, collaboration is off.

How an edit travels is in [docs/data-flow.md](docs/data-flow.md). How to
add an engine or a transport is in [docs/extending.md](docs/extending.md).
The framework's own design notes are at
`gutenberg/prototypes/sync/ARCHITECTURE.md` inside this repository's
bundled Gutenberg. Every page is indexed in
[docs/README.md](docs/README.md).

## Comparing the engines

Moving merge work to the server has a cost, and the point of this
repository is to measure it. `npm run bench` reports what the plugin
adds to a server on your own hardware, and
`npm run bench -- --suite=engines` prints the engine comparison. The
benchmarks, the fuzzer, and the debugging tools are described in
[tests/benchmarks/README.md](tests/benchmarks/README.md),
[tests/fuzzer/README.md](tests/fuzzer/README.md), and
[tests/debugging/README.md](tests/debugging/README.md).

## Development

The framework is maintained in a separate Gutenberg branch and copied
into `gutenberg/` as a squashed Git subtree. Each plugin commit pins one
exact framework commit, and the plugin loads this bundled copy when no
standalone Gutenberg plugin is active.

```bash
composer install          # PHP tooling
npm install               # Plugin dependencies
cd gutenberg && npm ci --ignore-scripts && npm run build && cd ..
npm run build             # Plugin client bundle
npm run env start         # Start WordPress at http://localhost:8888
npm run env:stop          # Stop it (and the Redis container)
npm run test:js           # Jest
npm run test:php          # PHPUnit in the wp-env tests container
npm run test:e2e          # Playwright, two-browser collaboration
```

`npm run playground` serves the built checkout on a local WordPress
Playground instead. `AGENTS.md` is the full guide to working in the
repo: environments, the test ladder, diagnostics, and the traps.
Framework development and updating the pin are in
[docs/gutenberg-subtree.md](docs/gutenberg-subtree.md). To type in a
second window by yourself, see [tests/tools/README.md](tests/tools/README.md).

## Maintainers

This plugin is maintained by the WordPress Core team, with contributions from
the community. The maintainers are:

- Chris Zarate ([@chriszarate](https://github.com/chriszarate))
- Alec Geatches ([@alecgeatches](https://github.com/alecgeatches))
- Joe Fusco ([@josephfusco](https://github.com/josephfusco))

## Feedback

Open GitHub issues or discuss in `#feature-realtime-collaboration` channel in
[WordPress Slack](https://make.wordpress.org/chat/). To contribute, see
[CONTRIBUTING.md](CONTRIBUTING.md).
