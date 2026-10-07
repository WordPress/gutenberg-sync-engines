# Q2: Is the documentation complete, current, and non-repetitive?

Reviewed at commit `113c5dab1c` (branch `review/arch`), 2026-10-07. Read-only.

## Bottom line

The documentation is large (about 6,300 lines of prose outside vendored code) and mostly accurate on names and numbers, but it has three real problems.

1. **The layering has broken down.** `AGENTS.md` (1,115 lines) now carries about half of the project's behavior description: the SSE hidden-tab rules, the storage cache strategy, every engine's known gaps, the de-rtc commit-hold rule, the vendored-library lore. Roughly 540 of its lines (about 48%) either duplicate a `docs/` page or belong in one. Two `docs/` pages even send the reader *to* `AGENTS.md` for facts (`engine-comparison.md:369`, `tests/fuzzer/README.md:247`).
2. **There are a handful of wrong or stale statements**, and they cluster around things that changed recently: de-rtc's default commit cadence (two docs say "immediate", the code says 10 s), de-rtc's Yjs document (one doc says it still has one), the storage backend (the polling README still says post meta), the transport list (two docs still list four transports, the settings screen has six choices), and a file that no longer exists (`save-flush.ts`). Out of 86 checked claims: 63 verified, 16 stale, 5 wrong, 2 unverifiable.
3. **The reader who is missing is the site owner and the host operator.** There is no install-and-configure page, no settings reference, no upgrade/uninstall page, no storage schema, no wire-protocol page, no "how to add an engine" page, and no single security page. Each of these exists in fragments across four to six files.

A consolidation that moves behavior out of `AGENTS.md` into about six new or relocated `docs/` pages, deletes two small files, and adds a doc-lint step would cut `AGENTS.md` to roughly 350-400 lines and give every fact one owner. The proposal is in section 6.

---

## 1. Inventory

Line counts and last change date come from `wc -l` and `git log -1`.

| File | Lines | Last change | Intended reader | Serves that reader? |
| --- | --- | --- | --- | --- |
| `README.md` | 204 | 2026-10-06 | Everyone, first contact | Mostly. Good "why" and "what". No install walkthrough. Ends with a 1-line console script that belongs in a tools doc. |
| `AGENTS.md` (= `CLAUDE.md`) | 1,115 | 2026-10-07 | Agents, then developers | Serves agents, at a cost: it is the de facto architecture doc, so humans must read it too. |
| `CONTRIBUTING.md` | 42 | | Contributor | Yes, short. |
| `SECURITY.md` | 8 | | Reporter | Yes. |
| `CHANGELOG.md` | 436 | 2026-10-02 | Site owner upgrading | Yes. Well-scoped rule (significant changes only). |
| `LOOP.md` | 99 | 2026-08-27 | Agent running the loop | Partly. Its first line contradicts three other files (see 2.3). |
| `docs/README.md` | 54 | 2026-10-01 | Everyone | Decent index, but one entry is stale and it omits six prose files (see 2.2). |
| `docs/engine-comparison.md` | 470 | 2026-10-02 | Decision maker, developer | Yes. The strongest page. Its "Known gaps" section defers to `AGENTS.md`. |
| `docs/principles.md` | 49 | 2026-08-21 | Decision maker | Yes. |
| `docs/scenarios.md` | 208 | 2026-10-02 | Developer | Yes. |
| `docs/data-flow.md` | 302 | 2026-10-01 | Newcomer, Core reviewer | Yes, best plain-language page. One stale row. |
| `docs/transports.md` | 333 | 2026-10-06 | Host operator, developer | Yes, but it is half operations manual, half behavior spec, in one long page. |
| `docs/sse-daemon.md` | 119 | 2026-10-01 | Host operator | Yes. Overlaps `transports.md` heavily. |
| `docs/de-rtc-fidelity.md` | 39 | 2026-10-02 | Design owner | Yes (historical record). One wrong default. |
| `docs/architecture-decisions.md` | 54 | 2026-10-02 | Framework maintainer | Yes. |
| `docs/awareness-high-latency.md` | 134 | 2026-10-06 | Site owner, developer | Yes. One wrong path, one stale mechanism. |
| `docs/glossary.md` | 119 | 2026-10-02 | Everyone | Yes. Doubles as the jargon-rule word list. |
| `docs/entity-sync-adapter.md` | 102 | 2026-10-01 | Framework maintainer | Yes. |
| `docs/gutenberg-subtree.md` | 72 | 2026-10-01 | Framework maintainer | Yes. |
| `docs/plan/README.md` | 162 | 2026-09-03 | Agent, issue filer | Yes. |
| `docs/plan/history.md` | 116 | 2026-09-30 | Developer, agent | Yes. One wrong default. |
| `docs/plan/wontfix.md` | 111 | 2026-09-08 | Developer | Yes. |
| `docs/plan/advisory-channel.md` | 566 | 2026-10-02 | Developer, relay author | Yes, but it is a shipped design, not a plan, and lives under `plan/`. Carries the only relay protocol reference. |
| `docs/plan/room-lifetime.md` | 130 | 2026-09-08 | Developer | Same: shipped design under `plan/`. |
| `src/providers/http-polling/README.md` | 189 | 2026-09-29 | Developer | Partly. Four stale statements. The only place the wire envelope is written down. |
| `src/engines/intent-log/SPEC.md` | 426 | | Developer | Yes for the vocabulary. Its header says it is a prototype that ships nothing; it is the shipping frozen core. Not indexed anywhere. |
| `tests/benchmarks/README.md` | 847 | 2026-09-28 | Benchmark user | Yes, but very long, and it keeps a numbers table that contradicts the current de-rtc wire model. |
| `tests/benchmarks/transport/README.md` | 197 | 2026-09-24 | Benchmark user | Partly. Three stale statements. |
| `tests/debugging/README.md` + `replay/README.md` | 52 + 122 | 2026-09-01 | Developer | Yes. |
| `tests/fuzzer/README.md` | 269 | 2026-10-06 | Developer | Yes. |
| `examples/advisory-relay/README.md` | 82 | 2026-10-02 | Host operator | Yes. The one true operator how-to in the repo. |
| `.github/ISSUE_TEMPLATE/report.yml`, `shaped-issue.md` | | | Reporter, agent | Yes. |
| `.claude/commands/shape-issue.md`, `solve-issue.md`, `.claude/agents/issue-verifier.md` | 161, 184, 64 | | Agent | Yes. |
| Tool headers (`tests/tools/*.js`, `tests/e2e/bin/*.mjs`, `tests/debugging/soak-transport.mjs`) | | | Developer | Yes. Each has a usage block. `rtc-dev.mjs` (906 lines) has the best header of any script. |
| `docs/images/*.png` (3 files) | | | | Orphaned: no document references them (`grep -rn "docs/images\|shared-draft"` across all prose returns nothing). |

