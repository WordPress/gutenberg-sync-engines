# Q1: Would a greenfield rebuild follow the same architecture?

Reviewer question: if `gutenberg-sync-engines` were rebuilt today from scratch, would it keep the same architectural and design principles? Where would a greenfield design differ, and why?

Repo reviewed: `/Users/zzz/Code/worktrees/gutenberg-sync-engines/review-arch` at `113c5dab1c` (branch `review/arch`). Read-only. No environment was started and no tests were run, so every claim below is from reading code and git history. Where I could not verify something by reading, I say so.

## Bottom line

**The principles would survive a rebuild almost unchanged. The shape of the code would not.**

The seven principles (`docs/principles.md`) and the three big bets they produced are right and I would keep them: the server sees and judges every edit (P1); nothing is lost silently (P2); real conflicts are shown to a person (P3); scripts can take part (P4); plain hosting is the baseline (P5); costs are measured (P6); edits carry intent and blocks carry identity (P7). The decision to store rooms in plugin-owned tables, to make short polling the base transport with everything else as an upgrade, and to keep the server as the authority are all sound.

What a greenfield design would change is the **number of things** and **where the seams sit**:

1. **One engine, not three.** The project's own history says the three engines were built "so they could be compared ... with the intention of eventually picking one" (`docs/plan/history.md`, "Where this project came from"). That comparison is done and published. Today the three engines share 196 lines of PHP and 111 lines of TypeScript and duplicate roughly 20,000 lines everywhere else. A rebuild would ship intent-log (the default, and the engine that meets the most principles on the project's own scorecard) and fold de-rtc's one unique capability, the save-path merge for scripts, into it. yjs-server fails P3 and P7 by the project's own table and is the most expensive per edit.

2. **A bigger engine contract, so the framework stops leaking.** The server engine interface is five methods (`gutenberg/lib/experimental/collaboration/interface-wp-sync-engine.php:31-110`): slug, protocol, update types, `handle_updates`, `get_updates_since`. That is the shape of a log relay. Everything an engine actually does beyond relaying (genesis, review, kses, save-path hooks, REST routes, room reset, materialize) lives outside the contract and is bolted on by the plugin bootstrap. Because the contract is too small, engine-specific words leaked *into* the framework instead: `DEFAULT_ENGINE = 'intent-log'`, `intentId` on every disposition, intent-log's conflict reasons hard-coded in the editor's review panel.

3. **One receive path, not four transports plus a side channel plus a relay.** The site owner chooses from six "Transport" entries, which multiply with three engines, two relay targets, three SSE wake modes and two presence back ends. Only part of that matrix is tested in CI (the `sse-daemon` transport has no CI lane at all). The 2,586-line polling manager carries the SSE stream, the websocket hand-back and the advisory-channel cadence rules as `if` branches over shared module state. A rebuild would have one room-sync core with a pluggable receiver (poll, stream, socket) and would treat the WebRTC advisory channel as the one optional enhancement.

4. **Byte-parity twins only where they buy something.** The intent-log JS/PHP twin plus 1.1 MB of vectors (kept in two copies) is the right mechanism for a merge core that must agree across languages. The de-rtc descriptor twin (1,109 lines of TypeScript including a hand-written SHA-256, 497 lines of PHP, 75 vectors) protects a check that, by the engine's own comments, "never affects the merge" and that any client can skip by sending nothing. A rebuild drops it.

5. **One configuration model.** 26 filters in two naming schemes, 10 stored options plus one virtual one, 14 constants, one environment variable, and at least seven values that can be set three different ways. Two settings-screen bugs fell out of the inventory (section 7).

The rest of this report goes axis by axis. Each axis says what exists, what I found, whether the principle still holds, whether the implementation drifted from it, and what a rebuild would do. Section 10 ranks the changes. Section 11 lists things that look wrong but are right.

---

## 1. The framework/plugin split

### What exists

The framework in the Gutenberg subtree holds a generic shell: `createSyncManager` (`gutenberg/packages/sync/src/manager.ts`, 809 lines), two registries fed only by filters (`engines.ts:68`, `providers/index.ts:33`; PHP `class-wp-sync-engine-registry.php:67`, `transports/class-wp-sync-transport-registry.php:58`), the storage interface, and the session handshake. The plugin registers three engines and four transports through those filters (`includes/class-gutenberg-sync-engines-plugin.php:214-232`, `src/index.ts:41-75`). With the plugin off, nothing is registered and the editor falls back to the post lock.

### Evidence

**The PHP engine contract is five methods.** `interface-wp-sync-engine.php:31-110`: `get_slug`, `get_protocol_version`, `get_update_types`, `handle_updates`, `get_updates_since`. Its docblock says genesis, materialization and compaction hooks will be "added when the first engine that needs them lands". Three engines have landed; none were added. Each engine privately invents `load_room`, `initialize_room`, `materialize`, `maybe_checkpoint` and `add_row`.

**Engine behaviour that the contract does not cover is wired by the plugin bootstrap, not through the SPI.** `includes/class-gutenberg-sync-engines-plugin.php:219-225`:

```php
WP_De_RTC_Sync_Meta_Colocation::register();
WP_De_RTC_Base_Version_Preflight::register();
WP_De_RTC_Autosave_Commits::register();
add_action( 'rest_api_init', array( new WP_De_RTC_Review_Controller(), 'register_routes' ) );
WP_Intent_Log_Base_Seq_Preflight::register();
add_action( 'gutenberg_sync_engines_room_reset', array( 'WP_De_RTC_Engine', 'forget_room_state' ) );
```

Save-path interception, a REST route for review decisions, a machine-writer merge lane and a room-reset hook are all engine concerns that an engine cannot declare. This is exactly `docs/architecture-decisions.md` item 1 ("narrow the engine SPI to principle-level obligations ... let each engine own its wire surface"), still open.

**Because the contract is too small, engine words leaked into the framework.** Verified hits:

| Framework location | What leaked |
|---|---|
| `class-wp-sync-engine-registry.php:32` | `const DEFAULT_ENGINE = 'intent-log'` (a plugin slug inside the framework) |
| `collaboration.php:84` | default transport `'http-polling'` (a plugin slug) |
| `collaboration.php:384-386` | `_wpCollaborationUserId`, commented as "the intent-log actor id"; read only by `src/engines/intent-log-manager.ts:990` |
| `collaboration.php:395-397` | `_wpCollaborationCanUnfilteredHtml`, which exists for the `requires-approval` review lane |
| `packages/sync/src/engines/session.ts:55-64` | `EngineDisposition.intentId` (intent-log's field name on every engine's verdicts) |
| `packages/sync/src/types.ts:123-162` | `SyncReviewItem`: `intentType`, "rule-4 unit members (txnId)", `targetId` "(syncId)", `targetIndex` "(e.g. de-rtc contests)", `proposedInsertion` "(insert_block)", and a link to a plugin-side `PROPOSAL-REVIEW.md` |
| `packages/editor/.../collaboration-review-panel/review-data.js:9-17` | `REASON_LABELS` hard-codes intent-log rebase rules `frame-conflict`, `dependent-on-escalated`, `requires-approval`; de-rtc translates its own reasons into these (`src/engines/de-rtc/engine.ts:69-71`) |
| `review-data.js:60-61,84-88,128-130` | the editor reads `metadata.syncId` to anchor review cards, so the framework assumes one engine's identity scheme |
| `packages/sync/src/types.ts:271-306` | `richTextFields`, `isRawContentBlock`, `serializeRawContent`, `hydrateRawContent`, documented as existing for intent-log's capture |

