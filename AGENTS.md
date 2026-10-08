# AGENTS.md

How to work in this repo: the environments, the test ladder, the
diagnostics, the traps, and the rules. What the plugin is and how it
behaves is in `README.md` and `docs/` (indexed by reader in
`docs/README.md`); this file only points there. One word used below: a
room is one post's shared editing session.

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
- If a word is defined in `docs/glossary.md`, it is one of our invented
  words. It belongs in code and in a design page, not in an issue's
  title, problem, or example (`docs/plan/README.md` has the rule).

## Where to read first

- What the plugin is, the three engines, the four transports:
  `README.md`.
- Which engine to pick and each engine's known gaps:
  `docs/engine-comparison.md`.
- How an edit travels: `docs/data-flow.md`. What is on the wire:
  `docs/protocol.md`. Where it is stored: `docs/storage.md`.
- How each transport behaves: `docs/transports.md` and
  `docs/advisory-channel.md`. What a host must provide:
  `docs/operations.md`. Who may do what: `docs/security.md`.
- Every setting, default and override: `docs/settings.md`.
- Adding an engine or transport, and every hook: `docs/extending.md`.
- The vendored and frozen code and how each is checked:
  `docs/vendored-libraries.md`.
- Why the code is shaped this way and what was tried and failed:
  `docs/plan/history.md`. Read it before a big change.
  `docs/architecture-decisions.md` has the early decisions still open to
  revisiting, and `docs/plan/wontfix.md` what we set aside.

## Repo layout

- `gutenberg-sync-engines.php` — plugin entry.
- `includes/` — server PHP: `engines/{intent-log,yjs-server,de-rtc}/`
  (one folder per engine; none uses another's classes), `shared/` (code
  more than one engine uses), `transports/` (the polling server, `sse/`,
  `websocket/`), `admin/` (the settings screen), `storage/` (the room
  tables and their CLI), `diagnostics/` (dev-only, see Diagnostics),
  `lib/` (vendored y-php and automerge-php), and the classes for
  awareness, locks and atomic options, each with a `*-backend.php`
  interface file.