Not reviewed: `gutenberg/`, `includes/lib/`, `vendor/`, and `artifacts/test-results/*.md` (Playwright output, not prose).

---

## 2. Accuracy audit

I checked 86 concrete claims against the code. Verdict key: **V** verified, **S** stale (true once, now outdated), **W** wrong, **U** unverifiable in this review.

### 2.1 Claims table

| # | Where | Claim | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| 1 | `AGENTS.md:35` | Framework default engine is `intent-log` | V | `gutenberg/lib/experimental/collaboration/class-wp-sync-engine-registry.php:32` `DEFAULT_ENGINE = 'intent-log'` |
| 2 | `AGENTS.md`, `transports.md:58` | Polling interval default 5 s; 0 means default | V | `includes/admin/class-gutenberg-sync-engines-settings.php:102,588` |
| 3 | `transports.md:58` | Setting caps at 25 s | V | settings.php:588 `min( 25, $value )` |
| 4 | `src/providers/http-polling/README.md:69-71` | "Company, some peer not on the channel: 1000 ms (the Polling interval setting, 1-25 s, replaces this)" | S | The setting replaces it and defaults to 5 s. The doc presents 1 s as the operative value. Same at L179 "~1 s with collaborators (4 s solo)" |
| 5 | `http-polling/README.md:33,40-42` | "post-meta storage"; "Storage is the framework's post-meta storage" | W | Table storage since September (`includes/storage/class-wp-sync-table-storage.php`; `README.md:75-78`) |
| 6 | `http-polling/README.md:6` | Engines are "intent-log, yjs-server, or a third-party engine" | S | de-rtc missing |
| 7 | `AGENTS.md` | `DEFAULT_CLIENT_LIMIT_PER_ROOM` is 3; filter `sync.pollingProvider.maxClientsPerRoom` | V | `src/providers/http-polling/config.ts:6`, `polling-manager.ts:379` |
| 8 | `http-polling/README.md:146-149` | 16 MB body, 15 MB client budget, 2 MB floor, 50 rooms, 1 MB per update | V | `config.ts:27-46`; `class-wp-http-polling-sync-server.php:89-105` |
| 9 | `http-polling/README.md:167` | Awareness expires after 30 s | V | `class-wp-http-polling-sync-server.php:61` `AWARENESS_TIMEOUT = 30` |
| 10 | `http-polling/README.md:77`, `AGENTS.md` | Background tab polls every 25 s | V | `config.ts:53` |
| 11 | `docs/plan/advisory-channel.md:55,518-519` | A lone tab settles on a "slow safety poll (25 s)" / "the 25 s safety timer" | S | Contradicts the same file's rule 3 (L129: "the tab schedules no polls") and rule 5 (L155: "There is no safety poll"). The code has a 30 s fast-discovery window (`config.ts:137`) and a 25 s background-tab cadence, no solo safety timer. The example sequence predates the solo-quiet change. |
| 12 | `advisory-channel.md:94,107` | Transports are "`http-polling`, `sse`, or `websocket`"; the screen shows "five entries" | S | Six entries incl. `sse-daemon` (settings.php:343-373, 307-310) |
| 13 | `advisory-channel.md:277` | Flush before save "via `save-flush.ts`" | W | No such file (`find src -name "save-flush*"` empty). The flush is the entity adapter's `beforeSave` (`src/entity-sync/adapter.ts`; `docs/entity-sync-adapter.md:35-37` says the old middleware was removed) |
| 14 | `advisory-channel.md:28-39` | The channel "can be established in three ways"; items 1 and 2 are both "(default, `webrtc-advisory`)" | S | Items 1 and 2 are one link with two signaling carriers. Confusing as written. |
| 15 | `advisory-channel.md:214-218` | Tab list in a transient, or the `wp_sync_tab_list_backend` backend (`WP_Sync_Presence_API_Tab_List_Backend`) | V | `includes/interface-wp-sync-tab-list-backend.php`, `class-wp-sync-presence-api-tab-list-backend.php` |
| 16 | `advisory-channel.md:389-390`, `glossary.md:24` | Access token lives 2 minutes; 30 s clock skew | V | `class-wp-websocket-token-controller.php:52` `TOKEN_TTL = 2 * MINUTE_IN_SECONDS`; `class-wp-websocket-access-token.php:65` `LEEWAY = 30` |
| 17 | `advisory-channel.md:500,498` | Peer cap 8; presence token expires after 300 s | V | `class-gutenberg-sync-engines-advisory-presence.php:134,91` |
| 18 | `advisory-channel.md:422-424,453` | Daemon: 200-byte room, 64-byte token, 16 KB presence, 200 messages per 5 s | V (mostly) | `class-wp-websocket-sync-server.php:159,176,184,1362`. The "per 5 seconds" window was not checked. |
| 19 | `advisory-channel.md:450-452`, `examples/advisory-relay/README.md:54` | Relay: 64 KB payload cap, 15 s ping, port 8790 | V | `examples/advisory-relay/relay.mjs:244,292,21` |
| 20 | `room-lifetime.md:35-37,82` | `gutenberg_sync_engines_room_reset_when_empty` filter, `gutenberg_sync_engines_unsaved_changes` option, `gutenberg_sync_engines_room_reset` action | V | advisory-presence.php, settings.php, plugin.php |
| 21 | `transports.md:265-266` | Streams end after at most five minutes; `wp_sync_sse_max_seconds` | V | `class-wp-sync-sse-server.php:311` |
| 22 | `transports.md:305-306` | Stream shortened to 5 s below PHP's execution limit | V | sse-server.php:312-314 |
| 23 | `transports.md:268,299,264` | 20 s catch-up read; presence refresh every 20 s; keepalive at least every 5 s | V | sse-server.php:334,317,340-342 |
| 24 | `transports.md:290-292,303` | Retry after 5 s doubling to 1 min; 25 s inactivity abort | V | `src/providers/sse/sse-exchange.ts:68-72` |
| 25 | `transports.md:231-233` | `X-WP-Sync-SSE-Wait` header: `redis`, `version-cache`, `version-table`, `reads` | V (3 of 4) | sse-server.php:160-174,278. `reads` not seen in the grep window. |
| 26 | `transports.md:201-202` | Both wp-env configs set `WP_SYNC_SSE_REDIS_URL` to `redis://sync-redis:6379` | V | `.wp-env.json:12`, `.wp-env.tests.json:12` |
| 27 | `transports.md:154-157` | `gutenberg_sync_engines_sse_redis_failed` action; `wp_sync_sse_redis_url` filter | V | `class-wp-sync-sse-server.php`, `class-wp-sync-redis-notifications.php` |
| 28 | `AGENTS.md:73` | A stored `http-long-polling` reads as `sse` | V | settings.php:240,800 |
| 29 | `AGENTS.md` | `wp_sync_awareness_timestamp_granularity` filter | V | polling-sync-server.php:883 |
| 30 | `AGENTS.md` | `get_room_versions`, `awareness_changed()`, `gutenberg_sync_engines_room_changed` | V | table-storage.php:249,192; sse-server.php:253; presence-api backend:201 |
| 31 | `AGENTS.md` | `WP_Sync_Table_Schema::CACHE_GROUP`, `DB_VERSION` | V | schema.php:87,48 |
| 32 | `AGENTS.md:949` | `review-manager-decorator.ts` is gone | V | `find src -name "*decorator*"` empty |
| 33 | `AGENTS.md` | `CAPTURE_SYNC_DELAY` 1.2 s | V | `intent-log-manager.ts:133` = 1200 |
| 34 | `AGENTS.md` | `@y/websocket-server` pinned exactly 0.1.1 | V | `package.json:20` |
| 35 | `AGENTS.md` | CI runs y-php and automerge-php suites; automerge in `php:8.4-cli` | V | `ci.yml:117-140` |
| 36 | `AGENTS.md` | `SSE_SETTLE_MS`, `sseStreaming()`, `setSseStreamHoldsWorker`, `heldTails`, `updatesInFlight`, `READ_FROM_HEAD` | V | polling-manager.ts:970,988,1032,1487,2087; polling-sync-server.php:113 |
| 37 | `AGENTS.md` | Dev config defines `wp-env-development-secret-not-for-production` | V | `.wp-env.json:18` |
| 38 | `README.md:95`, `AGENTS.md` | `WP_COLLABORATION_TRANSPORT` config value | V | `gutenberg/lib/experimental/collaboration/collaboration.php:85-88` |
| 39 | `AGENTS.md` | e2e global setup pins the tests site to 1 s | V | `tests/e2e/config/global-setup.ts:105` |
| 40 | `engine-comparison.md:175,227` | Checkpoints every 500 (intent-log) / 100 / 100 rows | V | filters `wp_sync_intent_log_checkpoint_interval` 500, `..._yjs_server_...` 100, `..._de_rtc_...` 100 |
| 41 | `engine-comparison.md:399-402` | `wp_sync_yjs_server_max_genesis_bytes` 1 MB; `..._max_room_bytes` 8 MB | V | yjs-server-engine.php:1162,308 |
| 42 | `engine-comparison.md:225` | `WP_Sync_Room_Lock`: 5 s wait budget, 503 to contenders | V | `includes/class-wp-sync-room-lock.php:97` default `5.0`; `:148` status 503 |
| 43 | `engine-comparison.md:141` | "Seventy-five PHP-generated test vectors" | V | `descriptor-vectors.json` has 75 entries |
| 44 | `engine-comparison.md:118,127,141` | `intent_log_base_seq`, `base_version`, `de_rtc_sync_meta_tampered` | V | base-seq-preflight.php, autosave-commits.php:65, merge-core.php |
| 45 | `engine-comparison.md:440`, `scenarios.md:200` | de-rtc's "20-version snapshot window" | U | No constant found in `class-wp-de-rtc-engine.php`; the window lives inside the frozen `merge-core.php` (`wp_de_rtc_update_automerge_version_snapshots`). Not checked. |
| 46 | `engine-comparison.md:179` | de-rtc presence: "Yjs awareness over the doc bridge" | S | Code uses a stub doc (`src/shared/awareness-sync.ts:32` `createAwarenessDoc`; `src/engines/de-rtc/record.ts:15-24`). `architecture-decisions.md:50` has the current wording. |
| 47 | `data-flow.md:297` | de-rtc: "the tab keeps a Yjs document for the editor and undo" | W | `CHANGELOG.md:31-32` (Unreleased): "The de-rtc engine no longer keeps a Yjs document in the browser"; `record.ts` |
| 48 | `data-flow.md:298` | de-rtc builds a proposal "at most every 10 s" | V | settings.php:81 `DE_RTC_COMMIT_INTERVAL_DEFAULT = 10` |
| 49 | `docs/plan/history.md:52-56` | "de-rtc's commit rhythm defaults to as-soon-as-possible … The default stays fast" | W | Default is 10 s (settings.php:81; `CHANGELOG.md:130-133`, 0.0.1) |
| 50 | `docs/de-rtc-fidelity.md:30` | "the default stays immediate so all three engines feel alike" | W | Same |
| 51 | `docs/awareness-high-latency.md:6` | "one small server class in `includes/awareness/`" | W | Directory does not exist. The server side is in `class-gutenberg-sync-engines-advisory-presence.php` and the settings class. |
| 52 | `awareness-high-latency.md:63` | Heartbeat interval 1 to 3600 s | V | advisory-presence.php:230 |
| 53 | `awareness-high-latency.md:52-53` | WebSocket awareness message every 10 s | V | `websocket-manager.ts:62` |
| 54 | `awareness-high-latency.md:51` | "Under SSE the parked stream exchange is reissued with the new value" | S | `AGENTS.md` says awareness changes go out on the updates request beside the stream via `announceLocalAwarenessChange` (`src/providers/advisory/announce.ts`, used by `src/awareness/channels/sync-channel.ts`). The stream is not reissued. |
| 55 | `sse-daemon.md:103-111` | Five code paths | V (4) / U (1) | `includes/transports/sse/*` and `src/providers/sse-daemon/` confirmed; `includes/transports/class-wp-sync-connection.php` not listed. |
| 56 | `sse-daemon.md:83` | Daemon idle timeout 45 s | V | `class-wp-websocket-sync-server.php:80` |
| 57 | `tests/benchmarks/transport/README.md:71` | `engine=` is "`intent-log`/`yjs-server`" | S | de-rtc missing |
| 58 | `transport/README.md:133-137` | "as of 2026-08-11 the intent-log engine mangles live typing over the websocket transport … Benchmark under yjs-server until fixed" | S | No such known issue in `AGENTS.md` or `engine-comparison.md`; CI runs the websocket lane; the fuzzer sweeps intent-log/websocket. Two months old with no update. |
| 59 | `transport/README.md:188` | Link `docs/transports.md#server-sent-events-with-redis` | W | The heading is "Server-sent events" (`transports.md:115`); the anchor does not resolve. |
| 60 | `transport/README.md:143` | "with the 1 s with-collaborators cadence" | S | 5 s default |
| 61 | `tests/benchmarks/README.md:214-215` | "make the architecture decision (which engine, or keep both)" | S | Three engines |
| 62 | `benchmarks/README.md:656-667, 769-775` | Representative table: de-rtc "~466 KB (every accepted proposal stores a FULL content row)", "~452 KB join payload", "every accepted proposal stores a full content row" | S | Pre-announce numbers presented without a date. `engine-comparison.md:227` says rows are ~200-byte announces now. The yjs-relay column is labeled retired; the de-rtc column is not labeled historical. |
| 63 | `benchmarks/README.md:527` | CI runs `--certify=3` | V | `ci.yml:208` |
| 64 | `README.md:59,63-64` | `npm run rtc:sse`, `rtc:ws`, `rtc:http` | V | `package.json` scripts |
| 65 | `README.md:124` | `gutenberg/prototypes/sync/ARCHITECTURE.md` | V | exists |
| 66 | `README.md:22-24` | Requires WordPress 7.0 and the Presence API | V | plugin header `Requires at least: 7.0`, `Requires Plugins: presence-api` |
| 67 | `CONTRIBUTING.md:14` | Minimum PHP 7.4 | V | header `Requires PHP: 7.4` |
| 68 | `README.md:158` | `npm run env stop` stops it | S | `transports.md:236-237`: "plain `wp-env stop` (including `npm run env stop`) does not stop Redis"; `AGENTS.md` says `npm run env:stop` |
| 69 | `docs/README.md:44-46` | `plan/` is "one file per bug or feature, written in plain language with an example and a way to tell when it is done" | S | `docs/plan/README.md:3`: "Work lives in GitHub Issues". `plan/` holds history, wontfix, and two shipped design docs. |
| 70 | `docs/README.md` | Index of docs | S | Omits `plan/advisory-channel.md`, `plan/room-lifetime.md`, `plan/wontfix.md`, `src/providers/http-polling/README.md`, `src/engines/intent-log/SPEC.md`, and the fuzzer/debugging READMEs. `transports.md:60` is the only pointer to the polling README. |
| 71 | `src/engines/intent-log/SPEC.md:3-6` | "not wired into the Gutenberg build … nothing here is a shipping API" | S | It is the shipping frozen core (`AGENTS.md` "Repo layout"). |
| 72 | `LOOP.md:3` | "This is not a per-cycle ledger" | W (contradiction) | `AGENTS.md` ("`LOOP.md` is the working ledger when the issue loop is running"), `docs/plan/README.md:149` ("`LOOP.md` is the ledger while the loop runs"), `.claude/commands/solve-issue.md:8` ("`LOOP.md` is the ledger: what happened, and what was learned"). `solve-issue.md` step 10 then says the opposite (comment on the issue). |
| 73 | `CHANGELOG.md:78` | Presence API 0.6.0 answers in one call | V | `class-wp-sync-presence-api-awareness-backend.php:52-55` |
| 74 | `tests/fuzzer/README.md:16-17` | Default matrix includes `sse-daemon` | V | `run.mjs:76` |
| 75 | `examples/advisory-relay/README.md:78` | `npm run rtc:ws:advisory` | V | package.json |
| 76 | `AGENTS.md` | `tests/e2e/specs/sse-framing/`, `tests/e2e/config/rtc-daemon-teardown.ts` | V | exist |
| 77 | `AGENTS.md` | WP-CLI: `collaboration rooms|storage|capture|bench-log|sync-server` | V | five `add_command` calls |
| 78 | `AGENTS.md`, `README.md` | `uninstall.php` drops the tables | V | `uninstall.php:20-22` |
| 79 | `http-polling/README.md:185-189` | `should_compact` stays on the wire, `compaction_request` gone, relay nominated a compactor | V as history | Mentions the retired engine only as history. |
| 80 | `engine-comparison.md:213`, `CHANGELOG.md:99` | Intent-log protocol 2 | V | `intent-log-session.ts:64` |
| 81 | `AGENTS.md` | Awareness interval "above 0" turns slow awareness on | V, incomplete | Max is 120 (`settings.php:178` `AWARENESS_INTERVAL_MAX = 120`); no document states the max. |
| 82 | `docs/entity-sync-adapter.md:11` | Upstream merge commit `05068f8e…` | U | Squashed subtree; `gutenberg-pin.json` names the branch commit, not the upstream merge. Not a contradiction, just unverifiable here. |
| 83 | `README.md:144`, `gutenberg-subtree.md:26`, `AGENTS.md:429` | Subtree install command | S (inconsistent) | Three variants: `npm ci --ignore-scripts`, `npm ci --ignore-scripts`, `npm install --ignore-scripts`. Not wrong, but a reader cannot tell which is the rule. |
| 84 | `docs/README.md:17` | "seven concrete situations" in scenarios | V | A through G |
| 85 | Retired-term sweep | `V1.md`, `TODO-n`, `wp_collaboration_enabled`, `_wpCollaborationEnabled`, `review-manager-decorator`, `yjs-relay`, `http-long-polling` | V | Every hit is framed as history ("retired", "gone", "old", "removed"). No doc describes a retired thing as current. The one exception is the benchmark table in #62. |
| 86 | `docs/images/` | Three PNGs | orphaned | No reference in any prose file. |

