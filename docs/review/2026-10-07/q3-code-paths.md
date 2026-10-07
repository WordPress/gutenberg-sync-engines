# Q3. Code paths of the primary use cases: are they easy to follow, and should the code be refactored?

Repo: `/Users/zzz/Code/worktrees/gutenberg-sync-engines/review-arch` (branch `review/arch`, head `113c5dab1c`). Every line number below was read from that tree. Where a doc or comment made a claim, the claim was checked against the code and the result is stated.

## Bottom line

1. **The paths work and are traceable, but only with the map in hand.** A keystroke crosses 16 files under intent-log, 17 under yjs-server, and 23 under de-rtc. It changes form 16, 10, and 23 times respectively. Three of those forms, in every engine, are the same message encoded as JSON inside JSON inside JSON (the row body is a JSON string, placed in a JSON object, placed in a JSON column).
2. **Two client files and four server files are god files**, and the two client ones hide implicit state machines. `polling-manager.ts` has 36 module-level mutable variables (16 booleans, 6 timers) and recomputes its receive mode from five or six of them on every call; no state is named. `intent-log-manager.ts` has a 715-line `loadEntity` and a 331-line `update`, and its 26-field `EntityState` encodes six phases as flag combinations.
3. **Intent-log does not use the framework's `createSyncManager`.** It is a whole second manager. A reader who starts in `gutenberg/packages/sync/src/manager.ts` (where `hydrate`, `observe`, review fan-out and undo wiring live) is on the wrong path for the default engine. This is the single largest followability cost and the root of most intent-log-only duplication (review fan-out, undo wiring, awareness lifecycle).
4. **The three PHP engines share one skeleton written three times**: boilerplate, ingest, kses, read, room state, compaction, genesis, block codec, `add_row`, debug stash. Several blocks are byte-identical (the `_debug` attach, the storage error, the floor clamp). None of it is frozen code.
5. **Transports duplicate the room envelope, generation restart, row application, token minting and request schema** between http-polling and websocket on the client, and between REST, SSE, and the daemon on the server. One real defect fell out: the websocket client drops the daemon's `type: 'error'` frames, so a 403 or 409 over websocket is invisible to the editor.
6. **Found along the way** (all confirmed in code): a syntax slip in the settings screen silences an admin notice (`class-gutenberg-sync-engines-settings.php:918`); the typed `syncWhileSolo` flag is dead because the manager reads an untyped `sendsWhileAlone`; de-rtc never passes `objectId` to `createAwareness` and never destroys its awareness; the de-rtc commit lane swallows every failure with no log; the intent-log read path's "cheap genesis guard" runs a full room replay on every cold request.
7. **Comments are heavy (30 to 54 percent of lines) and about two thirds of the history narration is load-bearing.** The rest belongs in `docs/plan/history.md` or a test name.
8. **Vocabulary is mostly consistent.** Four words carry two meanings (frame, register, version, snapshot) and two more carry three (announce, proposal). Twelve heavily used words are missing from the glossary.

A ranked refactor list with sizes and risks is at the end. Items that touch frozen code are marked and should not be done.

---

## Part 1. The use cases

### A. Opening a post (intent-log over http-polling)

**Server, page render**

1. `gutenberg-sync-engines.php:211` `gutenberg_sync_engines_load_bundled_gutenberg()` loads the subtree framework when no standalone Gutenberg is active.
2. `gutenberg-sync-engines.php:251` hooks `plugins_loaded` to `gutenberg_sync_engines_bootstrap()`, which calls `includes/class-gutenberg-sync-engines-plugin.php:72 boot()`, then `:111 load()` (sixty `require_once` lines), then `:214 register()`.
3. `class-gutenberg-sync-engines-plugin.php:299 register_engines()` answers the framework's `wp_sync_engines` filter with `WP_Yjs_Server_Engine`, `WP_Intent_Log_Engine`, `WP_De_RTC_Engine` (in that order). `:321 register_transports()` answers `wp_sync_transports` with four transports.
4. `gutenberg/lib/experimental/collaboration/collaboration.php:343 gutenberg_inject_collaboration_disabled_post_types()` (on `admin_init`) writes `window._wpCollaborationSync` with the engine slug, engine protocol, transport slugs and transport protocol. At `:393` it applies `wp_sync_transport_client_config`, answered by the plugin's `:344 filter_transport_client_config()`.
5. `class-gutenberg-sync-engines-plugin.php:378 enqueue_editor_assets()` enqueues `build/sync-engines.js`, inlines `window._gutenbergSyncEnginesSettings` (intervals, slow-awareness mode). **Presence enters here (1 of 3):** `:438` calls `Gutenberg_Sync_Engines_Advisory_Presence::editor_settings()` (`includes/class-gutenberg-sync-engines-advisory-presence.php:329`), which mints the tab's presence token with `wp_generate_password( 32, false )`, records it through the tab-list backend (`:1192 record_token`, Presence API row `gsetab-<token>` or a transient), and computes `othersPresent`.
6. `:456` enqueues the block-id stamper `includes/shared/sync-id.js` when the engine is intent-log or de-rtc. Note: it resolves the engine with a second `new WP_Sync_Engine_Registry( $storage )`, so the registry is built twice per page request.

**Client, bundle load**

7. `src/index.ts:41` unlocks the framework's private APIs, `:44-46` registers the three engine adapters, `:50-72` the four transports, `:75 registerPluginEntitySync()`, `:79 bootstrapSlowAwareness()`. `src/framework.ts:20` also unlocks and re-exports the same APIs "so adapters don't each repeat the unlock", but `index.ts` does not use it.
8. `src/entity-sync/index.ts:42 registerPluginEntitySync()` is gated on `window.__experimentalEnableRealTimeCollaboration`. It wraps core-data's `createDefaultEntitySyncManager()` with `src/entity-sync/adapter.ts:14 createEntitySyncAdapter()`, whose only addition is a 5 s flush of held updates before a non-autosave save.

**Client, the editor loads the record**

9. `gutenberg/packages/core-data/src/resolvers.js:225` calls `syncManager.load( kind, name, key, record, handlers )`.
10. `src/entity-sync/adapter.ts:21 load()` forwards to `gutenberg/packages/core-data/src/sync.ts:300`, which calls `:65 getSyncManager()`. **Negotiation:** `gutenberg/packages/sync/src/engines.ts:182 resolveEngineAdapter()` reads `window._wpCollaborationSync` and returns the registered adapter whose slug and protocol match, or null (post lock).
11. The adapter's `createManager` for intent-log is `src/engines/intent-log-adapter.ts:16`, which returns `src/engines/intent-log-manager.ts:964 createIntentLogManager()`. **The framework's `createSyncManager` (`gutenberg/packages/sync/src/manager.ts:68`) is not on this path.** `core.hydrate` (`manager.ts:355`) and `core.observe` (`:361`) never run for intent-log.
12. `sync.ts:484 createRecordHandlers()` builds `editRecord`, `getEditedRecord`, `refetchRecord`, `onStatusChange`, `persistCRDTDoc`, `addUndoMeta`, `restoreUndoMeta`, plus the review handlers.
13. `intent-log-manager.ts:1044 loadEntity()` (715 lines, to `:1758`): awaits `taxonomyProperties()`, creates the awareness object through `syncConfig.createAwareness` (`:1090`), creates the session (`src/engines/intent-log-session.ts:349 createIntentLogSession`), seeds `initialProps` for echo suppression, builds the 26-field `EntityState`, and installs six nested handlers: `session.onChange` (`:1262`), `onReset` (`:1420`), `onDisposition` (`:1498`), `onDiscard` (`:1540`), `onProposal` and the review mapping (`:1585-1725`). Only then (`:1728`) does it create the providers.
14. `src/providers/http-polling/http-polling-provider.ts:136 createHttpPollingProvider()` names the room `${objectType}:${objectId}` and constructs `HttpPollingProvider`, which calls `src/providers/http-polling/polling-manager.ts:2278 registerRoom()`.
15. `registerRoom`: `registerDebugSession`, `createUpdateQueue` (held while alone unless the codec says `sendsWhileAlone`), builds `RoomState`, `session.onLocalUpdate( onLocalUpdate )`, registers the window listeners. **The advisory channel enters here:** for the primary room, `:2433 setSyncClientId()`, `:2434 installAdvisoryHooks()`, `:2435 startAdvisoryChannel()`. Then `:2439 poll()`.
16. `polling-manager.ts:2064 poll()`, `:2068 start()`, `:1299 buildPayloadForRequest()`, `:1254 createPayloadRoom()`. The room entry carries `after: 0`, awareness, `client_id`, `engine`, `engine_protocol`, and **presence enters (2 of 3):** `presence_token` on the post's own room (`:1268-1272`). `:1308 buildProbe()` adds the advisory signaling probe to the same request.
17. `src/providers/http-polling/utils.ts:139 postSyncUpdate()` posts to `/wp-sync/v1/updates`.

**Server, the first poll**

18. `includes/transports/class-wp-http-polling-sync-server.php:338 check_permissions()`, `:399 validate_request()`, `:421 handle_request()`, which loops rooms into `:462 process_room_request()`.
19. `process_room_request`: **presence enters (3 of 3):** `:479 $this->presence->note_sync_request()` (`advisory-presence.php:662`) marks the token as joined; if nobody else is present it calls `:752 reset_abandoned_room()`, which calls `storage->reset_room()` and fires `gutenberg_sync_engines_room_reset`. Then `:482 get_engine_for_room()`, `:484 check_engine_mismatch()`, `:492 process_awareness_update()` (through `WP_Sync_Awareness`), and the `$context` array.
20. `includes/engines/intent-log/class-wp-intent-log-engine.php:311 handle_updates()` returns `dispositions => null` for an empty batch (no lock taken).
21. `:1194 get_updates_since()`. If `storage->get_cursor( $room ) === 0`, it calls `:1330 load_room()`, which reads every row (`get_updates_after_cursor( $room, 0 )`), finds no genesis, and calls `:1446 initialize_room()`: `WP_Sync_Config::parse_room`, `get_post`, `parse_blocks`, `:1501 blocks_to_specs()` (mints ids via `WP_Intent_Log_Planner::genesis_sync_id`, which delegates to `includes/shared/class-wp-sync-block-identity.php:38`), `WP_Sync_Post_Genesis_Props::for_post()`, `WP_Intent_Log_Document::create_document()`, `:1679 add_row()` for the genesis `snapshot` row, and `set_room_engine()` to stamp lineage.
22. `includes/storage/class-wp-sync-table-storage.php:505 get_updates_after_cursor()` runs `SELECT COUNT, MAX(id)` then `SELECT data ... id > cursor`, decodes the outer JSON of each row. The engine returns `updates: [ { data: <JSON string>, type } ]`, `end_cursor`, `total_updates`, `should_compact: false`.
23. **The generation token enters here:** `class-wp-http-polling-sync-server.php:566 room_generation()` reads room meta `generation` or mints `'g' . first_row_id` (`:600 derive_room_generation`).
24. `handle_request:434` answers the advisory probe with `advisory-presence.php:416 answer_probe()` in the same response.

**Client, applying the response**

25. `polling-manager.ts:2135 applyAnswer( advisory )`, `:2137 markConnected`, `:1631 applyResponseRooms()`, `:1514 applyRoomResponse()`: records `state.generation`, sets `endCursor`, `checkConnectionLimit`, `applyRemoteAwareness( mergedAwareness() )`, sets `hasCollaborators`, then `:1403 applyRoomRows()` calls `session.receiveUpdate()` per row.
26. `intent-log-session.ts:540 receiveUpdate`, `SNAPSHOT` case: `JSON.parse( update.data )`, `createClient( actorId, doc, seq )` (frozen core, `src/engines/intent-log/client.js:60`), `notifyChange()`.
27. `intent-log-manager.ts:1262` the `onChange` handler: `documentBlocks()` (bridge `engineDocumentToBlocks`), genesis seeding of `editorIds`, tombstone upkeep, `pushPropertyChanges()`, then the bootstrap branch: `setObserved()`; if the document is empty, a deferred pre-init recapture; else `:796 pushDocument()` calls `handlers.editRecord( { blocks: toEditorBlocks(...) }, { undoIgnore: true } )`. core-data dispatches and the canvas renders.
28. `polling-manager.ts:2153 hasBootstrapped = true`, `applyHolds()`, `scheduleNext( nextScheduledDelay() )`. The cadence is now decided by `advisoryCoversEveryone()`, `hasCompany()`, `isAlone()`, and `isActiveBrowser`.

