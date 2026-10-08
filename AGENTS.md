# AGENTS.md

How to work in this repo: the environments, the tests, the diagnostics,
and the rules. What the plugin is and how it behaves is in `README.md`
and `docs/` (start at `docs/README.md`); the traps are in
`docs/traps.md`. A room, below, is one post's shared editing session.

## Language

- IMPORTANT: Write clear, short sentences as if explaining things to a
  less-technical friend. Avoid all technical jargon and self-invented
  terms. Do not use abstract structural metaphors or shorthand arrow
  chains.
- Practice "BLUF": Bottom Line Up Front. Start with the main point or
  conclusion, then provide supporting details.
- Be as concise as possible without omitting essential information.
- Before posting something for external consumption, run the draft past
  a fresh subagent instructed to flag jargon and follow these language
  rules. Use a model that is skilled at summarizing.
- If a word is defined in `docs/glossary.md`, it is one of our invented
  words and belongs in code and design pages, not in an issue's title,
  problem, or example (`CONTRIBUTING.md` has the rule).

## Repo layout

- `gutenberg-sync-engines.php` — plugin entry.
- `includes/` — server PHP: `engines/{intent-log,yjs-server,de-rtc}/`
  (one folder per engine; none uses another's classes), `shared/`,
  `transports/` (polling, `sse/`, `websocket/`), `admin/` (the settings
  screen), `storage/`, `diagnostics/` (dev-only), `lib/` (vendored
  y-php and automerge-php, frozen; see `docs/traps.md`).
- `src/` — client TypeScript; `src/index.ts` builds `build/sync-engines.js`
  with `@wordpress/sync` and `yjs` external: `engines/`, `shared/`,
  `providers/{http-polling,sse,sse-daemon,websocket,advisory}/`,
  `awareness/`, `entity-sync/`, `framework.ts`, `debug/inspector.ts`.
- `gutenberg/` — a squashed Git subtree of Gutenberg, source only,
  pinned by `gutenberg-pin.json` (`commit`, `trunk`, and `tree`, which
  must equal `git rev-parse HEAD:gutenberg`). The plugin loads it when
  no standalone Gutenberg is active. Framework changes live on the
  Gutenberg `try/sync-engines` branch: rebase that branch on upstream
  trunk, test it, then `git subtree pull --prefix=gutenberg <checkout>
  <commit> --squash`, update the pin, rebuild, and run typecheck, Jest
  and the browser tests. Keep the private API exports, the post-lock
  fallback, the entity sync registration and the conflict-review
  callbacks the vendored copy carries. The release zip includes the
  built framework.
- `tests/` — `phpunit/`, `js/` (Jest, mirroring `src/`), `e2e/`
  (Playwright specs, config, fixture plugins, launchers in `bin/`),
  `benchmarks/`, `debugging/`, `fuzzer/`, `tools/`; each of the last
  four has a README.
- `bin/` — `build-plugin-zip.sh` and `release.mjs` (humans only).
- `blueprint.json` / `blueprint.local.json` — Playground blueprints.
- `examples/advisory-relay/` — the bring-your-own relay a host copies,
  with its protocol in its README.

## Setup

The commands are in `README.md` (Development). The subtree build
(`cd gutenberg && npm ci --ignore-scripts && npm run build`) is needed
for Jest and `npm run typecheck` too, because they resolve
`@wordpress/sync` and `yjs` from it; `--ignore-scripts` skips the
subtree's Husky hook, which needs its own Git root.

## Environment

Two SEPARATE wp-env configs, each a single site:

```bash
npm run env start         # DEV env (.wp-env.json), http://localhost:8888;
                          # its afterStart hook starts the sync daemon
                          # (detached; the transport selection is NOT touched)
npm run env:tests start   # TESTS env (.wp-env.tests.json), http://localhost:8889,
                          # Redis only; what test:php / test:e2e / CI target
npm run env:stop          # Stops Redis + WordPress (env:tests:stop for tests)
npm run cache:on          # Puts the Redis Object Cache drop-in in (the file that
                          # makes the object cache persistent); cache:off removes
                          # it; cache:tests:on/off for the tests env. Both configs
                          # leave it OUT, so the suites run without a persistent cache.
```

Each config's `afterStart` hook (a wp-env lifecycle script) starts a
Redis container as `sync-redis` and sets `WP_SYNC_SSE_REDIS_URL`. A
Redis that fails to start does not fail the environment. Plain `wp-env
stop` (and `npm run env stop`) leaves Redis running; use `npm run
env:stop`. With the object-cache drop-in on, the whole site goes through
Redis, so measurements describe a Redis-backed host. The benchmarks
switch this per run (`cache=none|redis`, `wake=auto|redis|cache|table`)
and restore it.
`autoPort` is on, so a busy port makes wp-env pick another and print
it; force one with `WP_ENV_PORT`. Each config has its own work dir
under `~/.wp-env`, databases included. Personal overrides go in
`.wp-env.override.json` / `.wp-env.tests.override.json`.

`npm run playground` needs no Docker: a local WordPress Playground at
http://127.0.0.1:9400 with `blueprint.local.json` applied (both plugins
active, a second account `editor` / `password`). The checkout must be
BUILT first; PHP edits are live, JS edits need `npm run build`. There is
no daemon and nothing persists. `--login` is pinned because the
blueprint's `login: true` alone does not log a browser in; `--workers=1`
because with several PHP workers the editor shows "Session expired" at
random.