Tally: 63 verified, 16 stale, 5 wrong, 2 unverifiable.

### 2.2 Where the errors cluster

- **de-rtc's commit cadence.** `history.md:52-56` and `de-rtc-fidelity.md:30` say the default is immediate. `CHANGELOG.md:130` (0.0.1) and the code say 10 s. Both docs were last touched after 0.0.1 shipped, so this is a missed update, not an old file.
- **de-rtc's client document.** `data-flow.md:297` says the tab keeps a Yjs document. The Unreleased changelog says it does not. `engine-comparison.md:179` uses the old wording too.
- **The polling README** (`src/providers/http-polling/README.md`) is the most stale file: post-meta storage, no de-rtc, 1 s cadence, and it is the only place the wire envelope is documented.
- **The transport-benchmark README** carries a two-month-old "known caveat" about intent-log over websocket that nothing else in the repo corroborates.
- **Transport lists.** `advisory-channel.md` says four transports and five screen entries. The screen has six choices and the plugin has four transports plus two advisory links.
- **Two internal contradictions.** `advisory-channel.md` says both "no safety poll" and "25 s safety poll". `LOOP.md` says it is not a ledger while three files say it is.

### 2.3 `docs/README.md` versus the directory

Every file the index names exists. The index misses: `plan/advisory-channel.md`, `plan/room-lifetime.md`, `plan/wontfix.md` (mentioned only inside `plan/README.md`), `src/providers/http-polling/README.md`, `src/engines/intent-log/SPEC.md`, `tests/fuzzer/README.md`, `tests/debugging/README.md`, `examples/advisory-relay/README.md`. Its description of `plan/` is stale (#69).

---

## 3. Completeness: what no document gives

| Need | Status | Where the fragments are |
| --- | --- | --- |
| **Getting started for a site owner** (install, Presence API first, activate, what turns on, pick a transport, what the defaults do) | Missing | `README.md:20-25` (requirements only), `README.md:91-96` (the screen exists), `CHANGELOG.md:91-95`, `AGENTS.md` gotcha on the collaboration experiment, `examples/advisory-relay/README.md:24-51` (the only step-by-step setup in the repo, and it is for the relay). |
| **Settings screen to behavior map** (nine stored options: delivery pair, engine, two server URLs, polling interval, de-rtc commit interval, unsaved changes, awareness interval, awareness channel; each with default, range, and effect) | Missing | Polling interval: `transports.md:57-60`. Unsaved changes: `room-lifetime.md:27-43`. Awareness: `awareness-high-latency.md:3-7,43-67`. Commit interval: `CHANGELOG.md:130`, `history.md:52`. Delivery list: `advisory-channel.md:281-290`, `AGENTS.md`. Awareness interval max (120) is stated nowhere. |
| **Upgrade / downgrade / deactivate / uninstall** (what happens to the tables, to open rooms, to a stored transport that no longer exists, to a room stamped by an engine you switched away from) | Partial | `README.md:79-82` (activate/deactivate/uninstall, one sentence each), `AGENTS.md` "Storage" (DB_VERSION upgrade) and gotcha "Engine switches vs room lineage" (409 fence, collection-room reset), `CHANGELOG.md:83-87,15-19` (long-polling migration, `iss`). Nothing on downgrade. |
| **Wire protocol per engine** (REST routes; request/response envelope; row types: intent-log `intent`/`snapshot`/`parked`/`resolved`/`cancel`; de-rtc `announce`/`fetch`/`snapshot`/`parked`/`resolved`; yjs-server `update`/`snapshot`; dispositions; generation token; 409 mismatch; `rows_received_separately`) | Partial | Envelope: `http-polling/README.md:94-142` (stale file). Intent vocabulary: `SPEC.md:87-158`. Row types: prose only, scattered (`glossary.md:56-59,78-85`, `engine-comparison.md:182,228`, `scenarios.md`). Routes: `/wp-sync/v1/updates` (README), `/ws-token` (transports.md), the review REST route (`de-rtc-fidelity.md:19`, never named), `rtc-test/v1` (debugging README). No single page. |
| **Storage schema** (the two tables' columns and keys, what `id` means, the room-meta keys each engine writes, the object-cache strategy, awareness backends) | Missing | Table names: `README.md:75-78`. Columns: only in `includes/storage/class-wp-sync-table-schema.php:153-167`. Cache strategy and meta keys: `AGENTS.md` "Storage" and "Awareness" (about 60 lines, nowhere in `docs/`). |
| **How to write a fourth engine or a fifth transport** (the PHP `WP_Sync_Engine` interface, the JS `SyncEngine` SPI in `gutenberg/packages/sync/src/types.ts`, the two registration filters, the `review` member, the bench authoring profile) | Missing | `README.md:126-130` names the filters. `tests/benchmarks/README.md:240-251` documents the bench-profile SPI (the only SPI documented anywhere). `wontfix.md:107-108` says new engines are "not planned". `AGENTS.md:17-30` describes the framework SPI in one paragraph. |
| **Security model** (who may join a room; capability and kses checks per engine; the three credentials and their lifetimes: REST nonce, one-time token 2 min, access token 2 min, presence token 300 s; what the daemon, a relay, and Redis are trusted with; the `rooms` claim; client-id binding) | Partial, scattered | `http-polling/README.md:150-152`, `advisory-channel.md:122-128,224-230,330-404`, `data-flow.md:235` (credentials row), `transports.md:88-96`, `sse-daemon.md:48-56`, `engine-comparison.md` P1 rows and "Capability enforcement" row, `scenarios.md` E. `SECURITY.md` is only a reporting pointer. |
| **Operations runbook** (what to monitor; table growth; Redis down; daemon down; stuck room; PHP worker sizing; cron independence) | Partial | Best coverage: `transports.md:166-197` (proxies, timeouts, worker pools), `transports.md:154-156` (Redis down falls back to version checks), `sse-daemon.md:69-99` (daemon process management). Missing: monitoring, what `wp collaboration storage status` reports, how to reset a room on production (`wp collaboration rooms` loads only in dev or with `GUTENBERG_SYNC_ENGINES_DIAGNOSTICS`, per `AGENTS.md`), daemon memory and restart cadence, the Playground/managed-host limits. |
| **Hooks and filters reference** | Missing | At least 25 filters/actions appear across docs (`wp_sync_*`, `gutenberg_sync_engines_*`, `sync.pollingManager.*`). No list. |

---

## 4. Repetition

### 4.1 Topic table

"Owner" is the single file that should state the fact; every other place should link.

| Topic | Appears in | Should own it |
| --- | --- | --- |
| What each engine is (three paragraphs) | `README.md:29-45`; `AGENTS.md:20-45`; `engine-comparison.md:26-44`; `data-flow.md:92-196`; `tests/benchmarks/README.md:225-234`; `history.md:20-23` | `engine-comparison.md` (full), `README.md` (one line each) |
| Transport list and shapes | `README.md:47-71`; `AGENTS.md:46-130` (about 85 lines); `transports.md:9-14,62-86`; `data-flow.md:210-238`; `sse-daemon.md` whole; `CHANGELOG.md:20-23,40-53` | `transports.md` |
| SSE rules: hidden tab, typing keeps the stream, `rows_received_separately`, 1 s settle, `heldTails` | `AGENTS.md` "What this is" (about 40 lines); `transports.md:274-303`; `CHANGELOG.md:40-53`; `http-polling/README.md:48-53`; `sse-daemon.md:18-22` | `transports.md` |
| Advisory channel cadence rules (quiet when alone, coverage, on-demand) | `AGENTS.md` (about 20 lines); `advisory-channel.md:116-180`; `http-polling/README.md:55-92`; `transports.md:16-37`; `data-flow.md:216-229`; `README.md:66-71` | `advisory-channel.md` (moved to `docs/`) |
| Access token, relay, `iss` claim | `AGENTS.md` (about 25 lines); `advisory-channel.md:308-477`; `transports.md:98-106`; `glossary.md:24-29`; `examples/advisory-relay/README.md`; `CHANGELOG.md:15-19` | `advisory-channel.md` (protocol); `examples/.../README.md` (setup only) |
| Storage tables and the object-cache strategy | `AGENTS.md` "Storage" (about 40 lines, the ONLY full statement); `README.md:73-90`; `transports.md:132-152` (counters); `CHANGELOG.md:67-79` | new `docs/storage.md` |
| Awareness and the Presence API backend | `AGENTS.md` "Awareness"; `README.md:83-90`; `CHANGELOG.md:54-79,91-107`; `advisory-channel.md:212-222`; `awareness-high-latency.md:110-117` | `docs/storage.md` (or an awareness section there) |
| Room lifetime / unsaved changes / generation token | `AGENTS.md` (6 lines); `transports.md:39-47`; `room-lifetime.md`; `http-polling/README.md:154-162`; `glossary.md:41-47`; `wontfix.md:91-105` | `room-lifetime.md` (moved to `docs/`) |
| yjs-server known gaps (size gates, `isValid`, #38, #57 late-join replay) | `AGENTS.md:950-1000` (about 50 lines; the #57 narrative exists only here); `engine-comparison.md:371-411`; `wontfix.md:10-21,59-71`; `history.md:43-50` | `engine-comparison.md` |
| de-rtc known gaps, `pendingOwnMergeSeq` hold, "never add `content` to the property lane" | `AGENTS.md:1000-1060` (about 60 lines); `engine-comparison.md:413-465`; `scenarios.md:99-106`; `history.md:36-41`; `de-rtc-fidelity.md` | `engine-comparison.md` (gaps); `scenarios.md` C (the timing rule); `history.md` (the "do not" rule, already there) |
| intent-log residuals (observed baseline, frame-conflict, 1.2 s capture delay, undo-on-reload) | `AGENTS.md:1061-1107` (about 45 lines); `engine-comparison.md:360-369` (points at AGENTS); `wontfix.md:40-57`; `scenarios.md:62-69,184-190` | `engine-comparison.md`; `wontfix.md` keeps the four accepted limits |
| Vendored libraries (y-php delta, automerge PCRE2 story, merge-core provenance, frozen-core rules) | `AGENTS.md:230-330` only (about 100 lines) | new `docs/vendored-libraries.md` |
| Benchmark commands and "no numbers here" | `README.md:98-102,180-194`; `AGENTS.md` repo layout; `docs/README.md:50-54`; `engine-comparison.md:18-24,245-251`; `principles.md` P6; `tests/benchmarks/README.md` | `tests/benchmarks/README.md`; one sentence elsewhere |
| Setup commands | `README.md:139-146`; `AGENTS.md:422-436`; `gutenberg-subtree.md:19-34` | `README.md`; AGENTS links |
| The issue loop (labels, claim rules, shape) | `docs/plan/README.md`; `LOOP.md`; `.claude/commands/*`; `AGENTS.md:911-930`; `shaped-issue.md` | `docs/plan/README.md` (rules), command files (procedure) |
| Polling interval default 5 s | `AGENTS.md`; `transports.md:58`; `CHANGELOG.md:135`; `benchmarks/README.md:80`; `advisory-channel.md:114`; `http-polling/README.md` (stale 1 s) | the settings reference |
| "Genesis blocks must set `isValid: true`" | `AGENTS.md` (twice); `engine-comparison.md:469-471` | `engine-comparison.md` |
| Worktree double-mount fatal | `AGENTS.md` gotcha; `AGENTS.md` Testing; `tests/fuzzer/README.md:216-217`; memory file | `AGENTS.md` gotcha (once) |

### 4.2 How much of `AGENTS.md` is duplicated or misplaced

Section sizes (from `awk` over `## ` headings):

| Section | Lines | Judgment |
| --- | --- | --- |
| Language | 12 | keep |
| What this is | 190 | about 160 lines describe behavior (engines, transports, SSE rules, advisory channel, storage, awareness). Everything here except the 15-line framework summary belongs in `docs/`. |
| Repo layout | 196 | about 90 lines are essays (vendored libraries, frozen-core rules, intent-log harness layout). A layout map needs paths plus one line each. |
| The `gutenberg/` subtree | 19 | duplicates `docs/gutenberg-subtree.md`; keep 5 lines and link |
| Setup | 15 | keep |
| Environment | 60 | keep (operational) |
| Testing | 186 | about 60 lines re-explain transport lanes and the daemon handshake (`transports.md`, `sse-daemon.md` have them). Keep commands, the ladder, and the traps. |
| Diagnostics | 73 | keep; this is the best agent-facing section |
| Gotchas | 105 | keep; trim the two that restate Testing |
| Coding standards, Commits, Releasing | 50 | keep |
| Known issues / out of scope | 197 | about 170 lines are engine known gaps and residuals. Belongs in `engine-comparison.md` and `history.md`. |
| Deep history | 7 | keep |

Estimate: about 540 of 1,115 lines (48%) duplicate a `docs/` page or are behavior description that has no `docs/` home yet. A trimmed `AGENTS.md` lands at roughly 350-400 lines.

The pattern that caused it: a change lands with a long explanatory paragraph in `AGENTS.md` (because the agent reads that file), and the `docs/` page gets a shorter or no update. The #57 late-join narrative, the `pendingOwnMergeSeq` rule, and the whole SSE hidden-tab discussion all exist in `AGENTS.md` first and best.

---

## 5. Structure and audience

**Does the stated layering hold?** "AGENTS.md = operational, docs/ = conceptual, docs/plan/ = planning, CHANGELOG = shipped" (`history.md:3-5`, `docs/README.md:48-50`).

- `AGENTS.md` = operational: **no.** It is about half operational, half the most complete behavior reference in the repo. Two `docs/` files and the fuzzer README defer to it for facts.
- `docs/` = conceptual: **mostly yes**, with two gaps. It contains no operational reference pages (storage, protocol, settings, security), so those facts drifted into `AGENTS.md`. And `transports.md` mixes a behavior spec with an operations manual and wp-env setup notes (L199-241 are about local Docker).
- `docs/plan/` = planning: **no.** `plan/README.md` says the work lives in GitHub Issues. The folder holds two shipped design documents (`advisory-channel.md`, `room-lifetime.md`, both headed "Status: implemented"), a history file, and a wontfix file. None is a plan. `docs/README.md:44-46` still describes it as "one file per bug or feature".
- `CHANGELOG.md` = shipped: **yes.** The rule is clear and followed.
- `LOOP.md`: an orphan. It says it is not a ledger; three other files say it is. Its "Lessons" section is five bullets that `history.md` would hold fine.

**Is `docs/README.md` a good entry?** It is a good index for the conceptual pages. It is not an entry point for a site owner (nothing to install or configure), for an operator (no runbook link), or for an extender (no SPI page). It omits eight prose files (section 2.3).

**Who is served, in one line each:** the decision maker (Core, choosing an engine) is served well by `engine-comparison.md`, `principles.md`, `scenarios.md`, `data-flow.md`. The framework maintainer is served by `gutenberg-subtree.md`, `entity-sync-adapter.md`, `architecture-decisions.md`. The agent is served by `AGENTS.md`, the command files, `plan/README.md`. The plugin developer is served unevenly: good on engines and transports, nothing on storage, protocol, or SPI. The site owner and the host operator are the readers no file is written for, except `examples/advisory-relay/README.md` and the "Running it on a host" section of `sse-daemon.md`.

---

## 6. Consolidation proposal

### 6.1 Target structure

Root:

| File | Purpose (one line) | Change |
| --- | --- | --- |
| `README.md` | What this is, why, requirements, 5-step install, one line per engine and transport, links. | Trim to about 120 lines. Move the "Testing by yourself" console script to `tests/tools/README.md` or a `tests/tools/type-forever.js`. Replace "Benchmarks and tools" with two links. Fix `npm run env stop` to `env:stop`. |
| `AGENTS.md` | How to work in this repo: language rules, repo map (paths only), setup, environments, testing ladder and commands, diagnostics, gotchas, standards, commits, releasing, issue loop pointer. | Cut to about 350-400 lines. "What this is" becomes a 15-line framework summary plus links to `docs/`. "Repo layout" becomes a path map with one line per entry. "Known issues" becomes a 10-line pointer list. Vendored-library essays move out. |
| `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` | unchanged | Add one line to `SECURITY.md` pointing at `docs/security.md`. |
| `LOOP.md` | delete | Move its five "Lessons" to `history.md` under a "Running the loop" heading. Fix the three references (`AGENTS.md`, `docs/plan/README.md:149`, `solve-issue.md:8`) to say "cycle notes go on the issue; durable lessons go in `docs/plan/history.md`". |

`docs/` (reader-first index in `docs/README.md`, grouped: "Use it", "Run it", "Understand it", "Change it", "Maintain the framework", "How we work"):

| File | Purpose | Change |
| --- | --- | --- |
| `docs/README.md` | Index by reader. | Rewrite. List every prose file, including the two moved plan docs, the polling README's replacement, `SPEC.md`, the tests READMEs. |
| **NEW `docs/getting-started.md`** | Site owner: install Presence API, install and activate this plugin, what turns on (the Gutenberg experiment), open Settings → Collaboration, pick a delivery choice, verify with two browsers, Playground option. | From `README.md:20-25,91-96`, `AGENTS.md` collaboration-gate gotcha, `CHANGELOG.md:91-95`. |
| **NEW `docs/settings.md`** | Every option on the screen: stored option name, default, range, what it changes, link to the behavior page. Nine rows. Plus the constants and filters that override them (`WP_COLLABORATION_TRANSPORT`, `wp_sync_websocket_url`, `WP_SYNC_WEBSOCKET_HOST/PORT`, `WP_SYNC_SSE_REDIS_URL`, the access-token secret). | New. Sources: settings class constants; `transports.md:57-60,88-96`; `room-lifetime.md:27-43`; `awareness-high-latency.md:3-7`; `advisory-channel.md:90-114,281-290`. Fix: state the awareness interval max (120). |
| **NEW `docs/operations.md`** | Host operator runbook: upgrade (DB_VERSION), deactivate, uninstall, downgrade; engine switch and the room fence; proxies and buffering; worker sizing; Redis (optional, what happens when it dies); the daemon as a service; monitoring (`wp collaboration storage status`, `/health`, the `X-WP-Sync-SSE-Wait` header); resetting rooms; managed-host limits. | Move `transports.md:166-197` (proxies), `transports.md:154-161` (Redis failure), `sse-daemon.md:69-99` (daemon on a host), `AGENTS.md` "Engine switches vs room lineage" gotcha (the user-facing half), `README.md:79-82`. |
| **NEW `docs/storage.md`** | The two tables (columns, keys, what `id` is), room-meta keys per engine, the object-cache strategy, awareness backends and the Presence API, write-once keys, version counters, the CLI. | Move `AGENTS.md` "Storage" and "Awareness" paragraphs (about 60 lines) here; add the column list from `class-wp-sync-table-schema.php:153-167`; absorb `transports.md:132-152` (counters). |
| **NEW `docs/protocol.md`** | Routes (`/wp-sync/v1/updates`, `/ws-token`, the review route, the stream route, `rtc-test/v1`), the room envelope, `rows_received_separately`, `generation`, `presence_token`, `advisory`, the 409 mismatch, dispositions, and a row-type table per engine. Links to `SPEC.md` for the intent vocabulary. | Move `src/providers/http-polling/README.md:94-152` here (corrected). Row types from the engine classes. |
| **NEW `docs/security.md`** | Who may join a room; capability and kses per engine (table); the credentials and lifetimes (nonce, one-time token 2 min, access token 2 min, presence token 300 s, client-id binding); what the daemon, a relay, and Redis are trusted with; the `rooms` claim. | Collect from `advisory-channel.md:122-128,224-230,330-404`, `http-polling/README.md:150-152`, `data-flow.md:235`, `engine-comparison.md` capability row, `scenarios.md` E. |
| **NEW `docs/extending.md`** | How to add an engine or transport: the PHP interface, the JS `SyncEngine` SPI (`gutenberg/packages/sync/src/types.ts`), `wp_sync_engines` / `wp_sync_transports`, `registerSyncEngine` / `registerSyncTransport`, the optional `review` member, the genesis property seed, the bench authoring profile, the fuzzer `ENGINE_CAPABILITIES` map. Plus a filters-and-actions reference table. | New. Move `tests/benchmarks/README.md:240-251` (profile SPI) here or link to it. |
| **NEW `docs/vendored-libraries.md`** | y-php (import, the one delta, conformance command), automerge-php (import, PCRE2 story, status-file delta, "the shipping path never calls it"), `merge-core.php` (provenance, `DELTA` markers, the `function_exists` guard), the frozen intent-log core (JSDoc typing, vectors in two copies, generators). | Move `AGENTS.md:230-330` and the frozen-core paragraphs. |
| `docs/engine-comparison.md` | unchanged purpose | Absorb the `AGENTS.md` known gaps and residuals (about 120 lines, condensed to about 60). Delete "AGENTS.md lists the rest of the residuals" (L369). Fix L179 (de-rtc awareness wording). |
| `docs/transports.md` | Behavior of each transport: cadence, streams, what the client does on failure. | Remove the operations half (to `operations.md`) and the wp-env/Redis-lifecycle half (L199-241, to `AGENTS.md` Environment, where most of it already is). Absorb `sse-daemon.md` as a section (its design notes L24-67 are good; L101-119 are code pointers). Absorb the `AGENTS.md` SSE paragraphs. |
| `docs/sse-daemon.md` | merge into `transports.md` | 119 lines, about 60% overlap with `transports.md:62-86` and the Testing section of `AGENTS.md`. |
| `docs/advisory-channel.md` (**moved** from `plan/`) | The advisory channel: rules, failure cases, the relay protocol ("Bring your own relay"). | Drop the "Plan:" title and status line. Fix #11, #12, #13, #14. Move "What exists now" code pointers to the bottom or delete (they rot fastest). |
| `docs/room-lifetime.md` (**moved** from `plan/`) | The unsaved-changes policy and the reset machinery. | Drop "Plan:". Reference the three orphan PNGs in `docs/images/` if they show this feature, else delete them. |
| `docs/data-flow.md`, `scenarios.md`, `principles.md`, `glossary.md`, `de-rtc-fidelity.md`, `architecture-decisions.md`, `awareness-high-latency.md`, `entity-sync-adapter.md`, `gutenberg-subtree.md` | unchanged | Fix #47 (`data-flow.md:297`), #50 (`de-rtc-fidelity.md:30`), #51 and #54 (`awareness-high-latency.md:6,51`). Make `gutenberg-subtree.md:26` match `README.md:144`. |
| `docs/plan/README.md`, `history.md`, `wontfix.md` | unchanged purpose | Fix #49 (`history.md:52-56`). Add the LOOP lessons. `plan/README.md:149` loses the LOOP.md sentence. |

Elsewhere:

| File | Change |
| --- | --- |
| `src/providers/http-polling/README.md` | Reduce to about 20 lines: component list plus links to `docs/protocol.md`, `docs/transports.md`, `docs/advisory-channel.md`. Or delete and move the component list into `AGENTS.md` repo layout. Everything else in it is either stale or owned by a `docs/` page after the move. |
| `src/engines/intent-log/SPEC.md` | Fix the header (L3-6): it is the shipping core. Link from `docs/protocol.md` and `docs/README.md`. |
| `tests/benchmarks/README.md` | Fix #61. Label the representative table (L652-667) with its date and "pre-announce de-rtc rows", or move the numbers to `history.md` and keep only the "comparison the decision turns on" prose, re-checked. Move the profile SPI paragraph to `docs/extending.md` or link. |
| `tests/benchmarks/transport/README.md` | Fix #57, #58 (delete or re-verify the 2026-08-11 caveat), #59 (anchor), #60. |
| `tests/fuzzer/README.md:247` | Point at `engine-comparison.md` "Known gaps" instead of `AGENTS.md`. |
| `examples/advisory-relay/README.md` | unchanged; link to `docs/security.md` for the token. |
| `docs/images/` | Reference or delete the three PNGs. |

### 6.2 Order of work

1. Fix the five wrong statements and the broken anchor (one commit; no structure change).
2. Move `plan/advisory-channel.md` and `plan/room-lifetime.md` to `docs/`; update links; rewrite `docs/README.md`.
3. Create `storage.md`, `protocol.md`, `vendored-libraries.md` by moving text out of `AGENTS.md` and the polling README. Replace each moved block in `AGENTS.md` with one line and a link.
4. Move the known gaps into `engine-comparison.md`; delete the `AGENTS.md` "Known issues" body.
5. Create `settings.md`, `operations.md`, `security.md`, `extending.md`, `getting-started.md` (new writing, each 60-150 lines).
6. Merge `sse-daemon.md` into `transports.md`; split operations out of `transports.md`.
7. Delete `LOOP.md`; trim `README.md`; trim the polling README.
8. Add the doc-lint step (6.3) so steps 1-7 stay true.

### 6.3 Keeping it from drifting again

The drift here has one shape: a name, number, or path in prose stops matching the code. Most of that is checkable by machine.

1. **A doc-lint script in CI** (`tests/tools/doc-lint.mjs`, run by the existing lint job) over every prose file outside `gutenberg/`, `includes/lib/`, `vendor/`:
   - Every backticked path that looks like a repo path (`src/...`, `includes/...`, `tests/...`, `docs/...`, `examples/...`) must exist. Would have caught #13, #51.
   - Every backticked identifier matching `gutenberg_sync_engines_[a-z_]+`, `wp_sync_[a-z_]+`, `WP_SYNC_[A-Z_]+`, `WP_[A-Z][A-Za-z_]+` (class), `sync\.[a-zA-Z.]+` (JS filter) must appear in `includes/`, `src/`, or `gutenberg/lib/`. Catches renamed or removed options and filters.
   - Every relative Markdown link and `#anchor` must resolve against the target file's headings. Would have caught #59.
   - `docs/README.md` must link every `docs/**/*.md`.
   - A banned-phrase list with an allowed-context rule: `yjs-relay`, `long-polling`, `review-manager-decorator`, `wp_collaboration_enabled`, `V1 item`, `TODO-[0-9]` are allowed only on a line that also contains `retired`, `removed`, `gone`, `old`, or `historical`. `post-meta storage` and `post meta storage` are banned outright. Would have caught #5.
2. **Asserted numbers.** A small Jest test, `tests/js/docs/doc-constants.test.js`, that imports the real constants (`config.ts`, `sse-exchange.ts`, `websocket-manager.ts`) and reads the PHP constants with a regex (`POLLING_INTERVAL_DEFAULT`, `DE_RTC_COMMIT_INTERVAL_DEFAULT`, `AWARENESS_INTERVAL_MAX`, `AWARENESS_TIMEOUT`, `PRESENCE_TTL`, `DEFAULT_MAX_PEERS`, `TOKEN_TTL`, `IDLE_TIMEOUT_S`, the four checkpoint defaults, the two yjs size gates), then asserts that `docs/settings.md` and `docs/transports.md` contain the matching phrase (for example, "default 5 seconds", "every 500", "25 seconds"). The doc marks each asserted number with an HTML comment (`<!-- const:POLLING_INTERVAL_DEFAULT -->5<!-- /const -->`) so the test knows which "5" to check. Would have caught #4, #49, #50, #60.
3. **Generate the settings table.** The settings class already knows every option, its default, and its sanitize range. A `wp collaboration settings describe --format=json` command (dev-gated like `rooms`) plus a Node script that renders the table into `docs/settings.md` between markers, with a CI diff check. Then the screen and the doc cannot disagree.
4. **One-owner headers.** Each `docs/` page starts with a one-line HTML comment naming what it owns ("Owns: SSE stream behavior. Operations live in operations.md."). The doc-lint flags a `docs/` page or `AGENTS.md` that defines a term already defined elsewhere, using the glossary's bold-term list as the key set (the same `grep -o '^- \*\*'` the issue rules already use).
5. **A rule in `AGENTS.md` Commits/PRs:** a change that alters a default, an option name, a filter, a transport slug, a REST route, or a row type must touch `docs/settings.md` or `docs/protocol.md` in the same commit, and the CHANGELOG entry names the doc. The doc-lint cannot enforce this, but the PR template can ask.
6. **Size guard on `AGENTS.md`.** A CI check that `AGENTS.md` stays under, say, 450 lines and that no single section exceeds 120 lines. Crude, but it is the pressure that pushes behavior text into `docs/` where the lint can check it.
7. **Date the numbers.** Any table of measured numbers in a README (`tests/benchmarks/README.md:652-744`) carries its date and commit in the heading, and the doc-lint fails a numbers table older than, say, 90 days unless it is under a "Historical" heading. Would have caught #62.