- `src/` — client TypeScript; `src/index.ts` builds `build/sync-engines.js`
  with `@wordpress/sync` and `yjs` external (`wp.sync`, `wp.sync.Y`).
  `engines/{intent-log,yjs-server,de-rtc}/` (no engine folder imports
  another's), `shared/`, `providers/{http-polling,sse,sse-daemon,websocket}/`
  and `providers/advisory/`, `awareness/` (slow awareness), `entity-sync/`
  (the core-data adapter), `framework.ts` (unlocks the private APIs
  once), `debug/inspector.ts` (`window.wpSync`).
- `gutenberg/` — a squashed Git subtree of Gutenberg, source only,
  pinned by `gutenberg-pin.json`. The plugin loads it when no standalone
  Gutenberg is active. Framework changes live on the Gutenberg
  `try/sync-engines` branch and are imported after review
  (`docs/gutenberg-subtree.md`, `docs/entity-sync-adapter.md`).
- `tests/` — all tests and tooling: `phpunit/`, `js/` (Jest, mirroring
  `src/`), `e2e/` (Playwright specs, config, fixture plugins, launchers
  in `bin/`), `benchmarks/`, `debugging/`, `fuzzer/`, `tools/`. Each of
  the last four has a README.
- `bin/` — `build-plugin-zip.sh` and `release.mjs` (humans only).
- `blueprint.json` / `blueprint.local.json` — Playground blueprints
  (public, and the one `npm run playground` applies).
- `examples/advisory-relay/` — the bring-your-own relay a host copies.
- `docs/` — the documentation. `docs/plan/` holds the issue rules,
  `history.md` and `wontfix.md`; the work itself lives in GitHub Issues.

## Setup (from a clean checkout)

The commands are in `README.md` (Development). Two things it does not
say: the subtree build (`cd gutenberg && npm ci --ignore-scripts && npm
run build`) is required for Jest and `npm run typecheck` too, because
they resolve `@wordpress/sync` and `yjs` from it, and `--ignore-scripts`
is what skips the subtree's Husky hook, which needs its own Git root.

## Environment

Two SEPARATE wp-env configs; both set `testsEnvironment: false`, so each
starts a single site:

```bash
npm run env start         # DEV env (.wp-env.json): the Presence API plugin
                          # (required) and this plugin, http://localhost:8888.
                          # Its afterStart hook starts the websocket sync
                          # daemon (detached, --mode=daemon; the site's
                          # transport selection is NOT touched).
npm run env:tests start   # TESTS env (.wp-env.tests.json): same mounts,
                          # http://localhost:8889, Redis only. This is what
                          # test:php / test:e2e / CI target.
npm run env:stop          # Stops Redis + WordPress (env:tests:stop for tests)
npm run cache:on          # Puts the Redis Object Cache drop-in in (the file that
                          # makes the object cache persistent, on sync-redis;
                          # the SSE transport then detects Redis). cache:off removes it;
                          # cache:tests:on/off for the tests env. Both configs
                          # install the plugin but leave the drop-in OUT, so
                          # the suites run without a persistent cache.
```

Redis: each config's `afterStart` hook starts a Redis container on that
environment's Docker network as `sync-redis` and sets
`WP_SYNC_SSE_REDIS_URL` to `redis://sync-redis:6379`. A Redis that fails
to start does not fail the environment start, and `npm run doctor`
reports the container per environment. The hooks call the `redis:*`
npm scripts (`GSE_WP_ENV_CONFIG=.wp-env.tests.json` selects the tests
config). The container runs with `--rm`, so stopping it removes it. This
wp-env version has no stop hook, so plain `wp-env stop` (including
`npm run env stop`) leaves Redis running: use `npm run env:stop`. With
the drop-in on, the whole site's options and posts go through Redis
too, so measurements taken that way describe a Redis-backed host. The
benchmarks switch this per run (`cache=none|redis`,
`wake=auto|redis|cache|table`) and restore it afterwards.

`autoPort` is on, so when a port is busy wp-env picks a free one and
prints the URL it chose. Force ports with `WP_ENV_PORT`. Each config has
its own work dir under `~/.wp-env`, so the two environments are fully
independent, databases included. Personal overrides go in
`.wp-env.override.json` / `.wp-env.tests.override.json` (gitignored).

`npm run playground` needs no Docker: it serves the checkout on a local
WordPress Playground at http://127.0.0.1:9400 with `blueprint.local.json`
applied (both plugins active, `WP_DEBUG` and `SCRIPT_DEBUG` on, a second
account `editor` / `password`). The checkout is served as-is, so it must
be BUILT (`preplayground` refuses otherwise): PHP edits are live, JS
edits need `npm run build`. It mounts the plugin once, so the
double-mount trap below does not apply; there is no daemon and nothing
persists across restarts. Two flags are pinned on purpose. `--login`
is needed because the blueprint's `login: true` alone does not log a
browser in on the CLI. `--workers=1` is needed because with several PHP
workers a tab's login session is missing on the other workers, and the
editor shows "Session expired" at random.

## Testing

```bash
npm run test:js             # Jest: engines/providers + frozen-core vectors
npm run test:php            # PHPUnit in the wp-env tests container
npm run test:e2e            # Playwright: two-browser collaboration (+ http-only)
npm run test:e2e:websocket  # Playwright: websocket-only suite (runs the daemon)
npm run test:e2e:sse        # Playwright: sse-only suite (needs the tests Redis)
npm run test:e2e:sse-daemon # Playwright: sse-daemon-only suite (runs the daemon)
npm run lint:docs           # The prose against the code (see Commits / PRs)
```

**Iterate at the cheapest layer that can catch the change.** The ladder,
fast to slow (only the last three need wp-env):

1. **Intent-log simulator sweep** — `node tests/tools/sweep.js [seeds]
   [steps] [clients]` (defaults 60/400/3; deterministic, sub-second at
   small sizes, no WordPress). First stop for any intent-log
   planner/merge-behavior change: fails loudly when a rule is broken and
   prints how each edit ended up, so drift is visible.
2. **Jest + frozen vectors** — `npm run test:js` (needs only the built
   subtree). Engines, providers, and the cross-language vector contract.
3. **Vendored conformance suites** — y-php (~4 s) and automerge-php
   (<1 s); commands in `docs/vendored-libraries.md`. Only when touching
   the vendored libs.
4. **PHPUnit** — `npm run test:php`. Server engines, transports, storage.
5. **e2e** — `npm run test:e2e` (minutes, browser collaboration).
6. **Fuzzer** — `npm run fuzz:quick` as a post-change smoke (all engines
   over http-polling, 2 seeds each, faults/reloads off; a few minutes
   against the running tests env); the full `npm run fuzz` matrix for
   real bug hunting (`tests/fuzzer/README.md`).

Single-test loops; don't rerun a whole suite while iterating on one
failure:

```bash
npm run test:js -- sync-id                    # Jest files matching a pattern
npm run test:js -- -t 'name substring'        # single Jest test by name
npm run test:php -- --filter Test_Class_Name  # single PHPUnit class/method
npm run test:e2e -- collaboration-intent-log  # single e2e spec by filename
RTC_E2E_ENGINE=de-rtc npm run test:e2e        # one engine's e2e slice
```

CI (`.github/workflows/ci.yml`) is the source of truth: it runs every
suite on pushes to `trunk` and on PRs, the default e2e suite as one job
per engine. A spec that belongs to an engine puts `@engine-<slug>` in
its describe title; `RTC_E2E_ENGINE=<slug>` runs only those, and
`RTC_E2E_ENGINE=none` runs every spec without the tag. A new engine spec
without the tag still runs, but in the `none` job, which is the wrong
one. One known intermittent remains (intent-log mid-burst
compaction, issue #37), so the e2e CI job keeps two retries.

Traps:

- Never run `test:php` while an e2e run is in flight against the same
  env: PHPUnit wipes the tests-env database, killing every in-flight
  spec. Serialize the suites.
- `test:php` leaves the plugin INACTIVE. A daemon suite started next
  fails with `Error: 'collaboration' is not a registered wp command.`
  and Playwright reports only `Process from config.webServer was not
  able to start`. Reactivate first:
  `npx @wordpress/env --config .wp-env.tests.json run cli wp plugin activate gutenberg-sync-engines`.
- `test:js` and `npm run typecheck` resolve the framework from the built
  subtree; `WP_SYNC_FRAMEWORK_ROOT=<framework-checkout>` points Jest at a
  live checkout instead (tsconfig paths stay pinned to the subtree).
- `test:php` and `test:e2e` need the running TESTS env with the subtree
  built. For e2e also run `npx playwright install chromium` once. If the
  tests site is not on `:8889`, pass `WP_BASE_URL=http://localhost:<port>`.
  If ANOTHER project's wp-env holds `:8889`, Playwright silently reuses
  that foreign site (wp-env credentials are identical everywhere) and
  the first visible failure is a global-setup REST call dying with
  "Unexpected end of JSON input". `npm run doctor` detects this and
  prints the right URL.
- A page whose post already has `DEFAULT_CLIENT_LIMIT_PER_ROOM` (5) tabs
  is refused the room ("Too many editors connected"), checked once on
  the page's first connection. A spec that opens a sixth tab on one post
  fails for this reason, not a transport fault: give extra tabs their
  own post, or raise `sync.pollingProvider.maxClientsPerRoom`.

The transport-specific suites: `tests/e2e/specs/http-only/` runs in the
default suite. `websocket-only/` runs under `test:e2e:websocket`
(`playwright.rtc-websocket.config.ts`); its launcher,
`tests/e2e/bin/rtc-real-ws-daemon.mjs`, selects the websocket transport
on the tests site, publishes the `wp collaboration sync-server` daemon
from the tests env's cli image on host port 8787, and restores the
previous transport at teardown. The same config runs the example relay
on port 8790 with a fixed test secret for the advisory-relay spec, which
activates `tests/e2e/plugins/advisory-relay-access-token.php` for its
duration. `sse-only/` runs under `test:e2e:sse`
(`playwright.rtc-sse.config.ts`, launcher
`tests/e2e/bin/rtc-sse-transport.mjs --select`); it refuses to run
without the tests Redis, so it tests wake-ups through Redis (the fuzzer
applies the same rule). `sse-daemon-only/` runs under
`test:e2e:sse-daemon` (`playwright.rtc-sse-daemon.config.ts`, the same
launcher with `--transport=sse-daemon`); both daemon suites share
`tests/e2e/config/rtc-daemon-teardown.ts`. `sse-framing/` runs under
both SSE suites. The specs read `window.__wpSyncSseState` and
`window.__wpSyncWsState`. The old y-websocket fixture (the test WS
provider plugin plus `rtc-test-ws-sync-server.mjs`) is used by no suite;
`@y/websocket-server` stays pinned EXACTLY to 0.1.1 because 0.1.5 moved
to the yjs-14 family and crashes with a 13.x client.

`npm run rtc:ws` is the one-command start for the real websocket
transport for manual two-window testing: it ensures the dev wp-env is
running, activates the right plugins, selects the websocket transport,
and runs the daemon in the wp-env cli container with port 8787 published
to the host (wp-env alone cannot publish extra ports, and the daemon
must bind 0.0.0.0; a loopback-bound daemon is unreachable even through
a published port). `npm run rtc:http` switches back to HTTP polling and
stops the daemon. The DEV config's `afterStart` hook runs the same
script as `--mode=daemon --detach || true` on every `npm run env start`;
the daemon binds host port 8787 under a fixed container name, so with
several worktrees the most recently started dev env owns it. The tests
config starts Redis only; CI and the suites never start a daemon.

## Diagnostics

When something misbehaves, reach for these before adding printf
debugging:

- **`npm run doctor`** — read-only environment preflight
  (`tests/e2e/bin/rtc-dev.mjs --mode=doctor`): builds present, both
  wp-env environments (running? REST reachable? which port?), the
  worktree plugin-copy arrangement, whether the plugin loaded, current
  engine/transport options, the foreign-wp-env-on-:8889 trap, the Redis
  drop-in state, and daemon health. Exits non-zero on real problems,
  each with its fix. Uniform timeouts across all engines are an
  environment failure, not an engine bug.
- **Browser wire inspector** — `window.wpSync` (`src/debug/inspector.ts`)
  on every editor page: `wpSync.enable()` (persists per profile), then
  `tail()` live-prints decoded traffic, `log()`/`table()` query the
  500-record ring buffer, `intents('p1')` filters history touching one
  syncId, `doc()`/`proposals()`/`cursor()` read live session state
  (intent-log), `export()` dumps JSON for bug reports, `help()` lists
  everything. Covers every transport.
- **Server `_debug` section** — enabling the inspector sets
  `debug: true` on each room request, and every engine adds a `_debug`
  section to its answer (lock wait, rows, counts, last snapshot),
  printed as `⚙ server` in the tail. Gated by `SCRIPT_DEBUG` (dev env on, tests
  env off) or the `wp_sync_debug_enabled` filter.
- **`qm/debug` reports** — the engines and the polling transport
  report lock timeouts, edits that were held back or thrown away,
  repairs, saved snapshots, log trimming and engine mismatches through
  Query Monitor's `qm/debug` action; install Query Monitor on the dev site to see them.
- **`wp collaboration rooms list|inspect`** — read-only room state
  (`docs/storage.md`, Commands); dev-only. `wp collaboration storage
  status|install|reset|drop` manages the tables and is always
  registered.
- **Session capture + request log** (`includes/diagnostics/`, same
  dev-only gate): `wp collaboration capture start|stop|list|export|drop`
  records real sessions in the community performance harness's fixture
  format (replay and sanitize via `tests/debugging/replay/`); requests
  tagged `X-RTC-Test: 1` get per-request server metrics, read via
  `wp collaboration bench-log report [--all]` or the `rtc-test/v1` REST
  routes. The transport benchmark tags its own traffic.
- **Fuzzer triage** — every run writes `summary.md` with failure
  signatures and replay commands; `--shrink` bisects a reproducible
  failure to a minimal `--steps`; `RTC_FUZZ_LOG_SYNC=1` captures
  per-request wire summaries (`tests/fuzzer/README.md`).
- **`tests/tools/observe-two-tab-sync.mjs`** — manual two-tab observer
  against a live env (`tests/tools/README.md`).

## Gotchas (each of these has bitten; don't rediscover them)

- **Jest scope:** `jest.config.js` sets `roots: [src, tests]`. Without it,
  `wp-scripts test-unit-js` recurses into the subtree's ~1030 monorepo suites.
- **phpcs scope:** `phpcs.xml.dist` excludes `/gutenberg/*`.
- **Slow awareness travels with the presence data that is already being
  sent.**
  Under SSE that is `announceLocalAwarenessChange`
  (`src/providers/advisory/announce.ts`), which sends it beside the
  stream; under the Heartbeat channel an advisory channel must be
  selected, and the plugin sets the admin Heartbeat interval on post
  edit screens to match. The e2e spec turns the advisory channel off
  for its duration. `src/awareness/registry.ts` installs the `gseBlock`
  field's equality check on EVERY awareness instance the engines
  create, in every mode: a peer can carry the field at any time, and
  core-data throws on an unknown field.
- **wp-env is a devDep here.** `@wordpress/scripts` does NOT bundle it.
  It's pinned to `@wordpress/env@^11` (for auto-port) with a top-level
  `overrides` entry, because scripts@30 only *optionally* peer-depends
  on env 10; the override clears the ERESOLVE without
  `--legacy-peer-deps`. A dev-shaped env still mounts the phpunit
  library (`/wordpress-phpunit`) in its cli service, which is what lets
  `test:php` run there.
- **PHPUnit version:** composer pins `phpunit/phpunit:^9.6`. WordPress's
  test bootstrap calls `parseTestMethodAnnotations()`, removed in PHPUnit
  10; letting `yoast/phpunit-polyfills` pull 10 makes every PHP test error.
- **PHP test bootstrap** (`tests/bootstrap.php`) loads the framework
  before the plugin: it resolves the framework plugin from
  `WP_SYNC_FRAMEWORK_PLUGIN` (env/const) else defaults to the subtree's
  wp-env path (`WP_PLUGIN_DIR/gutenberg/gutenberg.php`). Otherwise
  `WP_Sync_Post_Meta_Storage not found`.
- **e2e uses the subtree's collaboration fixtures**, so it must load a
  single `@playwright/test`. The subtree's `npm install` re-creates its
  own copy, which gives Playwright's "two instances" error;
  `pretest:e2e` removes the subtree's copy. The runner is `playwright
  test` directly, NOT `wp-scripts test-e2e` (v30's is the jest+puppeteer
  runner).
- **e2e global setup is plugin-local** (`tests/e2e/config/global-setup.ts`):
  auth, clean state, and activating `gutenberg-sync-engines` by file path
  (worktree-safe), because wp-env leaves mapped plugins INACTIVE on the
  tests site; without that, collaboration never turns on and sessions
  time out. It also deactivates a stale `gutenberg-stub` left by an
  aborted precedence-spec run (an active stub blocks the bundled
  framework). We deliberately do NOT reuse the subtree's global-setup.
- **Collaboration gate:** `wp_is_collaboration_enabled()` is just the
  Gutenberg experiment `gutenberg-real-time-collaboration`
  (WordPress/gutenberg#80658); the old `wp_collaboration_enabled` option
  is gone, and the client flag is
  `window.__experimentalEnableRealTimeCollaboration`. Tests flip the
  experiment through `gutenberg-experiments` in `POST /wp/v2/settings`
  (the fixture's `setCollaboration`) and set `wp_sync_engine` the same
  way; the CLI tools flip it with a `wp eval`. Activating the plugin
  turns the experiment on but does not pin it, so turning it off
  afterward still works; the e2e teardown and the host benchmark's
  restore depend on that.
- **Subtree build layout** (Gutenberg 23.x): built package JS lands at
  `gutenberg/build/scripts/<pkg>/`, not `gutenberg/build/<pkg>/`.
- **Engine switches:** each room records the engine that first wrote
  to it, and the transport answers HTTP 409 when a different engine
  tries to use that room (`docs/operations.md`, "Switching engines").
  Related trap: the storage's `get_cursor()` (the position of the last
  row a client read) and `get_update_count()` are per-request caches
  refreshed ONLY by `get_updates_after_cursor()`, kept that way from
  the post-meta default on purpose. Do not decide anything from them
  before a read has run.
- **An edit pushed from inside `SyncManager.update()` is overwritten.**
  core-data's `editEntityRecord` hands the sync manager the edits
  BEFORE it saves them, and every editor edit carries the editor's own
  block tree, so that save replaces any `editRecord` made during the
  call. This is deterministic, not a race: a push that reacts to the
  editor's own changes must be made from a later task (intent-log
  defers them past the typing burst; see `scheduleEditorSync`). Pushes
  from a transport callback work normally. The symptom is an editor
  whose tree silently never gets its syncIds.
- **Worktrees mount the plugin twice in wp-env:** `.wp-env.json` maps `.`
  to `wp-content/plugins/gutenberg-sync-engines` AND lists `.` in
  `plugins`, which also mounts it under the checkout's directory name.
  In a worktree the two differ, and activating both copies is a fatal
  `Cannot redeclare gutenberg_sync_engines_bootstrap()`. Keep the
  DIRECTORY-NAME copy active and the `gutenberg-sync-engines` copy
  inactive: `wp-env start` re-activates the directory-name copy on
  EVERY start, so the reverse arrangement fatals and aborts the next
  start. `npm run rtc:ws` enforces the surviving arrangement.

## Coding standards

- PHP: `composer lint` / `composer format` (PHPCS: WordPress-Core/Extra/Docs
  + PHPCompatibilityWP). Keep `composer lint` at zero errors and zero
  warnings; the excludes (`gutenberg/`, frozen cores, vendored
  libraries) are by design and must not widen.
- JS/TS: `npm run lint:js` (lints `src`, `tests` and the example relay)
  + `npm run format` (`@wordpress/prettier-config`). JSON is two-space
  (a `*.json` override in `prettier.config.js`); everything else keeps
  the WordPress config's tabs.
- The frozen intent-log core, the vendored `y-utilities/`, and the
  generated test vectors are excluded from prettier on purpose; what
  each is and how it is checked is in `docs/vendored-libraries.md`.
  Leave them alone unless deliberately syncing the cross-language
  contract (JSDoc-only edits to the core are fine).

## Commits / PRs

- **`CHANGELOG.md` records significant changes only.** Add an entry under
  **Unreleased**, as part of the change itself (same commit or PR), when a
  change is one of these: a new feature, a new setting or extension point,
  behavior that is removed or works differently, or anything a site owner
  or developer must know about when they upgrade. Do NOT add entries for
  bug fixes, tests, benchmarks, the fuzzer or other developer tooling,
  refactors, or docs; the commit message and the issue record those. Why:
  nearly every branch used to touch the same lines of the changelog, so
  merges conflicted constantly. Keep each entry to one or two sentences
  and link the issue. When in doubt, leave it out: when a version ships,
  the release script appends every commit merged since the last release
  under that version, so nothing is lost (`npm run release -- --dry-run`
  previews that list).
- **If a change alters a default, an option name, a filter, a
  transport slug, a REST route, or a row type, update
  `docs/settings.md` or `docs/protocol.md` in the same commit.** Name
  the page in the CHANGELOG entry. `npm run lint:docs` runs in CI and
  checks:
  - every path, option, filter, class and constant the docs name
    exists in the code;
  - links and anchors resolve, and `docs/README.md` lists every page;
  - a number wrapped in a `const:` HTML comment (see
    `docs/settings.md`) matches the code.
  It cannot tell when a changed default leaves a sentence stale; you
  must check that.
- This repo has commit **signing disabled locally**. Commit with
  `--no-verify` (the pre-commit hook is heavy/flaky).
- Do **not** open PRs / push to shared branches / take other
  outward-facing actions unless the user names that specific action.

## Releasing (HUMANS ONLY)

Releasing is a **human-only** action. Agents must never run `npm run
release`, trigger either release workflow, push a `release/*` branch, tag a
version, or bump the plugin version, not even when a release "seems ready".
An agent's entire involvement in releasing is: keep the changelog's
Unreleased section accurate (significant changes only, see Commits / PRs)
and use `@since n.e.x.t` in new code (the release tooling stamps the real
version).

## Issues and the loop

Open work lives in **GitHub Issues** (`gh issue list --label "agent:ready"`).
Anyone can file one; an agent investigates it and rewrites it into the
shape defined by `.github/ISSUE_TEMPLATE/shaped-issue.md`. Read
`docs/plan/README.md` for the rules and the label set before touching
any of it. The loop is `/loop /shape-issue` to work up what was filed,
then `/loop /solve-issue`; either also takes a single issue number
directly. Cycle notes go on the issue as a comment; durable lessons go in
`docs/plan/history.md` under "Running the loop".
