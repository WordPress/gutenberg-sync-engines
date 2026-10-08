# AGENTS.md

Operational guide for working in this repo. Read this first.

## Language

- IMPORTANT: Write clear, short sentences as if explaining things to a
  less-technical friend. Avoid all technical jargon and self-invented terms.
  Do not use abstract structural metaphors or shorthand arrow chains.
- Practice "BLUF": Bottom Line Up Front. Start with the main point or
  conclusion, then provide supporting details.
- Be as concise as possible without omitting essential information.
- Before posting something for external consumption, run the draft past a fresh
  subagent instructed to flag jargon and follow these language rules. Use a
  model that is skilled at summarizing.

## What this is

`gutenberg-sync-engines` is a WordPress plugin that supplies the
**engines** (how edits from several people merge) and the **transports**
(how updates move) for Gutenberg's real-time collaboration framework.
The framework lives in Gutenberg: its client is the `@wordpress/sync`
package and its server is `lib/experimental/collaboration/`. It knows no
particular engine. It provides a sync manager (`createSyncManager`), a
registry of engines and a registry of transports that the client and
server agree on at startup, the `SyncEngine` interface an engine
implements, and the Yjs library as `wp.sync.Y`. Without this plugin
active, the framework has nothing to negotiate and the editor falls back
to the classic one-person post lock. The split is complete: the
framework ships neither engines nor transports.

This plugin provides:

- **Three engines:** `intent-log` (the default when the `wp_sync_engine`
  option is unset; the server keeps a log of typed edits and sets
  genuine conflicts aside for review), `yjs-server` (the server merges
  Yjs updates with the vendored y-php library and has no conflict review),
  and `de-rtc` (Distributed Editing: clients send the whole post plus
  the version they started from, and the server merges it with the
  other changes). A
  configured engine that is not registered falls back to the first
  registered one, yjs-server. The decision guide and each engine's
  known gaps: `docs/engine-comparison.md`.
- **Four transports:** `http-polling` (the default), `sse`, `sse-daemon`,
  and `websocket`. Beside polling, every editor tab opens an **advisory
  channel** to the other tabs on its post (`src/providers/advisory/`,
  over WebRTC by default or a WebSocket to the daemon or a host's own
  relay) that carries presence and "go and poll" notices, never content,
  and decides the polling cadence. Behavior: `docs/transports.md` and
  `docs/advisory-channel.md`; the room envelope and routes:
  `docs/protocol.md`; what a host needs: `docs/operations.md`; the
  credentials: `docs/security.md`.
- **Settings:** one "Transport" radio list of (transport, advisory
  channel) pairs plus the engine, the server addresses, the polling
  interval (5 s default), the de-rtc commit cadence (10 s), the
  awareness interval, and "Unsaved changes" (default: a room nobody is
  in is reset to the saved post; `docs/room-lifetime.md`). Every option,
  default and override: `docs/settings.md`.
- **Storage:** rooms live in two plugin-owned tables, `{$prefix}sync_updates`
  (the update log; the row id is the cursor) and `{$prefix}sync_room_meta`
  (lineage, presence, engine bookkeeping), through `WP_Sync_Table_Storage`,
  substituted for the framework's post-meta default. Columns, the keys
  each engine writes, the object-cache strategy, the version counter,
  and the lifecycle commands: `docs/storage.md`.
- **Awareness:** who is in a room, read and written only through
  `WP_Sync_Awareness`; held in the required Presence API's `wp_presence`
  table when it is recording, else with the room's other data.
  `docs/storage.md` (Presence).

It registers through the framework's extension points: the PHP
`wp_sync_engines` and `wp_sync_transports` filters, and the JavaScript
`registerSyncEngine` and `registerSyncTransport` functions, unlocked
from `@wordpress/sync`'s private APIs. The engine and transport are
chosen on **Settings → Collaboration** (the `wp_sync_engine` option and
the `WP_COLLABORATION_TRANSPORT` config value). How to add one:
`docs/extending.md`.

## Repo layout

Paths only; what each piece does is in the docs it points at.

- `gutenberg-sync-engines.php` — plugin entry (activation creates the
  tables and turns the RTC experiment on; loads the bundled Gutenberg).