The storage interface has the same problem the other way: `interface-wp-sync-storage.php:33-38` says engines should `method_exists` for `get_room_meta`, `set_room_meta`, `peek_room_engine` and `reset_room`. I counted about 20 such checks across the engines and transports. Those four methods are part of the real contract and should be in the interface.

**Yjs is in the SPI, and two of three engines fake it.** `SyncConfig.applyChangesToCRDTDoc(ydoc)`, `RecordHandlers.addUndoMeta(ydoc: Y.Doc, ...)`, `SyncUndoManager.addToScope(ymap: Y.Map)` and `EngineEntity.awareness?: Awareness` (`types.ts:217,248,253-264,382-388`; `engines/engine.ts:45`). intent-log passes a stub `{clientID, on(){}, off(){}}` object as the document (`src/shared/awareness-sync.ts:32-38`, used at `intent-log-manager.ts:1090`) and makes `addToScope` a no-op (`intent-log-undo.ts:806-808`). de-rtc casts its plain record where a `Y.Map` is expected (`de-rtc/engine.ts:621-630`; `revert-undo.ts:234-241` re-types the method to get around "the framework's Y.Map-typed addToScope"). de-rtc also imports `Awareness` straight from `y-protocols` (`de-rtc/session.ts:4`), and `y-protocols` is a plugin dependency (`package.json:26`) that webpack does not externalize (`webpack.config.js:20-24` externalizes only `@wordpress/sync` and `yjs`), so the bundle carries a second copy of y-protocols next to the framework's. Collaborator carets are off for both stub engines because core-data places them with Yjs positions (`core-data/src/.../post-editor-awareness.ts:67-75`).

**intent-log bypasses the framework manager entirely.** Its adapter returns `createIntentLogManager` (`src/engines/intent-log-adapter.ts:20`), a 2,436-line hand-written `SyncManager` that does not call `createSyncManager`. `intent-log-manager.ts:1690-1722` is a near copy of the framework's review notify loop (`packages/sync/src/manager.ts:159-198`). The framework comment at `engines/engine.ts:39-42` says intent-log implements `EngineEntity`; it does not.

**Leaks between engines and transports inside the plugin.** Engines import transport modules: `src/engines/yjs-server/session.ts:16-21` imports from `providers/http-polling/{types,utils}`; `src/engines/de-rtc/session.ts:20` imports `announceLocalWrite` from `providers/advisory/announce`. Transports duck-type engines: the websocket daemon calls `flush_room_state_cache` when the engine has it, which only de-rtc does (`includes/transports/websocket/class-wp-websocket-sync-server.php:1679-1689`). The polling manager reads `sendsWhileAlone` through an ad-hoc cast (`polling-manager.ts:2300-2302`) while the declared extension file names it `syncWhileSolo` and nothing reads that (`src/providers/session-extensions.ts:33`). `READ_FROM_HEAD = PHP_INT_MAX` (`class-wp-http-polling-sync-server.php:113`) is an unwritten agreement with `class-wp-de-rtc-autosave-commits.php:111`, which passes the literal `PHP_INT_MAX`. The polling transport's `rows_received_separately` branch is explained in a comment by "de-rtc's fetch answer" (`:521-522`).

**The private-API unlock impersonates a core module.** `src/lock-unlock.ts:17-21` opts in as `'@wordpress/sync'`, which passes only because that name is on the core allow-list (`gutenberg/packages/private-apis/src/implementation.ts:42`). This works, but it is the framework saying "plugins may not do this" and the plugin doing it anyway.

### Verdict

- **Principle still right:** a generic shell in core, implementations in a plugin, negotiation by slug and protocol. Keep.
- **Implementation drifted:** the SPI is a relay-era interface, so the real contract is scattered across `method_exists` checks, plugin bootstrap hooks, framework constants, and vocabulary the editor learned from one engine.
- **Greenfield:** make the engine contract say what an engine *is* (authorize, merge, review, materialize, genesis, reset, save-path participation, optional routes) and make the storage interface include room meta and reset. Replace `intentId`, `REASON_LABELS` and `metadata.syncId` in the framework with engine-neutral names and an engine-supplied anchor. Type awareness and undo scope on an engine-provided object, not on `Y.Doc`. The cost is a coordinated framework change on the `try/sync-engines` branch, which is the expensive kind here (section 5), but it is the change that makes every other one cheaper.

---

## 2. Three engines

### What exists

intent-log (server-ordered typed edits; conflicts parked), yjs-server (a CRDT merged on the server by the vendored y-php), de-rtc (whole-document proposals three-way merged by a frozen core ported from wordpress-develop). All three are registered (`class-gutenberg-sync-engines-plugin.php:302-305`) and the admin picks one.

### Evidence

**Size.** Excluding frozen and vendored code: intent-log 8,090 lines (2,111 PHP, 5,979 TS), yjs-server 3,255 (1,795 PHP, 1,460 TS), de-rtc 9,931 (4,697 PHP, 5,234 TS). Frozen on top: intent-log core 3,453 JS + 2,631 PHP twin; de-rtc `merge-core.php` 6,399; y-php 3.0 MB on disk; automerge-php 1.9 MB on disk, which the shipping de-rtc path never calls (`AGENTS.md`, confirmed: only `merge-core.php:182-205` loads it, on the legacy whole-text lane).

**Shared.** `includes/shared/` is two files: `class-wp-sync-block-identity.php` (46 lines, the genesis id hash, used by intent-log and de-rtc) and `class-wp-sync-post-genesis-props.php` (150 lines, used by all three; yjs-server guards it with `class_exists` and a title-only fallback at `class-wp-yjs-server-engine.php:1191-1193`). Plus `includes/shared/sync-id.js` (314 lines, the editor-side stamper, enqueued only for intent-log and de-rtc, `plugin.php:453-465`) and `src/shared/awareness-sync.ts` (111 lines, all three). No engine folder imports another's; I confirmed AGENTS.md's claim by grep.

**Duplicated three ways, with line references.**

