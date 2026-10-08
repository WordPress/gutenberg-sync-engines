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

`gutenberg-sync-engines` is a WordPress plugin that supplies the pluggable
**engines** (how concurrent edits merge) and **transports** (how updates move)
for Gutenberg's real-time collaboration (RTC) **framework**. The framework
itself lives in Gutenberg core (`@wordpress/sync` client + the
`lib/experimental/collaboration/` server): it is a generic, engine-neutral
substrate — a `createSyncManager` shell, two registries (engines + transports)
with client/server negotiation, the `SyncEngine` SPI, and a shared `Y` export
(`wp.sync.Y`). **Without this plugin active, RTC is disabled** — the framework
registers no engine or transport, so a session finds nothing to negotiate and
the editor falls back to the classic exclusive post lock.

This plugin provides:

- **Engines:** `intent-log` (server-authoritative log of typed intents; merges
  by transform, sets genuine conflicts aside for review), `yjs-server`
  (server-authoritative CRDT: the vendored y-php library merges every update
  into a canonical room document server-side and compacts by itself —
  lock-free ingest; the editor saves its own serialized blocks, and the
  server-side `materialize()` serves only the rooms CLI, benchmarks, and
  tests; it inherited the retired naive-relay yjs-relay engine's client
  CRDT machinery and wire format), and
  `de-rtc` (Distributed Editing's save-centric model on the room protocol:
  clients propose whole content against a named base version; the server
  three-way-merges every proposal with the merge core ported verbatim from
  the wordpress-develop `add/distributed-editing` branch and announces
  each accepted version; genuine conflicts escalate instead of silently
  merging).
  The framework's conventional default engine
  (`WP_Sync_Engine_Registry::DEFAULT_ENGINE`) is **intent-log** — that's
  what runs when the `wp_sync_engine` option is unset. Registration order
  only matters when a CONFIGURED slug isn't registered (misconfiguration
  degrades to the first registered engine: yjs-server).