- `includes/` — server PHP.
  - `engines/{intent-log,yjs-server,de-rtc}/` — one folder per engine;
    none uses another's classes. `engines/de-rtc/merge-core.php` is the
    frozen merge core (`docs/vendored-libraries.md`).
  - `shared/` — code more than one engine uses: `WP_Sync_Block_Identity`
    (the block-id scheme for a post's first load), the editor-side
    block-id stamper `sync-id.js`, and `WP_Sync_Post_Genesis_Props` (a
    post's starting field values).
  - `transports/` — the polling server, `sse/`, and `websocket/` (the
    daemon, its CLI command, the token route, the access token).
  - `admin/` — the Settings → Collaboration screen (`docs/settings.md`).
  - `storage/` — the room tables: schema, storage, and the
    `wp collaboration storage` CLI (`docs/storage.md`).
  - `diagnostics/` — session capture, the request log, the rooms CLI;
    loaded on local/development sites only (see Diagnostics).
  - `lib/` — vendored y-php and automerge-php with their loaders
    (`docs/vendored-libraries.md`).
  - `class-wp-sync-awareness.php` and the `*-backend.php` interfaces —
    the replaceable presence, lock, and atomic-update backends.
- `src/` — client TypeScript; webpack entry `src/index.ts` builds
  `build/sync-engines.js` with `@wordpress/sync` and `yjs` external
  (`wp.sync`, `wp.sync.Y`).
  - `engines/intent-log/` — the frozen intent-log core: plain JavaScript
    typed through JSDoc, excluded from prettier, kept identical to its
    PHP twin and the vectors (`docs/vendored-libraries.md`).
  - `engines/yjs-server/` — the yjs-server engine with its Yjs client
    modules and the vendored `y-utilities/` (ignored by eslint). No
    other engine uses Yjs: de-rtc keeps a plain record
    (`engines/de-rtc/record.ts`), intent-log its own document.
  - `shared/awareness-sync.ts` — presence bridging all three engines
    use; no engine folder imports another engine's folder.
  - `providers/{http-polling,sse,sse-daemon,websocket}/` and
    `providers/advisory/` — the transports and the advisory channel
    (sse and sse-daemon reuse the polling manager).
  - `awareness/` — slow awareness (`docs/awareness-high-latency.md`).
    `registry.ts` installs the `gseBlock` field's equality check on
    EVERY awareness instance the engines create, in every mode. A peer
    can carry the field at any time, and core-data throws on an unknown
    field.
  - `entity-sync/` — registers the default entity sync adapter after
    engines and transports (`docs/entity-sync-adapter.md`).
  - `framework.ts` — unlocks `@wordpress/sync`'s private APIs once.
  - `debug/inspector.ts` — the `window.wpSync` wire inspector.
- `gutenberg/` — the pinned, squashed Gutenberg subtree (source only;
  see below).
- `tests/` — all tests, fixtures, and tooling: `phpunit/` (boots via
  `tests/bootstrap.php`), `js/` (Jest, mirroring `src/`;
  `js/engines/intent-log/` is the frozen core's harness), `e2e/`
  (Playwright specs, config, fixture plugins, and the `bin/` launchers),
  `benchmarks/` (`npm run bench`; its README), `debugging/` (the soak
  and the capture/replay tools; its README), `fuzzer/` (`npm run fuzz`;
  its README), and `tools/` (vector generators, the simulator sweep, the
  two-tab observer; its README).
- `bin/` — repo scripts, not shipped: `build-plugin-zip.sh` (the release
  zip) and `release.mjs` (humans only, see Releasing).
- `blueprint.json` / `blueprint.local.json` — WordPress Playground
  blueprints: the public one for playground.wordpress.net and the one
  `npm run playground` applies to the checkout (see Environment).
- `examples/advisory-relay/` — the bring-your-own WebSocket relay a host
  copies (Node + `ws`); linted with `npm run lint:js`.
- `docs/` — the documentation, indexed by reader in `docs/README.md`
  (every page is listed there). The pages are deliberately number-free:
  run `npm run bench` for numbers, and keep the SHAPES current when
  engine capabilities or benchmarks change. `docs/plan/` holds how we
  plan work (`README.md`), why the code is shaped this way
  (`history.md`), and what we set aside (`wontfix.md`); the work itself
  lives in GitHub Issues.

## The `gutenberg/` subtree

`gutenberg/` is a squashed Git subtree of Gutenberg, pinned by
`gutenberg-pin.json` (the only place that names the bundled commit).
The plugin loads `gutenberg/gutenberg.php` when no standalone Gutenberg
is active; a normal clone includes the source, and the build is
generated locally. Framework changes are maintained on the Gutenberg
`try/sync-engines` branch and imported here after review. Procedure and
what to retain on an update: `docs/gutenberg-subtree.md` and
`docs/entity-sync-adapter.md`.

## Setup (from a clean checkout)

```bash
composer install          # PHP tooling (PHPCS/WPCS, PHPUnit 9 + polyfills)
npm install               # JS tooling (@wordpress/scripts, wp-env, Playwright)

# Build the vendored Gutenberg once (source-only in git). Heavy (~1-2 min build,
# plus a large npm install). Required for wp-env to serve working editor assets
# AND for Jest/typecheck, which resolve @wordpress/sync + yjs from the subtree.
# --ignore-scripts skips the Husky install hook, which needs a Git root.
# npm run build regenerates required library and manifest outputs.
cd gutenberg && npm ci --ignore-scripts && npm run build && cd ..
npm run build             # This plugin's client bundle → build/sync-engines.js
```

## Environment

Two SEPARATE wp-env configs (the split the env 11 deprecation asks for; both
set `testsEnvironment: false`, so each starts a single site):

```bash
npm run env start         # DEV env (.wp-env.json): the Presence API plugin
                          # (required) and this plugin (which loads
                          # the bundled Gutenberg subtree itself),
                          # http://localhost:8888. Its afterStart
                          # lifecycle hook auto-starts the websocket sync
                          # daemon (detached, --mode=daemon: the site's
                          # transport selection is NOT touched).
npm run env:tests start   # TESTS env (.wp-env.tests.json): same mounts,
                          # http://localhost:8889, Redis lifecycle hooks only. This is
                          # what test:php / test:e2e / CI target.
npm run env:stop          # Stops Redis + WordPress (env:tests:stop for tests)
npm run cache:on          # Puts the Redis Object Cache drop-in in (a persistent
                          # object cache on sync-redis; the SSE transport then
                          # detects Redis by itself). cache:off removes it;
                          # cache:tests:on/off for the tests env. Both configs
                          # install the plugin (bundled Predis client, no PHP
                          # extension) but leave the drop-in OUT, so the suites
                          # run without a persistent cache.
```

Redis: each config's `afterStart` hook starts a Redis container on that
environment's Docker network as `sync-redis` and sets
`WP_SYNC_SSE_REDIS_URL` to `redis://sync-redis:6379`; a Redis that fails
to start does not fail the environment start (the other transports need
no Redis), and `npm run doctor` reports the container per environment.
The hooks call the `redis:*` npm scripts; `redis:project` reads wp-env's
project name, which identifies the checkout and config, and
`GSE_WP_ENV_CONFIG=.wp-env.tests.json` selects the tests config. The
container runs with `--rm`, so stopping it removes it and the next start
creates it again; `afterDestroy` removes a leftover. This wp-env version
has no stop hook, so plain `wp-env stop` (including `npm run env stop`)
leaves Redis running: use `npm run env:stop`. With the object-cache
drop-in on (`cache:on`), the whole site's options and posts go through
Redis too, so measurements taken that way describe a Redis-backed host,
not just the transport. The transport and host benchmarks switch this
per run: `cache=none|redis` picks the persistent object cache and
`wake=auto|redis|cache|table` pins what a stream waits on (`cache` needs
`cache=redis`, `table` needs `cache=none`). Both are restored
afterwards, and both work only for this checkout's wp-env sites. The
report records the wait the streams actually got, from the
`X-WP-Sync-SSE-Wait` header.

`autoPort` is on, so when a port is busy wp-env picks a free one and prints
the URL it chose. Force ports with `WP_ENV_PORT`. Each config has its own
work dir under `~/.wp-env` (the tests one carries a `-tests-` segment), so
the two environments are fully independent — separate databases included.
Personal overrides go in `.wp-env.override.json` /
`.wp-env.tests.override.json` (both gitignored).

A third, lighter option needs no Docker: `npm run playground` (an
inline script in `package.json`) serves the checkout on a local
**WordPress Playground** (`@wp-playground/cli`: WebAssembly PHP +
SQLite) at http://127.0.0.1:9400, mounted under the fixed name
`wp-content/plugins/gutenberg-sync-engines` (worktree-safe, and only ONE
mount, so the double-mount trap below does not apply) with
`blueprint.local.json` applied: the Presence API installed and
activated first (this plugin requires it), plugin activated (its activation hook
turns the RTC experiment on), `WP_DEBUG` + `SCRIPT_DEBUG` on, a second
account (`editor` / `password`), welcome guide off. The checkout is
served as-is, so it must be BUILT (`preplayground` refuses otherwise):
PHP edits are live, JS edits need `npm run build`. Two windows on one
post collaborate over HTTP polling (the two-tab observer passes against
it); there is no websocket daemon and nothing persists across restarts.
Two flags are pinned on purpose: `--login` (the blueprint's `login:
true` alone does not log a BROWSER in on the CLI) and `--workers=1`
(with several PHP workers a tab's login session is missing on the other
workers, and the editor shows "Session expired" at random).
`blueprint.json` at the repo root is the public twin for the OFFICIAL
Playground (`https://playground.wordpress.net/?blueprint-url=<raw URL
of that file on trunk>`): it installs the Presence API from
wordpress.org, then the LATEST release zip from
GitHub (Playground routes the cross-origin download through its own
CORS proxy; the console shows a CORS error first, then the proxied
fetch succeeds). Each hosted tab is its own site, so it demonstrates a
solo session only.

## Testing

```bash
npm run test:js             # Jest: engines/providers + frozen-core vectors
npm run test:php            # PHPUnit in the wp-env tests container
npm run test:e2e            # Playwright: two-browser collaboration (+ http-only)
npm run test:e2e:websocket  # Playwright: websocket-only suite (test WS provider
                            # plugin + y-websocket daemon, auto-started)
npm run test:e2e:sse        # Playwright: sse-only suite (selects the SSE
                            # transport on the tests site; needs its Redis)
npm run test:e2e:sse-daemon # Playwright: sse-daemon-only suite (selects the
                            # sse-daemon transport; runs the PHP daemon)
```

**Iterate at the cheapest layer that can catch the change.** The ladder,
fast → slow (only the last three need wp-env):

1. **Intent-log simulator sweep** — `node tests/tools/sweep.js [seeds]
   [steps] [clients]` (defaults 60/400/3; deterministic, sub-second at
   small sizes, no WordPress). First stop for any intent-log
   planner/merge-behavior change: fails loudly on oracle violations and
   prints disposition/escalation stats so drift is visible.
2. **Jest + frozen vectors** — `npm run test:js` (needs only the built
   subtree). Engines, providers, and the cross-language vector contract.
3. **Vendored conformance suites** — y-php (~4 s) and automerge-php
   (<1 s), commands above; no WordPress. Only when touching the vendored
   libs (rare — they're frozen).
4. **PHPUnit** — `npm run test:php`. Server engines, transports, storage.
5. **e2e** — `npm run test:e2e` (minutes, browser collaboration).
6. **Fuzzer** — `npm run fuzz:quick` as a post-change smoke (all engines
   over http-polling, 2 seeds each, faults/reloads off — a few minutes
   against the running tests env); the full `npm run fuzz` matrix for
   real bug hunting (see `tests/fuzzer/README.md`).

Single-test loops — don't rerun a whole suite while iterating on one
failure:

```bash
npm run test:js -- sync-id                    # Jest files matching a pattern
npm run test:js -- -t 'name substring'        # single Jest test by name
npm run test:php -- --filter Test_Class_Name  # single PHPUnit class/method
npm run test:e2e -- collaboration-intent-log  # single e2e spec by filename
RTC_E2E_ENGINE=de-rtc npm run test:e2e        # one engine's e2e slice
```

CI runs the default e2e suite as one job per engine. A spec that
belongs to an engine puts `@engine-<slug>` in its describe title;
`RTC_E2E_ENGINE=<slug>` runs only those, and `RTC_E2E_ENGINE=none` runs
every spec without the tag. A new engine spec without the tag lands in
the `none` slice, so it still runs, only in the wrong job.

Never run `test:php` while an e2e run is in flight against the same env:
PHPUnit wipes the tests-env database, killing every in-flight spec
(auth and plugin activation vanish mid-run). Serialize the suites.

`test:php` also leaves the plugin INACTIVE (measured: active before a run,
inactive after it). A daemon lane started next fails with
`Error: 'collaboration' is not a registered wp command.` and Playwright
reports only `Process from config.webServer was not able to start`, which
points at the daemon rather than at the plugin. Reactivate before any e2e
lane that starts a daemon:

```bash
npx @wordpress/env --config .wp-env.tests.json run cli wp plugin activate gutenberg-sync-engines
```

`test:js` and `npm run typecheck` resolve `@wordpress/sync`/`yjs` from the
**built subtree** (see Setup); `WP_SYNC_FRAMEWORK_ROOT=<framework-checkout>`
points Jest at a live framework checkout instead when co-developing (tsconfig
paths stay pinned to the subtree).

`test:php` and `test:e2e` need the running TESTS env (`npm run env:tests
start`) with the subtree built; both target `.wp-env.tests.json` (test:php
runs PHPUnit in that env's cli container, Playwright's webServer starts that
env when 8889 is not already serving). For e2e also run `npx playwright install chromium` once. If the
tests site isn't on `:8889` (auto-port / override), pass
`WP_BASE_URL=http://localhost:<tests-port>`. Beware: if ANOTHER project's
wp-env holds `:8889`, Playwright's webServer check sees the port alive and
silently reuses that foreign site (wp-env credentials are identical
everywhere, so auth even succeeds); the first visible failure is a
global-setup REST call dying with
"Unexpected end of JSON input". Always pass `WP_BASE_URL` in that case
(`npm run doctor` detects this arrangement and prints the right URL).

All suites are green at head; CI (`.github/workflows/ci.yml`) is the
source of truth for exact test counts — it certifies every suite
(including `composer lint`, the websocket e2e lane, and the subtree's
collaboration-review-panel component Jest) on pushes to `trunk` and
PRs. The v1 integration tree passed the full default e2e suite three
consecutive times with retries disabled; the old login
flake is closed by the plugin-local hardened fixtures
(`tests/e2e/config/collaboration-fixtures.ts` — the root-cause subtree
fixture fix remains upstream/human-owned). One known intermittent
remains: the parked-A12 residual (intent-log mid-burst compaction
splice, issue #37), firing ~1-2 of 8 under the repetition hammer; the
e2e CI job keeps the base config's 2-retries-in-CI to absorb it. The
vendored libraries' own
conformance suites run separately:
y-php (`composer --working-dir=includes/lib/y-php test`) and
automerge-php (`php includes/lib/automerge-php/tests/run.php`).

The transport-specific e2e suites (relocated from the framework):
`tests/e2e/specs/http-only/` runs in the default suite.
`tests/e2e/specs/websocket-only/` runs only under `test:e2e:websocket`
(`playwright.rtc-websocket.config.ts`), against the plugin's REAL
websocket transport. Its launcher, `tests/e2e/bin/rtc-real-ws-daemon.mjs`,
selects the websocket transport on the tests site. It publishes the
`wp collaboration sync-server` daemon from the tests env's cli image on
host port 8787, health-checked on `/health`. It restores the previous
transport at teardown. The same config runs the example relay
(`examples/advisory-relay/relay.mjs`) on port 8790 with a fixed test
secret for `collaboration-websocket-advisory-relay.spec.ts`, which
activates the `tests/e2e/plugins/advisory-relay-access-token.php`
fixture for its duration. `tests/e2e/specs/sse-only/` runs only under
`test:e2e:sse` (`playwright.rtc-sse.config.ts`), whose setup runs
`tests/e2e/bin/rtc-sse-transport.mjs --select`; it refuses to run
without the tests env's Redis container, so it tests wake-ups through
Redis rather than through storage checks (the fuzzer applies the same
rule to `sse`). `tests/e2e/specs/sse-daemon-only/` runs only under
`test:e2e:sse-daemon` (`playwright.rtc-sse-daemon.config.ts`), which
launches `rtc-real-ws-daemon.mjs` with `--transport=sse-daemon`; both
daemon suites share `tests/e2e/config/rtc-daemon-teardown.ts`.
`tests/e2e/specs/sse-framing/` runs under both SSE suites. The specs read
`window.__wpSyncSseState` and `window.__wpSyncWsState`. How the daemon
authenticates a stream, and the symptoms when that is wrong:
`docs/transports.md` ("Server-sent events from the sync daemon").

Every tab on a post joins that post's awareness roster, and a page whose
roster exceeds `DEFAULT_CLIENT_LIMIT_PER_ROOM` (5) is refused the room:
Gutenberg shows "Too many editors connected" and the real-time path stops
for that tab. The check runs once, on the page's first connection, so a
spec that opens a sixth tab on one post fails for this reason and not
because of a transport fault. Give extra tabs their own post, or raise
the limit with the `sync.pollingProvider.maxClientsPerRoom` filter.
The old y-websocket peer-relay fixture lane (the test WS provider plugin
plus `rtc-test-ws-sync-server.mjs`) is used by no suite; the files are
kept for reference. `.wp-env.json` maps `tests/e2e/plugins` and
`gutenberg/packages/e2e-tests/plugins` as plugin dirs.
`@y/websocket-server` is pinned EXACTLY to 0.1.1: 0.1.5 switched to the
yjs-14 family and its daemon crashes (`store.getClock is not a
function`) when a 13.x client connects. `npm run rtc:ws` is the
one-command start for the real websocket transport for manual two-window
testing: it ensures the dev wp-env is running, activates the right
plugins, selects the websocket transport, and runs the daemon in the
wp-env cli container with port 8787 published to the host (wp-env alone
cannot publish extra ports, and the daemon must bind 0.0.0.0; a
loopback-bound daemon is unreachable even through a published port).
`npm run rtc:http` switches the site back to HTTP polling and stops the
daemon.

The DEV config's `afterStart` lifecycle hook runs the same script as
`--mode=daemon --detach || true`: every `npm run env start` brings the
daemon up automatically WITHOUT touching the site's transport selection
(`|| true` keeps a daemon failure from failing the start itself; the
diagnosis still prints in the spinner output). The daemon binds host port
8787 under a fixed container name, so with several checkouts/worktrees the
most recently started dev env owns it. The tests config starts Redis only — CI
and the test suites never start a daemon.

## Diagnostics

When something misbehaves, reach for these before adding printf debugging —
they exist so a failure is observable without re-instrumenting:

- **`npm run doctor`** — read-only environment preflight
  (`tests/e2e/bin/rtc-dev.mjs --mode=doctor`): builds present (plugin
  bundle, subtree, subtree node_modules), both wp-env environments
  (running? REST reachable? which port?), the worktree plugin-copy
  activation arrangement (double-mount fatals), whether the plugin
  actually loaded (`wp collaboration` commands registered), current
  engine/transport options, the foreign-wp-env-on-:8889 trap, and
  websocket daemon health. Exits non-zero on real problems, each with its
  fix. It also reports whether each env runs the Redis object cache
  drop-in. First stop when anything smells environmental — uniform timeouts
  across all engines are an environment failure, not an engine bug.
- **Browser wire inspector** — `window.wpSync` (`src/debug/inspector.ts`),
  on every editor page. `wpSync.enable()` (persists per profile), then
  `tail()` live-prints decoded traffic, `log()`/`table()` query the
  500-record ring buffer, `intents('p1')` filters history touching one
  syncId, `doc()`/`proposals()`/`cursor()` read live session state
  (intent-log), `export()` dumps JSON for bug reports, `help()` lists
  everything. Covers ALL transports: http-polling, sse, and websocket
  (sends and pushed receives are separate one-directional records on
  the socket and stream lanes).
- **Server `_debug` envelope** — enabling the inspector also stamps
  `debug: true` on each room request; all THREE engines respond with an
  `_debug` envelope (intent-log: lock wait, window rows, head seq, plan
  counts, checkpoint; yjs-server: doc bytes, appended rows, replay-repair
  flag, disposition counts; de-rtc: claim retries, version, content bytes,
  disposition counts, checkpoint) plus read-side row counts, printed as
  `⚙ server` in the tail. Gated server-side by `SCRIPT_DEBUG` (dev env:
  on; tests env: off) or the `wp_sync_debug_enabled` filter.
- **`qm/debug` narration** — all three engines and the polling transport
  narrate sync-critical events (lock timeouts, voided/escalated intents,
  repairs, checkpoints, trims, engine mismatches) through Query Monitor's
  `qm/debug` action; install Query Monitor on the dev site to see them.
- **`wp collaboration rooms`** — read-only server-side state dump:
  `wp collaboration rooms list` (every room: resolved name, engine
  lineage, row count, cursor) and `wp collaboration rooms inspect <room>
  [--rows=N] [--materialize] [--format=json]` (row-type histogram,
  decoded room meta — checkpoints, canonical doc sizes, floors —
  awareness, last-N decoded rows). Loaded ONLY under WP-CLI on
  local/development environments (wp-env reports `local`) or with the
  `GUTENBERG_SYNC_ENGINES_DIAGNOSTICS` constant — deliberately absent
  from the production path. Reads go through the table storage's
  read-only helpers (`list_rooms`, `get_room_size`, `get_last_updates`,
  `get_all_room_meta`), which cannot create a room. The presence lane
  and the room generation token read `peek_room` (two indexed lookups:
  found + first/newest row id) on every heartbeat for the same reason. `wp collaboration
  storage status|install|reset|drop` (always registered under WP-CLI)
  manages the tables themselves.
- **Session capture + request log** (`includes/diagnostics/`, same
  local/development-or-constant gate, but hooked on web requests too —
  no-ops until used): `wp collaboration capture start|stop|list|export|drop`
  records real `/wp-sync/` sessions and exports them in the community RTC
  performance harness's fixture format (replay/sanitize via
  `tests/debugging/replay/`); requests tagged `X-RTC-Test: 1` get
  per-request server metrics (dispatch/CPU ms, db_queries, db_time with
  SAVEQUERIES, memory, concurrency) logged with that harness's column
  conventions — read via `wp collaboration bench-log report [--all]` or
  the community-compatible `rtc-test/v1` REST routes
  (`/log`, `/report`, `/report-all`, `/env`). The transport benchmark
  tags its own traffic and folds these into its summary.
- **Fuzzer triage** — every run writes `summary.md` with normalized
  failure signatures and ready replay commands; `--shrink` bisects a
  reproducible failure to a minimal `--steps`; `RTC_FUZZ_LOG_SYNC=1`
  captures per-request wire summaries; every test attaches its full
  seeded action trace as `fuzz-run.json`. See `tests/fuzzer/README.md`.
- **`tests/tools/observe-two-tab-sync.mjs`** — manual two-tab observer
  against a live env: prints each tab's block store, canvas, and console
  errors for a scripted scenario.

## Gotchas (each of these has bitten — don't rediscover them)

- **Jest scope:** `jest.config.js` sets `roots: [src, tests]`. Without it,
  `wp-scripts test-unit-js` recurses into the subtree's ~1030 monorepo suites.
- **phpcs scope:** `phpcs.xml.dist` excludes `/gutenberg/*`.
- **Slow awareness (the block name) goes out with whatever already
  carries presence** (`docs/awareness-high-latency.md`):
  - Over the sync transport it is a field on the framework awareness
    state (`gseBlock`). Under short polling the advisory channel carries
    it peer to peer. Under SSE `announceLocalAwarenessChange`
    (`src/providers/advisory/announce.ts`) sends it beside the stream.
  - Under the Heartbeat channel it is a field on the discovery probe, so
    an advisory channel must be selected, and the plugin sets the admin
    Heartbeat interval on post edit screens to match.
  - The e2e spec turns the advisory channel off for its duration.
- **wp-env is a devDep here.** `@wordpress/scripts` does NOT bundle it. It's
  pinned to `@wordpress/env@^11` (for auto-port) with a top-level `overrides`
  entry, because scripts@30 only *optionally* peer-depends on env 10 — the
  override clears the ERESOLVE without `--legacy-peer-deps`. Both configs
  set `testsEnvironment: false` — the tests site lives in its own config
  (`.wp-env.tests.json`), NOT in `.wp-env.json`'s deprecated combined mode.
  A dev-shaped env still mounts the phpunit library (`/wordpress-phpunit`)
  in its cli service, which is what lets `test:php` run there.
- **PHPUnit version:** composer pins `phpunit/phpunit:^9.6`. WordPress's test
  bootstrap calls `parseTestMethodAnnotations()`, removed in PHPUnit 10; letting
  `yoast/phpunit-polyfills` pull 10 makes every PHP test error.
- **PHP test bootstrap** (`tests/bootstrap.php`) loads the framework before the
  plugin: it resolves the framework plugin from `WP_SYNC_FRAMEWORK_PLUGIN`
  (env/const) else defaults to the subtree's wp-env path
  (`WP_PLUGIN_DIR/gutenberg/gutenberg.php`). Otherwise `WP_Sync_Post_Meta_Storage
  not found`.
- **e2e uses the subtree's collaboration fixtures**, so it must load a single
  `@playwright/test`. The subtree's `npm install` re-creates its own (identical)
  copy → Playwright "two instances" error. `pretest:e2e` rimrafs the subtree's
  copy so fixtures resolve up to this plugin's. The runner is `playwright test`
  **directly** — NOT `wp-scripts test-e2e` (v30's is the jest+puppeteer runner).
- **e2e global setup is plugin-local** (`tests/e2e/config/global-setup.ts`): auth,
  clean state, and — critically — activating `gutenberg-sync-engines` (by file
  path, worktree-safe), because wp-env leaves mapped plugins INACTIVE on the
  *tests* site. Without that, collaboration never turns on
  (`_wpCollaborationEnabled` stays false) and sessions time out. The framework
  itself needs no activation — the plugin loads its bundled Gutenberg — but the
  setup DOES deactivate a stale `gutenberg-stub` activation left by an aborted
  precedence-spec run (an active stub blocks the bundled framework). We deliberately
  do NOT reuse the subtree's global-setup (it deactivates a Gutenberg test
  plugin this env doesn't need touched). Ours also runs the WS-provider setup
  (`tests/e2e/config/rtc-websocket-setup.ts`), gated on
  `GUTENBERG_RTC_TEST_WS_PROVIDER`.
- **Collaboration gate:** `wp_is_collaboration_enabled()`, which since
  WordPress/gutenberg#80658 is just the Gutenberg experiment
  `gutenberg-real-time-collaboration`. The old `wp_collaboration_enabled`
  option and the Settings → Writing checkbox are GONE (Gutenberg deletes the
  option on upgrade), and the client flag is
  `window.__experimentalEnableRealTimeCollaboration`, not
  `window._wpCollaborationEnabled`. Tests flip the experiment through
  `gutenberg-experiments` in `POST /wp/v2/settings` (the fixture's
  `setCollaboration`) and set `wp_sync_engine` the same way; the CLI tools
  (`rtc-dev.mjs`, the fuzzer) flip it with a `wp eval` on that option. All of
  it only works with the plugins active. ACTIVATING this plugin turns the
  experiment on (`gutenberg_sync_engines_activate`, the entry file's
  activation hook, per site on a network-wide activation); it does not pin
  it, so turning the experiment off afterward still works — the e2e
  fixture's `setCollaboration( false )` teardown and the host benchmark's
  restore depend on that.
- **Subtree build layout** (Gutenberg 23.x): built package JS lands at
  `gutenberg/build/scripts/<pkg>/`, not `gutenberg/build/<pkg>/`.
- **Engine switches vs room lineage:** rooms are stamped with the engine
  that first wrote them and the transport 409s mismatches
  (`rest_sync_engine_mismatch`); the shared rooms that are not tied to
  one post are reset when a client speaking the new engine arrives,
  per-post rooms are not (`docs/operations.md`, "Switching engines").
  Related trap: the storage's `get_cursor()`/`get_update_count()` are
  per-request caches refreshed ONLY by `get_updates_after_cursor()`
  (kept from the post-meta default on purpose); do not decide a room's
  first load, or anything else, from them before a read has run.
- **A push dispatched from inside `SyncManager.update()` never reaches the
  editor.** core-data's `editEntityRecord` hands the sync manager the edits
  BEFORE it commits them, and every editor edit carries the editor's own
  block tree (`updateFootnotesFromMeta` always returns `{ blocks }`) — so
  the commit lands on top of any `editRecord` dispatched during the call.
  This is deterministic, not a race: capture-driven pushes must be
  dispatched from a later task (intent-log defers them past the typing
  burst; see `scheduleEditorSync`). Pushes made from a transport callback
  (a poll response) land normally. Rediscovering this costs an afternoon —
  the symptom is an editor whose tree silently never gets its syncIds.
- **Worktrees mount the plugin twice in wp-env:** `.wp-env.json` maps `.` to
  `wp-content/plugins/gutenberg-sync-engines` AND lists `.` in `plugins`,
  which also mounts it under the checkout's directory name. In the canonical
  checkout both paths coincide; in a worktree they don't, and activating both
  copies is a fatal `Cannot redeclare gutenberg_sync_engines_bootstrap()`.
  Keep the DIRECTORY-NAME copy active and the `gutenberg-sync-engines` copy
  inactive: `wp-env start` re-activates the plugins-list (directory-name)
  copy on EVERY start, so the reverse arrangement fatals — and aborts the
  start — the next time the env starts. `npm run rtc:ws` enforces the
  surviving arrangement automatically.

## Coding standards

- PHP: `composer lint` / `composer format` (PHPCS: WordPress-Core/Extra/Docs +
  PHPCompatibilityWP). JS/TS: `npm run lint:js` (lints `src` and `tests`,
  including the e2e specs) + `npm run format`
  (`@wordpress/prettier-config`).
- The frozen `src/engines/intent-log/**` core is excluded from prettier
  (eslint still runs it, with relaxed rules, and `tsc` type-checks it via
  `checkJs` + JSDoc); the vendored `src/engines/yjs-server/y-utilities/**` is
  excluded from both — leave them alone unless deliberately syncing the
  cross-language contract (JSDoc-only edits to the core are fine). The
  generated test vectors (`tests/js/engines/*/test-vectors/`,
  `tests/phpunit/test-vectors/`) are excluded from prettier too: their
  contract is byte parity with the generator, which writes two-space
  JSON, and prettier would collapse short arrays onto one line.
- JSON is formatted with two spaces (a `*.json` override in
  `prettier.config.js`); everything else keeps the WordPress config's
  tabs.

## Commits / PRs

- **`CHANGELOG.md` records significant changes only.** Add an entry under
  **Unreleased**, as part of the change itself (same commit or PR), when a
  change is one of these: a new feature, a new setting or extension point,
  behavior that is removed or works differently, or anything a site owner
  or developer must know about when they upgrade. Do NOT add entries for
  bug fixes, tests, benchmarks, the fuzzer or other developer tooling,
  refactors, or docs — the commit message and the issue record those. Why:
  nearly every branch used to touch the same lines of the changelog, so
  merges conflicted constantly. Keep each entry to one or two sentences
  and link the issue. When in doubt, leave it out: when a version ships,
  the release script appends every commit merged since the last release
  under that version, each linked to its pull request, so nothing is
  lost by leaving an entry out (`npm run release -- --dry-run` previews
  that list).
- This repo has commit **signing disabled locally**. Commit with `--no-verify`
  (the pre-commit hook is heavy/flaky).
- Do **not** open PRs / push to shared branches / take other outward-facing
  actions unless the user names that specific action.

## Releasing (HUMANS ONLY)

Releasing is a **human-only** action. Agents must never run `npm run
release`, trigger either release workflow, push a `release/*` branch, tag a
version, or bump the plugin version — not even when a release "seems ready".
An agent's entire involvement in releasing is: keep the changelog's
Unreleased section accurate (significant changes only, see Commits / PRs)
and use `@since n.e.x.t` in new code (the release tooling stamps the real
version).

## Known issues / out of scope

Open work lives in **GitHub Issues** (`gh issue list --label "agent:ready"`).
Anyone can file one; an agent investigates it and rewrites it into the
shape defined by `.github/ISSUE_TEMPLATE/shaped-issue.md`. Read
`docs/plan/README.md` for the rules and the label set before touching any of
it. **Write plainly.** The rule is mechanical: if a word is defined in
`docs/glossary.md`, it is one of our invented words and does not belong
in an issue's title, problem, or example — only in its notes.

Ideas we looked at and set aside are in `docs/plan/wontfix.md`.
`docs/plan/history.md` records why the code is shaped the way it is and what
has already been tried and failed — read it before a big change, and
before re-attempting anything that looks obvious.

The issue loop is `/loop /shape-issue` to work up what was filed, then
`/loop /solve-issue`; either also takes a single issue number directly.
Cycle notes go on the issue as a comment; durable lessons go in
`docs/plan/history.md` under "Running the loop".

Where the facts about each engine live now:

- Each engine's known gaps and accepted limits:
  `docs/engine-comparison.md`, "Known gaps and qualifications".
  Open defects are GitHub Issues; accepted limits are in
  `docs/plan/wontfix.md`.
- Rules that must not be undone (de-rtc's commit holds, the "no
  `content` in the property list" rule, how often intent-log saves a
  full snapshot): `docs/plan/history.md`.
- What all three engines share (collaborative undo, the review panel
  for intent-log and de-rtc, the same starting field values for a post
  under every engine): the feature parity table in
  `docs/engine-comparison.md`.
- `composer lint` is clean (zero errors, zero warnings); keep it that
  way. The excludes (`gutenberg/`, frozen cores, vendored libraries)
  are by design and must not widen.

## Deep history

The backstory of the multi-month RTC effort (framework/plugin split, engine
SPI, transports, benchmarks, the subtree/e2e work) lives in this repo:
`docs/plan/history.md` records where the project came from, the decisions
that shape the code today, and what has already been tried and failed;
`docs/architecture-decisions.md` records the load-bearing early decisions
still open to revisiting. Read both before a big change.