| Concern | intent-log | yjs-server | de-rtc | Same or different? |
|---|---|---|---|---|
| Request boilerplate (empty batch, invalid type, per-row voids, `add_row`, per-request room cache, `rest_sync_storage_error`) | `:312-314`, `:398-404`, `:1679-1688` | `:276-278`, `:327-333`, `:1784-1793` | `:313-315`, `:321-327`, `:2897-2906` | Copies. No base class or trait exists. |
| Read path (floor clamp, envelope, `_debug` attach) | `:1212-1250` | `:611-669` | `:1696-1777` | The `_debug` attach block is character-identical in all three (`:1239-1248`, `:658-667`, `:1766-1775`). |
| Checkpoint and trim | `maybe_checkpoint` `:1057-1177`, 500 rows | `:1045-1117`, 100 rows | `:2659-2811`, 100 rows | Same tail shape (snapshot row, `$wpdb->insert_id`, set meta, trim, set floor, `qm/debug`). intent-log and de-rtc have near-copied parked-row rescue loops. Three different filters for one knob. |
| Block serialization at genesis | wrapper regex `:1558`, freeform `:1596-1610`, innerContent interleave `:1641-1665` | regex `:1294`, `:1607-1615`, `:1685-1709` | n/a (stores content whole) | intent-log and yjs-server carry the same regex and the same interleave code; yjs-server's comment says "mirrors the intent-log genesis". |
| Machine-writer preflight | `class-wp-intent-log-base-seq-preflight.php` (421 lines) | none | `class-wp-de-rtc-base-version-preflight.php` (277 lines) | Scaffolding near-copied (`register`, `map_rest_base_*`, `apply_merged_content` byte-identical at IL `:213-221` / DE `:256-264`). The merge step differs. |
| Debug stash and `qm/debug` narration | `$debug_stash` `:168`, 8 calls | `:186`, 11 calls | `:186`, 14 calls | yjs-server and de-rtc docblocks say "Mirrors the intent-log engine's stash". 37 copies of the same two-rule `phpcs:ignore` comment. |
| Client property sync (synced-property list, `_crdt_document` exclusion, `{raw}` extraction, "Auto Draft" blanking, term-set equality) | `intent-log-manager.ts:337-560`, `:488`, `:1123` | delegates to framework | `de-rtc/record.ts:68-171`, `:87`, `:314` | intent-log and de-rtc re-implement the same rules; de-rtc has two identical equality functions of its own (`record.ts:107-120`, `doc-bridge.ts:620-632`). |
| Awareness bridging | stub doc `intent-log-manager.ts:1089-1093` | real `Y.Doc` `yjs-server/engine.ts:87` | stub doc `de-rtc/engine.ts:293-297` | The one well-shared concern. |

**Genuinely different because the merge model differs:** the merge itself, the document model, concurrency (intent-log's options-row lock at `:253-337`; yjs-server lock-free; de-rtc's CAS claims at `:549-747`, `:2840-2867`), the kses strategy (park the unit / sanitize and compensate / sequester per block), undo (810 / 201 / 437 lines, all different), and review (intent-log resolutions ride transport rows `:366-380`; de-rtc resolutions ride a REST route only and the engine rejects resolution rows `:317-328`; yjs-server has none). These could not be shared and nobody should try.

**Two review mechanisms, and the second one's permission gate drifted.** `WP_De_RTC_Review_Controller::check_permissions` (`includes/engines/de-rtc/class-wp-de-rtc-review-controller.php:65-67`) checks only `current_user_can( 'edit_posts' )`, with no per-room check, while the transport checks `can_user_sync_entity_type` per room (`class-wp-http-polling-sync-server.php:364-366`). `apply_resolution` (`class-wp-de-rtc-engine.php:1599-1607`) pins a `requires-unfiltered-html` block as approved on any `restored` resolution, without checking that the restorer has `unfiltered_html`; the only such gate is client-side (`src/engines/de-rtc/engine.ts:62-72`). I did not run this, but by reading it, an author without `unfiltered_html` who can edit posts could approve their own parked markup over REST. This is a correctness finding, not an architecture one, but it is the kind of thing that happens when the same concern (review decisions) has two separate paths with two separate gates. It belongs in an issue.

**A possible latent intent-log read-path defect.** yjs-server (`:620-635`) and de-rtc (`:1705-1712`) check `get_update_count` *after* the read because, as their comments say, the count is a per-request cache that only the read refreshes. intent-log still checks `get_cursor` *before* the read (`class-wp-intent-log-engine.php:1202`), which AGENTS.md itself warns against ("never gate genesis ... on them before a read has run"). On a cold cache that returns 0 and runs `load_room` on the first read of every request. Not verified by running; worth a test.

**Is keeping three justified today?** By the project's own words, no. `docs/plan/history.md`: "Three engines were built so they could be compared under identical conditions, with the intention of eventually picking one. The public write-up of that comparison is the sync engines rundown." The scorecard (`docs/engine-comparison.md:76-86`) says yjs-server "Violates, by documented policy" P3 and "Fails" P7, and is the most expensive per edit. `docs/plan/wontfix.md` says a review lane for yjs-server "is decided, not deferred ... a research project, not a feature". de-rtc's distinct value is P4 (scripts merge through the ordinary save path) and per-block salvage; intent-log already has a save-path lane (`base_seq`), so the capability gap is "heal a writer that declared nothing", which de-rtc also only partly covers (the "plain-save blind spot", `engine-comparison.md:454-461`).

### Verdict

- **Principle still right:** build competing engines under one harness to decide. That was a good research method and it produced a decision-grade comparison.
- **Implementation drifted:** the comparison is finished but all three engines still ship, with a settings dropdown, three CI e2e jobs, a fuzz matrix, and a benchmark matrix, and with the shared code never extracted because any extraction has to satisfy three models.
- **Greenfield:** ship one engine. intent-log is the default and the best fit for the principles. Carry over from de-rtc the save-path merge for scripts and the "heal an unaware writer afterwards" step. Keep yjs-server's one unique feature (character interleaving in one sentence) as a known non-goal. Cost: losing the live comparison harness as a regression check for the chosen engine (keep the benchmark; drop the other two profiles), and a one-time deletion of about 13,000 lines plus two vendored libraries. The cheaper middle step, if three must stay for a while: one abstract server base (request boilerplate, read envelope, checkpoint tail, debug stash), one preflight base, one client helper module for properties and identity. The audit found no technical reason that would block that step.

---

## 3. Transports, the advisory channel, and the relay

### What exists

Four transports (`http-polling`, `sse`, `sse-daemon`, `websocket`), an advisory channel over two links (`webrtc-advisory`, `websocket-advisory`), and a bring-your-own relay for the websocket link in access-token mode. The settings screen shows six "Transport" entries (`includes/admin/class-gutenberg-sync-engines-settings.php:336-376`): polling, polling+WebRTC (default), polling+WebSocket advisory, SSE, SSE from the daemon, WebSocket.

### Counting the choices

