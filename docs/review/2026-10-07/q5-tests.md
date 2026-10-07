# Q5: Are the tests and benchmarks sound? Do they convey confidence to a newcomer?

Reviewed worktree: `/Users/zzz/Code/worktrees/gutenberg-sync-engines/review-arch` (branch `review/arch`, head `113c5dab1c`). Date: 2026-10-07.

## Bottom line

The test suite is large, fast at the cheap layers, and green. Every suite I could run locally passed with no failures and almost no noise. CI runs on every push and PR, and the last three successful trunk runs show zero flaky retries in any e2e lane. The cross-language contract (intent-log) is checked in both directions by the same frozen file. The simulator oracles check real properties (convergence, no lost work, verifiable effects), not snapshots.

The confidence gaps are these. (1) Two suites that AGENTS.md presents as part of the certified set are not in CI: the `sse-daemon` e2e lane and the fuzzer. The simulator sweep runs in CI only at a reduced size (12 seeds x 150 steps inside Jest, versus 60 x 400 on the command line). (2) The de-rtc descriptor contract is one-directional: PHP generates the fixture and only the TypeScript side replays it; PHPUnit never reads it, and regenerating needs a running wp-env. (3) The e2e specs lean on 33 fixed `waitForTimeout` sleeps (1 to 8 seconds each) as "settle windows". These are deliberate and commented, but on a slower host they are the first thing that will break. CI keeps 2 retries to absorb one known intermittent. (4) The benchmarks have a sound single-run method (3 reps, 1 warm-up, p50/p90/p99, environment stanza) but no result is tracked over time; only the never-lose-work invariant is enforced in CI. The "number-free docs" policy is sound for the docs, but it also means nobody can see a performance regression without running the suite by hand. (5) Some first-impression details are off: there is no `npm test` script (`npm test` fails with "Missing script"), the sweep prints a Node module-type warning, AGENTS.md says CI runs on pushes to `main` while the workflow runs on `trunk`, and the vector-parity test header names a generator folder that no longer exists.

For a newcomer, the suite reads well as a specification: Jest and e2e names describe user-visible behavior ("both users typing on an EMPTY post converge without deleting each other"). PHPUnit names are more mixed; one file carries 8 empty stub tests the base class forces.

## What I ran

| Suite | Command | Result | Wall time | Noise |
| --- | --- | --- | --- | --- |
| Jest | `npm run test:js` | 63 suites, 775 tests, 775 passed, 0 skipped, 0 snapshots | 4.3 s (Jest), 5.3 s wall | None. Output is PASS lines plus the summary. `@wordpress/jest-console` (part of the wp-scripts config) fails any test that logs an unexpected console error, so silence is enforced, not accidental. |
| Typecheck | `npm run typecheck` | exit 0 | 1.8 s | None |
| Simulator sweep | `node tests/tools/sweep.js` (60 seeds x 400 steps x 3 clients) | 17,114 intents authored, 11,405 accepted, 66.5% applied / 33.0% escalated / 92 voided, "all oracles green" | 4.05 s | One Node warning: `MODULE_TYPELESS_PACKAGE_JSON` ("add \"type\": \"module\" to package.json"). Four lines of noise before the result. |
| automerge-php conformance | `php includes/lib/automerge-php/tests/run.php` | `passingTests: 680, failingTests: 0, passPercent: 100` (688 registered incl. 8 optional) | 0.61 s | None. Output is a JSON report. Local PHP 8.4.26 links PCRE2 10.49, so the GB11 trap in AGENTS.md did not apply. Worktree stayed clean afterwards (the `PORTING_STATUS.json` delta works). |
| y-php conformance | not run | `includes/lib/y-php/vendor` is not installed in this worktree | - | - |
| PHPUnit, e2e, fuzzer, bench | not run (need wp-env) | see CI section for recent results | - | - |

`npm test` fails: `npm error Missing script: "test"`. There is no umbrella script.

## 1. Inventory and shape