## Testing

```bash
npm run test:js             # Jest: engines/providers + frozen-core vectors
npm run test:php            # PHPUnit in the wp-env tests container
npm run test:e2e            # Playwright: two-browser collaboration (+ http-only)
npm run test:e2e:websocket  # websocket-only suite (runs the daemon)
npm run test:e2e:sse        # sse-only suite (needs the tests Redis)
npm run test:e2e:sse-daemon # sse-daemon-only suite (runs the daemon)
npm run lint:docs           # the prose against the code (see Commits / PRs)
composer --working-dir=includes/lib/y-php install && composer --working-dir=includes/lib/y-php test
php includes/lib/automerge-php/tests/run.php   # the vendored suites, no WordPress
```

Iterate at the cheapest layer that can catch the change, fast to slow:

1. `node tests/tools/sweep.js [seeds] [steps] [clients]` (defaults
   60/400/3; no WordPress): the first check for any intent-log planner
   or merge change.
2. `npm run test:js` (needs only the built subtree).
3. The vendored suites, only when touching the vendored libraries.
4. `npm run test:php`.
5. `npm run test:e2e` (minutes).
6. `npm run fuzz:quick` as a post-change smoke; the full `npm run fuzz`
   matrix for bug hunting (`tests/fuzzer/README.md`).

Single-test loops: `npm run test:js -- sync-id` (files matching),
`npm run test:js -- -t 'name'`, `npm run test:php -- --filter Class`,
`npm run test:e2e -- collaboration-intent-log`,
`RTC_E2E_ENGINE=de-rtc npm run test:e2e` (one engine's slice; CI runs
one e2e job per engine, selected by `@engine-<slug>` in the describe
title, and `RTC_E2E_ENGINE=none` runs the untagged specs).

Test traps:

- Never run `test:php` while an e2e run is in flight against the same
  env: PHPUnit wipes the tests database. Serialize the suites.
- `test:php` leaves the plugin INACTIVE; a daemon suite started next
  fails with `Error: 'collaboration' is not a registered wp command.`
  Reactivate first:
  `npx @wordpress/env --config .wp-env.tests.json run cli wp plugin activate gutenberg-sync-engines`.
- `test:php` and `test:e2e` need the running TESTS env with the subtree
  built, and e2e needs `npx playwright install chromium` once. If the
  tests site is not on `:8889`, pass `WP_BASE_URL`. If ANOTHER
  project's wp-env holds `:8889`, Playwright silently reuses that site
  and the first failure is a global-setup REST call dying with
  "Unexpected end of JSON input"; `npm run doctor` detects this.
- The transport suites, one per command:
  - `websocket-only` under `test:e2e:websocket`:
    `tests/e2e/bin/rtc-real-ws-daemon.mjs` selects the transport,
    publishes the daemon on host port 8787, runs the example relay on
    8790, and restores the transport at teardown.
  - `sse-only` under `test:e2e:sse`; it refuses to run without the
    tests Redis.
  - `sse-daemon-only` under `test:e2e:sse-daemon`.
  - `sse-framing` under both SSE suites.
  - `@y/websocket-server` stays pinned to 0.1.1 (0.1.5 crashes with a
    13.x client); the old y-websocket fixture is used by no suite.
- `npm run rtc:ws` starts the real websocket transport for manual
  two-window testing (the daemon must bind 0.0.0.0 with port 8787
  published; wp-env alone cannot publish extra ports); `npm run
  rtc:http` switches back. The DEV env's `afterStart` hook does the same
  with `--mode=daemon --detach`; with several worktrees the most
  recently started dev env owns port 8787.

## Diagnostics

- `npm run doctor` — read-only preflight: builds, both environments,
  the worktree plugin-copy arrangement, whether the plugin loaded, the
  engine and transport options, the foreign-wp-env trap, the Redis
  drop-in, daemon health. Uniform timeouts across all engines are an
  environment failure, not an engine bug.
- `window.wpSync` on every editor page (`src/debug/inspector.ts`):
  `enable()`, then `tail()`, `log()`, `table()`, `intents('p1')`,
  `doc()`, `proposals()`, `cursor()`, `export()`, `help()`. Enabling it
  also makes every engine add a `_debug` section to its answers (gated
  by `SCRIPT_DEBUG` or the `wp_sync_debug_enabled` filter).