- **Transports:** `http-polling` (default), `sse`, `sse-daemon`,
  `websocket`. `sse` and `sse-daemon` are two framings of the same
  receive stream, and differ only in who
  holds it: the web tier (a PHP worker per stream) or the sync daemon
  (its own process, on the port the websocket transport already uses).
  A stream request names the daemon instead of a REST route and
  authenticates with a one-time token in an `Authorization` header,
  minted per stream open at `/wp-sync/v1/ws-token`.
  SSE uses normal PHP requests: one held worker per stream, woken by
  Redis Pub/Sub notices when `WP_SYNC_SSE_REDIS_URL` is set or a Redis
  object cache is detected (`WP_REDIS_*` constants), and otherwise by
  half-second checks of a per-room VERSION COUNTER
  (`WP_Sync_Table_Storage::get_room_versions`, bumped atomically on every
  storage write; in the object cache when persistent, else a `_version`
  room-meta row; snapshot taken BEFORE each read; awareness held by the
  Presence API bumps no counter, so each check then also reads the
  stream's rooms' awareness and compares it with what was last sent —
  `awareness_changed()`; the Presence API backend fires
  `gutenberg_sync_engines_room_changed` itself, so Redis notices still
  go out) through
  `WP_Sync_Storage_Change_Waiter`, the retired long-polling transport's
  wait; a storage without counters is read the long way. Bounded
  reconnects from durable cursors. A stored `http-long-polling` choice reads as
  `sse`. wp-env lifecycle hooks start and remove Redis for each checkout
  and config on its own network. Setup, the proxy/buffering caveat, and
  failure behavior: `docs/transports.md`.
  Short polling is the BASE transport; beside it every editor tab opens an
  **advisory channel** (`src/providers/advisory/`) that carries presence
  and "go and poll" notices, never content. It runs over one of two
  LINKS, chosen on the settings screen: `webrtc-advisory` (default; a
  WebRTC mesh signaled over the WordPress heartbeat by
  `includes/class-gutenberg-sync-engines-advisory-presence.php`) or
  `websocket-advisory` (one socket per tab to the websocket transport's
  daemon, which relays presence and notices in memory —
  `handle_advisory_message` in the daemon — and never carries rows). It
  decides the polling cadence: quiet when alone, timer cadence when a
  peer is unreachable, on demand (with the heartbeat carrying the room's
  head cursor) when every peer is reachable. SSE turns it off while its
  stream is up (its handshake signals ride the heartbeat, never a poll),
  and a solo SSE tab goes quiet like short polling, closing its stream.
  A HIDDEN tab holds its stream or drops it depending on who holds it.
  A stream the web tier serves keeps a PHP worker up for as long as the
  tab lives, so `sseStreaming()` is false
  while `document.visibilityState` is hidden, and `handleVisibilityChange`
  drops the stream on hide through the deliberate-abort path
  (`abortParkedStream()` then `sseExchange.close()`, as `handlePageHide`
  does, so no failure is logged or backed off); the tab then receives
  over ordinary requests under short polling's own rules (the background
  cadence, `POLLING_INTERVAL_BACKGROUND_TAB_IN_MS`, with the channel
  left off) and polls at once on return, which reopens the stream.
  A stream the sync daemon serves holds no worker, so the `sse-daemon`
  transport calls `setSseStreamHoldsWorker( false )` and a hidden tab
  keeps its stream, staying live to rows it cannot see yet.
  A tab that TYPES keeps its stream: edits (and awareness changes,
  checked once a second) go out on the updates request BESIDE the
  stream, marked `rows_received_separately: true`, which the server answers with the
  verdicts and the room's head cursor but no stored rows
  (`READ_FROM_HEAD` in `process_room_request`). The stream is the only
  path that delivers stored rows and moves a room's cursor; the manager
  holds such an answer (`heldTails`) until the stream has carried the
  cursor to that head, then applies it rows-first, so no engine had to
  change (issue #106). One send at a time (`updatesInFlight`): a stream
  receive never takes updates, and a poll takes none while a send is in
  flight.
  For the first second after a room registers the tab receives over
  ordinary requests (`SSE_SETTLE_MS`), so the rooms registering one by
  one at load open ONE stream, not one per room. Rules and failure
  cases: `docs/advisory-channel.md`.
  The websocket link can end at a host's OWN relay instead of the
  daemon: with a `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` configured
  (constant, env, or the `wp_sync_websocket_access_token_secret` filter),
  the token route mints a signed two-minute access token (JWT HS256, claims
  `user_id`/`blog_id`/`iss`/`rooms`/`iat`/`exp`, `WP_WebSocket_Access_Token`)
  that a relay verifies with the secret alone; the daemon accepts
  access tokens too. `iss` is the network site URL without its scheme;
  a relay shared by several installs (one secret) keys rosters by
  `iss`, `blog_id`, and room (issue #126). The daemon does not check
  `iss`.
  The relay's address goes in the "WebSocket advisory server" setting (`gutenberg_sync_engines_advisory_websocket_url`;
  empty = the transport server, `gutenberg_sync_engines_websocket_url`,
  itself empty = the HOST/PORT constants; the `wp_sync_websocket_url`
  filter wins for the transport). The screen shows ONE "Transport"
  radio list of (transport, advisory) pairs — the form field
  `gutenberg_sync_engines_delivery` is never stored; its sanitize
  callback writes the two real options, which WP-CLI, the fuzzer, and
  the e2e specs keep setting directly. The polling interval defaults
  to 5 s (0 means the default); e2e global setup pins the tests site
  to 1 s so the suite's timing is unchanged. The
  DEV wp-env config defines a development secret
  (`wp-env-development-secret-not-for-production`), so the dev daemon
  and a local relay run in access-token mode out of the box; the TESTS
  config does not, so the daemon lane keeps certifying the cookie path
  and only the relay spec (through its fixture plugin) uses access
  tokens. `examples/advisory-relay/relay.mjs` is the reference
  relay (Node + `ws`); the access token and frame formats are in the
  advisory-channel doc's "Bring your own relay" section.
  The same presence lane decides a per-post room's LIFETIME under the
  "Unsaved changes" setting (default: an empty room is reset to the
  saved post; the room's generation token tells clients to start over).
  Reasoning and the switch: `docs/room-lifetime.md`.
- **Storage:** rooms live in two plugin-owned tables, `{$prefix}sync_updates`
  (the update log; the row id is the cursor) and `{$prefix}sync_room_meta`
  (lineage, presence, engine bookkeeping), through `WP_Sync_Table_Storage`,
  substituted for the framework's post-meta default. Columns, the keys
  each engine writes, the object-cache strategy, the version counter,
  and the lifecycle commands: `docs/storage.md`.
- **Awareness:** who is in a room, read and written only through
  `WP_Sync_Awareness`; held in the required Presence API's `wp_presence`
  table when it is recording, else with the room's other data. `docs/storage.md`
  (Presence).

It registers through the framework's extension points: PHP `wp_sync_engines` /
`wp_sync_transports` filters; JS `registerSyncEngine` / `registerSyncTransport`
(via `@wordpress/sync`'s unlockable private APIs). The active engine/transport
are chosen on the **Settings → Collaboration** screen (`wp_sync_engine` option +
the `WP_COLLABORATION_TRANSPORT` config value).

The framework/plugin split is complete: the framework ships **neither** engines
**nor** transports; both come solely from here.

## Repo layout

- `gutenberg-sync-engines.php` — plugin entry.
- `includes/` — server PHP: `engines/{intent-log,yjs-server,de-rtc}/`
  (one folder per engine; none uses another's classes), `shared/` (code
  the base provides to more than one engine: `WP_Sync_Block_Identity`,
  the genesis block-id scheme; the editor-side block-id stamper
  `sync-id.js`; the genesis property seed `WP_Sync_Post_Genesis_Props`),
  `transports/{sse/,websocket/}` plus the polling server, `admin/` (the
  Collaboration settings screen), `storage/` (the room tables: schema,
  storage, and the `wp collaboration storage` CLI), `diagnostics/`
  (session capture, the request log, the rooms CLI; dev-only), and
  `lib/` (the vendored libraries and their loaders).
  - `engines/de-rtc/merge-core.php` — the DE-RTC merge core, ported
    verbatim and frozen. `docs/vendored-libraries.md`.
  - `lib/y-php/` — vendored y-php (two local deltas, preserve both when
    re-vendoring). `lib/automerge-php/` — vendored automerge-php (the
    shipping de-rtc path never calls it). Both frozen, excluded from
    phpcs, each with its own conformance suite in CI. Provenance,
    deltas, commands, and the PCRE2 trap: `docs/vendored-libraries.md`.
- `src/` — client JS/TS (webpack entry `src/index.ts` → `build/sync-engines.js`,
  externalizes `@wordpress/sync`→`wp.sync` and `yjs`→`wp.sync.Y`):
  - `engines/intent-log/` — the frozen intent-log core, kept identical
    to its PHP twin and the JSON vectors (two copies, Jest and PHPUnit,
    always update both). Plain JavaScript typed through JSDoc; excluded
    from prettier. Its Jest harness, simulator, and the client-only
    `client.js`: `docs/vendored-libraries.md`.
  - `engines/yjs-server/` — the yjs-server engine, WITH its Yjs client
    modules (CRDT doc schema, snapshot helpers, `undo.ts`, vendored
    `y-utilities/` — the latter ignored by eslint), inherited from the
    retired yjs-relay engine. No other engine uses Yjs: de-rtc keeps a
    plain record (`engines/de-rtc/record.ts`), intent-log its own
    document.
  - `shared/` — client code the base provides to more than one engine
    (no engine folder imports another engine's folder):
    `shared/awareness-sync.ts` — presence bridging used by all three
    engines.
  - `providers/{http-polling,sse,sse-daemon,websocket}/` — transports
    (sse and sse-daemon reuse the polling manager, swapping only its
    receive half for the stream).
  - `awareness/` — SLOW AWARENESS (`docs/awareness-high-latency.md`),
    on when the "Awareness interval" setting is above 0: each tab
    publishes the block its selection is in (`metadata.syncId`, else the
    editor clientId, or null) once per interval, over the sync
    transport's awareness state (field `gseBlock`) or WordPress
    Heartbeat (`channels/`), and peers draw Gutenberg's block outline and
    avatar badge on that block (`ui/`, through the public
    `editor.BlockListBlock` filter plus a badge layer drawn into the
    canvas document). `registry.ts` installs the field's equality check
    on EVERY awareness instance the engines create, in every mode: a
    peer can carry the field at any time and core-data throws on an
    unknown field. Jest: `tests/js/awareness/`.
  - `entity-sync/` — registers the default entity sync adapter after engines
    and transports. It wraps the vendored core-data bridge and flushes held
    HTTP updates through `beforeSave`. There is no opt-in bundle. Upstream
    commit and retained framework changes: `docs/entity-sync-adapter.md`.
  - `framework.ts` — unlocks `@wordpress/sync` private APIs once and re-exports
    the framework runtime the adapters use.
- `gutenberg/` — a **pinned, squashed Git subtree of Gutenberg** (source only;
  see below). The BUNDLED runtime framework: the plugin entry loads
  `gutenberg/gutenberg.php` itself whenever no standalone Gutenberg is
  active (wp-env no longer mounts it as a separate plugin).
- `tests/` — ALL tests, fixtures, and test tooling: `tests/phpunit/` (PHPUnit,
  boots via `tests/bootstrap.php`), `tests/js/` (Jest unit tests + setup files,
  mirroring `src/`; `tests/js/engines/intent-log/` is the frozen core's
  harness), `tests/e2e/` (Playwright specs + config; `specs/http-only/` and
  `specs/websocket-only/` are the transport-specific suites relocated from the
  framework, `plugins/` holds the test WebSocket provider fixture plugin,
  `bin/` the y-websocket sync-server daemon + the `rtc:ws`/`rtc:http` dev
  switcher for the real websocket transport; see Testing),
  `tests/benchmarks/` (the BENCHMARKS behind one command, `npm run
  bench` — by default the HOST COST REPORT in `tests/benchmarks/host/`,
  what the plugin adds to a server vs the same site with the plugin
  deactivated; `--suite=engines` is the engine-decision matrix (`wp
  eval-file tests/benchmarks/benchmark.php` per run) and
  `--suite=transport` the browser-driven transport-experience benchmark
  in `tests/benchmarks/transport/`),
  `tests/debugging/` (the debugging/analysis TOOLS, deliberately NOT
  behind `npm run bench` — run directly: the N-window soak
  (`tests/debugging/soak-transport.mjs`) and the
  capture→sanitize→replay session tools in `tests/debugging/replay/` —
  community-harness fixture format; see `tests/debugging/README.md`),
  `tests/fuzzer/` (the seeded browser fuzzer swept across every
  engine × transport combo — `npm run fuzz`; see its README for strategy,
  replay, and triage), and
  `tests/tools/` (Node CLI scripts: vector generators, the simulator sweep,
  the manual two-tab observer). The frozen intent-log vectors exist as TWO
  deliberate copies — `tests/js/engines/intent-log/test-vectors/` (replayed by
  Jest) and `tests/phpunit/test-vectors/` (replayed by PHPUnit) — kept
  byte-identical by `tests/js/engines/intent-log/vector-parity.test.js`;
  regenerate with the `tests/tools/` scripts and always update both.
- `bin/` — repo scripts, not shipped: `build-plugin-zip.sh` (the release
  zip) and `release.mjs` (humans only, see Releasing).
- `blueprint.json` / `blueprint.local.json` — WordPress Playground
  blueprints: the public one for playground.wordpress.net (installs the
  latest release zip) and the one `npm run playground` applies to the
  mounted checkout (see Environment).
- `examples/` — code a host copies rather than the plugin runs:
  `advisory-relay/` (the bring-your-own WebSocket relay for the
  advisory channel, Node + `ws`, plus its README). Linted with
  `npm run lint:js`; the websocket e2e config runs it for the
  advisory-relay spec.
- `docs/` — the conceptual docs, indexed by `docs/README.md`:
  `engine-comparison.md` (the decision guide: scorecard, parity table,
  resource profiles, per-engine known gaps), `principles.md` (P1-P7),
  `scenarios.md` (the A-G wire narratives), `transports.md`,
  `sse-daemon.md`, `de-rtc-fidelity.md` (the audit against the upstream vision),
  `architecture-decisions.md`, and `glossary.md` (the project's
  vocabulary in plain words). The set is the interpretation layer over
  both benchmark harnesses; deliberately number-free (run `npm run
  bench` for numbers) — keep the SHAPES current when engine
  capabilities or benchmarks change.
- `docs/plan/` — how we plan work. `README.md` (the rules, the labels, the
  flow), `history.md` (why the code is shaped this way and what has
  already been tried and failed), `wontfix.md` (looked at, set aside,
  with reasons). The work itself lives in GitHub Issues, not here.

## The `gutenberg/` subtree

The plugin includes Gutenberg source as a squashed Git subtree. Framework
changes are visible in this repository and are also maintained as commits
on the separate Gutenberg `try/sync-engines` branch. Rebase that branch onto
upstream trunk, test it, then import the reviewed version here.

The plugin loads `gutenberg/gutenberg.php` when no standalone Gutenberg is
active. Dependencies and built assets are generated locally. A normal clone
includes the source; CI needs no submodule setup. Release ZIPs include the
built framework.

`gutenberg-pin.json` records the bundled framework commit, the trunk it
sits on, and its source tree ID; it is the only place that names them. The
framework includes PR #83410 and the default adapter integration. Retain
the private API exports, post-lock fallback, and conflict-review
integration on updates.
See `docs/gutenberg-subtree.md` and `docs/entity-sync-adapter.md`.

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

The transport-specific e2e suites live here (relocated from the framework):
`tests/e2e/specs/http-only/` runs in the default suite; `tests/e2e/specs/
websocket-only/` runs only under `test:e2e:websocket`, which since the
V1 A3 rework runs against the plugin's REAL websocket transport:
`playwright.rtc-websocket.config.ts` launches
`tests/e2e/bin/rtc-real-ws-daemon.mjs` as a second webServer, which
selects the websocket transport on the tests site, publishes the
`wp collaboration sync-server` PHP daemon from the tests env's cli
image on host port 8787 (health-checked on the daemon's own /health),
and restores the previous transport at teardown. No spec is skipped.
The same config also runs the example advisory relay
(`examples/advisory-relay/relay.mjs`) on port 8790 with a fixed test
secret; `collaboration-websocket-advisory-relay.spec.ts` activates
the `tests/e2e/plugins/advisory-relay-access-token.php` fixture (same
secret, socket URL aimed at the relay) for its duration, so the
relay lane never touches the daemon's auth path.
`tests/e2e/specs/sse-framing/` holds how a tab behaves around an open
receive stream, and both SSE lanes run it — the web tier under
`test:e2e:sse`, the sync daemon under `test:e2e:sse-daemon` — because
the framing and the send path are the same for both, and only the
process writing the stream differs.
`tests/e2e/specs/sse-only/` runs only under `test:e2e:sse`
(`playwright.rtc-sse.config.ts`): its global setup runs the default one
and then `tests/e2e/bin/rtc-sse-transport.mjs --select`, which refuses
to run without the tests env's Redis container and selects the SSE
transport on the tests site; the global teardown restores the previous
transport from the same state file. The specs read the exchange's
`window.__wpSyncSseState` (open, events, rooms) the way the websocket
specs read `__wpSyncWsState`. The fuzzer sweeps `sse` by default and
refuses an sse combo without Redis.
`tests/e2e/specs/sse-daemon-only/` runs only under
`test:e2e:sse-daemon` (`playwright.rtc-sse-daemon.config.ts`), which
launches the same `rtc-real-ws-daemon.mjs` with `--transport=sse-daemon`.
The `sse-daemon` transport is the same receive stream the `sse`
transport speaks, written by the sync daemon instead of a web request:
the daemon serves the socket and the stream on one port, so this lane
differs from the websocket lane only in the slug the tests site
negotiates, and both daemon lanes share
`tests/e2e/config/rtc-daemon-teardown.ts`, which replays the launcher's
persisted transport restore.
A receive stream is a POST whose body can arrive across several reads,
and the daemon's handshake handler runs once per read. The one-time
token it authenticates with is spent on first sight, so the daemon
authenticates once per connection and keeps the result; a second pass
over the same connection otherwise spends the token again and refuses a
stream that was already accepted. Symptoms of getting that wrong: the
daemon logs `Handshake rejected: Missing, expired, or mismatched
token.`, the browser reports the stream POST as a CORS failure (a 403
carries no CORS headers, so the status is hidden), and the client logs
`Error posting sync update, will retry with backoff` — then succeeds on
the retry with a fresh token, so the suite still passes.
Every tab on a post joins that post's awareness roster, and a page whose
roster exceeds `DEFAULT_CLIENT_LIMIT_PER_ROOM` (5) is refused the room:
Gutenberg shows "Too many editors connected" and the real-time path stops
for that tab. The check runs once, on the page's first connection, so a
spec that opens a sixth tab on one post fails for this reason and not
because of a transport fault. Give extra tabs their own post, or raise
the limit with the `sync.pollingProvider.maxClientsPerRoom` filter.
(The old y-websocket PEER-relay fixture lane — the test WS provider
plugin plus `rtc-test-ws-sync-server.mjs` — only demonstrated
client-merging engines and none remains; the fixture files are kept
for reference but no suite uses them.) `.wp-env.json` maps
`tests/e2e/plugins` (that fixture) and
`gutenberg/packages/e2e-tests/plugins` (framework fixtures like
sync-connection-error-filter) as plugin dirs. `@y/websocket-server` is pinned
EXACTLY to 0.1.1 — 0.1.5 switched to the yjs-14 (`@y/y`) family and its daemon
crashes (`store.getClock is not a function`) when a 13.x client connects.
`npm run rtc:ws` is the one-command start for the REAL websocket transport
(manual two-window testing): it ensures the dev wp-env is running, activates
the right plugins, selects the websocket transport, and runs the
`wp collaboration sync-server` daemon in the wp-env cli container with port
8787 published to the host (wp-env alone cannot publish extra ports, and
the daemon must bind 0.0.0.0 — a loopback-bound daemon is unreachable even
through a published port). `npm run rtc:http` switches the site back to
HTTP polling and stops the daemon.

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
- **Slow awareness rides whatever carries awareness.** Over the sync
  transport the block name goes out on the framework awareness state
  (`gseBlock`), which is one of the BASE presence fields the advisory
  channel's presence lane carries peer to peer, so under short polling
  a new name reaches every reachable peer with no request at all. A
  new name also raises `announceLocalAwarenessChange`
  (`src/providers/advisory/announce.ts`), which the polling manager
  uses only under SSE, to send the changed state on the updates
  request beside the stream. The e2e
  spec turns the advisory channel off for its duration. Under the
  Heartbeat channel the block name is a field on the advisory channel's
  discovery probe (`block`), kept on the tab's presence token by
  `Gutenberg_Sync_Engines_Advisory_Presence` and answered back with
  each peer's name and avatar, so it needs an advisory channel
  selected; the plugin also SETS the admin Heartbeat interval on post
  edit screens, so the probe's cadence follows the awareness interval.
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
  that first wrote them, and the transport 409s mismatches
  (`rest_sync_engine_mismatch`). Global collection/taxonomy rooms (e.g.
  `taxonomy/wp_pattern_category`) outlive any engine flip, so the polling
  transport RESETS those rooms (rows + lineage + room meta) when a client
  speaking the newly-selected engine arrives — they're rebuildable
  change-feeds. Per-post entity rooms keep the strict fence (they can hold
  unsaved collaborative content; sessions degrade to the post lock).
  Related trap: the storage's `get_cursor()`/`get_update_count()` are
  per-request caches refreshed ONLY by `get_updates_after_cursor()` (the
  table storage keeps the post-meta default's semantics here on purpose)
  — never gate genesis (or anything) on them before a read has run.
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

`LOOP.md` is the working ledger when the issue loop is running
(`/loop /shape-issue` to work up what was filed, then `/loop /solve-issue`;
either also takes a single issue number directly).

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