| Layer | Files | Cases | How counted | In CI? |
| --- | --- | --- | --- | --- |
| Jest (`tests/js`) | 63 `*.test.*` | 775 (reported by Jest); ~648 static `it(`/`test(` calls, the rest generated from vectors and loops | Jest summary | Yes (`js` job) |
| Jest by area | intent-log core 15 files / 125 static; de-rtc 14 / 93; yjs-server 6 / 62; providers 9 / 203; root-level engine managers 6 / 120; awareness 4 / 16; entity-sync 5 / 15; benchmarks 2 / 8; examples 1 / 3; e2e-fixture unit 1 / 3 | grep | Yes |
| PHPUnit (`tests/phpunit`) | 44 classes | 515 `function test_*` methods; 8 are `@doesNotPerformAssertions` stubs forced by `WP_Test_REST_Controller_Testcase` (`wpHttpPollingSyncServer.php`); 5 conditional `markTestSkipped` (2 need PHP >= 8.2 + mbstring, 3 need multisite) | grep | Yes (`php` job, inside wp-env) |
| PHPUnit largest classes | `wpHttpPollingSyncServer` 66, `wpSyncEngineBenchmark` 34 (tests the benchmark harness itself), `wpIntentLogEngine` 32, `wpDeRtcEngine` 30, `gutenbergSyncEnginesAdvisoryPresence` 30, `wpYjsServerEngine` 28, `wpSyncTableStorage` 23 | grep | Yes |
| Playwright default suite (`specs/` + `specs/http-only/`) | 9 + 5 spec files | 57 static `test(` calls; 81 tests executed in CI (specs parametrized over engines: `multi-client-content`, `unsaved-changes`, `text-slices`) split as intent-log 32, yjs-server 15, de-rtc 15, engine-neutral 19 | CI logs of run 37655909702 | Yes, 4 parallel jobs |
| Playwright `websocket-only` | 4 files | 4 tests (CI: "4 passed (1.2m)") | CI log | Yes |
| Playwright `sse-only` + `sse-framing` | 1 + 1 files | 1 + 3 = 4 tests (CI: "4 passed (43s)") | CI log | Yes |
| Playwright `sse-daemon-only` + `sse-framing` | 1 + 1 files | 2 + 3 = 5 tests | grep | **No.** `ci.yml` has no `test:e2e:sse-daemon` step (verified by grep: no match for `sse-daemon`). |
| Fuzzer (`tests/fuzzer`) | 1 spec (2,201 lines) + runner (1,099 lines) + `runner.test.mjs` (2 tests, `node --test`) | 1 parametrized test per seed x engine x transport; `npm run fuzz:quick` = 3 engines x 2 seeds | grep | **No.** Not in any workflow. `runner.test.mjs` is not under Jest either. |
| Simulator sweep | `tests/tools/sweep.js` + `simulator.js` (1,015 lines) | CLI default 60 seeds x 400 steps; Jest replica runs 12 seeds x 150 steps (`simulator.test.js:191-204`) | file read | Only the reduced Jest form |
| Vendored y-php | 35 `*Test.php`, 274 test methods | - | grep | Yes (`php` job) |
| Vendored automerge-php | hand-rolled runner | 680 mapped upstream tests, 688 registered | runner JSON | Yes (in `php:8.4-cli` docker) |
| Benchmarks | `tests/benchmarks/` 17 files; `host/` 3; `transport/` 3 | `--certify=3` invariant sweep | `ci.yml:207` | Yes (`bench` job, certify only) |

### Mapping source to tests

Method: for every file under `src/` (excluding vendored `y-utilities/`) I checked whether any file under `tests/js`, `tests/e2e`, or `tests/fuzzer` names its module path; for every class under `includes/` (excluding `lib/`) I checked whether `tests/phpunit` or `tests/benchmarks` names the class. The script is in my scratchpad (`map.js`).

**`src/` files no test imports directly** (2,531 of 25,718 lines, ~10%):

| File | Lines | Note |
| --- | --- | --- |
| `src/providers/advisory/webrtc-link.ts` | 723 | The WebRTC mesh. Exercised indirectly through `channel.test.ts` and the e2e `collaboration-advisory-channel.spec.ts` (2 tests, engine-neutral lane). No unit test owns its peer-connection state machine. Largest untested JS surface. |
| `src/providers/advisory/websocket-link.ts` | 524 | `websocket-link.test.ts` exists but drives it through `channel.ts` (`startAdvisoryChannel` with `channel: 'websocket-advisory'`, lines 101/164). Indirect but real coverage. |
| `src/awareness/ui/presence-badges.tsx`, `canvas-styles.ts`, `block-indicator.tsx` | 432 + 302 + 108 | Slow-awareness UI. One e2e test (`collaboration-slow-awareness.spec.ts`, "shows a peer's block with an outline and a badge") covers the visible result. No component tests. |
| `src/awareness/controller.ts` | 143 | Wires publisher + channels + store. Pieces are tested; the wiring is not. |
| `src/shared/awareness-sync.ts` | 112 | Presence bridging used by all three engines. Only covered through engine tests that construct real awareness instances. |
| `src/providers/session-extensions.ts` | 54 | Small. |
| `src/providers/advisory/link.ts` | 84 | Interface + small helpers. |
| `src/debug/inspector.ts` | - | Not flagged by my script because one e2e test names it ("the wpSync console inspector records decoded wire traffic when enabled"). No unit test. |

False positive from my script: `src/engines/intent-log/text-slices.js` is tested (`text-slices.test.js` imports it with a `.js` extension, which my pattern missed).

**`includes/` classes never named in a test** (8,199 of 32,123 lines; 6,400 of those are `merge-core.php`, which IS tested by `wpDeRtcMergeCore.php` through its functions, so the real figure is ~1,800 lines, ~6%):

| File | Lines | Note |
| --- | --- | --- |
| `includes/class-gutenberg-sync-engines-plugin.php` | 505 | Plugin bootstrap and registration. Only `gutenbergSyncEnginesActivation.php` (5 tests) touches activation. |
| `includes/diagnostics/class-gutenberg-sync-engines-rooms-cli-command.php` | 326 | Read-only CLI. `gutenbergSyncEnginesDiagnostics.php` (15 tests) covers request log and capture, not this. |
| `includes/diagnostics/class-gutenberg-sync-engines-capture-cli-command.php` | 190 | CLI wrapper. |
| `includes/storage/class-wp-sync-table-storage-cli-command.php` | 173 | `wp collaboration storage` CLI. |
| `includes/transports/sse/class-wp-sync-sse-daemon-transport.php` | 167 | The `sse-daemon` transport class. Its only coverage is the e2e lane that CI does not run. |
| `includes/class-wp-sync-presence-api-tab-list-backend.php` | 96 | Presence-API tab list. |
| `includes/diagnostics/class-gutenberg-sync-engines-bench-log-cli-command.php` | 90 | CLI wrapper. |
| `includes/transports/websocket/class-wp-sync-server-cli-command.php` | 79 | CLI wrapper. |
| Three interfaces (`WP_Sync_CAS_Backend`, `WP_Sync_Lock_Backend`, `WP_Sync_Tab_List_Backend`) | 173 | Interfaces; fine. |