- Query Monitor's `qm/debug` action receives lock timeouts, edits held
  back or thrown away, repairs, snapshots, trimming and engine
  mismatches.
- `wp collaboration rooms list|inspect` (dev-only) and
  `wp collaboration storage status` (`docs/storage.md`);
  `wp collaboration capture start|stop|list|export|drop` records real
  sessions for `tests/debugging/replay/`, and requests tagged
  `X-RTC-Test: 1` get per-request server metrics
  (`wp collaboration bench-log report`).
- The fuzzer writes `summary.md` with failure signatures and replay
  commands; `--shrink` bisects a failure; `RTC_FUZZ_LOG_SYNC=1` captures
  wire summaries. `tests/tools/observe-two-tab-sync.mjs` is the manual
  two-tab observer.

## Environment traps

- `jest.config.js` sets `roots: [src, tests]`; without it Jest recurses
  into the subtree's ~1030 suites. `phpcs.xml.dist` excludes
  `/gutenberg/*`.
- `@wordpress/scripts` does NOT bundle wp-env; it is pinned to
  `@wordpress/env@^11` with an `overrides` entry that clears the
  ERESOLVE. Composer pins `phpunit/phpunit:^9.6`; PHPUnit 10 removed a
  method WordPress's bootstrap calls.
- `tests/bootstrap.php` loads the framework before the plugin, from
  `WP_SYNC_FRAMEWORK_PLUGIN` or the subtree's wp-env path; otherwise
  `WP_Sync_Post_Meta_Storage not found`.
- e2e must load a single `@playwright/test`: the subtree's `npm install`
  re-creates its own copy, and `pretest:e2e` removes it. The runner is
  `playwright test` directly, NOT `wp-scripts test-e2e`.
- `tests/e2e/config/global-setup.ts` activates the plugin by file path
  (wp-env leaves mapped plugins INACTIVE on the tests site) and
  deactivates a stale `gutenberg-stub` from an aborted precedence run.
- Collaboration is on only while the Gutenberg experiment
  `gutenberg-real-time-collaboration` is; tests flip it through
  `gutenberg-experiments` in `POST /wp/v2/settings` (the fixture's
  `setCollaboration`), the CLI tools with a `wp eval`. The client flag
  is `window.__experimentalEnableRealTimeCollaboration`. Activation
  turns it on but does not pin it.
- Built subtree JS lands at `gutenberg/build/scripts/<pkg>/`.
- Worktrees mount the plugin twice (`.wp-env.json` maps `.` to
  `wp-content/plugins/gutenberg-sync-engines` AND lists `.` in
  `plugins`); activating both is a fatal
  `Cannot redeclare gutenberg_sync_engines_bootstrap()`. Keep the
  DIRECTORY-NAME copy active: `wp-env start` re-activates it on every
  start, so the reverse arrangement aborts the next start. `npm run
  rtc:ws` enforces this.

## Coding standards

- PHP: `composer lint` / `composer format`; keep lint at zero errors and
  zero warnings, and never widen the excludes. JS/TS: `npm run lint:js`
  + `npm run format`. JSON is two-space; everything else keeps tabs.
- The frozen intent-log core, the vendored `y-utilities/`, and the
  generated test vectors are excluded from prettier on purpose
  (`docs/traps.md`). JSDoc-only edits to the core are fine.

## Commits / PRs

- **`CHANGELOG.md` records significant changes only** (a new feature,
  setting or extension point, or behavior that changes), under
  **Unreleased**, as part of the change itself, one or two sentences
  with the issue linked. Not bug fixes, tests, tooling, refactors or
  docs; the release script lists every merged commit anyway.
- **A change to a default, an option name, a filter, a transport slug,
  a REST route or a row type updates the settings screen's text
  (`includes/admin/class-gutenberg-sync-engines-settings.php`) or
  `docs/protocol.md` in the same commit.** `npm run lint:docs` (CI)
  checks that every path, option, filter, class and constant the docs
  name exists in the code, that links and anchors resolve, that
  `docs/README.md` lists every page, and that a number wrapped in a
  `const:` HTML comment matches the code. It cannot tell when a changed
  default leaves a sentence stale.
- Commit signing is disabled locally; commit with `--no-verify` (the
  pre-commit hook is heavy).
- Do **not** open PRs, push to shared branches, or take other
  outward-facing actions unless the user names that specific action.
- **Releasing is human-only.** Never run `npm run release`, trigger a
  release workflow, push a `release/*` branch, tag, or bump the version.
  Use `@since n.e.x.t` in new code.

## Issues and the loop

Open work lives in GitHub Issues (`gh issue list --label "agent:ready"`);
`CONTRIBUTING.md` has the labels and the filing rules. The loop is
`/loop /shape-issue` then `/loop /solve-issue` (either takes an issue
number). Notes about what one cycle did go on the issue as a comment;
a durable lesson goes in `docs/traps.md`.