Admin-selectable: 3 engines × 6 delivery entries = 18. The polling+WebSocket entry has two targets (the PHP daemon or a host's relay, chosen by whether `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` is set and by the advisory URL field), so 21. Environment then multiplies: an SSE stream sleeps on Redis, an object-cache counter, or a table counter (`docs/transports.md`, "Server-sent events" table; `class-wp-sync-sse-server.php:171-243`); awareness lives in the Presence API or the room array; the room array lives in the object cache or a row. Taking only the admin-visible and the SSE wake choices, a support engineer can face about 30 distinct delivery arrangements for one bug report, before the "Unsaved changes" switch, the awareness channel switch, and the de-rtc cadence.

What is tested: CI's default e2e lane runs the http-polling arrangement once per engine plus one engine-neutral job (`.github/workflows/ci.yml:214-232`); one websocket lane; one SSE lane with Redis. **There is no `sse-daemon` lane in CI** (`grep sse-daemon .github/workflows/ci.yml` returns nothing), although `npm run test:e2e:sse-daemon` exists and AGENTS.md says CI "certifies every suite". The fuzzer sweeps 3 engines × 4 transports = 12 combos by default (`tests/fuzzer/run.mjs:152-153`), locally only.

### The polling manager

`src/providers/http-polling/polling-manager.ts` is 2,586 lines of module-level state. The audit split it as: about 750 lines that are inherent to a polling transport (cursors and queues per room, the 50-room rotation and body-size packing, the 413 shrink, the poll loop with backoff, the unload beacon, visibility cadence); about 450 lines of advisory-channel cadence rules and the solo hold (`:420-628`, `:508-572`, `:856-931`); about 500 lines of SSE (`:933-1074`, the separate send path `:1899-2062`, held tails `:1475-1504`, and roughly 25 `if ( sseMode )` branches inside otherwise generic functions at `:559-563`, `:607-617`, `:647-650`, `:693-695`, `:724-734`, `:1106-1112`, `:1144-1159`, `:2079-2103`, `:2406-2419`); about 60 lines of websocket park and reclaim (`releaseRoom` `:2481-2518`, `initialCursor`/`initialUpdates` `:111-118`).

Concrete coupling:

- **SSE is not injected; it is a flag.** `src/providers/sse/sse-provider.ts:9-12` calls `setSseMode(true)` and returns the polling provider. `sse-daemon` additionally sets the stream URL, an auth provider, and `setSseStreamHoldsWorker(false)` (`sse-daemon-provider.ts:87-102`), with ordering enforced by a comment.
- **The websocket manager copies the room-sync core and has drifted.** `websocket-manager.ts:154-179` copies `createPayloadRoom`; `:337-364` copies `restartRoom`; `applyServerRoom` (`:257-326`) applies awareness before rows and skips recovery, the engine-mismatch fence, compaction and `onUpdatesDiscarded`. `sendUpdate` (`:213-221`) drops a local update while the socket is connecting and relies on `getInitialUpdates()`, which only yjs-server fills; intent-log and de-rtc return `[]`. An edit made in the 5-second window before a park may be lost. Not run; worth a test.
- **Dead compaction machinery.** `createCompactionUpdate` and `should_compact` handling (`:1454-1472`, `types.ts:14-28`, `utils.ts:95-106`) are inherited from the retired relay and implemented by no engine. The README admits it (`src/providers/http-polling/README.md:185-189`).
- **Save flush is wired to one transport.** `src/entity-sync/index.ts:13-20` imports `flushHeldUpdates` from the polling-manager module; under the websocket transport it returns at once (`polling-manager.ts:539-540`).
- **Failure state is shared across send and receive.** `consecutiveFailures`, `pollInterval` and the disconnected status are one set of variables, so a failed send changes the next receive delay (`:2049`) and can show "disconnected" while the stream is healthy.
- **Cadence rules read about eight module variables** and call into signaling and channel modules directly (`nextScheduledDelay` `:595-628`, `wakeForLocalWork` `:728-730` has its own copy of the rule). The unit tests need `jest.isolateModules` because nothing can be reset (`tests/js/providers/http-polling/polling-manager.test.ts:192`).

On the server, the picture is cleaner than the client: `WP_Sync_SSE_Server extends WP_HTTP_Polling_Sync_Server` (`class-wp-sync-sse-server.php:17`), and both the SSE and websocket connections share `WP_Sync_Connection` (`class-wp-sync-sse-connection.php:28`, `class-wp-websocket-connection.php:25`). The websocket daemon is still 2,087 lines that re-implement frame handling, rooms, rosters, the advisory mode, the stream mode, and a once-a-second room scan.

### The advisory channel

The idea is right and the channel module itself is clean (`src/providers/advisory/channel.ts`, link-agnostic). It gives short polling sub-second latency with no new server process. The coupling is all on the polling manager's side (`installAdvisoryHooks` wired from inside, `:856-931`). The `websocket-advisory` link exists for networks where WebRTC cannot connect; it needs the same daemon as the websocket transport, so a host that runs the daemon could just use the websocket transport. The relay is a reasonable "bring your own" escape hatch, documented well (`docs/plan/advisory-channel.md`, "Bring your own relay"), but it is one more thing to keep in protocol lockstep (issue #126 already needed a token claim change for it).

### Verdict

- **Principle still right:** short polling is the base; everything else is an enhancement that falls back to it; the channel is a rumor and never authority. Keep all three rules.
- **Implementation drifted:** the enhancements were added as branches in the base, and the websocket lane forked the base instead of sharing it. `sse` and `sse-daemon` differ only in who writes the stream, yet are two transport slugs, two providers, two e2e lanes, and one CI gap.
- **Greenfield:** one room-sync core (apply rows, then verdicts; generation check; restart; recovery; discarded-update report; engine stamp; presence token) used by every lane; one pure cadence function; one send gate; a receiver interface (`receive`, `isOpen`, `holdsWorker`, `settle`) with three implementations (poll, stream, socket). Ship polling+WebRTC and one push lane; make "daemon-written stream vs worker-written stream" a server deployment detail behind one slug, since the browser already handles both. Cost: a large refactor of the most-tested file in the repo, and the end-to-end suites are what would catch mistakes; do it with the suites green and the fuzzer available.

---

## 4. Storage

### What exists

`WP_Sync_Table_Storage` (`includes/storage/class-wp-sync-table-storage.php`, 1,042 lines) replaces the framework's post-meta default through `__unstable_wp_sync_storage` (`class-gutenberg-sync-engines-plugin.php:215`, `:251-256`), only when the schema option says the tables are ready. Two tables: `sync_updates` (the row id is the cursor) and `sync_room_meta`. With a persistent object cache, awareness and two write-once keys live only in the cache (`:342-343`, `:371-377`, `:435-451`); nothing else is cached. A per-room version counter is bumped on every write (`notify_change` `:180-195`) and fires `gutenberg_sync_engines_room_changed`.

### Evidence

**The interface is shaped by the post-meta default it replaced.**

- `get_cursor()` and `get_update_count()` are per-request caches refreshed only by `get_updates_after_cursor()` (post-meta `:218`, `:632`, `:669-670`; table storage keeps the same semantics on purpose, `:67-70`). The interface writes this into the contract (`interface-wp-sync-storage.php:63-65`: "during the current request"). It is a leftover of how postmeta reads worked, and it is the direct cause of the "check after the read" dance in two engines and the possible stale check in the third (section 2).
- Awareness is a storage method (`get_awareness_state`, `set_awareness_state`) because in postmeta it was one meta row. Today awareness has its own abstraction layered on top (`WP_Sync_Awareness` + `WP_Sync_Awareness_Backend`, `includes/class-wp-sync-awareness.php`, `interface-wp-sync-awareness-backend.php`), so there are two awareness contracts, and the Presence API backend never touches storage at all.
- `get_updates_after_cursor`'s docblock says "Updates from the specified client should be excluded" but there is no client parameter (`:95`). Stale.
- Room meta, `peek_room_engine` and `reset_room` are outside the interface but required in practice (`:33-38`).
- Engines read `$wpdb->insert_id` after `add_update()` to learn the cursor, so the table storage saves and restores `insert_id` around every other write (`:35-42`, `:224/232`, `:630/639`, `:772/782`). That is an unwritten contract between engines and storage.

**Transports and the presence lane know both storages' internals.** `instanceof WP_Sync_Table_Storage` appears in the SSE server (`class-wp-sync-sse-server.php:183`), the polling transport (`class-wp-http-polling-sync-server.php:601`), the presence lane (`class-gutenberg-sync-engines-advisory-presence.php:535`) and the rooms CLI (`:176`). The polling transport and the presence lane also run raw SQL against posts/postmeta for the post-meta case (`:606-620`; `:542-556` uses `WP_Sync_Post_Meta_Storage::SYNC_UPDATE_META_KEY`). The six table-only extras (`get_room_versions`, `peek_room`, `list_rooms`, `get_room_size`, `get_last_updates`, `get_all_room_meta`) are reached this way. The request log even constructs `new WP_Sync_Table_Storage()` directly, skipping the filter (`class-gutenberg-sync-engines-request-log.php:1086`).

**de-rtc keeps room state outside the room tables.** Its canonical document and version claim live in `wp_options` rows named by string in five places (`class-wp-de-rtc-engine.php:2587-2588`, `:2604`, `:2883`; `class-wp-de-rtc-sync-meta-colocation.php:177`; `rooms-cli-command.php:241`). The storage layer's `reset_room()` does not touch them. They are cleared by `forget_room_state`, hooked to `gutenberg_sync_engines_room_reset`, which only the presence lane fires (`advisory-presence.php:782`); the polling transport's engine-switch reset (`class-wp-http-polling-sync-server.php:852-856`) and `wp collaboration storage reset` do not fire it. `forget_room_state` uses `delete_option()` rather than the CAS class, so a substituted CAS backend would be bypassed. `uninstall.php:17-23` drops the two tables and nothing else: de-rtc canonical rows that hold whole documents, the advisory mailboxes, and every stored option survive uninstall. The CAS interface has no `delete` (`class-wp-sync-atomic-option.php:171-175` falls back to `reset( $name, '' )`, leaving an empty row).

**Awareness change notification has two paths.** Table storage bumps the version counter on awareness writes; the Presence API backend only fires the action (`class-wp-sync-presence-api-awareness-backend.php:199-202`). So the SSE wait compares versions and then, `if ( WP_Sync_Awareness::has_substitute_backend() )`, reads every room's awareness and compares it (`class-wp-sync-sse-server.php:221-260`). `WP_Sync_Awareness::put()` reaches into the transport for its timestamp (`class-wp-sync-awareness.php:146`).

### Verdict

- **Principle still right:** plugin-owned tables, the row id as the cursor, awareness kept out of the DB when a cache exists, idle polls that write nothing. All of this followed the hosting team's measured recommendation and it is the right shape. Keep.
- **Implementation drifted:** the interface is the postmeta interface with tables underneath. Capabilities are discovered by `instanceof` and `method_exists`; one engine's durable state lives beside the tables with three reset paths that do not agree.
- **Greenfield:** write the storage interface for tables (cursor and count as real reads, room meta and reset as members, version counter and change notice as members, no awareness), and give engines a "per-room engine state" bag in `sync_room_meta` so de-rtc's canonical and claim rows live where `reset_room` and uninstall can find them. Move the locks and CAS onto the same table or at least name their rows from one constant. Cost: a framework interface change (section 5 again) plus a one-time migration of de-rtc rows, which the project can skip since it has no external users (`architecture-decisions.md`, opening line).

---

## 5. The bundled Gutenberg subtree and the pin

### What exists

`gutenberg/` is a squashed subtree of the Gutenberg branch `try/sync-engines` pinned by `gutenberg-pin.json` (commit `ee35540…` on trunk `0d3eefe…`, tree `e2c85ca…`). The plugin loads `gutenberg/gutenberg.php` itself unless a standalone Gutenberg is active (`gutenberg-sync-engines.php:181-211`). The release zip ships `gutenberg/lib`, `gutenberg/build`, `gutenberg/build-module` and a few package files (`bin/build-plugin-zip.sh`).

### Evidence

- **Weight.** 12,874 tracked files and 61.5 MB of tracked source under `gutenberg/` versus 645 tracked files for the plugin itself; 3.0 GB on disk once built. The subtree has been re-imported six times since August (`git log -- gutenberg/`: `930749125f`, `50f733417f`, `6e96ab115d`, `e472fed871`, `ddb48a3ad8`, `3e21802b6c`).
- **The plugin is not compatible with unmodified Gutenberg, by its own docs.** `docs/entity-sync-adapter.md`: "This change does not make the plugin compatible with unmodified upstream Gutenberg, or remove the need for the subtree." The retained framework changes include exposing `registerEntitySyncManager`/`createDefaultEntitySyncManager` through the private API (`core-data/src/private-apis.ts:20,32,40`, verified), first-registration-wins (`entity-sync.ts:237-256`), the post-lock fallback (`core-data/src/sync.ts:84-96`, `resolvers.js:163`, `reducer.js:740`), and the review callbacks in `sync-review.js`. The list of what the fork carries is not kept in one place; the closest is `gutenberg/packages/sync/CHANGELOG.md:7-52`.
- **"Defer to standalone" has no compatibility check.** If `gutenberg/gutenberg.php` is in `active_plugins`, the bundled copy is skipped (`gutenberg-sync-engines.php:198-206`). The plugin then checks only that three PHP interfaces exist (`class-gutenberg-sync-engines-plugin.php:91-93`). No file reads `GUTENBERG_VERSION`, the pin, or any protocol beyond the per-engine and per-transport numbers in the handshake. An unmodified Gutenberg without `WP_Sync_Engine` shows a notice and stays off (safe). A Gutenberg that has the interfaces but a different SPI shape would register anyway and the JS bundle would call unlocked functions without checking they exist (`src/index.ts:41-75`, `src/entity-sync/index.ts:45-51`). The e2e spec `tests/e2e/specs/standalone-gutenberg-precedence.spec.ts` certifies only that the standalone copy wins, with a stub.
- **The pin discipline is good.** `tree` equals `git rev-parse HEAD:gutenberg`, so the pin can be checked without a Gutenberg checkout (`docs/gutenberg-subtree.md`). Updating is a documented procedure. Human-owned pieces (the login-race fixture fix, upstreaming) are named in `docs/plan/wontfix.md`.

### Verdict

- **Principle still right:** while the SPI is unstable, the plugin must ship the exact framework it was built against, and showing framework changes in plugin PRs is valuable. For a research plugin with no external users, bundling is the honest choice.
- **Implementation drifted:** the fork list is scattered; the standalone-precedence path is a silent compatibility gamble; the private-API unlock impersonates a core module (section 1); the plugin's own entry comment is already stale (`src/index.ts:6-9` lists two engines and three transports).
- **Greenfield:** bundling is not a sustainable *end state* for a WordPress plugin. The sustainable shape is: the SPI lands in Gutenberg trunk (sections 1 and 4 say what it needs to contain), and the plugin requires a minimum Gutenberg version and refuses to load against anything else. Until then, keep the subtree but (a) keep one file that lists every retained framework change, (b) make the plugin refuse a standalone Gutenberg whose tree does not match the pin instead of hoping, and (c) stop impersonating `@wordpress/sync` once the SPI is public. Cost of (b): a few lines; of the end state: an upstream negotiation, which is "a person's job rather than an agent's" (`wontfix.md`).

---

## 6. Frozen cross-language cores

### What exists

- intent-log: a JS core (`src/engines/intent-log/`, 3,453 lines of plain JS with JSDoc types, excluded from prettier) and a PHP twin (`class-wp-intent-log-planner.php`, `-document.php`, `-rich-text.php`, 2,631 lines), held to byte parity by JSON vectors kept in two copies (`tests/js/engines/intent-log/test-vectors/`, `tests/phpunit/test-vectors/`, 1.1 MB each) and a Jest test that fails when the copies differ (`vector-parity.test.js`). A 426-line `SPEC.md` is the human contract.
- de-rtc: `merge-core.php` (6,399 lines, verbatim port, excluded from phpcs) and the client descriptor builder `src/engines/de-rtc/descriptor.ts` (1,109 lines) held to parity with PHP by 75 PHP-generated vectors (`tests/js/engines/de-rtc/test-vectors/descriptor-vectors.json`, 132 KB).
- Vendored: y-php and automerge-php, each with its own conformance suite in CI.

### Evidence

**What "frozen" cost in practice.** The intent-log core changed substantively twice since the split. PR #127 (`f8c55f3d3b`, text edits across paragraph splits) touched 25 files and added 4,568 lines: both twins (`rebase.js` +61, `reducer.js` +12, new `text-slices.js` +48; `class-wp-intent-log-planner.php` +94, `-document.php` +48), both vector copies (+1,600 lines each), `SPEC.md` (+51), the simulator, the undo module and a benchmark. PR #131 (`c44737cf40`) moved `sync-id.js` to `includes/shared/` and touched the core only by path. So "frozen" means "a change costs two implementations, a spec update, regenerated vectors in two places, and a protocol bump" (protocol 2 refused protocol-1 clients). That is the right price for a merge core: a mismatch between client prediction and server verdict is the worst class of bug this system can have, and the vectors make it visible before e2e.

**Drift in the frozen boundary's own description.**
- AGENTS.md says the vendored y-php has "ONE deliberate local delta" (the composer platform pin). There is a second: the `StringDecoder.php` rewrite from PR #29 (`3a3425f7d5`, "Fix quadratic string decode in vendored y-php"); its header at lines 17-18 describes the fix and there is no `DELTA` marker in the file, although `docs/engine-comparison.md:394-396` says there is one. `wontfix.md` lists "a speed fix to the y-php library" among things to upstream, so the project knows; the two docs just disagree.
- `vector-parity.test.js:5-8` says the generators live in `src/engines/intent-log/tools/`; they are in `tests/tools/` (moved in `03b681d037`).
- `includes/shared/class-wp-sync-block-identity.php` is shared, but the JS reference `genesisSyncId` lives in the test tree (`tests/js/engines/intent-log/genesis-sync-id.js`), and the shipped stamper (`includes/shared/sync-id.js`) is a third copy using WebCrypto.

**The de-rtc descriptor twin is parity without a payoff.** `descriptor.ts:11-27`: "The descriptor is TAMPER EVIDENCE, not merge input ... Merge outcomes are identical with or without it." The server validates it once against the plain base and then drops it (`class-wp-de-rtc-engine.php:490-494`, `:785-820`), and proposals with no descriptor take the "engine-unaware writer" lane and are accepted (`$engine_aware = ! empty( $proposal['clientUpdate'] )`, `:491`). So a client that wants to avoid the check sends nothing. What the check does catch is a *disagreement between the two implementations* of the same derivation, and the price of a false positive is a rejected legitimate save (`:756-759`), which is why there is a special acceptance for the `document.replace_unsupported` fallback (`:768-774`). To make this work, the client carries a hand-written FIPS 180-4 SHA-256 (`descriptor.ts:50-110`, because WebCrypto is async) and a JS twin of `parse_blocks`. The server-side derivation it mirrors is about 500 lines of `merge-core.php` (`:334-830`). `engine-comparison.md:144-145` says so plainly: "It is an integrity check, which makes it really a P1 concern" (and P1 is already met by the server merging everything itself).

### Verdict

- **Principle still right:** when a client predicts what a server will decide, the two must be one algorithm, and byte vectors generated by one side and replayed by the other are the right way to prove it. Keep for intent-log.
- **Implementation drifted:** the boundary's documentation lags the code (two y-php deltas, moved tools), and the same mechanism was applied to de-rtc where it buys a consistency check that any client can opt out of.
- **Greenfield:** keep the intent-log twin and vectors; generate the vectors in one place and let the PHP suite read the JS copy (or the reverse) instead of keeping two files byte-identical by a third test. Drop the de-rtc descriptor lane, or keep it server-only if the fidelity audit insists. Mark every vendored delta with one word in the file (`DELTA`) and list them in AGENTS.md. Cost: near zero for the doc fixes; the descriptor removal is a de-rtc protocol bump.

---

## 7. Configuration surface

### Inventory (verified by grep, excluding vendored code and the frozen cores)

| Kind | Count | Notes |
|---|---|---|
| PHP filters applied | 26 | 19 `wp_sync_*`, 7 `gutenberg_sync_engines_*` |
| PHP actions fired | 4 owned + `qm/debug` at 38 sites | `gutenberg_sync_engines_room_reset`, `_room_changed`, `_sse_redis_failed`, `_sse_publish_failed` |
| Stored options, user-facing | 10 + 1 virtual | `wp_sync_engine` (framework-owned), transport, advisory channel, websocket URL, advisory URL, unsaved changes, polling interval, de-rtc commit interval, awareness interval, awareness channel; `gutenberg_sync_engines_delivery` is never stored (`settings.php:209`, `:817-826`) |
| Stored options and rows, internal | 8 fixed + 5 dynamic families + 3 transient families | schema versions, capture session state, de-rtc canonical and claim rows, ingest lock rows, advisory mailboxes, token lists |
| Constants read | 14 configuration (`WP_SYNC_*` ×5, `GUTENBERG_SYNC_ENGINES_DIAGNOSTICS`, `WP_REDIS_*` ×8) + `SCRIPT_DEBUG`, `SAVEQUERIES` | plus `WP_COLLABORATION_TRANSPORT` in the framework |
| Environment variables | 1 (`WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET`) | plus `WP_COLLABORATION_TRANSPORT` in the framework |
| JS filters | 3 `applyFilters` (`sync.pollingManager.*`, `sync.pollingProvider.maxClientsPerRoom`), 1 `addFilter`, 3 `addAction` | the `sync.*` filters can only lower the interval (`config.ts:96-116`) |
| JS settings globals | 2 (`_gutenbergSyncEnginesSettings`, `_wpCollaborationTransportConfig`) | |
| Settings-screen fields | 9 | `settings.php:664-674` |

### Evidence of accretion rather than a model

**Seven values that can each be set three ways.** Transport: constant, env, filter (framework) and the stored option, which is applied *inside* the filter and so silently wins over the constant (`settings.php:220`). WebSocket URL: option, then `WP_SYNC_WEBSOCKET_HOST/PORT`, then `wp_sync_websocket_url`; the daemon itself listens on `--host/--port` CLI flags that do not read the constants (`class-wp-sync-server-cli-command.php:56-57`), so the two must agree by hand. Advisory URL: option, else the transport URL. Advisory on/off and link: option, then two filters. Unsaved changes: option, then filter. Access-token secret: constant, env, filter. Redis: `WP_SYNC_SSE_REDIS_URL`, else `WP_REDIS_*`, then filter.

**Two naming schemes for the same kind of thing.** Transport and engine tuning filters are `wp_sync_*` (Core-style, several marked `@since 7.2.0`); advisory, room policy and settings hooks are `gutenberg_sync_engines_*`. Internal rows use three schemes (`gutenberg_sync_engines_*`, `{prefix}sync_*`, `gse_adv_*`). The checkpoint interval is three filters, one per engine.

**Values hard-coded on both sides that must agree.** Max rooms per request 50 (`class-wp-http-polling-sync-server.php:97`, `config.ts:39`); max update size 1 MB; body size 16 MB server vs 15 MB client; the 25-second background cadence in PHP (`settings.php:576/588`, `plugin.php:505`) and JS (`config.ts:56`), which must stay under `AWARENESS_TIMEOUT` = 30, itself defined twice (`polling-server.php:61`, `advisory-presence.php:143`). The PHP polling default is 5 s and `polling_interval()` never returns 0, so the client's own 4 s / 1 s defaults in `config.ts:51-52` are effectively dead when the bundle loads normally.

**Two settings-screen bugs found by the inventory, both verified by reading.**
- `settings.php:918`: `class_exists( 'WP_WebSocket_Access_Token' && true !== WP_WebSocket_Access_Token::is_enabled() )`. The closing parenthesis is misplaced, so `class_exists` receives a boolean and the "access token is NOT configured" notice can never show; if the class were missing the line would fatal.
- The `sse-daemon` stream URL is derived from `gutenberg_sync_engines_websocket_url` (`class-wp-sync-sse-daemon-transport.php:118`), but the screen shows that field only for the `websocket` entry (`settings.php:934`). An admin who picks "SSE from the daemon" cannot see or edit the URL it uses.

**Uninstall leaves everything but the two tables** (`uninstall.php:17-23`): all ten options, the schema version, the de-rtc canonical rows, the mailboxes, and the diagnostics tables.

### Verdict

- **Principle still right:** settings for site owners, filters for developers, constants for hosts. Keep the three audiences.
- **Implementation drifted:** every feature added its own knob in its own scheme, and nothing says which of three sources wins. Several knobs only exist because there are three engines or four transports.
- **Greenfield:** one prefix; one documented precedence rule (constant beats option beats default; filter last and only for code); one "delivery" option that *is* stored instead of a virtual field writing two; one checkpoint filter with the engine slug as an argument; shared constants for the dual-sided limits emitted into the page settings so the client reads them instead of mirroring them. Fix the two bugs now regardless. Cost: small and mostly mechanical, with a one-time option rename.

---

## 8. Cross-cutting concerns

### What exists

Locks and CAS (`WP_Sync_Room_Lock`, `WP_Sync_Atomic_Option`, each with a filterable backend interface); a server `_debug` envelope requested per room by the browser inspector; `qm/debug` narration; the diagnostics folder (request log, session capture, three CLI commands) behind one load gate; the client inspector `window.wpSync`.

### Layered well

- **Diagnostics load gate.** One check (`class-gutenberg-sync-engines-plugin.php:188-201`): local/development environment or `GUTENBERG_SYNC_ENGINES_DIAGNOSTICS`. In production none of it loads. When loaded, each hook returns early on a header or an autoloaded option.
- **Debug envelope permission.** One gate at the one choke point every transport passes through: `process_room_request` sets `$context['debug']` from the request flag and `is_debug_allowed()` (`class-wp-http-polling-sync-server.php:503`, `:724-736`); SSE inherits by extension; the websocket daemon calls the same method (`class-wp-websocket-sync-server.php:1599-1601`).
- **Primitives.** Each lock or CAS is one class with one interface and one filter. Room rows go only through the table storage.
- **Client inspector.** One `recordPoll` sink with one enable flag (`src/debug/inspector.ts:289`, `:82-88`); polling and SSE share one call site.

### Sprinkled

- **`qm/debug`:** 38 inline `do_action` calls across six files (de-rtc 14, yjs-server 12, intent-log 8, polling 2, SSE 1, presence 1), each with the same two-rule `phpcs:ignore` comment, no helper and no gate. The websocket daemon logs with `error_log( '[wp-sync-ws] …' )` instead (`:2083-2084`).
- **Engine `_debug` envelopes:** the stash-and-attach code is copied in all three engines (section 2); the transport passes a boolean, not a builder.
- **Storage capabilities by `instanceof` and `method_exists`** (section 4).
- **de-rtc's state outside storage with three reset paths that disagree** (section 4).
- **The CAS interface has no `delete`**, so the one caller falls back to writing an empty value (`class-wp-sync-atomic-option.php:171-175`). The presence sweep lists mailbox rows with raw `SELECT option_name ... LIKE` even when a CAS backend is substituted (`advisory-presence.php:1276-1287`; the comment admits it).
- **The inspector depends on a provider** (`inspector.ts:31` imports `getAdvisoryDebugState` from `providers/advisory/channel`), and the websocket manager taps it separately with its own `_debug` casts (`websocket-manager.ts:194-205`, `:263-280`).
- **The request log reaches past the REST boundary** into `$wpdb->num_queries`, `SAVEQUERIES`, `getrusage` and a direct `new WP_Sync_Table_Storage()` (`class-gutenberg-sync-engines-request-log.php:235`, `:892-894`, `:1086`). Acceptable for a benchmark tool that never loads in production, but it means the diagnostics know table-storage internals.

### Verdict

- **Principle still right:** make failures observable without re-instrumenting (AGENTS.md, "Diagnostics"). The inspector, the `_debug` envelope and the rooms CLI are exactly that and they are the most useful operational assets in the repo. Keep.
- **Implementation drifted:** the primitives are layered but their callers are not: the same narration, the same envelope and the same row names are hand-copied at each site.
- **Greenfield:** one `wp_sync_debug( $room, $message, $data )` helper that both narrates to Query Monitor and fills the envelope; an abstract engine base that owns the stash; constants for every options-row name; `delete` on the CAS interface; locks and CAS rows on the room tables or at least registered with `reset_room` and uninstall. Cost: small.

---

## 9. Scorecard: principle versus implementation

| Axis | Principle | Still right? | Implementation drift | Greenfield verdict |
|---|---|---|---|---|
| 1 Framework/plugin split | generic shell in core, implementations outside | yes | SPI is relay-shaped; engine words leaked into the framework; Yjs in the SPI | **change**: widen the SPI, de-Yjs the types |
| 2 Three engines | compare engines under one harness | yes, as a method | comparison finished, all three still ship, nothing shared | **cut to one** (or extract a base now) |
| 3 Transports and channel | polling base, enhancements fall back, channel is a rumor | yes | enhancements are `if` branches; websocket forked the core; `sse-daemon` untested in CI | **change**: one core, a receiver seam, fewer slugs |
| 4 Storage | plugin tables, cursor = row id, cache-only presence | yes | postmeta-shaped interface; `instanceof` discovery; de-rtc rows beside the tables | **change**: write the interface for tables, give engines a meta bag |
| 5 Subtree and pin | ship the exact framework you built against while the SPI is unstable | yes, for now | fork list scattered; standalone precedence is unchecked | **keep for now, plan the exit** |
| 6 Frozen cores | one algorithm on both sides, proven by vectors | yes for a merge core | boundary docs lag; applied to de-rtc where it buys little | **keep for intent-log, drop for the descriptor** |
| 7 Configuration | settings, filters, constants for three audiences | yes | two prefixes, three sources per value, two UI bugs | **change**: one model |
| 8 Cross-cutting | observable without re-instrumenting; Core-style primitives | yes | narration and envelopes copied per engine; row names by string | **change**: helpers and constants |

---

## 10. Ranked changes by value for cost

1. **Fix the two settings-screen bugs and the review-route permission gate.** `settings.php:918` (misplaced parenthesis), the hidden `sse-daemon` URL field, and `class-wp-de-rtc-review-controller.php:65-67` (per-room check and `unfiltered_html` on restore). Hours of work; the third one may be a real capability bypass.
2. **Widen the engine and storage contracts in the framework** (sections 1, 4). Add genesis, review, reset, save-path participation and route registration to `WP_Sync_Engine`; add room meta, reset, versions and change notice to `WP_Sync_Storage`; rename `intentId` and the review vocabulary. One framework PR on `try/sync-engines`; it removes about 20 `method_exists` checks, the engine bolt-ons in `plugin.php:219-225`, and the `instanceof` checks in three transports.
3. **Decide the engine question in writing and act on it.** Either retire two engines, or extract the shared server base, preflight base and client helpers now so the three stop drifting (section 2). Deleting is cheaper than extracting; extracting is cheaper than three more months of parallel bug fixes.
4. **Extract the room-sync core out of the polling manager and make the websocket manager use it.** Section 3. This closes the known drift in `applyServerRoom` and the possible lost-update window in `websocket-manager.ts:213-221`, and it is the precondition for a receiver seam. Medium cost; well covered by the existing suites.
5. **Collapse `sse` and `sse-daemon` into one transport slug** with a server-side "who writes the stream" switch, and add the daemon stream to CI or remove it. Low cost; removes a provider, a lane, and a hidden-field bug.
6. **One configuration model.** Section 7. Low cost, mostly renames and one precedence rule, plus emitting the dual-sided limits into page settings.
7. **Drop the de-rtc descriptor lane** (or make it server-only). Section 6. Deletes about 1,600 lines and a hand-written SHA-256; one protocol bump.
8. **Debug and row-name helpers.** Section 8. A `wp_sync_debug()` helper, constants for options-row names, `delete` on the CAS interface, reset and uninstall that cover every per-room row. Low cost.

---

## 11. Things that look wrong at first glance but are right

- **A lone tab holds its edits in the browser instead of sending them.** It looks like needless complexity (a save flush, a hidden-tab flush, waiters). It is the shape the default "discard unsaved changes" policy needs: the room follows saves, and unsaved work is exactly what the editor's own warning describes. `docs/plan/wontfix.md`, "Sending a lone editor's changes right away". If the policy flips to "keep", take the simplification in the same change.
- **de-rtc commits through the ordinary autosave endpoint, not the sync channel.** It looks like an engine escaping the transport. It is the point of the engine: if collaborating is saving, anything that can save can collaborate, including scripts (`docs/plan/history.md`). The transport carries only ~200-byte notices for the same reason (an hour-long soak once ran PHP out of memory with document-sized rows).
- **The 1.2-second capture delay in intent-log (`CAPTURE_SYNC_DELAY`).** It looks like a lazy debounce. It exists because core-data hands the sync manager an edit *before* committing it, so any push made inside `update()` is overwritten by the commit. This is deterministic, not a race (AGENTS.md gotcha; `scheduleEditorSync`). Do not "fix" it by pushing synchronously.
- **Checkpoint every 500 rows for intent-log, 100 for the others.** It looks inconsistent. The smaller number was crossing mid-typing and voiding in-flight edits; 500 is sized to one sitting (`history.md`; issue #37).
- **Engine registration order puts yjs-server first even though intent-log is the default.** It looks like a mistake. `DEFAULT_ENGINE` handles the unset case; registration order only decides the fallback when a configured slug is not registered (`plugin.php:296-305`).
- **Collection rooms (taxonomies) are reset on an engine switch while post rooms keep the fence.** It looks asymmetric. Collection rooms are rebuildable change feeds; post rooms can hold unsaved content (AGENTS.md, "Engine switches vs room lineage").
- **yjs-server has no review lane.** It looks like a gap to fill. It is a decided non-goal: the CRDT's premise is to avoid needing conflict detection, so adding review means building detection first (`wontfix.md`). The settings screen says so.
- **The frozen intent-log vectors exist as two byte-identical copies.** It looks like duplication to remove. Each copy sits with the suite that replays it, and `vector-parity.test.js` is what fails when only one is regenerated. A single copy would be fine too, but the current arrangement is deliberate, not accidental.
- **The websocket one-time token rides `Sec-WebSocket-Protocol`, not the URL.** It looks odd. Query strings land in access logs (`docs/transports.md`).
- **Diagnostics never load in production.** It looks like missing observability for hosts. It is a deliberate gate (`plugin.php:188-201`), and a host can opt in with one constant.

---

## 12. What I could not verify

- Whether the intent-log read-path check at `class-wp-intent-log-engine.php:1202` actually reloads on every request's first read under the table storage; the other two engines' comments say the cached count is stale cold, and the pattern matches, but I did not execute it.
- Whether the websocket `sendUpdate` window (`websocket-manager.ts:213-221`) loses an edit in practice for intent-log and de-rtc; by reading, `getInitialUpdates()` returns `[]` for both.
- Whether the de-rtc review route permission gap is exploitable end to end (the client-side gate may make it hard to reach from the editor, but REST is open to any `edit_posts` user by the code).
- The size of the framework fork relative to upstream trunk; the subtree is squashed and I had no upstream checkout. The retained-changes list is from `docs/entity-sync-adapter.md` and `gutenberg/packages/sync/CHANGELOG.md`, with four of its claims confirmed in code.
- Any performance number. The docs are deliberately number-free (P6) and I did not run `npm run bench`.