**Largest untested surfaces, ranked:** (a) `webrtc-link.ts` (723 lines, no direct test, two e2e tests); (b) the `sse-daemon` transport end to end (PHP class 167 lines + 5 e2e tests that never run in CI); (c) the slow-awareness UI (842 lines, one e2e test); (d) the WP-CLI commands (~860 lines, zero tests, but they are gated off production). The websocket daemon (`class-wp-websocket-sync-server.php`, 2,088 lines) is referenced by `wpWebSocketSyncTransport`, `wpWebSocketAdvisory`, `wpWebSocketClosedStream`, `wpWebSocketRoomScan` (20 tests total) plus the websocket e2e lane; coverage exists but is thin for its size.

## 2. Test quality (25+ samples)

Verdict: the suite tests behavior far more than implementation. Assertions are specific. Setup is readable because test names and inline comments state the scenario. The weak spots are fixed sleeps in e2e, a few tests that read `wp.data` store internals, and one PHPUnit class with forced empty stubs.

### Jest

1. `tests/js/providers/http-polling/polling-manager-cadence.test.ts` (29 tests). Names read as rules: "a lone tab keeps the solo cadence for a discovery window after load, then stops scheduling", "a flush that lands while a poll is in flight waits for the successor that carries the work". Setup (lines 18-110) mocks the signaling lane, the SSE exchange, the advisory channel, and `announce` with controllable fakes. Behavior-level, but the 90-line mock block is heavy; a newcomer must know four internal modules to follow it. Fake timers throughout (310 uses of `useFakeTimers`/`advanceTimersByTime` across the Jest suite), so no real sleeps.
2. `tests/js/engines/intent-log-manager.test.ts:REGRESSION: an edit made during the join round trip is captured at bootstrap`. Replays a fuzzer finding (seed 6) deterministically: `manager.update(...)` before snapshot, `expect(sent).toHaveLength(0)`, snapshot lands, `jest.advanceTimersByTime(1)`, then asserts an `insert_block` carrying "typed during join" reached the wire. Meaningful, documented, and traceable to its origin. Good.
3. `tests/js/engines/de-rtc/announce.test.ts` "holds commits after a merged own announcement so the rest of a typing burst never declares the stale base". Asserts "Gamma" is absent before the burst quiets and present after. One real sleep: `setTimeout(resolve, 140)` at line 431 against a 50 ms quiet window (`setDeRtcBurstQuietMsForTesting(50)`). Acceptable margin, but it is one of only 4 real sleeps in Jest (the others: two `setTimeout(…, 0)` flushes and the relay test's `wait`).
4. `tests/js/engines/yjs-server/engine.test.ts` "does NOT seed the document from the loaded record on hydrate". Behavior contract. Good.
5. `tests/js/providers/sse/sse-exchange.test.js` "never applies an event cut off by a killed PHP process", "reconnects after a kill with the last applied cursor, not a partial event". Protocol framing tested as failure cases. Good.
6. `tests/js/engines/intent-log/merge-matrix.test.js`. Every intent type against every intent type; no hand-written expected documents; asserts universal guarantees (termination, determinism, prediction parity, convergence, verifiable effects). Property-based, not snapshot-based. Strong.
7. `tests/js/engines/intent-log/vectors.test.js` + `vector-parity.test.js`. Replays the frozen file in JS; asserts both copies are byte-identical (see section 4).
8. `tests/js/awareness/publisher.test.ts` "publishes on start and then only when the block changes". A 25-line `fakeReader()` makes the setup self-explanatory. Good.
9. `tests/js/entity-sync/adapter.test.js` "propagates a preparation failure before the request". Good.
10. `tests/js/framework-review.test.ts`. Drives the REAL `createSyncManager` from the subtree with a fake engine that supplies a `review` source. Tests the integration seam, not a mock of it. Good.
11. `tests/js/benchmarks/host-measurement.test.js` "accepts cache and wake controls before workload validation". Spawns the benchmark CLI and asserts on `stderr` text ("edit-seconds must be at least 30"). This is an argument-parsing test that asserts on a message string. Low value, slightly brittle, but harmless.
12. `tests/js/e2e/collaboration-login.test.js`. A Jest unit test of the e2e login fixture, with a mocked page whose `waitForURL` rejects to reproduce the old flake. Unusual and good: the flake fix has its own regression test.
13. `tests/js/engines/intent-log/simulator.test.js` "randomized schedules uphold every oracle across seeds" (12 seeds x 150 steps) and "simulation is exactly reproducible from its seed". Good, but much smaller than the CLI sweep.

### PHPUnit

14. `tests/phpunit/wpHttpPollingSyncServer.php`. 66 methods. Names are specific ("test_a_poll_carrying_unchanged_awareness_writes_nothing", "test_an_idle_poll_with_a_persistent_object_cache_reads_one_table_once", "test_sync_awareness_client_id_cannot_be_used_by_another_user"). Uses a `Test_Opaque_Relay_Engine` fixture so the transport is tested without a real engine; the header explains why (lines 21-29) and a `set_up` comment explains a WP hook-snapshot trap (lines 64-70). The 8 `@doesNotPerformAssertions` stubs (`test_get_items`, `test_create_item`, etc.) are forced by the REST controller base class and inflate the count by 8. The query-count test (`reads_one_table_once`) tests an implementation property on purpose, and the AGENTS.md "Storage" section explains why it matters.
15. `tests/phpunit/wpSyncTableStorage.php` "test_meta_and_lineage_writes_leave_insert_id_naming_the_last_update_row" (lines 71-90). Pins `$wpdb->insert_id` after meta writes with a message explaining the engine contract. Implementation-level, but it guards a real bug ("the insert_id-after-meta-write trap"). "test_cursor_caches_refresh_only_on_read" likewise pins a documented gotcha.
16. `tests/phpunit/wpYjsServerEngine.php` "test_genesis_snapshot_on_first_read" (sampled). Builds a y-php client doc from the response and asserts title, block name, attribute, content text, and lineage stamp. Behavior-level with concrete values. Good.
17. `tests/phpunit/wpDeRtcMergeCore.php` "test_update_not_matching_proposed_content_is_rejected" (asserts `de_rtc_sync_meta_tampered`) and "test_missing_client_update_is_server_generated" (asserts both edits are in `merged_content`). Good. Two tests skip when PHP < 8.2 (automerge-php gate).
18. `tests/phpunit/wpSyncEngineBenchmark.php` (34 tests). Tests the benchmark harness itself: "test_convergence_oracle_detects_corruption", "test_workload_generation_is_deterministic", "test_de_rtc_contended_paragraph_salvages_conflicts_and_loses_nothing". This means the oracle the certify sweep relies on is itself tested. Good.
19. `tests/phpunit/wpSseSyncServer.php` "test_stream_delivers_a_notice_and_ends_cleanly_on_redis_loss", "test_without_redis_the_stream_notices_a_new_row_by_checking_storage". Failure paths named. Good.
20. `tests/phpunit/wpSyncAwareness.php` "test_a_write_does_not_disturb_another_client", "test_the_presence_api_backend_stands_down_when_not_recording". Good.

### Playwright

21. `collaboration-intent-log-engine.spec.ts` "a passive reader on an EMPTY post receives typed content" (lines 253-298). Collects `pageerror` and console errors on page2, filters "Failed to load resource" noise, asserts `pageErrors` is empty after the text arrives. This is a console assertion, but it is used as a "no sync error" oracle, and the filter is explained. Reasonable.
22. Same file, line 246: `await page1.waitForTimeout(3000)` then asserts both canvases still show 2 paragraphs, commented "And they STAY converged (no delete/reinsert war)". A fixed sleep used as a stability window. The assertion after it is meaningful, but the 3 s is a guess.
23. Same file, lines 912-945 (review-panel resolve). `toPass({timeout: 60000})` wrapping a loop that clicks Reject until the panel is empty, then `waitForTimeout(3000)` for "quiescence", then `waitForTimeout(4000)` twice around a reload. Three fixed sleeps in one test (11 s). Comments explain each. This is the pattern most at risk on a slow host.
24. `collaboration-multi-client-content.spec.ts` lines 639-653: a `toPass` loop reads `getEditedPostContent()` via `wp.data`, sleeps 1.5 s, reads again, asserts unchanged. A "settled" probe built from a sleep. There are 38 `wp.data` evaluations across the specs; these read editor state through store selectors rather than the DOM, which is closer to implementation than to what a user sees, but it is the standard Gutenberg e2e approach.
25. `collaboration-unsaved-changes.spec.ts` "keep: reloading the only open tab lands on the shared working copy" (lines 160-200). Fakes `document.visibilityState` via `Object.defineProperty` and dispatches `visibilitychange`, then sleeps 2.5 s + 1 s. The AGENTS.md memory notes Playwright cannot hide a tab, so the fake is forced. It still tests the real flush path.
26. `sse-framing/collaboration-sse-transport.spec.ts` "delivers a peer's edit over the open stream, with the receiver sending nothing". Counts requests by decoded URL and body shape (`rows_received_separately`), reads `window.__wpSyncSseState`. It asserts on wire behavior the transport promises. Good. One `catch {}` around `postDataJSON()` (line 62) is a parse guard, not a swallowed assertion.
27. `http-only/collaboration-advisory-channel.spec.ts` "a tab editing alone polls slowly, holds its typing, and flushes it before a save" (lines 118-150). `waitForTimeout(2000)` then `waitForTimeout(8000)` then `expect(seen.length).toBeLessThanOrEqual(3)`. Cadence tested by counting requests in a fixed window. This is the only honest way to test a cadence, but the 8 s window and the `<= 3` bound encode the 4 s solo cadence; a slower host makes it pass more easily, not fail, so it is safe but weak.
28. `collaboration-de-rtc-engine.spec.ts` lines 208-214: `page1.keyboard.type(' from one', { delay: 150 })` in parallel with page2, with a comment that the delay makes each commit land mid-burst on every host. A deliberate device to make a race deterministic rather than to hide one. Good.
29. `collaboration-yjs-server-late-join.spec.ts` lines 263-297: holds every `wp-sync` request with `page.route` until `releaseAt`, types during the hold, asserts `Date.now() < releaseAt`, then `waitForTimeout(HOLD_MS + 2000)`. Request interception used to create the race on purpose. Good design; the trailing sleep is the usual weakness.
30. `collaboration-slow-awareness.spec.ts` `watchAwarenessErrors` (lines 49-62) collects console messages containing "equality check" and asserts none. A targeted console oracle for a specific past bug. Fine.

### Patterns found

- `test.skip`, `test.fixme`, `test.only`, `xit`, `describe.only`: none in `tests/js`, `tests/e2e`, `tests/fuzzer`.
- Jest `.skip`/`.todo`: none.
- PHPUnit skips: 5 conditional (`markTestSkipped`), all with a reason string. No `@group skip`.
- Catch-and-ignore in e2e specs: 5 sites, all route/parse guards (`route.continue().catch(() => {})`, `postDataJSON` parse), none wrapping an assertion.
- Console assertions: 3 specs use console listeners as "no error" oracles; none assert on log content as the behavior under test.
- Giant fixtures: the 1.1 MB `planner.json` vector file (generated, two copies). The fuzzer spec is 2,201 lines in one file.
- Mocking the thing under test: not found. Mocks replace neighbors (signaling, hooks, apiFetch, blocks registration). The polling cadence test replaces four neighbors at once, which is the heaviest case.
- `@doesNotPerformAssertions`: 8, all forced stubs in one REST test class.

## 3. Flake management

Mechanisms in place:

- **Retries.** The `@wordpress/scripts` base config sets `retries: process.env.CI ? 2 : 0` (`node_modules/@wordpress/scripts/config/playwright.config.js:20`). The plugin config inherits it (`tests/e2e/playwright.config.ts:50-51`). `ci.yml:260-263` names the reason: "absorbs the suite's known under-load flake". The fuzzer config sets `retries: 0` on purpose (`tests/fuzzer/playwright.config.ts:49`) so failures surface, with its own recheck pass instead.
- **Evidence of actual flake rate.** In the three most recent successful trunk CI runs (37655909702, 37554864875, 37071128623) every e2e job log reports N passed with no "flaky" line: intent-log 32/32/32, de-rtc 15/15/15, yjs-server 15/15/15, engine-neutral 19/14/14, websocket 4/4, sse 4/4. So the retries are a safety net that was not used in those runs. That is the strongest confidence signal in this review. Note that Playwright's `github` reporter lists flaky tests separately, so a zero here is meaningful.
- **Timeouts.** Per-test cap lowered from 100 s to 60 s with a stated reason (`playwright.config.ts:55-61`); `navigationTimeout: 30_000` added so a hung login navigation fails fast (lines 62-70). Twelve tests opt up to 120-300 s with `test.setTimeout` (large documents, body size, multi-client content).
- **Hardened login.** `tests/e2e/config/authenticated-collaboration-utils.ts:26-45`: joining users authenticate through a bounded 10 s POST to `/wp-login.php` on the context's request client instead of the login form. The form-focus flake is reproduced in a Jest unit test (`tests/js/e2e/collaboration-login.test.js`). This is a root-cause fix, not a retry.
- **CPU throttle knobs.** `RTC_E2E_CPU_THROTTLE` and `RTC_E2E_PROFILE` (`collaboration-fixtures.ts:26-80, 317-360`) slow the browser and attach long-task timelines and CPU profiles to failures. These exist to REPRODUCE slow-host failures locally, which is the right direction.
- **Per-keystroke delays.** `keyboard.type(..., { delay: 150 })` in the de-rtc concurrency spec forces the commit interleaving on every host (`collaboration-de-rtc-engine.spec.ts:208-214`). This makes a race deterministic rather than hiding it.
- **Visibility fakes.** `Object.defineProperty(document, 'visibilityState')` in `collaboration-unsaved-changes.spec.ts:166-185` because Playwright cannot hide a tab. Honest workaround, documented in memory.
- **The "repetition hammer".** Not a script. It is `--repeat-each=8 --retries=0` on a single spec (memory note `issue-37-structuredclone-stall.md`), used by hand to measure an intermittent. AGENTS.md says the remaining intermittent (issue #37) fires "~1-2 of 8" under it. There is no CI job that runs this, so the rate is not tracked.

Fixed timing constants: 33 `waitForTimeout` calls across 13 of 21 spec files (values 100 ms to 8 s; sum roughly 75 s of sleeping per full run), 14 `setTimeout` (12 are `test.setTimeout` opt-ups, 2 are route-hold timers). Against those, 62 `toPass` blocks, 28 `expect.poll`, 10 `waitForResponse`. So the dominant style is polling with a deadline; the sleeps are "settle windows" after a condition is already met. On a slow host, polls get slower but still pass; the risk is in the handful of sleeps whose assertion is "nothing more happened", because a slow host may not have finished the thing that would break it. These are flagged in comments as deliberate ("Quiescence, not just momentary emptiness", `collaboration-intent-log-engine.spec.ts:909-912`).

Assessment: flakiness is being fixed, not papered over. The one open intermittent is named, has an issue (#37), has reproduction knobs, and its rate is stated. The retries stay on as insurance. The one thing missing is a periodic measurement of that rate (a nightly `--repeat-each` run), so a regression from "1-2 of 8" to "5 of 8" would show up only as CI retries quietly firing.

## 4. The cross-language contract

**Intent-log.** Three vector files (`planner.json` 1.1 MB, `rich-text.json` 12 KB, `sync-id.json` 2.6 KB) exist as two copies, `tests/js/engines/intent-log/test-vectors/` and `tests/phpunit/test-vectors/`. I confirmed with `diff -rq` that the copies are identical.

- JS side: `vectors.test.js` replays `planner.json` through `createServer`/`serverIngestBatch` and compares dispositions, proposals, log, and canonical document; `rich-text.test.js` and `sync-id.test.js` replay the other two.
- PHP side: `wpIntentLogPlanner.php:20` loads `planner.json` and `sync-id.json` (line 85); `wpIntentLogRichText.php:18` loads `rich-text.json`.
- Parity guard: `vector-parity.test.js:26-39` asserts the two folders hold the same file names and that each file is byte-identical.
- Generators: `tests/tools/generate-planner-vectors.js`, `generate-rich-text-vectors.js`, `generate-sync-id-vectors.js`. The planner generator header (lines 5-11) says to write one file and `cp` it to the other folder. Fully deterministic (fixed seeds), no WordPress needed.

So the contract is tested in both directions against one artifact. Drift is detectable three ways: a JS core change breaks `vectors.test.js`; a PHP core change breaks `wpIntentLogPlanner.php`; a regeneration that touches one copy breaks `vector-parity.test.js`. The one undetectable case is a regeneration committed to both copies after a JS change, which `vectors.test.js` header (lines 4-8) says is exactly why the JS replay was added: the reviewer must still read the diff. Vector history: regenerated 2026-08-10, 2026-09-23, 2026-09-28 (`git log` on the file).

Stale doc: `vector-parity.test.js:7` says the generators live in `src/engines/intent-log/tools/`; they live in `tests/tools/`. `wpIntentLogPlanner.php:31` names `prototypes/sync/src/simulator.js`, a path that no longer exists.

**De-rtc descriptor.** One fixture, `tests/js/engines/de-rtc/test-vectors/descriptor-vectors.json` (131 KB), generated by PHP (`tests/tools/generate-de-rtc-descriptor-vectors.php` run through `wp eval-file` by `generate-de-rtc-descriptor-vectors.mjs`) and replayed only by TypeScript (`descriptor-vectors.test.ts`). No PHPUnit test reads it (grep for `descriptor-vectors` in `tests/phpunit` returns nothing). So: if the PHP fingerprint derivation changes, nothing fails until someone regenerates and the TS test then breaks. Regeneration needs a running tests wp-env with the plugin active, so it cannot run in the `js` CI job. The contract is one-directional and the PHP side is pinned only by `wpDeRtcDescriptorEnforcement.php` (9 tests) and `wpDeRtcMergeCore.php` (14 tests), which exercise behavior rather than the frozen fixture. Regenerated twice (2026-08-19, 2026-09-23).

## 5. The simulator sweep

Oracles (`simulator.js:922-1014`, `checkOracles`):

1. Convergence: every drained client's acked document AND optimistic document equal a fresh replay of the full log; every cursor is at head.
2. Intent accounting: every authored intent has a terminal disposition (`applied`/`voided`/`escalated`), escalations appear in the proposal lane, voids carry a reason. "No disposition" is reported as "work lost".
3. Escalation soundness: every proposal's reason is in the documented `ESCALATION_REASONS` set.
4. Effect verification: for every applied log entry, `verifyEffect(docBefore, docAfter, entry)` confirms the documented effect is visible at that position ("applied means verifiably applied").
5. Attribution: every log entry and proposal carries the author that authored it.

Prediction parity and idempotent redelivery are checked inline during the run (header, line 913). These are real properties of the engine's guarantee, not snapshots. The sweep also prints the disposition mix (66.5% applied, 33.0% escalated locally), so escalation-rate drift is visible by eye between runs, but nothing stores or compares it.

CI: `sweep.js` is NOT in CI. `simulator.test.js` runs 12 seeds x 150 steps x 3 clients inside Jest (plus `merge-matrix.test.js`, which runs the same oracles over every ordered pair of intent types). The CLI default (60 x 400) takes 4 s locally, so adding it to the `js` job would cost nothing.

## 6. The fuzzer

Not in CI. Manual only (`npm run fuzz`, `npm run fuzz:quick`). `tests/fuzzer/README.md` lines 94-118 list what it asserts after each seeded step:

- Convergence: all participants expose the same normalized title + block tree (`waitForConvergence`).
- Structural validity: no block becomes `isValid: false`.
- No duplication: every authored marker is unique, so a marker appearing twice is content duplication. Loss is deliberately NOT asserted (parked escalations make absence legitimate).
- Persistence: mid-run save plus a final save, reload, reconverge; REST title and full saved content must match the converged state after parse/serialize.
- Session lifecycle: seeded mid-run reload; with `--users=3`, a late joiner must be able to contribute.
- Fault injection: delayed (250-1500 ms) or failed (429/500/503) sync requests before some steps.

Triage: failing seeds are re-run once with traces; "reproducible" versus "flaky" is split and grouped by signature with a replay command (`summary.md`). `--shrink` bisects steps. `tests/fuzzer/cases/de-rtc-heading-duplication.json` is a kept investigation record ("not a passing test").

Would a newcomer trust it? The design is credible: oracles are engine-neutral, it finds real bugs (two regression tests in `intent-log-manager.test.ts` cite fuzzer seeds; AGENTS.md cites "fuzz:quick caught the synchronous variant"), and it refuses to count an empty report as a pass (`runner.test.mjs:32`). What they cannot know is how often it is run and whether it is currently green: there is no CI job, no last-run record in the repo, and `fuzz:quick` is described only as a "post-change smoke" in AGENTS.md. The 2,201-line spec file is also hard to approach.

## 7. Benchmarks

Three suites behind `npm run bench` (`tests/benchmarks/bench.mjs`): host cost report (default), engines matrix (`--suite=engines`), transport experience (`--suite=transport`), plus `--suite=text-slices` (JS only).

Methodology, as found in code and README:

- **Engines suite** (`benchmark.php`): `reps=3`, `warmup=1` (lines 63-64); counted metrics asserted identical across reps (line 174); timing pooled across measured reps as p50/p90/p99 plus per-rep mean and stddev (README lines 598-601); seeded deterministic workload (`seed=42`, `WP_Sync_Bench_Workload::build`); every JSON report includes an `environment` stanza (PHP/WP/DB versions, opcache) and a `calibration` block (lock-pair cost) and the README insists on quoting both when comparing machines (lines 602-605). In-memory storage by default, so DB latency is excluded on purpose (Limitations, line 804). A single-process model with no queueing (first limitation, line 785); `--concurrency=N` adds a multi-process phase with a 1-worker uncontended baseline (bench.mjs lines 471-476).
- **Host report** (`host/host-benchmark.mjs`): baseline = the same site with the plugin deactivated, measured first; one engine per run; configurable baseline turns (default 2) and `edit-seconds` per person (default 120, minimum 30, enforced and unit-tested); per-span deltas (editing, idle). A single file mount of an mu-plugin collects server-side metrics; `WP_DEBUG`/`SAVEQUERIES` caveats are documented.
- **Transport suite** (`transport/benchmark-transport.mjs`): `warmup=3` unmeasured trials, `baseline=10` ambient samples (community-harness convention), jittered deterministic spacing to sample the polling phase, editing/idle/recovery phases tagged server-side, p50/p90 reported.
- **Comparing runs**: `compare.js` renders any number of JSON outputs side by side and WARNS when workloads or environments differ (header lines 12-16). So two runs can be compared, but only if both JSON files were kept.
- **Results checked in?** No. `bench-results/` is gitignored (`.gitignore:25`). The README's "Representative run" table (lines 650-660) carries approximate numbers with a "quote your own environment" caveat. Nothing tracks numbers over time; no CI artifact of a bench run is uploaded.
- **What CI enforces**: `npm run bench -- --certify=3` (`ci.yml:207`), which runs the engines suite across 3 seeds per engine and scenario and FAILS on `quality.lost_work > 0` or `quality.converged === false` (`bench.mjs:checkInvariants`, lines 417-431). The oracle it relies on is itself tested in `wpSyncEngineBenchmark.php` ("test_convergence_oracle_detects_corruption"). This is a correctness gate, not a performance gate.
- **Does the matrix measure what `docs/engine-comparison.md` claims?** The doc claims shapes: intent-log cheapest per ingest, de-rtc a small multiple, yjs-server most expensive and the only one that grows with document size; de-rtc pays in bytes not CPU; peak memory largest under de-rtc. The harness reports `service_us` percentiles, payload bytes, storage bytes/rows, peak memory, and a hosting card per engine over the same seeded scenario, so each claim maps to a column. The doc states its own fairness caveat (line 272: the session scenarios run at the poll cadence, which measures de-rtc "as we adapted it rather than as it was designed"). The claims are testable; nothing in CI tests them.
- **Is "deliberately number-free" sound?** For the document, yes: the stated reason (numbers go stale and mislead) is right, and the README still shows one representative table with caveats. But the policy has a cost the docs do not name: there is no series of numbers anywhere, so a 2x regression in yjs-server ingest or a doubling of idle polls would not be noticed by any automated step. The repo has the pieces (JSON output, `compare.js` with environment warnings, a CI bench job that already starts wp-env) to upload one JSON per run as an artifact and compare against the previous trunk run with a loose threshold. The memory note `yphp-stringdecoder-quadratic.md` records a 25x ingest cost that was found by a human running the bench; a tracked number would have made it visible earlier.

## 8. CI as the source of truth

`.github/workflows/ci.yml`: triggers on push to `trunk` and on `pull_request`; concurrency group per ref with cancel-in-progress (explains the many "cancelled" runs in the list). Jobs (all `ubuntu-latest`, each rebuilds the Gutenberg subtree):

| Job | Steps | Timeout | Observed duration (run 37655909702) |
| --- | --- | --- | --- |
| Lint, typecheck, Jest | `lint:js`, `typecheck`, `test:js`, subtree `collaboration-review-panel` Jest, `build` | 40 min | 5.2 min |
| PHPUnit (wp-env) | `composer lint`, y-php conformance, automerge-php conformance in `php:8.4-cli` docker with a PCRE2 guard, `env:tests start`, `test:php` | 30 min | 6.7 min |
| Benchmark invariants | `bench -- --certify=3` | 30 min | 7.8 min |
| End-to-end x4 (intent-log, yjs-server, de-rtc, engine-neutral) | `test:e2e` with `RTC_E2E_ENGINE`, `fail-fast: false`, artifacts on failure/cancel | 60 min | 9.4 / 9.4 / 9.2 / 13.2 min |
| End-to-end websocket (real daemon) | `test:e2e:websocket` | 45 min | 7.0 min |
| End-to-end server-sent events (Redis) | `test:e2e:sse` | 45 min | 5.0 min |

Whole run: 13 min 13 s wall (17:02:37 to 17:15:50). Nothing is `continue-on-error`; nothing is allowed to fail. Retries: Playwright 2 (base config under `CI`), nothing else. Recent trunk history: 10 of the last 15 CI runs succeeded, 5 were cancelled by newer pushes; no failures.

Not in CI: `test:e2e:sse-daemon` (5 tests), the fuzzer, `tests/tools/sweep.js` at full size, `tests/fuzzer/runner.test.mjs`, the three transport/host benchmarks as measurements. The release workflows (`create-release-pr.yml`, `release.yml`) are human-triggered and do not run tests.

AGENTS.md claims versus what I could verify:

- "All suites are green at head; CI is the source of truth for exact test counts." Verified for the suites CI runs. Not verifiable for sse-daemon or the fuzzer, which have no CI record. The AGENTS.md Testing section lists `test:e2e:sse-daemon` beside the other lanes without saying it is CI-exempt.
- "CI certifies every suite (including composer lint, the websocket e2e lane, and the subtree's collaboration-review-panel component Jest) on pushes to `main` and PRs." The workflow runs on `trunk`, not `main` (`ci.yml:5-6`). Minor, but a newcomer following the text will look for the wrong branch.
- "One known intermittent remains ... firing ~1-2 of 8 under the repetition hammer; the e2e CI job keeps 2 retries to absorb it." Consistent with `ci.yml:260-263`. The three runs I checked needed no retry.
- "CI runs the default e2e suite as one job per engine ... A new engine spec without the tag lands in the `none` slice." Nine spec files lack a tag; four of them are engine-specific by name (`collaboration-yjs-server-late-join.spec.ts`, 2 tests, titled "yjs-server late join (issue #57)"; `collaboration-text-slices.spec.ts`, which parametrizes over engines in its title without the `@engine-` prefix). They run in the engine-neutral job, which is why that job grew from 14 to 19 tests between runs and is the slowest (13.2 min). Not wrong, but the job label is misleading.

## 9. First-impression test

What a newcomer sees after Setup:

- `npm test`: "Missing script: test". They must read README or AGENTS.md to find `test:js`. README's "Tests" section (lines 170-178) does list the three commands.
- `npm run test:js`: 63 PASS lines and a summary in ~5 s. Clean. No warnings.
- `npm run typecheck`: silent success in 2 s.
- `node tests/tools/sweep.js`: four lines of Node warning about module type, then a clear statistics block and "all oracles green". The warning is the first thing printed and looks like an error.
- `php includes/lib/automerge-php/tests/run.php`: a large JSON blob; the pass/fail summary is in the first 10 lines. Fine for CI, noisy for a human.
- `npm run test:php` / `test:e2e` need Docker and 2-13 minutes each. The Testing section's "ladder" (fast to slow) tells them which to run first, which is good guidance.

Ten test names judged as specification:

| Name | Layer | Verdict |
| --- | --- | --- |
| "both users typing on an EMPTY post converge without deleting each other" | e2e | Clear user story and expected outcome. |
| "a genuine conflict parks for review, the panel presents it, and discard closes it for both users" | e2e (de-rtc) | Three observable steps named. Reads as a spec. |
| "a typing tab keeps its stream open and sends beside it" | e2e (sse) | Clear, but "sends beside it" needs the glossary. |
| "legacy blocks get DETERMINISTIC genesis ids: both tabs and the server mint identical identities with no adoption round-trip" | e2e (intent-log) | Precise; uses two invented terms ("genesis", "adoption"). |
| "never applies an event cut off by a killed PHP process" | Jest (sse-exchange) | Excellent failure-mode spec. |
| "holds commits after a merged own announcement so the rest of a typing burst never declares the stale base" | Jest (de-rtc) | States the rule and the reason, but needs engine vocabulary. |
| "REGRESSION: an edit made during the join round trip is captured at bootstrap (reload + insert on an empty-genesis room)" | Jest | Tagged as regression with the scenario; good practice. |
| `test_a_poll_carrying_unchanged_awareness_writes_nothing` | PHPUnit | Clear performance contract. |
| `test_identity` (wpDeRtcEngine) | PHPUnit | Too short to read as a spec. |
| `test_get_items` (`@doesNotPerformAssertions`) | PHPUnit | Noise forced by the base class; a newcomer may think the endpoint is untested. |

Overall: Jest and e2e names are strong and usually name the user-visible behavior. PHPUnit names range from excellent (`wpHttpPollingSyncServer`, `wpSyncAwareness`) to terse (`test_identity`). Describe blocks carry engine tags inconsistently.

## Ranked improvements

| # | Improvement | Size | Confidence added for a newcomer |
| --- | --- | --- | --- |
| 1 | Add the `sse-daemon` e2e lane to `ci.yml` (same shape as the websocket job; the launcher already exists). Until then, say in AGENTS.md Testing that it is manual. | S | High. Closes the only transport with no CI record and makes "all suites green" fully verifiable. |
| 2 | Run `node tests/tools/sweep.js` (default 60 x 400) in the `js` CI job. It takes 4 s. Also add `"type": "module"` or rename to `.mjs` to remove the Node warning. | S | Medium-high. The oracle is the intent-log engine's strongest correctness argument; today CI only runs a fifth of it. |
| 3 | Run `npm run fuzz:quick` on a schedule (nightly or weekly) with the summary uploaded as an artifact, retries 0. | M | High. Turns the fuzzer from "a tool that exists" into "a tool that is green as of last night". |
| 4 | Make the de-rtc descriptor contract two-directional: add a PHPUnit test that reads `descriptor-vectors.json` and asserts the PHP fingerprint derivation still produces it. | S | Medium. Today a PHP-side change is invisible until someone regenerates. |
| 5 | Upload one engines-suite JSON per CI bench run as an artifact and run `compare.js` against the previous trunk artifact with a loose threshold (warn, not fail, at first). | M | High for anyone evaluating performance claims; gives the number-free docs a tracked backing series. |
| 6 | Add a scheduled `--repeat-each=8 --retries=0` run of the known-intermittent spec (issue #37) that records the pass count. | S | Medium. Makes the "1-2 of 8" claim a measured, dated number and shows whether it drifts. |
| 7 | Add an `npm test` script that runs typecheck + Jest + the sweep (the no-Docker layers). | S | Medium. Removes the first error a newcomer hits. |
| 8 | Tag every engine-specific spec with `@engine-<slug>` (late-join, text-slices) so the "engine-neutral" job is truly neutral and the per-engine jobs stay balanced. | S | Low-medium. Makes job labels truthful and shortens the slowest job. |
| 9 | Fix doc drift: `ci.yml` runs on `trunk` not `main` (AGENTS.md); generator path in `vector-parity.test.js:7`; `prototypes/sync/src/simulator.js` in `wpIntentLogPlanner.php:31`. | S | Low individually, but stale paths in the files that define the frozen contract undercut the "frozen" story. |
| 10 | Add direct unit tests for `webrtc-link.ts` (peer state machine, reconnect, roster) and a component test for the presence badges. Replace the 8 forced PHPUnit stubs with a non-controller base class or a comment block that names them as stubs. | L / S | Medium. Covers the largest untested JS file and removes the most confusing PHPUnit noise. |