**Count:** 28 hops across 17 files (6 PHP including the framework's, 11 TS/JS including 4 framework files).

**Verdict.** Followable with AGENTS.md open; not followable from the framework entry point. The negotiation itself is short and clean (one window global, one function). The cost is that intent-log replaces the whole manager, so the framework's lifecycle names (`hydrate`, `observe`, `onRemoteChange`) do not apply to the default engine. The 715-line `loadEntity` closure with six nested event handlers is the single biggest readability problem on this path. Presence enters at three places and generation at one, which is fine, but the three presence entries live in three unrelated files.

One claim checked and found misleading. `get_updates_since` (`class-wp-intent-log-engine.php:1195-1200`) says it ensures genesis "WITHOUT reconstructing full engine state" because "running it here made every poll O(session length)". But `WP_Sync_Table_Storage::get_cursor()` (`:476`) returns `$this->room_cursors[ $room ] ?? 0`, and `room_cursors` is written only by `get_updates_after_cursor()` (`:527`). Nothing earlier in `process_room_request` warms it. So on a fresh PHP request the guard is true for every intent-log room, and `load_room()` (a full read of the room and the replay bookkeeping loop) runs on every idle poll. The PHPUnit idle-poll query test (`tests/phpunit/wpHttpPollingSyncServer.php:858`) does not see this: it dispatches through one `rest_get_server()` whose storage object stays warm across dispatches, and its rows are yjs-shaped (`type: 'update'`). This needs a cold-request measurement before anyone calls it a cost; as a readability matter, `get_cursor()` reads like a query and is a cache.

### B. One keystroke from editor A to editor B

#### B1. intent-log

**A, send side**

1. `gutenberg/packages/core-data/src/actions.js:399 editEntityRecord` hands the merged edits to `getEntitySyncManager().update()` before the store commits them. Form 1: the editor's whole block tree.
2. `src/entity-sync/adapter.ts:29 update()`, then `gutenberg/packages/core-data/src/sync.ts:339 update()` calls the manager with `postType/post`, the id, an origin, and `isNewUndoLevel`.
3. `src/engines/intent-log-manager.ts:1887 update()` (331 lines): property and meta registers first (`session.author( 'set_property' )`), then for `blocks`: `collectBlockIds`, `:907 chooseObservedBaseline()` (bridge `summarizeEditorTree` and `documentDistance` over the pending pushes).
4. `src/engines/intent-log-bridge.ts:968 deriveIntents( baseDoc, blocks, options )` (473 lines, 8 inner closures): `blockToEngineSpec` (form 2: `BridgeBlock` to `BlockSpec` with fields and formats), `adoptExistingIds`, `deriveSplitsAndMerges`, `diffText`, `diffFormats` (form 3: typed intents `{ type, payload }`).
5. `intent-log-manager.ts:2117 session.authorBatch()`, in `intent-log-session.ts:800`: `createIntent()` adds `intentId`, `actorId`, `baseSeq`, `txnId` (form 4: `IntentEnvelope`); frozen `client.js:147 authorIntent()` applies it to the replica's optimistic document; `:464 emitIntent()` does `JSON.stringify( intent )` into `{ data, type: 'intent' }` (form 5) and calls the transport's `localUpdateListener`.
6. `intent-log-manager.ts:2130 applyDerivedIntents( baseDoc, intents )` applies the same intents a second time, to compute the new observed baseline; `setObserved`; then `scheduleEditorSync()` (1.2 s).
7. `polling-manager.ts:2341 onLocalUpdate()` adds to `updateQueue`, `:720 wakeForLocalWork()`, `:773 pollSoonForLocalUpdate()` (300 ms).
8. `:2064 poll()`, `:1299 buildPayloadForRequest()` takes queued rows under the body limit (form 6: REST JSON in which `data` is a JSON string). `postSyncUpdate()`.

**Server**

9. `class-wp-http-polling-sync-server.php:462 process_room_request()`: presence note, engine lookup, mismatch fence, awareness merge.
10. `class-wp-intent-log-engine.php:311 handle_updates()`, `:253 acquire_room_lock()` (`WP_Sync_Room_Lock`), `:351 handle_updates_locked()` (450 lines): `load_room()` replay; per update `json_decode( $update['data'] )` (form 7: PHP array); envelope checks; `WP_Intent_Log_Planner::is_valid_payload`; stamp `actorId`; cancels; `group_units`; stale filter; kses lane (`intent_requires_unfiltered_html`); the `$doc_at` replay cache; `:636 WP_Intent_Log_Planner::plan_batch()` (form 8: accepted transformed intent, or a proposal); the commit loop `:640` calls `:1679 add_row()`, which wraps `{ client_id, data: wp_json_encode( payload ), type }` (form 9); `class-wp-sync-table-storage.php:310 add_update()` does `wp_json_encode( $update )` (form 10: a JSON column whose `data` field is itself a JSON string) and `notify_change()` (version counter plus `gutenberg_sync_engines_room_changed`); `maybe_checkpoint`; three `qm/debug` lines; the `_debug` stash; resolutions; `$this->room_state[ $room ] = null`; dispositions.
11. `:1194 get_updates_since()` for A's own catch-up; `room_generation()`; A receives `dispositions`, and `applyRoomRows` calls `receiveDispositions`, which calls `settlePending`.

**B, receive side**

12. B's poll fires. A's `applyRoomResponse` (`polling-manager.ts:1577`) called `announceLocalWrite()` after its write landed; B's `onAdvisoryAnnounce( pollSoonForAnnounce )` (`:889`, `:787`) polls within 150 ms. Without the channel, the timer cadence polls.
13. Server: `process_room_request`, `handle_updates` (empty), `get_updates_since`, `class-wp-sync-table-storage.php:505 get_updates_after_cursor()` (`COUNT/MAX` then `SELECT`), `json_decode` of the outer JSON (form 11). The engine returns `{ data: <still a JSON string>, type }` (form 12: REST response JSON).
14. B `applyResponseRooms`, `applyRoomResponse`, `applyRoomRows`, `session.receiveUpdate()`.
15. `intent-log-session.ts:598` the `INTENT` case: `JSON.parse( update.data )` (form 13), dedupe by `appliedIntentIds`, `settlePending`, frozen `client.js:190 clientReceive()` runs `serverDocAt` and `replan()` (form 14: new `replica.doc`), `notifyChange()`.
16. `intent-log-manager.ts:1262 onChange`: `documentBlocks()`, bridge `:458 engineDocumentToBlocks()` and `:395 engineBlockToBlock()` (form 15: engine fields back to HTML attributes through `fieldToHtml`); the typing-quiet gate (`PUSH_QUIET_MS` 500 ms); `:835 syncEditor()` compares `canonicalBlocksJson`; `:796 pushDocument()`, `:707 toEditorBlocks()` (form 16: adds a stable `clientId`), `handlers.editRecord( { blocks }, { undoIgnore: true } )`. core-data, `useBlockSync`, canvas.

**Counts.** 16 distinct files. 16 forms. Three of the forms are pure serialization layers of one message (envelope JSON string, inside the wire JSON, inside the storage JSON column). Two are the same computation done twice on A (`authorIntent` applies the intents to `replica.doc`; `applyDerivedIntents` applies them again to `baseDoc`).

**Verdict.** The idea (diff the tree into typed intents, plan them on the server, replay on the client) is sound and well explained. The path is long because the manager and the bridge each have one 300 to 700 line function, and because the observed-baseline logic (`chooseObservedBaseline`, `pendingPushes`, `pushSeq`, three timers `PUSH_OBSERVED_DELAY`, `CAPTURE_SYNC_DELAY`, `PUSH_QUIET_MS`) is a second state machine layered over the replica. It is implicit: five flags and three timers, no named phase.

#### B2. de-rtc

Assumed: both tabs on a `post`, default commit interval 10 s.

**A, send side**

1. `actions.js:399 editEntityRecord` calls `getEntitySyncManager().update()`.
2. `src/entity-sync/adapter.ts:29`, then `core-data/src/sync.ts:344`, then the framework `gutenberg/packages/sync/src/manager.ts:628 updateOrDefer` (synchronous with a peer present, `setTimeout( 0 )` when alone), `:563 updateCRDTDoc`, `:590 core.applyLocalChanges`.
3. `src/engines/de-rtc/engine.ts:575 applyLocalChanges` buffers before bootstrap, else `:350 applyEditorChanges`, which calls `recordChangesFromEditor`. Form 1: `src/engines/de-rtc/record.ts:276-330` turns the edits into record fields; `identifyEditorBlocks` (`:345-393`) stamps `metadata.syncId`; `content` is dropped (blocks are the content).
4. `record.ts:209 record.apply` stores fields and notifies.
5. `src/engines/de-rtc/session.ts:471 onRecordChange` sets `dirty = true` and calls `:328 maybePropose`. The cadence timer is one `setTimeout( maybePropose, wait )` at `:355-359`, from `commitIntervalMs` (`:314-324`, read from `window._gutenbergSyncEnginesSettings.deRtcCommitIntervalMs`; server default 10 at `class-gutenberg-sync-engines-settings.php:81`). The hold `pendingOwnMergeSeq` is checked at `:344`, set at `:611` when our own announce comes back with a different hash, cleared at `:670` or `:687`. Other gates in the same `if`: `inFlight`, `commitsHeld > 0` (the save hold), not bootstrapped.
6. `session.ts:247 buildProposal`. Form 2: `doc-bridge.ts:961 buildContent()` serializes the block tree to block HTML. Form 3: `:757 buildProperties()` flattens fields to a `meta.<key>` map. Form 4: `descriptor.ts:975 buildDeRtcClientUpdate()` diffs base string against proposed string into a block-native operation list with SHA-256 hashes. Form 5: `JSON.stringify( payload )` into an `EngineUpdate` of type `proposal`.
7. `session.ts:365-383`: `inFlight = true`; because `options.commit` exists (post or page), `commitThroughSave`.
8. `src/engines/de-rtc/commit.ts:60 createDeRtcCommitAdapter`: form 6: `JSON.parse( update.data )`; form 7: re-keyed to snake_case REST params (`proposal_id`, `base_version`, `proposed_content`, ...). `apiFetch` posts to `/wp/v2/posts/<id>/autosaves`.

**Server, commit**

9. `includes/engines/de-rtc/class-wp-de-rtc-autosave-commits.php:56 maybe_commit` on `rest_pre_dispatch`. A commit is recognized by four params present together (`:64-75`): `proposal_id`, `base_version`, `proposed_content`, numeric `client_id`. Anything else is an ordinary autosave and passes through. Checks the post, `edit_post`, the experiment, and the room's de-rtc lineage via `WP_De_RTC_Sync_Meta_Colocation::room_doc_state` (`class-wp-de-rtc-sync-meta-colocation.php:160`). Form 8: re-encoded into a camelCase proposal row (`:118-138`).
10. `class-wp-de-rtc-engine.php:312 handle_updates`, `:346 process_updates`. Form 9: `json_decode` (`:375`).
11. `:470 ingest_proposal` (300 lines): `:2155 resolve_effective_base` (form 10: base64-decoded version snapshot from `sync_meta`, or revision mining `:2253`); `:784 validate_and_drop_client_update` runs the frozen `merge-core.php:1418` validator and sets `clientUpdate` to null; `WP_De_RTC_Block_Identity::adopt`; kses gate (`:538-552`, `sequester_unfiltered_blocks :1286`); the retry loop `:571-760`: `:1475 merge_by_identity` (`class-wp-de-rtc-identity-merge.php:55`) or the frozen `wp_de_rtc_get_automerge_retry_save_result` (`merge-core.php:1211`) (form 11: one merged string); `:2840 claim_version` (CAS on an options row through `WP_Sync_Atomic_Option::swap`, `includes/class-wp-sync-atomic-option.php:82`); `:897 merge_proposed_properties`; form 12: `wp_de_rtc_update_automerge_version_snapshots` base64-encodes previous and next content into `sync_meta`; `:2459 save_canonical` (form 13: `"<seq>|<json>"` written with `swap_prefixed` into options row `{prefix}sync_de_rtc_canonical_<md5>`). The options row is the document of record; the update table holds content only in genesis and checkpoint snapshots.
12. `:699-713 add_row()` for the `announce` row (version, baseVersion, contentHash, properties, author, proposalId; no content). Form 14: `class-wp-sync-table-storage.php:310 add_update` JSON-encodes the envelope; `notify_change`.
13. `process_updates` finishes: `:2659 maybe_checkpoint`, dispositions (`:457`).
14. `maybe_commit:143` reads back the rows this commit appended with `get_updates_since` (`:1695`). Form 15: `json_decode` per row. Response `{ dispositions, updates, end_cursor }`.

**A, settle**

15. `session.ts:385-394`: `announceLocalWrite()`, then `:480 processRow` for the announce: own `authorClientId` and `proposalId` match (`:555-557`), hash equal (`:563-566`), so `doc-bridge.ts:832 advanceVersion` moves the version. `handleDispositions` (`:707`).

**B, receive side**

16. B's wake: the advisory notice (`polling-manager.ts:889`, 150 ms) or the timer.
17. `polling-manager.ts:2068 start`, `buildPayloadForRequest`, `postSyncUpdate`.
18. `class-wp-http-polling-sync-server.php:462 process_room_request`: `handle_updates` with no updates (`class-wp-de-rtc-engine.php:313-315` returns `dispositions => null`), `get_updates_since` returns the announce row.
19. `polling-manager.ts:1631`, `:1514`, `:1403`, `session.receiveUpdate`. `session.ts:480 processRow`: form 16: `JSON.parse`. Not ours, so `behindSeq = announcedSeq` (`:613-615`) and `:228 maybeFetch`. Form 17: a new `fetch` row `{ haveVersion }` goes to `localUpdateListener`.
20. `polling-manager.ts:2341 onLocalUpdate` queues it; `pollSoonForLocalUpdate` (300 ms) carries it.
21. Server: `process_updates` (`:355-368`) records `content_requests[ room ][ client ] = haveVersion`. `get_updates_since` (`:1730-1755`) calls `:1813 load_room`; form 18: `:2634 decode_canonical` splits `"<seq>|<json>"`. Form 19: one synthesized `snapshot` row `{ version, content, properties, ephemeral: true }` (`:1740-1750`), never stored.
22. B `processRow` snapshot branch (`session.ts:622-697`): typing-quiet gate 500 ms (`:643-648`); `:415 applyOrDeferCanonical` defers while dirty or in flight; `doc-bridge.ts:816 applyCanonical`. Form 20: `:234 parseCanonicalBlocks`. Form 21: `:320 stabilizeClientIds` re-keys fresh clientIds onto B's by syncId. Form 22: `:643 unflattenProperties`. `:739 applyRemote` drops `blocks` when they serialize the same, else `record.apply( ..., DE_RTC_REMOTE_ORIGIN )`.
23. `engine.ts:600-613` the entity's `observe` subscriber sees the remote origin and calls `observers.onRemoteChange()`.
24. Framework `manager.ts:361` routes to `:719 _updateEntityRecord`, awaits `handlers.getEditedRecord()`, calls `core.getEditorChanges` (`:735`). `engine.ts:583` calls `record.ts:408 editorChangesFromRecord`. Form 23: record fields diffed against the edited record; changed `blocks` get a lazy `content` serializer.
25. `manager.ts:748 handlers.editRecord( changes )` is `resolvers.js:227-242`, which dispatches `EDIT_ENTITY_RECORD`. Canvas.

**Counts.** 23 files (10 client A, 9 server, 4 new on B). 23 forms. Six are JSON encode or decode of the same object (5, 6, 8, 9, 14-15, 16). The proposal is encoded three times and decoded twice between `buildProposal` and `ingest_proposal` (forms 5, 6, 7, 8, 9). Waits on the path: the 10 s cadence, B's poll (1 s or 150 ms), B's fetch poll (300 ms), B's typing-quiet gate (500 ms). The announce carries no content, so B always needs a second round trip.

**When the post type is not post or page.** `commit.ts:53-57` returns no commit adapter; `session.ts:368-379` hands the `proposal` row to the transport instead; the engine accepts `proposal` rows (`class-wp-de-rtc-engine.php:321`) and runs the same `ingest_proposal`. On that lane only, the session offers `createRecoveryUpdate` (`session.ts:799`). Saves bypass the room entirely for such types (the base-version REST mapping is hooked for `post` and `page` only, `class-wp-de-rtc-base-version-preflight.php:82-84`); only the external-save healer (`maybe_heal_external_save`, `:1928`) brings saved content back in.

**Verdict.** Three forms of the same proposal between client and engine (camelCase JSON string, snake_case REST params, camelCase row) exist only because commits ride the autosave endpoint. The engine's 300-line `ingest_proposal` does validation, identity adoption, kses, two merge strategies, the version claim, property merge, snapshots, canonical write and the announce row inline, and `maybe_heal_external_save` (`:2013-2124`) repeats the commit half of it. The read side is clear once you know canonical content lives in an options row and not in the update table; nothing in the file names says so.

#### B3. yjs-server

**A, send side**

1. `gutenberg/packages/core-data/src/hooks/use-entity-block-editor.js:88-98 onChange` hands over the whole block tree to `editEntityRecord`.
2. `actions.js:399`, `src/entity-sync/adapter.ts:29`, `core-data/src/sync.ts:339`, framework `manager.ts:628 updateOrDefer`, `:563 updateCRDTDoc`, `:590 core.applyLocalChanges`.
3. `src/engines/yjs-server/engine.ts:251 applyLocalChanges`, `:126 applyChanges` wraps `syncConfig.applyChangesToCRDTDoc( ydoc, changes )` in `ydoc.transact`.
4. `gutenberg/packages/core-data/src/entities.js:405` routes to `utils/crdt.ts:126 applyPostChangesToCRDTDoc`; the `blocks` case calls `utils/crdt-blocks.ts:480 mergeCrdtBlocks`. Form 1: the whole tree is made serializable (`:486-495`); equal blocks are skipped from both ends (`:519-539`); the changed rich-text attribute goes through `:1171 mergeRichTextUpdate`. Form 2: old `Y.Text` to a Quill Delta, new string to a Delta, diffed with the cursor, `applyDelta`.
5. The document fires `updateV2`. `src/engines/yjs-server/session.ts:136 onDocUpdate` ignores its own origin and calls `createSyncUpdate( update, 'update' )`. Form 3: Yjs V2 update bytes. Form 4: `src/providers/http-polling/utils.ts:40 createSyncUpdate` base64-encodes into `{ data, type: 'update' }`.
6. `polling-manager.ts:2341 onLocalUpdate` queues it, `wakeForLocalWork`, `pollSoonForLocalUpdate` (300 ms).
7. `:2064 poll`, `:1299 buildPayloadForRequest` (form 5: request JSON), `postSyncUpdate`.

**Server**

8. `class-wp-http-polling-sync-server.php:208 register_routes`, `:338 check_permissions`, `:399 validate_request`, `:421 handle_request`, `:462 process_room_request`, `:507 handle_updates`.
9. `includes/engines/yjs-server/class-wp-yjs-server-engine.php:275 handle_updates`: `:786 load_room` reads the canonical document from room meta `yjs_server_doc` (`:792`), applies it with `\Yjs\applyUpdateV2` (`:798`), applies any rows past its stamped cursor (`:810-825`); encodes the whole document as `$before_bytes` (`:295`) for the 8 MB ceiling and no-op detection; decodes the row (`:336`) and calls `:922 apply_update_for_row` (state vector, `applyUpdateV2`, `diffUpdateV2` against the pre-apply state vector). Form 6: the stored row is this diff, re-encoded to base64 (`:930`), not the bytes A sent. Encodes the whole document again as `$after_bytes` (`:419`). kses lane `:465-467` (`:522 sanitize_unfiltered_html`, only for authors without `unfiltered_html`: serializes every top-level block, `wp_kses_post` each, rebuilds dirty blocks, emits a compensating row). `:470 add_row` (`:1784`). Form 7: `class-wp-sync-table-storage.php:310 add_update` JSON column. `:496 save_canonical` (`:1007`). Form 8: `{ doc: <base64 of the whole document>, cursor }` written to room meta. `:497 maybe_checkpoint`.
10. `:610 get_updates_since` for A: clamps to the floor, reads rows after A's cursor, drops A's own `update` rows (`:638`). A gets `dispositions: [ { status: 'applied' } ]`.
11. A `applyRoomResponse:1577 announceLocalWrite()`.

**B**

12. B's poll (advisory notice at `polling-manager.ts:889`, or the head-cursor heartbeat `:890-898`, or the timer).
13. Server: `handle_updates` returns `{ dispositions: null }` (`:276-278`); `get_updates_since`; `class-wp-sync-table-storage.php:505 get_updates_after_cursor`. A's row passes B's own-row filter (`:636-645`). Form 9: response JSON with base64.
14. `polling-manager.ts:2138 applyResponseRooms`, `:1514`, `:1403`, `session.receiveUpdate`.
15. `yjs-server/session.ts:147 processDocUpdate`, `update` case: `base64ToUint8Array`, `Y.applyUpdateV2( doc, bytes, YJS_SERVER_SESSION_ORIGIN )` (`:172-176`).
16. `engine.ts:302 onRecordUpdate` (attached by `observeDeep` at `:330`): not local, so `observers.onRemoteChange()`.
17. Framework `manager.ts:361`, `:719 _updateEntityRecord`, `:735 core.getEditorChanges( await handlers.getEditedRecord() )`.
18. `engine.ts:263 getEditorChanges` calls `syncConfig.getChangesFromCRDTDoc` (`crdt.ts:367 getPostChangesFromCRDTDoc`). Form 10: `ymap.toJSON()` of the whole record (`:377`); the `blocks` case returns the whole tree (`:415`) plus an injected `content` serializer. The engine's bootstrap guard (`:273-292`) may drop `content` while the document still matches the saved post.
19. `manager.ts:748 handlers.editRecord( changes )`, `resolvers.js:227-243`, `EDIT_ENTITY_RECORD`. Canvas.

**Counts.** 17 named files (8 plugin, 9 subtree) plus y-php. 10 forms (11 on the kses path).

**Verdict.** The shortest and most conventional of the three paths, because it reuses the framework's manager and core-data's CRDT bridge. The cost is in one place and is O(document) per keystroke: a full decode (`:798`), two full encodes (`:295`, `:419`), and a whole-document base64 into room meta (`:496`). The `$before_bytes` encode exists only to detect a no-op batch and to rebuild after a failed apply. Both editors also do whole-tree work per keystroke (A diffs the full block list, B dispatches the full tree), but those lines are in the subtree.

### C. Saving the post

#### C1. de-rtc

1. core-data `actions.js:534 saveEntityRecord` calls `syncManager.beforeSave` (`:604-613`).
2. `src/entity-sync/adapter.ts:34 beforeSave` runs the vendored `sync.ts:420 beforeSave` (pushes pending edits with `manager.update`; de-rtc's `serialize` returns `''` at `engine.ts:598`, so no CRDT meta is added), then awaits `flushBeforeSave` (`src/entity-sync/index.ts:16`, a 5 s race against `polling-manager.ts:538 flushHeldUpdates`).
3. `actions.js:716 PUT /wp/v2/posts/<id>`.
4. `src/engines/de-rtc/save-base-version.ts:52 apiFetch middleware` (installed at `engine.ts:331`): matches `/wp/v2/posts/(\d+)` and not `/autosaves`; calls `control.prepareForSave()` (`session.ts:862`): up to 4 s of `maybePropose` while `dirty || inFlight`, then `commitsHeld++`, then waits out a commit that slipped in; returns `release`. Adds `base_version` from `control.lastVersion()` to the body (`:84-87`); `release()` in `finally`.
5. Server `rest_pre_insert_post`: `class-wp-de-rtc-base-version-preflight.php:121 map_rest_base_version` copies `base_version` onto the prepared post.
6. `content_save_pre` at priority -999999: `:106 capture_raw_content` keeps the un-kses'd content in a static.
7. `wp_insert_post_empty_content`: `:138 preflight`. Acts only when `base_version` is present and a de-rtc room exists (`room_doc_state`). Builds a proposal with id `save-<md5>` and client id `WRITER_CLIENT_ID` 2000000002 (`:184-202`) and calls the same `handle_updates` as B2 hops 10-12. So an editor save is a server-side commit: claim, merge, canonical row, announce row. `applied`: `materialize` (`class-wp-de-rtc-engine.php:1791`) gives the merged canonical, kept in a static. `escalated` or anything else: `$last_error` is set to a 409 and the filter returns `true`.
8. `wp_insert_post_data` priority 10: `:256 apply_merged_content` replaces `post_content` with the merged canonical.
9. `wp_insert_post_data` priority 20: `class-wp-de-rtc-sync-meta-colocation.php:100 embed_sync_meta` appends a `data-wp-sync-meta` script pseudo-block (room version, seq, content hash, version snapshots).
10. `wp_after_insert_post`: `:272 cleanup` clears the statics.
11. `rest_prepare_post` priority 20: `:70 strip_sync_meta_from_rest_response` removes the script from `content.raw`.
12. Client `receiveEntityRecords`, then `syncManager.afterSave` (`sync.ts:361-378`) pushes server-mutated fields back through `manager.update( ..., { isSave: true } )`. De-rtc ignores `isSave` (`engine.ts:575`), so a differing field makes the record dirty again.
13. Afterwards the room has one more version and an announce row by client 2000000002. The saving tab reads it as a peer's, fetches a snapshot, and `applyCanonical` moves its version without changing blocks. A save that changes nothing still produces a new version and an announce row (no short-circuit in `ingest_proposal` for content equal to canonical was found).

**Finding.** When the preflight returns `true`, WordPress core reports `empty_content`. Nothing on the REST path reads `WP_De_RTC_Base_Version_Preflight::last_error()` (the only other reference is the intent-log twin). The editor sees a generic failed save, not the 409 reason.

#### C2. intent-log

1. Same `beforeSave` path as C1 hops 1-3. The flush matters here: `flushHeldUpdates` pushes a lone tab's held queue so the room has the edits before the save.
2. `PUT /wp/v2/posts/<id>` with `content` serialized by the editor. There is no middleware and no autosave interception. The room is not consulted.
3. The server saves `post_content` as any WordPress save does. `includes/engines/intent-log/class-wp-intent-log-base-seq-preflight.php` (hooked like the de-rtc preflight) only acts for machine writers that carry a base seq; an editor save passes through.
4. `afterSave` (`sync.ts:361`) pushes server-mutated fields (`modified`, `date`, slug, meta) back through `manager.update( ..., { isSave: true } )`. `intent-log-manager.ts:1896` sees `options.isSave` and calls `announceCollectionSave( objectType )` (a `set_property` intent on the collection room, so peers refetch their lists); the property registers that differ author `set_property` intents as ordinary edits.
5. Peers receive those intents on their next poll as in B1.

**Verdict (C).** Under intent-log, saving is the ordinary WordPress save plus a flush; the room is the live truth and the save is a copy of it. Under de-rtc, saving IS a commit through the room, and the save is intercepted at five WordPress hooks spread over three files (`autosave-commits`, `base-version-preflight`, `sync-meta-colocation`) plus one apiFetch middleware. That is the right design for de-rtc's model, but a reader needs all four files open to see one save, and the error path (hop 7) loses its reason.

### D. Receive under SSE

**Stream open (`sse`)**

1. `src/providers/sse/sse-provider.ts:8 createSseProvider()` calls `polling-manager.ts:1016 setSseMode( true )` and returns the plain polling provider. SSE is a flag on the polling manager, not a separate manager.
2. `http-polling-provider.ts:49 connect()`, `polling-manager.ts:2278 registerRoom()`: under `sseMode` it sets `sseSettleUntil = now + SSE_SETTLE_MS` (`:2410`, 1000 ms at `:970`), aborts a parked stream, closes the exchange, starts the 1 s awareness check timer (`:2413-2418`), then `poll()`.
3. `:2068 start()`: `streamReceive = sseStreamReady()` (`:2086`) is false during the settle window (`:999-1001`), so the bootstrap read goes over `postSyncUpdate` to REST `/wp-sync/v1/updates`. `nextScheduledDelay` returns `sseDelay()` (`:1007`), the rest of the settle.
4. The poll after the settle: `sseStreamReady()` true, `takeUpdates = false` (`:2087`), a park `AbortController` (`:2118-2121`), `await sseExchange.exchange( payload, parkSignal )` (`:2130`).
5. `src/providers/sse/sse-exchange.ts:202 exchange`: refuses a payload with updates (`:206-209`); computes the stream signature from rooms minus `after`, `awareness`, `updates` (`:218-223`); a changed signature or cursor closes the old stream; opens via `apiFetch( { path: '/wp-sync/v1/sse', parse: false } )` (`:273-280`); checks `text/event-stream`; wraps the body in `readSse` (`:16`); awaits the first event (`:302`).
6. Server `includes/transports/sse/class-wp-sync-sse-server.php:67 register_routes`: `/sse` reuses the parent's `check_permissions`, `validate_request`, `get_route_args`, and hooks `rest_pre_serve_request` to `serve`.
7. `:89 handle_request`: rejects any room with updates as 400 `rest_sse_read_only`; writes this client's awareness (`:104-108`); flushes Redis notices; `:131 subscribe` BEFORE the catch-up read (Redis URL from `class-wp-sync-redis-notifications.php:29-38`; on `RuntimeException` falls back to `snapshot_versions()` plus `WP_Sync_Storage_Change_Waiter`); then `parent::handle_request` (REST `:421`), which calls `process_room_request` per room.
8. `:271 serve`: `text/event-stream` headers, `X-Accel-Buffering: no`, `X-WP-Sync-SSE-Wait`, ends output buffers, `stream()`, closes the subscriber in `finally`.
9. `:310 stream`: the limit is `min( 300, filter )` capped at `max_execution_time - 5` (25 s under wp-env). The first frame is the catch-up: `event: sync\ndata: <json>\n\n` (`:322`).

**A row arrives (another tab wrote)**

10. The writer's `add_update` (`class-wp-sync-table-storage.php:310`) calls `:180 notify_change`: `:212 bump_room_version` (`wp_cache_incr` with a persistent cache, else `INSERT ... ON DUPLICATE KEY UPDATE` on the `_version` room-meta row) and fires `gutenberg_sync_engines_room_changed`.
11. `WP_Sync_Redis_Notifications::changed` (`:120`) records the room; `flush` on `shutdown` (`:126-144`) publishes per room, only when the active transport slug is `sse` (`:129`).
12. The reader's worker is inside `stream()`'s loop at `:340 $this->subscriber->wait( min( 5.0, remaining, deadline ) )`. With Redis: `class-wp-sync-redis.php:158 wait` does `stream_select` and returns on a `message`. Without: `class-wp-sync-storage-change-waiter.php:60 wait` sleeps 0.5 s steps and calls `stream_has_new_data` (`sse-server.php:216-245`), which compares `get_room_versions` with the snapshot taken BEFORE the last read (`:190 snapshot_versions`, called at `:372`); when counters match and the Presence API backend is in use, it checks `:253 awareness_changed` per room against `$stream_awareness` (recorded at `:330`).
13. On wake: `connection_aborted` and deadline checks (`:345-347`), `wp_cache_flush_runtime` (`:349-351`), `can_user_sync_room` re-check per room (`:352-356`), own presence refresh every 20 s (`:361-371`), `snapshot_versions` (`:372`), then per room `get_engine_for_room()->get_updates_since( room, client_id, after )`, the awareness map, `room_generation` (`:374-383`).
14. Loop top emits the frame (`:322`), advances `$room['after']` to `end_cursor` (`:323-329`), records sent awareness (`:330`).
15. Client `sse-exchange.ts:16 readSse`: buffers, splits on `\n\n`, reads `event:`; `retry` throws (`:43-45`); non-`sync` frames (keepalives) skipped; `data:` lines joined and parsed; yields a `SyncResponse`.
16. `exchange` resumes at `:302`: records cursors, resets failures, publishes `window.__wpSyncSseState`, returns.
17. `poll()` applies it: `applyAnswer` (`:2135`), `markConnected`, `applyResponseRooms( rooms, payload, 'receive' )` (`:2138`). `applyRoomResponse` on the receive lane: generation check (`:1529-1536`), held tails cleared if the cursor went back (`:1538-1543`), `state.endCursor = room.end_cursor` (`:1544`), connection limit, awareness merge, `applyRoomRows` (`:1611`), `drainHeldTails` (`:1619`).
18. `setAdvisoryDisabledByTransport( sseExchange.available )` (`:2148`) turns the advisory channel off while the stream is up. `scheduleNext( sseDelay() )` is 50 ms (`STREAM_REISSUE_MS`, `:1074`); the next `poll()` calls `exchange()` again, which only awaits `this.events.next()` because `this.events` is still set (`:242`, `:302`). No request is sent.

**Held tail (a send while the stream is open)**

19. An edit reaches `onLocalUpdate` (`:2341`): `updateQueue.add`, `wakeForLocalWork( held )`.
20. `:720 wakeForLocalWork`: `streamReceiving()` is true (`:1934`, `sseStreamReady() && isPolling`), so `scheduleSend()` (`:1944`, a 0 ms timer, deduplicated by `sendTimer`).
21. `:2002 sendNow`: returns if `updatesInFlight`; builds the payload with `takeUpdates = true`; stamps `rows_received_separately = true` on every room (`:2022-2024`); `updatesInFlight = true`; posts to `/updates`.
22. Server `process_room_request`: ingests (`:507`). Because `rows_received_separately` is set, `$read_cursor = self::READ_FROM_HEAD` (`PHP_INT_MAX`, const at `:113`, chosen at `:524`). `get_updates_since( room, client_id, PHP_INT_MAX )` returns no stored rows but reports `end_cursor` as the head, and still returns rows an engine synthesizes and never stores (de-rtc's fetch answer). Awareness, generation, dispositions attached. The write also bumped the version counter and published to Redis, which wakes the sender's own stream.
23. Client `applyResponseRooms( rooms, payload, 'send' )` (`:2033`). In `applyRoomResponse` the `'send'` branch (`:1580-1609`) drops the answer if the generation changed (`:1591-1597`); otherwise, if it carries rows, dispositions or `should_compact`, pushes `{ endCursor, updates, dispositions, shouldCompact }` onto `state.heldTails` (`:1603-1608`). The cursor is not moved (the `state.endCursor =` assignment at `:1544` is inside the `'receive'` branch only). `drainHeldTails` does nothing yet because `heldTails[0].endCursor <= state.endCursor` (`:1485`) is false.
24. `updatesInFlight = false; finishSend()` (`:2052-2053`). More queued work schedules another send. If the loop had stopped (alone) and tails are held, `pollNow()` forces one receive (`:2035-2039`).
25. The stream event for that write arrives (hops 12-17). `state.endCursor` reaches the head, `applyRoomRows` applies the stored rows first, then `drainHeldTails` (`:1482-1495`) applies the held verdicts. Rows first, verdicts after.
26. Exclusion: `poll()` takes no updates while `updatesInFlight` (`:2087`); a stream receive never takes updates; `exchange` throws if a payload carries updates (`:206-209`).

**Hide and show**

27. `:1139 handleVisibilityChange` (registered at `:2424`). On hide: `isActiveBrowser = false` (`:1141`). If `sseMode && sseStreamHoldsWorker` (`:1144`), `:743 abortParkedStream()` (sets `parkAbortedOnPurpose = true`, aborts `inFlightParkController`) then `sseExchange.close()` (`:1158`).
28. The parked `exchange()` sees the abort (`sse-exchange.ts:232-233`) and throws; its `catch` (`:318-329`) does not count a failure because `signal.aborted`. In `poll()` the `catch` (`:2162-2181`) sees `parkAbortedOnPurpose` and schedules `poll` at 0 ms with no backoff and no log.
29. Next `poll()`: `sseStreamReady()` is false because `sseStreaming()` (`:988-994`) requires `isActiveBrowser || ! sseStreamHoldsWorker`. The request goes over `postSyncUpdate` and may carry updates. `nextScheduledDelay()` (`:599-628`): `sseStreaming()` false, `advisoryCoversEveryone()` false (channel disabled by the transport, `channel.ts:85, 236-239`), `! isActiveBrowser` yields `POLLING_INTERVAL_BACKGROUND_TAB_IN_MS` (25 s, `config.ts:51`).
30. A lone tab with held work starts a 1.5 s `hiddenFlushTimer` (`:1168-1173`) running `flushHeldUpdates`; `handlePageHide` cancels it.
31. On show: `isActiveBrowser = true`, `fastDiscoveryUntil` reset (`:1179`), the pending timer is cleared and `poll()` runs at once (`:1193-1196`). `sseStreamReady()` is true again (the settle is not reset), so that poll calls `exchange`, which reopens the stream.
32. `sse-daemon`: `src/providers/sse-daemon/sse-daemon-provider.ts:98 setSseStreamHoldsWorker( false )`. `sseStreaming()` stays true when hidden, `handleVisibilityChange` skips the abort, the stream is kept.

**The `sse-daemon` variant, hops that change**

33. `sse-daemon-provider.ts:84-101`: `setSseStreamUrl( streamUrl() )` reads `window._wpCollaborationTransportConfig['sse-daemon'].url` (published by `class-gutenberg-sync-engines-plugin.php:351-355` from `class-wp-sync-sse-daemon-transport.php:116 get_stream_url`, `ws://` rewritten to `http://`). `setSseAuthProvider( streamAuthHeaders )` (`:55-68`) mints a token per open with `POST /wp-sync/v1/ws-token` and returns `Authorization: Bearer <token>`.
34. `class-wp-websocket-token-controller.php:108 handle_request`: a random 32-byte hex in a 2-minute transient, or a signed access token.
35. `exchange`: an absolute URL goes out as plain `fetch` with `credentials: 'include'` and the auth header (`:262-272`), not apiFetch.
36. Daemon `class-wp-websocket-sync-server.php:505 accept_connection` (same listener as websocket), `:626 handle_readable`, `:703 handle_handshake` while not open. The head is parsed once and kept on the client entry (`:711-728`). A non-upgrade request that is `OPTIONS` gets a CORS preflight answer (`:755-760`); otherwise the socket is re-framed as `WP_Sync_SSE_Connection` by `:587 stream_on` (`:762-763`), carrying over the buffered body bytes.
37. **Authenticate once per connection:** `$auth = $this->clients[ $key ]['auth'] ?? null` (`:774`). Only when null does it run `wp_cache_flush()` and `:962 authenticate_handshake`: token from `Authorization: Bearer` when no subprotocol offer carries it (`:995-1000`), `WP_WebSocket_Token_Controller::consume_token` (`:174-191`, `get_transient` then `delete_transient`, spent on first sight), token user must equal cookie user (`:1048-1050`). Stored at `:794`. Because `accept_request` can return null while the body is still arriving (`:823-825`) and `handle_handshake` runs on every read, the stored result is what keeps the second pass from spending the token again.
38. `class-wp-sync-sse-connection.php:79 accept_request` waits for `Content-Length` bytes, writes `HTTP/1.1 200` with `text/event-stream` and the CORS block, marks open.
39. The body is parsed, `type = 'sync'` added, `handle_message` (`:845-866`): `:1113 validate_room_request`, `:1125 check_subscription` on first reference, the monotonic cursor rule (`:1165-1168`), `process_room_request` (`:1171`), first response with `send_text`, which the SSE framing writes as `event: sync\ndata: ...\n\n` (`sse-connection.php:176-178`).
40. **Row arrival differs:** the daemon has no Redis subscription (`flush()` publishes only for slug `sse`). A peer's REST write is found by the room scan in `tick()` every `ROOM_SCAN_INTERVAL_S = 1` (`:104`, `:1762-1797`): `room_head_cursor` (`:1400`) per subscribed room, then `:1629 broadcast_room` when the head passed a socket's floor. A websocket peer's frame triggers `broadcast_room` at once (`:1204-1206`). So under `sse-daemon` a REST-written row reaches a stream within about 1 s; under `sse` with Redis it is one notice.
41. Keepalive: `tick()` every 15 s calls `send_keepalive` (`:1801-1825`), writing `: keepalive\n\n`. Streams are never idle-timed-out because `sends_messages()` is false (`sse-connection.php:63-65`). The client's `INACTIVITY_MS` is 25 s (`sse-exchange.ts:72`). There is no 25 s stream limit; the stream lives until the browser closes it.

**Verdict (D).** The design is sound and the two framings share the send path correctly. It is hard to follow because SSE is not a module; it is a mode flag on the polling manager, spread across `setSseMode`, `sseStreamHoldsWorker`, `sseSettleUntil`, `inFlightParkController`, `parkAbortedOnPurpose`, `updatesInFlight`, `pollInFlightCounted`, `sendTimer`, `awarenessCheckTimer`, and `heldTails`. Four variables express "a poll should follow at once" by different routes: `pollAgainRequested` (`:452`), `repollImmediately` (`:417`), the `parkAbortedOnPurpose` path, and `pollNow()` clearing a timer. The held-tails rule is correct and the comment at `:1580-1590` explains it, but a reader must know that `state.endCursor` moves only in the `'receive'` branch to see why `drainHeldTails` waits.

### E. Presence and the advisory channel

**(a) A tab opens a post and finds its peers (21 hops, 11 files)**

1. `class-gutenberg-sync-engines-plugin.php:437-443 enqueue_editor_assets()` calls `editor_settings( $post )`.
2. `class-gutenberg-sync-engines-advisory-presence.php:337-338 editor_settings()` mints the token and calls `record_token( $room, $token, 0 )`.
3. `:1192 record_token()` writes through the tab-list backend `put()` (`class-wp-sync-presence-api-tab-list-backend.php:74-77`: `wp_set_presence( $room, 'gsetab-' . $token, ... )`) or, without one, a transient `gse_adv_tokens_<md5 room>` (`:1236`). Never in room meta (`:36-40` says why).
4. Backend wiring: `class-gutenberg-sync-engines-plugin.php:217, 283-288` (`wp_sync_tab_list_backend`).
5. Settings go out as `window._gutenbergSyncEnginesSettings.advisory` (`plugin.php:445-449`): `room`, `token`, `othersPresent`, `channel`, `leaveUrl`, `nonce`, plus `iceServers`/`maxPeers` or `socketUrl`.
6. `src/providers/advisory/signaling.ts:125 getAdvisorySettings()` reads them.
7. `polling-manager.ts:2430-2436`: on the primary room, `setSyncClientId`, `installAdvisoryHooks`, `startAdvisoryChannel`.
8. `:856 installAdvisoryHooks()` calls `installSignaling()` and `installSignalingLifecycle()` and registers the listeners.
9. `signaling.ts:660 install()` hooks `heartbeat.send`, `heartbeat.tick`, `heartbeat.error` with `@wordpress/hooks`.
10. Each beat: `:496 onHeartbeatSend` attaches `:273 buildProbe()` under `gutenberg_sync_engines_advisory`. Each poll also carries the probe (`polling-manager.ts:1308-1311`).
11. PHP: the `heartbeat_received` filter (`presence.php:200`) runs `:383 answer_heartbeat()`; the poll route runs `answer_probe()` from `class-wp-http-polling-sync-server.php:434-441`.
12. `:416 answer_probe()`: validates, refreshes the token, reads all tokens, files sent signals, builds `peers` of other tokens, answers `others`, `peers`, `signals`, `cursor`, `engine` (`:454-466`).
13. Heartbeat interval: `:217 filter_heartbeat_settings` sets it only when slow awareness rides the Heartbeat; otherwise WordPress keeps 10 s focused, 120 s hidden.
14. JS: `signaling.ts:520 onHeartbeatTick` calls `:536 applyAnswer()`: company belief, peer list, cursor and engine listeners. The poll path calls the same at `polling-manager.ts:2135`.
15. Discovery: tab B's page render stamps its token (hops 2-3), so tab A's next answer lists B. B starts with `othersPresent: true` from `:1327 others_present()`.
16. WebRTC handshake: `src/providers/advisory/webrtc-link.ts:636 start()` subscribes `onPeersChanged( reconcile )` and `onSignal( handleSignal )`. `:483 reconcile()` makes one `PeerLink` per token; the lower token initiates (`:459`) and `:383 connect()` sends the offer with `sendSignal( token, 'offer', sdp )`.
17. `signaling.ts:228 sendSignal()` queues the message; after 50 ms it asks the carrier (the polling manager's `pollNow`, `polling-manager.ts:877-883`) or `wp.heartbeat.connectNow()`.
18. Server mailbox: `presence.php:897 file_signals()` groups by recipient; `:947 append_mail()` writes with compare-and-swap into an options row `gse_adv_mail_<md5 room>_<md5 token>` through `WP_Sync_Atomic_Option`.
19. The recipient's next probe answer empties its box (`:972 take_mailbox`). JS `signaling.ts:640 deliverSignals` feeds `webrtc-link.ts:521 handleSignal`; an offer runs `:420 respond()`; ICE candidates trickle and are buffered when early (`:576-583`).
20. The data channel opens: `:264 wireDataChannel` sends `hello` with the client id and the current presence, then `emitCoverage()`.
21. Coverage and cadence: `channel.ts:236 advisoryCoversClients()` asks the link whether every discovered token and every awareness client id has an open link (`webrtc-link.ts:596 coversPeers`); false when nobody is known. `polling-manager.ts:597 nextScheduledDelay()` decides: alone and bootstrapped gives no timer after the 30 s discovery window (`FAST_DISCOVERY_WINDOW_MS`, `config.ts:137`); full coverage gives on-demand; hidden gives 25 s; company without coverage gives the collaborator interval; else the base interval. `:504 isAlone()` needs the signaling lane, no collaborators in the awareness map, and `othersPresent()` false.

**(b) A tab writes rows and sends the notice (8 hops, 6 files)**

1. `polling-manager.ts:1574-1578` calls `announceLocalWrite( room.room )` when `sentUpdates`; de-rtc commits ride autosave, so `de-rtc/session.ts:383-388` calls it itself.
2. `src/providers/advisory/announce.ts:28` fires listeners.
3. `channel.ts:177-183 onLocalWrite` calls `link.sendAnnounce( room )`.
4. `webrtc-link.ts:686` broadcasts `{ t: 'announce', room }` on every open data channel.
5. Peer: `dc.onmessage` (`:281-285`), `handleMessage`, `host.announce( room )` (`:251-255`).
6. `channel.ts:107-109` emits to `announceListeners`.
7. `polling-manager.ts:889` registered `:787 pollSoonForAnnounce` (150 ms coalesce, 250 ms floor, `config.ts:133-134`), then `pollNow()`.
8. The poll fetches and applies the rows.

**(c) Head-cursor check (4 hops)**

1. Every probe answer carries `cursor` (`presence.php:461`).
2. `:497 head_cursor()` calls `:531 probe_room()`: with table storage `class-wp-sync-table-storage.php:927 peek_room()` (one `MIN/MAX` query); with post-meta storage two raw queries in presence.php (`:552-559`, `:585-592`).
3. `applyAnswer` fires `cursorListeners` (`signaling.ts:623-630`).
4. `polling-manager.ts:890-898 onRoomCursor`: when `cursor > state.endCursor` on the primary room, `pollSoonForAnnounce()`. The daemon has its own head read, `room_head_cursor()` (`:1400`), which uses `get_updates_after_cursor( $room, PHP_INT_MAX )` plus `get_cursor()`, not `peek_room`.

**(d) Awareness (10 hops, 13 files)**

1. Send: polling sends `awareness: state.session.getLocalAwareness()` per room per poll (`:1260`); websocket every 10 s (`websocket-manager.ts:62, 505-514`); SSE a 1 s change check beside the stream (`polling-manager.ts:1928, 1981-1985`).
2. `process_room_request` (`:462-492`) calls `:900 process_awareness_update()`. `null` is a leave.
3. `includes/class-wp-sync-awareness.php` resolves one backend per request through `wp_sync_awareness_backend` (`:58-82`); the plugin returns `WP_Sync_Presence_API_Awareness_Backend` when the Presence API records (`plugin.php:268-273`), which writes `wp_set_presence( $room, 'gse-' . $client_id, ... )` (`class-wp-sync-presence-api-awareness-backend.php:153`), skips the write while the row is younger than timeout/3 and unchanged (`:136-146`), and fires `gutenberg_sync_engines_room_changed`. Without it, the room array (`awareness.php:143-154, 185-204`; `table-storage.php:337-381`), in the object cache when persistent.
4. The 10 s bucket: `class-wp-http-polling-sync-server.php:874 awareness_timestamp()`. **Checked:** the bucket applies only to the room-array fallback; the Presence API backend stamps exact time and uses the refresh fraction instead.
5. Response: `awareness` map (`:527`, `:908-914`).
6. Client: `state.lastServerAwareness = room.awareness` (`:1562`), `:810 mergedAwareness()` overlays the channel's copy, `session.applyRemoteAwareness()` ends in `src/shared/awareness-sync.ts:50 applyServerAwarenessStates` (called from all three engines).
7. Company: more than one client in the map sets `hasCollaborators` (`:1570-1572`); the limit check at `:1547` (`DEFAULT_CLIENT_LIMIT_PER_ROOM = 3`).
8. Ownership: `:692 is_client_id_owned_by_another_user()` reads awareness on every request.
9. Lifetime on join: the poll carries `presence_token` on the post room only (`:1268-1272`); `process_room_request:477-480` calls `note_sync_request()` (`presence.php:662`): first request with the token is the join (`'j'` flag, `:1206-1208`); if `others_present()` is false (`:1327`: other tokens, else `:1347 has_live_awareness_besides()`), `:752 reset_abandoned_room( 'join' )` runs, gated by `:721 resets_empty_rooms()` (option `gutenberg_sync_engines_unsaved_changes`, filter `gutenberg_sync_engines_room_reset_when_empty`), calls `storage->reset_room()`, fires `gutenberg_sync_engines_room_reset` (de-rtc listens, `plugin.php:224`).
10. Lifetime on leave and the generation token: `pagehide` sends the beacon (`signaling.ts:431-468`) to `/gutenberg-sync-engines/v1/advisory/leave`; `:634 handle_leave()` calls `:695 leave()`, which forgets the token and the awareness and resets when nobody is left. A closed daemon socket does the same from `disconnect()` (daemon `:1965-2000`). The generation token (`class-wp-http-polling-sync-server.php:566`) is stamped by REST (`:529-532`), the daemon (`:1652-1657`), and SSE (`sse-server.php:381`); the client compares it (`polling-manager.ts:1529-1535`) and runs `restartRoom` (`:2219-2270`); websocket has a twin (`websocket-manager.ts:288-297, 329-365`).

**(e) The websocket-advisory link, hops that change (7)**

1. `editor_settings()` sends `socketUrl` (`presence.php:361-372`, from `settings.php:897 advisory_websocket_url()`).
2. `channel.ts:71-75` picks `websocketLink`; `websocket-link.ts:414 start()`, `:320 connect()`: `fetchToken()` posts `/wp-sync/v1/ws-token` (`:112-123`), opens `WebSocket( url, [ 'wp-sync', 'wp-sync-token.<token>' ] )`.
3. `:305 onOpen`, `:144 subscribe()` sends `{ type: 'advisory', room, client_id, presence_token }`.
4. Daemon `handle_message` (`:1093-1095`) routes to `:1230 handle_advisory_message()`: checks the access-token rooms claim and `check_subscription`, stores the follower in memory (`:1262-1269`), `:1431 send_advisory_roster()` to every follower.
5. JS `:216 onMessage`, `:183 applyRoster()`, `host.presence()` per peer, `coverageChanged()`.
6. Coverage `:365 coversPeers`: open socket, a roster for the post room, every discovered token on it, every awareness client id on some roster.
7. Notice: `:458 sendAnnounce` sends `{ announce: room }`; the daemon relays with `:1469 send_advisory_announce()`, skipping the sender, and also pushes rows to websocket-transport tabs (`:1298-1300`). The daemon adds two notice sources a WebRTC mesh does not have: rows landed by a sync socket (`:1207-1212`) and the 1 s scan.

The heartbeat probe still runs under this link (`websocket-link.ts:416 installSignaling()`) for `others`, the head cursor, and discovered tokens; the mailbox hops are unused. A closed socket only re-sends rosters (daemon `:1977-1984`); it is not a leave.

**Verdict (E).** Each trace works and matches `docs/plan/advisory-channel.md` and `docs/plan/room-lifetime.md`. The followability cost is that one fact ("this tab is in this room") is stored in four client places and two server places, and "is anyone else here" is computed in five places (see Judgment 2 and 3). The presence class is six jobs in one file.

---

## Part 2. Judgments

### 1. God files

Comment ratios (lines starting with `//`, `*`, `/*`, `#`, or inside a block): `polling-manager.ts` 31%, `intent-log-manager.ts` 36%, `intent-log-bridge.ts` 30%, `de-rtc/session.ts` 37%, `class-wp-de-rtc-engine.php` 43 to 46%, `class-wp-yjs-server-engine.php` 49%, `class-wp-intent-log-engine.php` 39 to 41%, `class-wp-websocket-sync-server.php` 45%, `advisory-presence.php` 54%.

**`src/providers/http-polling/polling-manager.ts` (2586 lines).**

Module-level mutable state: 36 variables. 16 booleans: `areListenersRegistered:403`, `hasCheckedConnectionLimit:405`, `isManualRetry:406`, `hasCollaborators:407`, `isActiveBrowser:408`, `isPolling:409`, `isUnloadPending:410`, `repollImmediately:417`, `hasBootstrapped:451`, `pollAgainRequested:452`, `advisoryHooksInstalled:473`, `sseMode:947`, `sseStreamHoldsWorker:958`, `parkAbortedOnPurpose:1070`, `updatesInFlight:1921`, `pollInFlightCounted:1922`. 6 timers: `pollingTimeoutId:412`, `hiddenFlushTimer:453`, `localUpdatePollTimer:470`, `announcePollTimer:471`, `sendTimer:1923`, `awarenessCheckTimer:1929`. 9 numbers: `consecutiveFailures`, `pollInterval`, `syncRequestBodySizeLimit`, `fastDiscoveryUntil`, `sendsStarted`, `sendsFinished`, `lastAnnouncePollAt`, `sseSettleUntil`, `roomOverflowOffset`. 5 objects: `roomStates`, `sendDoneResolvers`, `sseExchange` (10 more fields in `sse-exchange.ts:94-126`), `inFlightParkController`, `lastSentAwareness`. Per room, `RoomState` has 12 fields including `heldTails`, `generation`, `holdWhileAlone`, and the queue's `isPaused`.

Is the state machine explicit? No. No state is named. The receive mode is recomputed on every call: `sseStreaming()` (`:988`) from three flags, `sseStreamReady()` (`:999`) adds a time check, `streamReceiving()` (`:1934`) adds `isPolling`, `isAlone()` (`:504`) from three sources, `nextScheduledDelay()` (`:599-628`) reads seven of them, `releaseRoom` (`:2506-2508`) reconstructs "in flight" from three variables. Two counters (`sendsStarted`, `sendsFinished`) plus `pollInFlightCounted` exist only so `flushHeldUpdates` and `releaseRoom` can wait for "the next request that could carry updates".

Responsibilities by line range: REST error classification and 403/409 handlers (`:150-324`); connection limit (`:336-401`); cadence, holds, flush, wake, park (`:475-801`); awareness merge with the channel and advisory hook installation (`:803-931`); SSE mode, worker flag, settle, exchange setters, park controller (`:933-1084`); page lifecycle (`:1086-1203`); room selection and payload building under the size cap (`:1205-1380`); response application incl. generation, held tails, rows, debug tap (`:1382-1672`); connected marking, failure handling, backoff (`:1674-1897`); SSE send lane (`:1899-2062`); the poll loop (`:2064-2216`); room restart (`:2218-2276`); register, unregister, release, drop, retry (`:2278-2586`).

Do not belong: SSE plumbing (a receive-lane object), advisory integration (`src/providers/advisory/` exists; the hook installer belongs there), page lifecycle, payload size budgeting (pure), failure classification (pure), the response envelope application (shared with websocket).

Concrete split: `room-registry.ts` (roomStates, register/unregister/release/drop); `cadence.ts` with an explicit `receiveMode: 'polling' | 'stream-settling' | 'streaming' | 'stream-backoff' | 'hidden-polling' | 'quiet'` set in one `setReceiveMode()` that also opens or closes the exchange and the advisory channel; `send-lane.ts` with `sendLane: 'idle' | 'scheduled' | 'in-flight'`; `request-builder.ts` (createPayloadRoom, buildPayloadForRequest, size budget); `room-envelope.ts` shared with websocket (applyRoomResponse, applyRoomRows, held tails, generation restart, debug tap); `errors.ts`; `page-lifecycle.ts`. Keep `polling-manager.ts` as the loop (about 700 lines).

Drift found: `TransportSessionExtensions.syncWhileSolo` (`src/providers/session-extensions.ts:33`) is the typed flag, but the manager reads `sendsWhileAlone` through an inline cast (`polling-manager.ts:2301`), de-rtc sets `sendsWhileAlone` (`de-rtc/session.ts:777`, `engine.ts:106`), and `tests/js/providers/http-polling/polling-manager.test.ts:2931` sets `syncWhileSolo`, which nothing reads.

**`src/engines/intent-log-manager.ts` (2436 lines).**

`EntityState` (`:150-290`): 26 fields; 6 booleans (`unloaded`, `syncForce`, `staleVoidRecapturePending`, `resetRecapturePending`, `capturing`, `genesisSeeded`), 1 timer (`syncTimer`), 2 counters (`pushSeq`, `lastEditorEditAt`), 4 id sets/maps (`editorIds`, `prevDocIds`, `docTombstones`, `clientIds`), 2 baselines (`observed`, `pendingPushes`), 2 trees (`preInitTree`, `lastEditorTree`), 3 property mirrors (`lastPushedProps`, `knownMeta`, `syncedProperties`). The phases "pre-init", "bootstrapping", "observing", "capturing", "recapture pending", "reset pending" are encoded as combinations of `session.isInitialized()`, `observed === null`, `capturing`, `resetRecapturePending`, `staleVoidRecapturePending`. Implicit.

Functions: `loadEntity` 715 lines (`:1044-1758`) with six nested handlers; `update` 331 lines (`:1887-2217`). Responsibilities: property registers (`:337-560`, `:1204-1260`, `:1930-2030`); meta registers (same places); block capture (`:2030-2217`); the observed-baseline machine (`:781-963`); bootstrap and pre-init recovery (`:1262-1420`); horizon reset and stale-void recovery (`:1420-1540`); review item mapping and escalation notices (`:1585-1760`), which re-implements the framework's `attachEntityReview` fan-out (`gutenberg/packages/sync/src/manager.ts:145-198`); collection rooms (`:1759-1886`); a discard notice through a duck-typed `window.wp.data` (`:1540-1584`); undo lifecycle (`:975-986`, `:2361-2363`, `:1922-1924`), which re-implements `manager.ts:292-304, 583-584, 789-791`; awareness registry.

Split: `properties.ts` (register capture and push incl. meta), `baseline.ts` (observed, pendingPushes, choose, push, syncEditor, schedule as a class with named phases), `recovery.ts` (reset, stale-void, pre-init), `review.ts` (mapReviewItems, summarizeProposal, proposedInsertionFor), `collections.ts`, a short `manager.ts`. None of this is frozen (`src/engines/intent-log/**` is untouched). The larger move, adopting `createSyncManager`, is Refactor 1 below.

**`src/engines/intent-log-bridge.ts` (1759 lines).** Eight responsibilities in one file: block to spec and back (`:262-480`), text and format diff (`:545-735`), id adoption (`:735-850`), splits and merges (`:846-968`), `deriveIntents` (`:968-1440`, 473 lines, 8 inner closures), tree summary and distance (`:1442-1590`), apply (`:1590-1680`), canonical and verify (`:1680-1759`). Split along those lines; the diff and adoption parts are pure and testable alone.

**`includes/engines/de-rtc/class-wp-de-rtc-engine.php` (2908 lines).** Implements a 5-method interface with 48 methods (10 public, 38 private). Fourteen responsibilities: SPI identity (`:51-279`); ingest orchestration with a 300-line `ingest_proposal` (`:312-771`); descriptor validation (`:784-888`); property-register merge (`:897-1090`); base resolution incl. revision mining (`:1092-1113`, `:2155-2314`); the review ledger (`:1132-1265`, `:1523-1682`); the kses lane (`:1286-1385`); merge strategies (`:1398-1512`); read side (`:1695-1798`); canonical persistence as an options-row chain (`:1813-1909`, `:2327-2643`); external-save healing (`:1928-2132`), which repeats the commit half of `ingest_proposal`; checkpoints (`:2659-2805`); the version claim (`:2817-2884`); row writing; the debug stash. `array $state` appears in 13 signatures, `array $proposal` in 8, `&$review` in 9; dispositions are built in at least 9 places; the announce row twice; the parked row in three shapes; the snapshot row in three places. 30 of 48 signatures take an `array`. Split into `WP_De_RTC_Canonical_Store` (persistence plus claim), `WP_De_RTC_Base_Resolver`, `WP_De_RTC_Proposal_Merger` (descriptor, kses, merge), `WP_De_RTC_Property_Merger`, `WP_De_RTC_Review_Ledger` (which the review controller would construct instead of a whole engine, `class-wp-de-rtc-review-controller.php:92`), `WP_De_RTC_Commit` (the shared commit step used by ingest, healing, and the preflight), `WP_De_RTC_External_Save_Healer`, `WP_De_RTC_Checkpointer`, plus value objects with `from_array`/`to_array` so the wire stays unchanged. The engine keeps about 300 lines.

**`includes/transports/websocket/class-wp-websocket-sync-server.php` (2087 lines).** Five jobs: event loop (`:316-497`, `:505-617`, `:626-694`), HTTP and auth handshake incl. the health endpoint, CORS, origin allowlist, token and cookie auth (`:703-868`, `:883-942`, `:962-1058`), room sync (`:1068-1213`, `:1318-1334`, `:1400-1421`, `:1524-1618`, `:1629-1690`), advisory relay (`:1230-1302`, `:1344-1388`, `:1431-1513`), room scan and sweeps (`:1725-1844`, `:1857-1887`, `:1896-1955`). Each `$clients` entry is an untyped array with 11 keys at creation (`:557-569`) and 3 added later (`auth :794`, `access_token :799`, `access_token_rooms :802`); the docblock (`:218-247`) omits two and misnames one. Split: `WP_Sync_Daemon` (loop, accept, framing, close), `WP_Sync_Daemon_Handshake`, `WP_Sync_Daemon_Auth`, `WP_Sync_Daemon_Room_Service`, `WP_Sync_Advisory_Relay`, and a `WP_Sync_Daemon_Client` object. The framing split (`WP_Sync_Connection`, `WP_WebSocket_Connection`, `WP_Sync_SSE_Connection`) already exists and is good.

**`includes/engines/yjs-server/class-wp-yjs-server-engine.php` (1795 lines).** Ten responsibilities; about 1,050 lines (kses `:502-592`, canonical store and repair `:772-1023`, compaction `:1025-1117`, block schema codec `:1278-1771`) need no engine state. Split: a static `WP_Yjs_Server_Block_Codec`, a `WP_Yjs_Server_Room_Store` (owns `$room_docs` and the `META_*` keys), a `WP_Yjs_Server_Kses`, with compaction and genesis skeleton shared (Judgment 2). Engine keeps about 500 lines.

**`includes/engines/intent-log/class-wp-intent-log-engine.php` (1690 lines).** Thirteen responsibilities; about 900 lines (kses predicates `:796-1006`, compaction `:1033-1177`, `load_room` `:1322-1414`, the block walk and `to_serializable_block` `:1501-1666`) need no ingest state. `handle_updates_locked` (`:351-794`) does ten things in one scope sharing about fifteen locals: parse three row types, cancels, group and filter units, kses gate, `doc_at` cache, park approvals, plan and commit, checkpoint, narrate and stash, resolutions, dispositions. Split: static `WP_Intent_Log_Kses`, static `WP_Intent_Log_Block_Codec`, `WP_Intent_Log_Room_State` (`load_room`, `document_at`, `head_seq`, `add_row`; the base-seq preflight would depend on this instead of constructing a whole engine, `class-wp-intent-log-base-seq-preflight.php:154`), and `handle_updates_locked` into seven private methods. Engine keeps about 550 lines.

**`includes/class-gutenberg-sync-engines-advisory-presence.php` (1382 lines).** Twelve jobs: config readers (`:241-316`); heartbeat interval filter (`:217-234`); editor settings (`:329-381`); probe answer (`:383-467`); storage probing with raw SQL (`:477-596`); REST leave (`:598-644`); room lifetime (`:662-798`, `:824-832`); authorization (`:842-882`); handshake mailbox with CAS and raw-SQL sweep (`:897-1058`, `:1260-1289`); tab token store with two code paths (`:1068-1237`, `:1299-1317`); slow-awareness name and avatar on the token (`:427-429`, `:444-448`, `:1096-1101`, `:1212-1223`, `:1239-1250`); company detection (`:1327-1381`). The room-reset policy and the WebRTC mailbox share nothing but the token. Split: `WP_Sync_Tab_Presence` (one path; move the transient code into a `WP_Sync_Transient_Tab_List_Backend`), `WP_Sync_Signaling_Mailbox`, `WP_Sync_Room_Lifetime` (the transports construct the whole presence class only for this today, `class-wp-http-polling-sync-server.php:143-147, 479`), a `WP_Sync_Room_Peek` shared with `derive_room_generation()` (same query at `class-wp-http-polling-sync-server.php:609-616` and `presence.php:585-592`), and a thin endpoint class.

**`includes/admin/class-gutenberg-sync-engines-settings.php` (1282 lines).** Mostly a real settings screen. Not a settings job: `:219-226` feeds the framework's `wp_collaboration_transport` filter at runtime (belongs in the plugin's `register()`); `:817-826 sanitize_delivery()` calls `update_option()` twice on other options from inside a sanitize callback (deliberate per the docs, but hard to test); about 200 lines of runtime readers (`:238-416`, `:586-660`, `:884-906`, `:1022-1048`) that presence.php, plugin.php and the transports call, loaded on every request; about 130 lines of JavaScript in PHP strings (`:704-725`, `:779-795`, `:975-1005`, `:1225-1280`). **Bug (confirmed):** `:918` reads `class_exists( 'WP_WebSocket_Access_Token' && true !== WP_WebSocket_Access_Token::is_enabled() )`. The `&&` is inside the `class_exists()` argument, so the argument is a boolean and the notice at `:919` never renders; if the class is missing, the expression fatals before `class_exists` can guard it. The string is not translated. Split: `Gutenberg_Sync_Engines_Options` (always loaded) and `Gutenberg_Sync_Engines_Settings_Screen` (under `is_admin()`), with the four inline scripts in one enqueued admin file.

**`includes/diagnostics/class-gutenberg-sync-engines-request-log.php` (1412 lines).** A full benchmark harness in one class: table schema (`:378-462`, `:625-670`), two measurement lanes (`:192-201`, `:477-620`; `:223-330`), tag parsing twice (`:679-770` request-based, `:775-845` `$_SERVER`-based; `approach_label()` and `server_approach_label()` implement the same rule), process metrics, a concurrency counter with raw SQL on the options table (`:913-960`), six REST routes (`:965-1200`), a text report (`:1206-1410`). Dev-only (local or a constant), so the cost is maintenance. Split: `Request_Log_Table`, `Request_Metrics`, `Request_Log_REST`, `Request_Log_Report`; collapse the two labelers.

### 2. Duplication across engines

No duplicated code sits in the frozen trees. The frozen parts define the interfaces and reason codes the duplicates implement.

**(a) Genesis seeding.** The same five steps three times. Step 1 (parse room, fetch post):

```php
// class-wp-intent-log-engine.php:1447-1451
$parsed  = WP_Sync_Config::parse_room( $room );
$genesis = array( 'root' => array() );
if ( null !== $parsed && 'postType' === $parsed['entity_kind'] && ! empty( $parsed['object_id'] ) ) {
    $post = get_post( (int) $parsed['object_id'] );
// class-wp-yjs-server-engine.php:1138-1142
$parsed   = WP_Sync_Config::parse_room( $room );
$wrappers = array();
if ( null !== $parsed && 'postType' === $parsed['entity_kind'] && ! empty( $parsed['object_id'] ) ) {
    $post = get_post( (int) $parsed['object_id'] );
// class-wp-de-rtc-engine.php:2328-2335
$parsed = class_exists( 'WP_Sync_Config' ) ? WP_Sync_Config::parse_room( $room ) : null;
if ( null !== $parsed && 'postType' === $parsed['entity_kind'] && ! empty( $parsed['object_id'] ) ) {
    $post = get_post( (int) $parsed['object_id'] );
```

Step 2, the props seed, three different guards for a class the plugin always loads (intent-log `:1429` none; yjs `:1191` `class_exists ? : array( 'title' => ... )`; de-rtc `:2341` `if ( class_exists )`). Step 3, the genesis row: same type string `'snapshot'` (`:92`, `:114`, `:104`) but three payload shapes and two server client ids (0 for intent-log and yjs; `SERVER_CLIENT_ID = 2000000001` for de-rtc). Step 4, the "room is empty" gate: intent-log `:1202` checks `get_cursor() === 0` BEFORE the read (the cold-cache trap in Part 1 A); yjs `:631` and de-rtc `:1708` check `get_update_count() === 0` AFTER the read, with a de-rtc comment "See the yjs-server engine for why". Step 5, the lineage stamp and the same error text `'Failed to store the room genesis snapshot.'` (`:1470-1486`, `:1235-1245` "see the intent-log engine's identical rationale", `:2418-2427`). The `parse_blocks` tree walk with the freeform rule is written twice: `blocks_to_specs` (`intent-log:1504-1546`) and `blocks_to_yblocks` (`yjs:1341-1368`, "mirrors the intent-log genesis"). Helper: `WP_Sync_Room_Genesis::for_room( $room, callable $build_payload )`.

**(b) Awareness bridging.** `src/shared/awareness-sync.ts` is already shared. The lifecycle is four copies:

```ts
// intent-log-manager.ts:1089-1095
const awareness = syncConfig.createAwareness?.( createAwarenessDoc( clientId ) as never, objectId );
registerAwareness( objectType, objectId, awareness );
// yjs-server/engine.ts:88-89
const awareness = syncConfig.createAwareness?.( ydoc );
registerAwareness( objectType, objectId, awareness );
// de-rtc/engine.ts:295-298
const awareness = syncConfig.createAwareness?.( createAwarenessDoc( record.clientId ) as never );
registerAwareness( objectType, objectId, awareness );
```

Two differences look like bugs (confirmed): de-rtc does not pass `objectId`, which `createAwareness` takes (`gutenberg/packages/core-data/src/entities.js:415`), so its `PostEditorAwareness` has no post id; and tear-down disagrees: intent-log calls `awareness?.destroy()` in four places, yjs relies on `ydoc.destroy()`, de-rtc never destroys it (`engine.ts:633-641` drops observers, review and the save hook only), so its awareness check interval keeps running after unload. The codec members `applyRemoteAwareness`/`getLocalAwareness` are three copies plus a fourth for de-rtc's collection codec. Helper: `src/shared/entity-awareness.ts` with `createEntityAwareness()` returning `{ awareness, getLocalAwareness, applyRemoteAwareness, destroy }`.

**(c) kses.** One expression five times, always gated by `current_user_can( 'unfiltered_html' )`:

```php
// intent-log:806-808
return wp_kses_post( $html ) !== $html;
// yjs-server:528
if ( wp_kses_post( $serialized ) !== $serialized ) {
// de-rtc:524-526
$sanitized = wp_kses_post( $proposed_content );
if ( $sanitized !== $proposed_content ) {
```

Also de-rtc `:927`, `:1325-1329`, and `class-wp-de-rtc-identity-merge.php:283-285`. The "untouched blocks pass" set trick is written twice (yjs `:538-545`, de-rtc `:1310-1331`). What differs by design and should stay: intent-log parks the unit as `requires-approval`; yjs rewrites the canonical doc and broadcasts a compensating row; de-rtc reverts risky blocks to base and parks them. Helper: `WP_Sync_Kses::would_change( $html )`, `::author_is_filtered()`.

**(d) Undo.** Three models, one repeated shell: all implement `SyncUndoManager` with a no-op `addRecord`, `undo()`/`redo()` returning `[]`, and a `{ hasUndo, hasRedo }` notifier (`yjs-server/undo.ts:60-63, 110-116, 146-157`; `intent-log-undo.ts:488-504, 777-794`; `de-rtc/revert-undo.ts:260-265, 408-435`). "A new edit clears the redo stack" is hand-written twice (`intent-log-undo.ts:724-757`, `revert-undo.ts:289-298`). Intent-log also re-implements the manager's lazy creation, getter and `stopCapturing` wiring because it bypasses `createSyncManager`. Helper: `createUndoShell()` plus `createUnitStacks()`; the inverse computation stays per engine.

**(e) Review lane.** intent-log and de-rtc keep the same open/resolved ledger on the client:

```ts
// intent-log-session.ts:378, 662-669, 871-874
const resolvedIds = new Set< string >();
case INTENT_LOG_UPDATE_TYPES.RESOLVED: { if ( ! resolvedIds.has( id ) ) { resolvedIds.add( id ); notifyProposalsChange(); }
getOpenProposals: () => proposals.filter( ( p ) => ! resolvedIds.has( p.intent.intentId ) ),
// de-rtc/review.ts:78-80, 147-157
const open = new Map< string, DeRtcParkedProposal >();
const resolvedIds = new Set< string >();
noteResolved( proposalId ) { if ( resolvedIds.has( proposalId ) ) { return; } resolvedIds.add( proposalId ); if ( open.delete( proposalId ) ) { notify(); } },
```

Both resolve optimistically; de-rtc reopens on failure, intent-log has no failure path. de-rtc exposes a `SyncReviewSource` and lets the framework fan out; intent-log re-implements the fan-out by hand (`intent-log-manager.ts:1690-1725`). Server: the open/resolved guard and the `resolved` row payload are identical (`class-wp-intent-log-engine.php:746-768`, `class-wp-de-rtc-engine.php:1566-1590`).

**(f) Block identity.** The hash is shared (`includes/shared/class-wp-sync-block-identity.php:38`); `WP_Intent_Log_Planner::genesis_sync_id` (`:66-68`) is an extra name for it. The tree walk reading `metadata.syncId` with the whitespace-only freeform rule is written three times in PHP (`class-wp-de-rtc-block-identity.php:248-258`, `class-wp-intent-log-engine.php:1532-1537`, `class-wp-de-rtc-identity-merge.php:448-451`) and five small walks in TS. Helper: move de-rtc's `walk()` into `WP_Sync_Block_Identity` with `read_sync_id()`/`write_sync_id()`; one `src/shared/sync-id.ts`. Frozen: `src/engines/intent-log/sync-id.js` (random minting) is frozen and is not a duplicate.

**(g) The `_debug` envelope.** The gate is in one place (`class-wp-http-polling-sync-server.php:503`, `:724-737`). The engine side is three copies: the `$debug_stash` property (`:160-168`, `:178-186` "Mirrors the intent-log engine's stash", `:178-186`) and a byte-identical attach block in all three `get_updates_since` (verified with `diff`: intent-log `:1236-1248`, yjs `:655-667`, de-rtc `:1763-1775`):

```php
if ( ! empty( $context['debug'] ) ) {
    $response['_debug'] = array_merge(
        $this->debug_stash[ $room ] ?? array(),
        array( 'rows_returned' => count( $typed_updates ), 'total_rows' => $response['total_updates'] )
    );
    unset( $this->debug_stash[ $room ] );
}
```

Helper: a trait `WP_Sync_Engine_Debug_Stash`.

**(h) `qm/debug` narration.** No wrapper. Every call is a bare `do_action( 'qm/debug', ... )` with the same 170-character phpcs-ignore comment above it: de-rtc 14, yjs 11, intent-log 8, polling 2, SSE 1, presence 1. The prefix is inconsistent:

```php
// intent-log:1156-1157
do_action( 'qm/debug', "wp-sync: trimmed history below cursor {$previous['cursor']} for {$room}" );
// yjs-server:1112-1113
do_action( 'qm/debug', "wp-sync: yjs-server trimmed history below cursor {$prev_cursor} for {$room}" );
// de-rtc:2807-2808
do_action( 'qm/debug', "wp-sync: de-rtc trimmed history below cursor {$prev_cursor} for {$room}" );
```

Helper: `gutenberg_sync_engines_narrate( $engine, $message )`.

**(i) Errors and dispositions.** Empty-batch early return, three identical copies (`:312-314`, `:276-278`, `:313-315`). `rest_invalid_update_type`, three copies with different messages. `rest_sync_storage_error` with `'Failed to store sync update.'`, eight identical copies (intent-log `:493`, `:624`, `:678`, `:761`, `:1471`; yjs `:471`, `:482`, `:1236`; de-rtc `:1584`, `:2419`). Dispositions: intent-log always carries `intentId`; yjs carries no `intentId` (`:338-349`), which does not satisfy the TS `EngineDisposition.intentId: string` but works because its session reads only `status`; de-rtc merges `intentId` onto three shapes. Helper: `WP_Sync_Engine_Errors` and a `WP_Sync_Disposition` builder.

**(j) Room-meta keys and compaction.** intent-log uses string literals (`'intent_log_checkpoint'`, `'intent_log_floor'`, `:1090`, `:1160`, `:1172`, `:1213`); yjs and de-rtc use constants. The floor clamp is four identical lines three times (`:1212-1216`, `:611-615`, `:1696-1700`). `maybe_checkpoint` is three copies of one shape (store the row, read `insert_id`, stamp the checkpoint, trim, stamp the floor, narrate):

```php
// intent-log:1134-1175
$stored = $this->add_row( $room, $client_id, self::UPDATE_TYPE_SNAPSHOT, array( 'doc' => $head_doc, 'seq' => $head_seq, 'checkpoint' => true ) );
if ( ! $stored ) { return false; }
global $wpdb;
$cursor = (int) $wpdb->insert_id;
if ( $cursor <= 0 ) { return true; }
$this->storage->set_room_meta( $room, 'intent_log_checkpoint', array( 'seq' => $head_seq, 'cursor' => $cursor ) );
if ( is_array( $previous ) && isset( $previous['cursor'] ) ) {
    $this->storage->remove_updates_before_cursor( $room, (int) $previous['cursor'] );
    $this->storage->set_room_meta( $room, 'intent_log_floor', (int) $previous['cursor'] );
// yjs-server:1085-1111
$stored = $this->add_row( $room, $client_id, self::UPDATE_TYPE_SNAPSHOT, wp_json_encode( array( 'doc' => ..., 'checkpoint' => true ) ) );
if ( ! $stored ) { return false; }
global $wpdb;
$cursor = isset( $wpdb ) ? (int) $wpdb->insert_id : 0;
if ( $cursor <= 0 ) { return true; }
$this->storage->set_room_meta( $room, self::META_CHECKPOINT, array( 'cursor' => $cursor ) );
if ( $prev_cursor > 0 ) {
    $this->storage->remove_updates_before_cursor( $room, $prev_cursor );
    $this->storage->set_room_meta( $room, self::META_FLOOR, $prev_cursor );
```

de-rtc `:2765-2810` is the same again. The "re-append unresolved parked rows below the new floor" pass is near-identical in intent-log (`:1096-1131`) and de-rtc (`:2719-2763`, "the intent-log retention rule"). Helper: `WP_Sync_Room_Compactor` with `commit_checkpoint()`.

**(k) Adapters and boilerplate.** `yjs-server-adapter.ts:17-26` and `de-rtc-adapter.ts:20-29` are the same file with names swapped. `src/index.ts:41` unlocks the private APIs a second time while `src/framework.ts:20-23` exists for that purpose. PHP class boilerplate (`SLUG`, `PROTOCOL_VERSION`, constructor, `get_slug`, `get_protocol_version`) is three copies; `add_row` three copies with one difference (intent-log JSON-encodes an array; the others take a string). Helper: an abstract `WP_Sync_Engine_Base` holding the constructor, slug and protocol accessors, `add_row`, the debug-stash trait, the error helpers, the floor clamp, and template methods for genesis payload and checkpoint payload. Both large engine files have the same skeleton in the same order, which is the strongest argument for it.

### 3. Duplication across transports

**Client.**

| What | Copy A | Copy B |
|---|---|---|
| Room envelope (after, awareness, client_id, engine, engine_protocol, presence_token, debug, room, updates) | `polling-manager.ts:1254-1278 createPayloadRoom` | `websocket-manager.ts:154-179 buildSyncFrame` ("see the polling manager's twin") |
| Generation check and restart | `polling-manager.ts:1529-1536`, `restartRoom :2229-2276` | `websocket-manager.ts:288-299`, `:337-364` |
| Apply rows and dispositions | `polling-manager.ts:1403-1473` (logs failures, guards `receiveDispositions`) | `websocket-manager.ts:303-316` (swallows, no guard, ignores `should_compact`) |
| Debug inspector tap | `polling-manager.ts:1651-1668`, `:1716-1726` | `websocket-manager.ts:194-204`, `:264-280` |
| Token mint | `websocket-manager.ts:111-120 fetchToken` | `sse-daemon-provider.ts:55-68 streamAuthHeaders` (same POST, same path, same error string) |
| Daemon URL from window config | `websocket-manager.ts:130-145` | `sse-daemon-provider.ts:25-39` |
| Backoff | `polling-manager.ts:1809-1817` + `config.ts:11-19` | `sse-exchange.ts:68-69, 321-327` (5 s doubling to 60 s); `websocket-manager.ts:56-57, 612-625` (1 s doubling to 30 s). Three policies. |
| Awareness send | `polling-manager.ts:1965-1985` (compare every 1 s) | `websocket-manager.ts:505-514` (every 10 s, no change check) |
| `log()` helper | `http-polling-provider.ts:113-130` | `websocket-manager.ts:415-429` |

Asymmetries that are defects, not just duplication: `checkConnectionLimit` exists only in polling (`polling-manager.ts:336-401`), so a websocket tab is never refused for roster size. The daemon sends `type: 'error'` frames (`class-wp-websocket-sync-server.php:1700-1717`) for `rest_cannot_edit`, `rest_sync_engine_mismatch`, and invalid rooms; `websocket-manager.ts:378` returns on anything not `type: 'sync'` (confirmed), so over websocket a refused room stays "connected" (status set at open, `:557-559`) and silently receives nothing. Polling handles 403, 409, 413 and protocol mismatch (`:1731-1799`).

Should be one module: `src/providers/shared/room-envelope.ts` (`buildRoomEnvelope`, `applyRoomEnvelope` with generation, awareness, rows, dispositions, compaction, debug tap, and `restartRoom`), `src/providers/shared/daemon-auth.ts` (`fetchDaemonToken`, `daemonUrl( slug )`), and one backoff helper with a named policy.

**Server.**

| What | Copies |
|---|---|
| Request schema | `get_route_args` (`class-wp-http-polling-sync-server.php:231-328`) vs hand-written `validate_room_request` (`class-wp-websocket-sync-server.php:1524-1618`). Same room pattern at `:299`, `:1530`, `:1346`; same `maxLength 64` for `presence_token` (`:294` vs `:1567`); `MAX_UPDATE_DATA_SIZE` defined twice (`:105` vs `:64`); 50 rooms twice (`:97` vs `:56`). |
| Permission check | `check_permissions` (`:338-386`) vs `check_subscription` (`:1318-1334`). REST returns `WP_Error` with `status`; the daemon's has none. |
| Awareness map (`client_id => state`) | `:906-911`; SSE `stream :377-380`; SSE `awareness_changed :254-257`; daemon `broadcast_room :1636-1639`. Four copies. |
| "Read since cursor, attach awareness, attach generation" | REST `:526-532`; SSE `:375-382`; daemon `:1649-1657`. Three copies. |
| Daemon address | `get_socket_url` (`class-wp-websocket-sync-transport.php:112-129`) vs `get_stream_url` (`class-wp-sync-sse-daemon-transport.php:116-138`). Same setting, same constants, differ by scheme and filter name. |
| SSE frame text | `"event: sync\ndata: "` at `sse-server.php:322` and `sse-connection.php:177`; `": keepalive\n\n"` at `:342` and `:194`. |
| Awareness written twice per stream open | `WP_Sync_SSE_Server::handle_request:104-108` then again inside `process_room_request:492`. The comment at `:97-102` says the second is skipped as unchanged. |

Should be one place: `WP_Sync_Room_Request_Schema`; `WP_Sync_Room_Access::check()` returning one `WP_Error` with `status` and `rooms`; `WP_HTTP_Polling_Sync_Server::read_room( $room, $client_id, $cursor, $context )` returning rows, awareness map and generation, called from `process_room_request`, `stream`, and `broadcast_room`; `WP_Sync_Awareness::map( $room )`; `WP_Sync_Daemon_Address::url( $scheme )`.

### 4. Naming and vocabulary

Mostly consistent. Counts (word-prefix, case-insensitive) across `src` live / `includes` / `tests`: room 860/2107/2735; cursor 139/272/234; row 316/659/823; intent 385/490/1331; proposal 221/261/563; announce 96/65/152; parked 104/54/254; disposition 75/134/587; floor 12/32/52; checkpoint 22/82/84; generation 44/26/34; epoch 1/2/1 (nearly unused); genesis 83/134/548; bootstrap 87/13/94; hydrate 14/0/17 (SPI name only); materializ- 10/36/259; seq 123/90/98; frame 120/189/312; register 167/97/431.

Synonyms for one concept:

- **Stored row.** `row` 659 and `update` 301 in PHP; `update` 331 and `row` 301 in TS. The storage API says "update" (`add_update`, `get_updates_after_cursor`) while its docblocks say "row" (`class-wp-sync-table-storage.php:298-300`). The TS wire type is `SyncUpdate` (`types.ts:34`) but the function that applies them is `applyRoomRows` (`polling-manager.ts:1403`).
- **The advisory "go and poll" message.** Code says `announce` everywhere (`webrtc-link.ts:60`, `websocket-link.ts:42-45`, daemon `:1469`, `announce.ts:28`, `channel.ts:285`, `polling-manager.ts:787`). Prose says "notice" (`channel.ts:26, 281`; `announce.ts:2, 7`; the glossary), "nudge" (`polling-manager.ts:891`; `presence.php:253`; advisory-channel.md), and "announcement" (`settings.php:352, 358` user-facing; `config.ts:129`). "Poke" is not used.
- **The per-tab token.** `presence_token`/`getPresenceToken` (`polling-manager.ts:1271`, `websocket-link.ts:160-167`, daemon `:1264`); "token" and "per-tab token" in presence.php; "tab" in the backends (`gsetab-`); the daemon's roster frame says `token` (`:1452`) while its request frame says `presence_token`; advisory-channel.md:182 says "signaling token".
- **Snapshot / checkpoint / canonical doc.** All three engines use `'snapshot'` as the genesis and checkpoint row type and `'checkpoint'` as the room-meta key; de-rtc also uses "snapshot" for the never-stored fetch answer (`class-wp-de-rtc-engine.php:90`); "canonical" (152 PHP, 118 TS) exists only in prose, no `canonicalDoc` identifier.
- **Reset / generation / epoch.** "reset" is the verb, "generation" the token, "epoch" appears in three comments about a future compaction mode.
- **Bootstrap / hydrate / genesis / join.** "genesis" is server-side first row; "bootstrap" the client's first apply; "hydrate" the SPI no-op (`de-rtc/engine.ts:135, 570`) plus an unrelated `hydrateRawContent` callback (`intent-log-manager.ts:1184`); `bootstrapSlowAwareness` (`src/awareness/index.ts:29`) reuses "bootstrap" for plain startup.
- **A tab attached to a room over a link.** "follower" in the daemon (`:1216-1223`, `:1496`), "subscriber" for sync sockets (`:1414`) and in the JS link (`websocket-link.ts:93, 144`), "discovered peer" in signaling (`signaling.ts:45`), "peer" in the roster frame, `PeerLink` in WebRTC, `Peer`/`PeerReport` in slow awareness.

One name, two meanings:

| name | meaning 1 | meaning 2 |
|---|---|---|
| frame | intent-log region of an edit (glossary; `rebase.js:90-105`, planner 37 hits) | a WebSocket or SSE wire message (daemon 26 hits, `websocket-link.ts:40, 125`); also a seq position ("observed frame", `intent-log-session.ts:433, 499`) |
| register | a synced field (glossary; `intent-log-manager.ts:93-96`) | API registration (`registerSyncEngine`, `src/awareness/registry.ts:34`) |
| version | de-rtc document version (`$state['version']`, `baseVersion`) | the storage per-room change counter (`get_room_versions`, `_version` row) and `DB_VERSION` |
| snapshot | the stored genesis/checkpoint row type | de-rtc's never-stored fetch answer; the SPI `encodeSnapshot` |
| proposal | de-rtc whole-content submission | intent-log's escalated intent awaiting review (`IntentLogProposal`, `intent-log-session.ts:85-92`) |
| announce | de-rtc row type (`class-wp-de-rtc-engine.php:85`) | the advisory channel notice (`announce.ts:28 announceLocalWrite`); `de-rtc/session.ts:388` uses both meanings in one function |
| channel | the advisory channel | its two links, which the setting and `Advisory_Presence::channel()` also call a channel despite `link.ts:18-20`; the slow-awareness channel (`sync`/`heartbeat`); the WebRTC data channel |
| session | the TS per-room engine codec (320 hits) | the daemon's authenticated connection (`:1872`); the diagnostics "session capture" |

Heavily used words the glossary lacks (src live / includes / tests): awareness 233/159/289, presence 93/92/171 (and the difference between them), session 320/81/978, transport, engine, link 229/7/65, channel 141/67/189, codec 46/8/64, replica 90/6/28, claim 10/95/64, stamp 15/76/128, heal 0/16/24, preflight 4/23/3, lane 94/69/120, held/hold 89/70/108 (`heldTails`), kses, ingest, daemon, company (`hasCompany`, `isAlone`, `othersPresent`, `others`), follower, delivery (`DELIVERY_*` constants name the transport-advisory pair; the screen labels it "Transport").

### 5. Dead or vestigial code

81 marker hits in `src` + `includes` (TODO 3, of which 2 are `specsToDocument` matching "sToDo"; legacy 7; retired 10; deprecated 1; "no longer" 6; "used to" 12; "kept for" 3; compat 11; fallback 26). FIXME, XXX, HACK: zero.

**Truly dead or dead by gate.**

- The y-websocket test provider fixture. `tests/e2e/config/rtc-websocket-setup.ts:104` runs only when `GUTENBERG_RTC_TEST_WS_PROVIDER === '1'`; `grep -rn GUTENBERG_RTC_TEST_WS_PROVIDER tests package.json .github` returns only the reader (`:7, :104`) and a comment (`global-setup.ts:9`). The real websocket config sets `GUTENBERG_RTC_REAL_WS` (`playwright.rtc-websocket.config.ts:62`). So `rtc-websocket-setup.ts`, `tests/e2e/plugins/rtc-websocket-provider/` (still mounted at `.wp-env.json:27`), and `tests/e2e/bin/rtc-test-ws-sync-server.mjs` (no script, referenced only by comments at `rtc-dev.mjs:44-50`, `playwright.rtc-websocket.config.ts:14`) are dead.
- The client compaction request lane. `polling-manager.ts:1448-1472` handles `shouldCompact`; every engine returns `'should_compact' => false` (`class-wp-intent-log-engine.php:1231`, `class-wp-de-rtc-engine.php:1758`, `class-wp-yjs-server-engine.php:650`); `grep -rn createCompactionUpdate src` finds only the call site (`:1459`), no implementation. `SyncUpdateType.COMPACTION` (`types.ts:25`) has one consumer, the queue-restore filter (`utils.ts:98`). The request log still stores a `should_compact` column (`request-log.php:432`).
- The typed `syncWhileSolo` extension (see Judgment 1) and its one test use.
- Thirteen `export` keywords with no importer (used only in their own file): `blockIdOf` (`src/awareness/block-id.ts:39`), `identityFromState` (`channels/sync-channel.ts:90`), `awarenessKey` (`registry.ts:29`), `initialsOf`, `nameColorOn` (`ui/presence-badges.tsx:81, 97`), `canonicalizeCoreBlockNames`, `canonicalizeContentForHash`, `getTopLevelBlockRecords` (`de-rtc/descriptor.ts:241, 275, 300`), `valuesEqual` (`de-rtc/record.ts:107`), `engineBlockToBlock` (`intent-log-bridge.ts:395`), `deriveInverses`, `deriveInverse` (`intent-log-undo.ts:107, 141`), `getAdvisoryChannelSlug` (`channel.ts:65`); plus four constants and about 26 interfaces.

**Kept for reference, alive and documented.** `Test_Opaque_Relay_Engine` (loaded by `tests/bootstrap.php:54`, driven by `tests/phpunit/wpSyncEngineRegistry.php`); the `http-long-polling` alias (`settings.php:240, 800`, a live shim); `ADVISORY_LEGACY_WEBRTC = 'web-rtc'` (`settings.php:117, 1024`, tested); `review-manager-decorator` (gone; one comment at `tests/js/framework-review.test.ts:8`); long-polling remnants in SSE (comments only).

**Unreachable but frozen (leave, document).** The de-rtc automerge whole-text lane. `wp_de_rtc_get_automerge_retry_save_result` (`merge-core.php:1211`) reaches the native port only when the update's `format` is not `native-automerge-blocks-v1` (`:1226-1235`); when `$client_update` is null it synthesizes one with that format. The engine calls it with `null` (`:1425`, `:2028`, `identity-merge.php:542`) or a validated descriptor (`:587`), so the `$port->merge` branch (`:1235-1260`) is unreachable from this plugin. Frozen file.

**Live shims still needed.** The storage's non-creating lineage read (`class-wp-sync-table-storage.php:597-600`, framework probes with `method_exists`); the daemon keeping the cookie beside an access token (`:1008-1012`); `is_hash_pinned_unsupported_fallback` (`class-wp-de-rtc-engine.php:840`, older client descriptor shape).

**Comments that only narrate history.** `yjs-server/constants.ts:6-7`, `yjs-server/engine.ts:22`, `yjs-server/undo.ts:44` ("originated in the retired yjs-relay engine"); `http-polling/types.ts:14-15`; `websocket-manager.ts:225` ("the way the retired test WS provider did"); `de-rtc/record.ts:15` ("the job a local Y.Doc used to do"); `de-rtc/doc-bridge.ts:103`; `class-wp-yjs-server-engine.php:13`; `class-wp-websocket-sync-server.php:1555`.

### 6. Comment load

Comment lines as a share of all lines: `polling-manager.ts` 802/2586 (31%), `intent-log-manager.ts` 866/2436 (36%), `intent-log-bridge.ts` 519/1759 (30%), `de-rtc/session.ts` 318/888 (37%), `class-wp-de-rtc-engine.php` 1251/2908 (43%), `class-wp-yjs-server-engine.php` 826/1795 (49%), `class-wp-intent-log-engine.php` 666/1690 (39%), `class-wp-websocket-sync-server.php` 840/2087 (45%), `advisory-presence.php` 701/1382 (54%). PHP docblocks inflate the PHP numbers, but the presence file has more comment than code even after that.

Narrative-history markers in `src` + `includes`: 46 lines ("found by" 13, "used to" 12, "fuzzer" 10, "before this" 6, "no longer" 6, "issue #" 2, "previously" 2). Top files: `intent-log-manager.ts` 7, `class-wp-de-rtc-engine.php` 5, `class-wp-websocket-sync-server.php` 4.

Ten examples with a verdict:

1. `intent-log-manager.ts:186-194` (pre-init buffer, "the fuzzer found it as a reload straddling a block insert"). Keep: it states why the capture is deferred and only-when-empty. Trim the fuzzer sentence.
2. `intent-log-manager.ts:648-653` (serializer emits a VOID comment; "createBlock() is deliberately NOT used"). Keep: a non-obvious negative choice.
3. `intent-log-manager.ts:1364-1371` ("every block duplicates (found by fuzz:quick when this recovery ran synchronously)"). Keep the invariant ("must not run synchronously"), move the discovery to history.
4. `intent-log-manager.ts:1508-1515` ("found by A2's retry-free e2e runs: a table-cell edit burst..."). Move: the rule is in the next sentence; the A2 story is history.
5. `intent-log-manager.ts:2161-2168` (forced push after a deleted remote block; "found by the fuzzer after a peer re-joined"). Keep: explains why a redundant-looking push is required.
6. `class-wp-de-rtc-engine.php:257-268` (the cache must be cleared at the daemon's message boundary; "Found by the post-inversion websocket fuzz"). Keep: documents a caller obligation.
7. `class-wp-intent-log-engine.php:1072-1081` (checkpoint interval 500 because 100 voided burst tails). Keep: justifies a magic number.
8. `class-wp-intent-log-engine.php:1628-1634` (open and close fragments kept apart; "found by the fuzzer's nested-group + save + reload lane"). Keep the rule, move the lane name to the test.
9. `class-wp-websocket-sync-server.php:1756-1762` (the room scan exists because de-rtc commits ride autosave). Keep: without it the scan looks like waste.
10. `de-rtc/session.ts:793-800` ("issue #39, found by the fuzzer's fault injection"). Move: `createRecoveryUpdate` is explained by the two lines above it.

Judgment: about two thirds of the narration is load-bearing because it names an invariant the code depends on and that a reader would otherwise "simplify" away. The pattern to change is not the invariant but the attribution: "found by X on date Y" belongs in `docs/plan/history.md` or in the name of the test that pins it. The AGENTS.md "Gotchas" section already does this well for a few of them; the comments repeat it.

### 7. Error handling and failure paths

PHP totals (includes): `new WP_Error` 87, `throw new` 17, `return false;` 77, `return null;` 75, `is_wp_error` 51, `catch (` 8, `qm/debug` 38, `error_log` 2. TS totals (src live): `throw` 21 (11 in `sse-exchange.ts`), `catch` 37 (29 bare `catch {`), `.catch( () => {} )` 4, `console.error` 1, `console.warn` 1.

Ten representative sites:

1. `class-wp-intent-log-engine.php:325-330`: lock timeout narrated with `qm/debug`, then `return $lock` (a `WP_Error`). The REST layer turns it into a status. Engine style.
2. `class-wp-websocket-sync-server.php:968` and 26 siblings: `WP_Error` in the handshake. But the daemon's `WP_Error`s carry no `status` (`:1322, 1326, 1330`, `:1526-1586`), and `send_error` (`:1700-1717`) forwards only `code`, `message`, `rooms`, so the HTTP status and the 409 payload (`engine`, `engine_protocol`) are lost on the wire.
3. `advisory-presence.php:662-707`: `note_sync_request` and `leave` return `false` three times each for bad token, unknown room, mismatch. No reason reaches the caller or a log.
4. `class-wp-de-rtc-identity-merge.php`: 24 `return null;` meaning "identity declined, use the positional fallback". Deliberate sentinel, documented at `class-wp-de-rtc-engine.php:1383`.
5. `class-wp-sync-redis.php:38, 43`: `throw new RuntimeException`; caught at `sse-server.php:138-140` (fallback plus `qm/debug`) and `redis-notifications.php:139-142` (plugin action). Infrastructure throws, one boundary catches. Consistent.
6. `class-wp-de-rtc-engine.php:714-719`: the announce row failed to store after canonical already advanced. Only a `qm/debug` line; the disposition still says `applied`. Peers converge only when something else makes them fetch. `:1210-1214` and `:1004-1008`: a parked row that fails to store is silently not recorded. `:2112-2124`: the healer's announce row result is not checked at all.
7. `class-wp-de-rtc-base-version-preflight.php:162-168, 204-206, 225-244`: the `WP_Error` is parked in a static `$last_error` and the filter returns `true`; WordPress reports `empty_content`; nothing reads `last_error()`. The person saving sees a generic failure.
8. `class-wp-yjs-server-engine.php:931-933, 972-974`: `catch ( \Throwable $e ) { return null; }` and `{ return false; }` around y-php decode. Silent.
9. `src/engines/de-rtc/session.ts:274-276` (descriptor build), `:395-411` (any commit failure: network, 403, 409 no room, 503), `:482-486` (bad row JSON): all swallowed with no log (confirmed). The commit lane retries forever at 2 s; a permanent 409 (`de_rtc_commit_no_room`) loops silently. `save-base-version.ts:73-77`: a `prepareForSave` throw is swallowed and the save proceeds without the hold.
10. `polling-manager.ts:1418-1423, 1438-1444, 1465-1470, 1848-1853`: `state.log( ..., 'error', true )` (routes to `console.error` via `http-polling-provider.ts:124`). `websocket-manager.ts:310-312` (bare `catch {}` around `receiveUpdate`), `:346-348` (restart handler threw; decision becomes `disconnect`, no log), `:375-377`, `:578`: swallowed. `intent-log-manager.ts:1545 console.error` and `:1717 console.warn` bypass the file's own `log` helper.

Judgment: not one way, but the split follows a rule and is held to on the server: engines and REST return `WP_Error` and narrate through `qm/debug`; infrastructure (Redis, the rich-text parser) throws and is caught at one boundary; presence, storage and identity-merge return `false`/`null`. The non-uniform parts: the daemon's `WP_Error`s lose their status and data on the wire; the presence `false` returns lose the cause where a `WP_Error` would carry it to the REST response; and on the client the same event (a row the session cannot apply, a restart handler that throws) is logged under polling and silent under websocket, while the whole de-rtc commit lane has no logging at all.

### 8. Type safety

**TypeScript (src live, 72 files).** `: any` 12, `as any` 7, `as unknown as` 2, `@ts-ignore` 0, `@ts-expect-error` 0, `Record< string, unknown >` 140, bare `object` 7. Per file (any plus as-unknown plus Record): `intent-log-manager.ts` 28, `intent-log-bridge.ts` 22, `de-rtc/doc-bridge.ts` 21, `de-rtc/record.ts` 13, `debug/inspector.ts` 12, `de-rtc/descriptor.ts` 11.

Hot spots: `de-rtc/record.ts:345-359 identifyEditorBlocks( blocks: any[] ): any[]`, `:129 blocks as any[]`, `doc-bridge.ts:263, 407, 425, 433, 533, 701`, `revert-undo.ts:136, 368`: all Gutenberg `BlockInstance[]`; the `any` exists because `__unstableSerializeAndClean` is untyped; a local `EditorBlock` alias removes all 13. `de-rtc/session.ts:481 let decoded: any`: the parsed row payload; a `DeRtcRowPayload` union is implied at `:491-492`. `intent-log-undo.ts:690 ( settled as any ).reason`: `SettledDisposition` lacks `reason`; add the field. `intent-log-bridge.ts` 22 `Record< string, unknown >` stand in for block attributes; `intent-log-manager.ts` 28 for REST-shaped properties and meta. `de-rtc/engine.ts:623 undoManager as unknown as DeRtcRevertUndoManager` hides that the framework's `UndoManager` and de-rtc's differ. Duck-typed codec extensions: `polling-manager.ts:2301` (`sendsWhileAlone`), `:2385` and `websocket-manager.ts:342` (`TransportSessionCodec` casts), `:315` (`as never` on dispositions).

**PHP (includes, 53 files).** `@param array` 220, `@return array` 144. Per file: `class-wp-de-rtc-engine.php` 39, `class-wp-intent-log-planner.php` 31 (frozen twin), `class-wp-intent-log-document.php` 25 (frozen twin), `class-wp-yjs-server-engine.php` 16, `class-wp-intent-log-engine.php` 14, `class-wp-de-rtc-identity-merge.php` 14. About 30 docblocks use `array{...}` shapes; the rest describe shape in prose or not at all (`@return array<int, mixed> Sync updates.` at `class-wp-sync-table-storage.php:504`; `@param mixed $update Serializable sync update, opaque to the storage.` at `:308`).

Five value objects that would make the flow legible:

1. **Room request and room response.** `process_room_request( array $room_request )` documents keys in prose (`:457-460`), returns `array|WP_Error`, and is driven by three transports. The response shape (`updates`, `awareness`, `dispositions`, `should_compact`, `end_cursor`, `generation`, `_debug`) is rebuilt in each engine's `get_updates_since` and mirrored by `SyncResponse` in TS (`types.ts:97`).
2. **Disposition.** Built as `array( 'status' => ..., 'reason' => ... )` in 32 places (de-rtc 10, intent-log engine 9, yjs 6, planner 4, document 3).
3. **de-rtc room state and announce.** `$state['content'|'version'|'version_seq'|'sync_meta'|'properties'|'properties_by_version'|'healed_hash']` (88 reads); the announce body built twice.
4. **Stored row.** `add_update( string $room, $update )` takes `mixed`, `get_updates_after_cursor` returns `array<int, mixed>`, yet every engine assumes `type`, `data`, `client_id`, and the inspector decodes them. A `Sync_Row` with those fields plus `cursor` would type 659 "row" uses.
5. **Intent-log plan result** (`plan_batch` returns `array( 'rows' => ..., 'headDoc' => ... )`, `class-wp-intent-log-planner.php:1021-1022`). Frozen twin: wrap at the engine boundary, do not change the planner.

Runner-up: the awareness entry `array( 'client_id', 'state', 'user_id', 'timestamp' )` (`class-wp-sync-awareness.php:113-137`), and the daemon's `$clients` entry (Judgment 1).

---

## Part 3. Ranked refactor list

Legend: size S (a day), M (a week), L (several weeks). "Test layer" names the cheapest suite that would catch a regression (the ladder in AGENTS.md). FROZEN means the item touches `src/engines/intent-log/**`, `includes/engines/intent-log/class-wp-intent-log-{planner,document,rich-text}.php` as the cross-language twin, `merge-core.php`, or the vendored libraries, and should NOT be done.

1. **Make the polling manager's state explicit.** Introduce `receiveMode` (`polling | stream-settling | streaming | stream-backoff | hidden-polling | quiet`) and `sendLane` (`idle | scheduled | in-flight`), set in one place; replace `pollAgainRequested`, `repollImmediately`, the `parkAbortedOnPurpose` path and `pollNow()`-clears-timer with one "poll next" request; replace `sendsStarted`/`sendsFinished`/`pollInFlightCounted` with a promise on the lane. Then move the file groups out (`request-builder.ts`, `room-envelope.ts`, `cadence.ts`, `page-lifecycle.ts`, `errors.ts`). Why: 36 module variables and six recomputed predicates are the main reason D is hard to follow, and every SSE and advisory change lands in this file. Size L. Risk medium-high (timing behavior is pinned by many Jest tests, which is also the protection). Test layer: Jest (`tests/js/providers/http-polling/*`, 3000+ lines of cadence tests), then the three SSE and websocket e2e lanes. Not frozen.

2. **Share the room envelope and restart between http-polling and websocket, and fix the two websocket gaps.** One `applyRoomEnvelope()` with generation, awareness, rows, dispositions, compaction, debug tap, logging; one `restartRoom`; one `fetchDaemonToken`/`daemonUrl`. While there: handle the daemon's `type: 'error'` frames in `websocket-manager.ts` and add the connection limit. Why: the two managers are twins by their own comments, and the websocket client currently cannot report a 403 or 409. Size M. Risk low-medium. Test layer: Jest for both managers, `test:e2e:websocket`. Not frozen.

3. **A PHP `WP_Sync_Engine_Base` plus four shared helpers: genesis skeleton, compactor, debug-stash trait, narrate wrapper, error and disposition builders.** Why: the three engines share one skeleton written three times, several blocks byte-identical; the intent-log genesis guard would move to the after-read form, closing the cold-cache trap in Part 1 A. Size M. Risk low (pure extraction; the storage shapes do not change). Test layer: PHPUnit (`test:php`), plus `fuzz:quick`. Not frozen: the planner, document, rich-text, and merge-core files are not touched; only the engine wrappers are.

4. **Split `class-wp-de-rtc-engine.php` along the fourteen jobs, with a shared `WP_De_RTC_Commit` used by ingest, the external-save healer, and the preflight, and value objects for proposal, state, disposition, announce, parked row.** Why: 2908 lines, 300-line `ingest_proposal`, the commit pipeline written twice, 30 of 48 signatures untyped arrays. Size L. Risk medium (the merge order and CAS semantics must stay byte-for-byte; the de-rtc PHP-generated vectors and the announce Jest tests pin them). Test layer: PHPUnit, `tests/js/engines/de-rtc/test-vectors/`, `RTC_E2E_ENGINE=de-rtc npm run test:e2e`. Not frozen: `merge-core.php` stays as the callee.

5. **Surface the de-rtc failure paths.** Log commit failures in `de-rtc/session.ts:395-411` (through the provider logger, with a backoff instead of a flat 2 s retry); read `WP_De_RTC_Base_Version_Preflight::last_error()` on the REST save path and return it as the save error instead of `empty_content`; check the announce-row store result at `class-wp-de-rtc-engine.php:714` and `:2112` and surface a `storage-error` disposition. Why: today a stuck tab looks healthy and a conflicting save looks like an empty post. Size S-M. Risk low. Test layer: Jest (`tests/js/engines/de-rtc/`), PHPUnit. Not frozen.

6. **Fix the small confirmed defects.** `settings.php:918` (`&&` inside `class_exists`); `syncWhileSolo` versus `sendsWhileAlone` (keep one name, type it, fix the test at `polling-manager.test.ts:2931`); de-rtc `createAwareness` without `objectId` and no `destroy()` (`de-rtc/engine.ts:295-298`, `:633-641`); `src/index.ts:41` to import from `framework.ts`; yjs dispositions to carry `intentId`. Size S. Risk very low. Test layer: Jest, PHPUnit. Not frozen.

7. **Split the advisory-presence class into tab presence, signaling mailbox, room lifetime, and a storage peek shared with `derive_room_generation()`; give the tab-token store one code path by making the transient fallback a `WP_Sync_Tab_List_Backend`.** Why: six unrelated jobs, two token code paths, raw SQL that duplicates the transport's, and the transports construct the whole class only for the lifetime rule. Size M. Risk low-medium (room reset is behavior-visible; `docs/plan/room-lifetime.md` and the e2e lifetime specs pin it). Test layer: PHPUnit, default e2e. Not frozen.

8. **One client presence model.** One store keyed by room and client id with three inputs (server awareness map, channel presence, daemon roster) and derived views (the y-protocols awareness, slow-awareness roster, `hasCompany`, coverage); one `pagehide` handler performing the three leave actions; one `createEntityAwareness()` for the engines. Why: one fact is held in four client stores, "anyone else here" is computed in five places, and the transport imports a slow-awareness field name (`polling-manager.ts:829-834`). Size M-L. Risk medium. Test layer: Jest (`tests/js/awareness/`, advisory channel tests), e2e. Not frozen.

9. **Split `intent-log-manager.ts` into properties, baseline (as a class with named phases), recovery, review, collections.** Why: a 715-line and a 331-line function, 26-field state, six implicit phases. Size M. Risk medium (the observed-baseline rules are subtle; the manager Jest tests and the "THE OBSERVED BASELINE" note pin them). Test layer: Jest (`tests/js/engines/intent-log-manager.test.ts`), `RTC_E2E_ENGINE=intent-log`. Not frozen: `src/engines/intent-log/**` is untouched. The larger follow-on, running intent-log on `createSyncManager` so review fan-out, undo wiring and awareness lifecycle come from the framework, is an L-size decision that also needs a framework change (a `SyncEngine` whose `createEntity` returns an intent-log core); worth a design note before any code.

10. **Server transport trio: one request schema, one access check with `status`, one `read_room()` used by REST, SSE and the daemon, one awareness map helper, one daemon address helper; and split the daemon class into loop, handshake, auth, room service, advisory relay with a typed client object.** Why: three copies of the read-and-attach step and two of the schema and permission check are where a protocol change gets missed; the daemon's refusals lose status and data. Size L. Risk medium. Test layer: PHPUnit (daemon unit tests), `test:e2e:websocket`, `test:e2e:sse-daemon`. Not frozen.

Also worth doing, below the top ten: delete the dead y-websocket fixture lane and the compaction-request lane (S, no risk, Jest and e2e); move pure history out of comments into `docs/plan/history.md` (S); add the missing glossary words and rename the advisory `announce` to `notice` where the de-rtc row keeps `announce` (S-M, touches wire field names on the advisory link only); unexport the thirteen unused exports (S).

**Do NOT refactor (frozen):** the intent-log JS core (`src/engines/intent-log/**`) and its PHP twins (`class-wp-intent-log-planner.php`, `class-wp-intent-log-document.php`, `class-wp-intent-log-rich-text.php`), despite their 31 and 25 untyped `@param array` docblocks; `includes/engines/de-rtc/merge-core.php`, including its unreachable automerge whole-text branch; `includes/lib/y-php`, `includes/lib/automerge-php`, `src/engines/yjs-server/y-utilities/`; and the `gutenberg/` subtree (the whole-tree-per-keystroke costs in `crdt-blocks.ts` and `crdt.ts`, and the `createSyncManager` wiring, are framework facts to raise upstream, not to patch here).
