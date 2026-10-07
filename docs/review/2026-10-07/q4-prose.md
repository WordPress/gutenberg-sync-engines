# Q4: Does the prose follow the project's writing rules? Can a novice read it?

Review of `gutenberg-sync-engines` at commit `113c5dab1c`, branch `review/arch`. Read-only. Nothing was run except `grep`, `gh issue list`, and small counting scripts.

## Bottom line

The public-facing prose is good. The internal prose is not.

- `README.md`, `docs/engine-comparison.md` (its first page), `docs/data-flow.md`, `docs/plan/README.md`, `docs/plan/history.md`, `docs/plan/wontfix.md`, and `docs/gutenberg-subtree.md` follow the rules. Short sentences. Main point first. Few invented words. A novice can read them.
- `AGENTS.md` breaks every rule it sets. Sentences average 20.5 words and one runs to 135 words. It has 341 parenthetical asides in 103 paragraphs, 131 em dashes, 9 arrow chains, 32 sentences over 40 words, and 12 bullet paragraphs over 150 words. The longest bullet is 937 words. It uses the project's invented words from line 35 and does not point to the glossary until line 393.
- The settings screen and the REST error messages are mostly plain. Three settings strings use words a site owner cannot know ("escalate for review", "No review lane", "every settle").
- The glossary is plain, but it is incomplete. About 20 invented terms that the docs use often are missing from it, and 4 glossary terms are almost never used.
- The 10 open issues follow the issue rules well. Only one, a human-filed one with no label, breaks the glossary rule, and the rule does not bind reporters.
- A newcomer who starts at `README.md` can understand what the plugin does and can pick an engine. They cannot find out how to see two tabs collaborating without opening files the docs do not point to.

## Method

The measurement script strips fenced code, splits paragraphs on blank lines and bullet starts, and splits sentences on `.`, `!`, `?` followed by a capital letter. Text inside backticks counts as one word. Parentheses were removed before measuring sentence length, so the lengths below are an undercount. "Sample-30" means 30 sentences drawn with a fixed random seed.

| File | Sentences | Mean words / sentence (all) | Sample-30 mean | Sentences > 40 words | Arrows in prose | Parentheses per paragraph | Paragraphs > 150 words |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AGENTS.md | 311 | 20.5 (max 135) | 24.6 | 32 | 9 | 3.31 | 12 (largest 937) |
| README.md | 69 | 14.8 | 16.1 | 1 | 1 | 1.06 | 0 |
| CONTRIBUTING.md | 15 | 12.9 | 12.9 | 0 | 0 | 0.90 | 0 |
| CHANGELOG.md | 177 | 17.8 | 16.2 | 7 | 11 | 1.76 | 2 |
| docs/README.md | 17 | 20.8 | 20.8 | 0 | 13 | 1.07 | 0 |
| docs/engine-comparison.md | 191 | 17.3 | 16.6 | 7 | 0 | 0.74 | 3 |
| docs/transports.md | 139 | 19.7 | 19.0 | 6 | 5 | 1.03 | 3 (largest 383) |
| docs/data-flow.md | 84 | 13.7 | 13.9 | 0 | 0 | 0.33 | 0 |
| docs/scenarios.md | 97 | 16.7 | 14.7 | 1 | 0 | 0.55 | 1 |
| docs/principles.md | 22 | 18.1 | 18.1 | 0 | 0 | 0.88 | 0 |
| docs/architecture-decisions.md | 21 | 20.6 | 20.6 | 0 | 0 | 2.40 | 0 |
| docs/de-rtc-fidelity.md | 10 (+ table) | 21.3 | 21.3 | 0 | 2 | 0.50 | 0 |
| docs/glossary.md | 58 | 18.1 | 17.3 | 1 | 0 | 0.68 | 0 |
| docs/sse-daemon.md | 47 | 18.9 | 17.5 | 0 | 0 | 0.12 | 0 |
| docs/awareness-high-latency.md | 62 | 18.8 | 17.4 | 0 | 2 | 0.57 | 1 |
| docs/entity-sync-adapter.md | 44 | 11.6 | 11.7 | 0 | 0 | 0.21 | 0 |
| docs/gutenberg-subtree.md | 38 | 10.1 | 9.8 | 0 | 0 | 0.07 | 0 |
| docs/plan/README.md | 51 | 15.0 | 14.6 | 1 | 0 | 0.33 | 0 |
| docs/plan/advisory-channel.md | 211 | 18.3 | 18.6 | 8 | 3 | 1.19 | 2 |
| docs/plan/history.md | 56 | 16.0 | 15.9 | 1 | 0 | 0.14 | 0 |
| docs/plan/room-lifetime.md | 50 | 17.5 | 16.0 | 1 | 2 | 0.81 | 0 |
| docs/plan/wontfix.md | 47 | 16.2 | 17.0 | 0 | 0 | 0.09 | 0 |

The ASD-STE100 target is about 20 words for a procedural sentence and 25 for a descriptive one. Most docs sit under that. `AGENTS.md` sits over it, and its tail is the problem: 32 sentences over 40 words.

## Scorecard per document

Scale: 1 is poor, 5 is good. "BLUF" asks: does the first paragraph tell the reader the main point?

| Document | Plainness | BLUF | Jargon density | Novice-ready | Evidence |
| --- | --- | --- | --- | --- | --- |
| README.md | 4 | 5 | Low | 4 | First two paragraphs say what the plugin is and that it is "a decision tool, not a solution". Engine bullets explain CRDT and three-way merge in plain words. Two weak spots: the "Architecture" section ("Both axes are independent registries with a client/server handshake... any mismatch degrades to a post lock rather than corruption") and the 2,500-character one-line console script under "Testing by yourself". |
| CONTRIBUTING.md | 5 | 5 | None | 5 | Short. Says what it needs to say. |
| SECURITY.md | 5 | 5 | None | 5 | Two sentences and a link. |
| AGENTS.md | 1 | 3 | Very high | 1 | See the section below. The "What this is" section is a 937-word bullet. |
| CHANGELOG.md | 3 | 4 | Medium | 3 | The header states the rule. Most entries are understandable. Several entries name internal classes and filters with no explanation of what changes for a site owner. See the CHANGELOG section. |
| docs/README.md | 4 | 4 | Low | 4 | Good index. One stale claim about `plan/`. Every bullet is written as an arrow chain. |
| docs/engine-comparison.md | 3 | 5 | Medium to high | 3 | Best BLUF in the repo: "Short answer: start with intent-log". The first 75 lines are plain. The tables and the "Known gaps" section are dense and use undefined words (see quotes). |
| docs/transports.md | 3 | 4 | Medium | 3 | Table first, good. Then a 383-word paragraph on the version counter. |
| docs/data-flow.md | 5 | 5 | Low | 5 | The best novice document. Defines room and row in one sentence each before using them. |
| docs/scenarios.md | 3 | 4 | High | 2 | Assumes the glossary. "Capture then waits for the typing to fall quiet", "writes typed edits into the outbox". |
| docs/principles.md | 4 | 5 | Medium | 4 | Clear statements. "launder a script tag", "read-modify-writes a post" are metaphor and verbed noun. |
| docs/architecture-decisions.md | 2 | 3 | High | 2 | "opaque `EngineUpdate` envelopes over rows-after-cursor", "save-centric semantics were squeezed into poll-cadence proposals". |
| docs/de-rtc-fidelity.md | 2 | 3 | Very high | 1 | Written for the DE-RTC author. Table cells of 60+ words. The closing paragraph is excellent and should be at the top. |
| docs/glossary.md | 4 | n/a | Low (by design) | 4 | Definitions are plain. Some lean on other glossary words ("Escalate — refuse to merge automatically and park the edit instead"). |
| docs/sse-daemon.md | 4 | 4 | Medium | 3 | Mostly plain. "framing" is used 9 times and never defined. |
| docs/awareness-high-latency.md | 4 | 5 | Low | 4 | Problem stated first, then the fix. |
| docs/entity-sync-adapter.md | 4 | 4 | Medium | 3 | Short sentences. Assumes the reader knows core-data. |
| docs/gutenberg-subtree.md | 5 | 5 | Low | 4 | Shortest sentences in the repo (mean 10 words). |
| docs/plan/README.md | 5 | 5 | None | 5 | The rules it states are followed in its own text. |
| docs/plan/advisory-channel.md | 3 | 4 | Medium | 3 | "The rules, stated plainly" section is plain. The surrounding sections are design notes. |
| docs/plan/history.md | 5 | 5 | Low | 5 | A model for the rest. "If you are ever tempted to add a document-sized field to that channel, this is the history that says do not." |
| docs/plan/room-lifetime.md | 4 | 5 | Low | 4 | Question first, options, decision. |
| docs/plan/wontfix.md | 5 | 5 | None | 5 | Each item says why it is waiting. |

## AGENTS.md against its own rules

The file is written for agents. It is also the only operations manual. It is 1,115 lines. The "Language" section at its top asks for "clear, short sentences as if explaining things to a less-technical friend", no jargon, no "abstract structural metaphors or shorthand arrow chains", and "as concise as possible".

Measured:

- Sentence length: mean 20.5 words, median 17, maximum 135. Sample of 30: mean 24.6 words; 12 of 30 over 25 words; 6 of 30 over 40 words. Across the whole file, 32 sentences over 40 words and 5 over 60.
- Parenthetical asides: 341 opening parentheses in 103 paragraphs, 3.31 per paragraph.
- Arrow chains in prose: 9 (lines 201, 286, 287, 366, 434, 512, 795, 813, and one inside a code comment). Three are the UI path "Settings → Collaboration". Six are shorthand: "`src/index.ts` → `build/sync-engines.js`", "`@wordpress/sync`→`wp.sync`", "capture→sanitize→replay", "fast → slow", "copy → Playwright 'two instances' error".
- Em dashes: 131. Many join two sentences that should be separate.
- Capitalized emphasis words: ONLY (6), ONE (5), FIXED (4), REAL (3), BEFORE (3), TESTS (3), EVERY, BASE, WHOLE, VERBATIM, ZERO, and more. Capitals replace structure.
- Bullet paragraphs over 150 words: 12. Sizes: 937, 700, 556, 384, 314, 268, 249, 231, 221, 159, 154, 153. The 937-word one is the "Transports" bullet in "What this is". The 700-word one is "The transport-specific e2e suites live here" in Testing.
- Invented words before the glossary is named: "room" and "canonical" at line 35, "materialize" at line 37, "awareness" at line 65, "cursor" at line 73, "lane" at line 142, "genesis" at line 213. The glossary is first mentioned at line 393, in the list of docs. The word "lane" is used for ten different things (review lane, presence lane, daemon lane, commit lane, property lane, relay lane, fixture lane, websocket lane, whole-text lane). The glossary defines only "review lane".
- Metaphors the Language section forbids: "sits beside it", "rides the heartbeat", "lands rows", "fenced", "the PHP-memory cliff", "healed", "wire-chasing", "a stale tab speaking yesterday's engine", "the price of the design".

### The ten hardest passages (verbatim)

1. Line 109 area, "Transports" bullet, one sentence of 60 words:
   > "A stream the web tier serves keeps a PHP worker up for as long as the tab lives, so `sseStreaming()` is false while `document.visibilityState` is hidden, and `handleVisibilityChange` drops the stream on hide through the deliberate-abort path (`abortParkedStream()` then `sseExchange.close()`, as `handlePageHide` does, so no failure is logged or backed off); the tab then receives over ordinary requests under short polling's own rules (the background cadence, `POLLING_INTERVAL_BACKGROUND_TAB_IN_MS`, with the channel left off) and polls at once on return, which reopens the stream."

2. "Transports" bullet, the SSE wake sentence, 53 words with a parenthesis of 50 more words inside it:
   > "SSE uses normal PHP requests: one held worker per stream, woken by Redis Pub/Sub notices when `WP_SYNC_SSE_REDIS_URL` is set or a Redis object cache is detected (`WP_REDIS_*` constants), and otherwise by half-second checks of a per-room VERSION COUNTER (`WP_Sync_Table_Storage::get_room_versions`, bumped atomically on every storage write; in the object cache when persistent, else a `_version` room-meta row; snapshot taken BEFORE each read; awareness held by the Presence API bumps no counter, so each check then also reads the stream's rooms' awareness and compares it with what was last sent — `awareness_changed()`; the Presence API backend fires `gutenberg_sync_engines_room_changed` itself, so Redis notices still go out) through `WP_Sync_Storage_Change_Waiter`, the retired long-polling transport's wait; a storage without counters is read the long way."

3. "de-rtc known gaps", the opening sentence, 135 words:
   > "every block carries a durable `metadata.syncId` (intent-log's scheme; `WP_De_RTC_Block_Identity` stamps genesis deterministically and engine-unaware writers' blocks, `adopt()` lines an id-less copy up with its base by path, and the editor-side stamper in `includes/shared/sync-id.js` serves de-rtc too) and `WP_De_RTC_Identity_Merge` three-way merges by that identity at every depth BEFORE the frozen positional core (which stays the fallback whenever identity declines: id-less blocks, classic content between blocks, irregular containers); parked rows carry `syncId` + `path` beside `index`, the client restores/contests/anchors by syncId (`DeRtcContestKey`), `blockBaseVersions` keys may be syncIds, kses sequestration (`WP_De_RTC_Identity_Merge::sequester`), authorship (`getBlockAuthorshipById`) and revert-undo all work by identity at every depth with the positional rules as the id-less fallback; truly concurrent SAME-block edits merge from their TRUE base (`blockBaseVersions`) or raise a contested pending item (Adopt/Reject) — the old silent client-side block LWW is retired; ..."

4. "Storage" bullet:
   > "On a host with a persistent object cache (`wp_using_ext_object_cache()`) the storage follows the strategy the WordPress hosting tests recommended (`custom-table-with-transients`, wordpress-develop#11599): awareness in the room array (the fallback when the Presence API is not recording, see Awareness below) lives ONLY in the object cache (group `WP_Sync_Table_Schema::CACHE_GROUP`, never a row), and the two write-once keys (engine lineage, the polling transport's generation token) are cached after their first read; `reset_room()` drops the cached copies."

5. Testing, the transport-specific suites, 70 words:
   > "`tests/e2e/specs/websocket-only/` runs only under `test:e2e:websocket`, which since the V1 A3 rework runs against the plugin's REAL websocket transport: `playwright.rtc-websocket.config.ts` launches `tests/e2e/bin/rtc-real-ws-daemon.mjs` as a second webServer, which selects the websocket transport on the tests site, publishes the `wp collaboration sync-server` PHP daemon from the tests env's cli image on host port 8787 (health-checked on the daemon's own /health), and restores the previous transport at teardown."

6. Repo layout, automerge-php, 58 words:
   > "FULL parity needs the fixed GB11 grapheme rules of PCRE2 ≥ 10.43 — a property of the PCRE2 library PHP LINKS, not of the PHP version: PHP 8.4 bundles 10.44, but distro-style builds (Ubuntu 24.04 packages, and since 2026-09-03 setup-php's PHP 8.4 on GitHub runners) link the system libpcre2 10.42, under which two adjacent emoji-ZWJ sequences count as ONE `\X` cluster and exactly 2 of the 680 tests fail (grapheme cursor tracking + a UTF-16-boundary splice)."

7. Gotchas, slow awareness, 61 words:
   > "Under the Heartbeat channel the block name is a field on the advisory channel's discovery probe (`block`), kept on the tab's presence token by `Gutenberg_Sync_Engines_Advisory_Presence` and answered back with each peer's name and avatar, so it needs an advisory channel selected; the plugin also SETS the admin Heartbeat interval on post edit screens, so the probe's cadence follows the awareness interval."

8. Known issues, intent-log, 83 words with a parenthesis that opens a new topic:
   > "FIXED: an edit made DURING the join round trip used to stay local forever on an empty-genesis room (found 2026-08-17 as a reload straddling a block insert — update() dropped pre-init trees and the empty-genesis bootstrap pushes nothing that would reconcile). update() now buffers the latest pre-init tree and an empty-genesis bootstrap captures it via a DEFERRED recovery that runs only if the document is still empty after the delivery burst — a rejoiner's history replays right behind the genesis row, and capturing against the bare genesis baseline would duplicate every saved block (fuzz:quick caught the synchronous variant)."

9. Known issues, de-rtc:
   > "Since protocol 2 the transport carries ADVISORIES, not documents: accepted proposals broadcast ~200-byte `announce` rows (version + canonicalized content hash + merged property registers); canonical content lives once per room in a CHAINED options row (`swap_prefixed` — writers CAS against their predecessor's sequence prefix, so canonical persistence can never regress), and a behind client's `fetch` row is answered with one synthesized, never-stored snapshot."

10. "What this is", first paragraph:
    > "The framework itself lives in Gutenberg core (`@wordpress/sync` client + the `lib/experimental/collaboration/` server): it is a generic, engine-neutral substrate — a `createSyncManager` shell, two registries (engines + transports) with client/server negotiation, the `SyncEngine` SPI, and a shared `Y` export (`wp.sync.Y`)."

### Three rewrites in the plain style

**Passage 1, hidden tabs under SSE.** Original: one sentence, 60 words, four parentheses. Rewrite:

> A stream served by the web tier holds one PHP worker for as long as the tab is open. So a hidden tab drops its stream. `handleVisibilityChange` closes it the same way `handlePageHide` does: `abortParkedStream()` and then `sseExchange.close()`. This is a deliberate close, so nothing is logged and no backoff starts. While hidden, the tab polls on the slow background timer (`POLLING_INTERVAL_BACKGROUND_TAB_IN_MS`) with the advisory channel off. When the tab becomes visible, it polls once and the stream opens again.

Seven sentences. Longest is 22 words. Same facts.

**Passage 4, storage on a host with an object cache.** Rewrite:

> On a host with a persistent object cache, the storage keeps two kinds of data out of the database. First, presence (who is in the room) is kept only in the object cache, never in a table row. This applies to the fallback presence store; the Presence API store is described under Awareness. Second, two values that are written once per room, the engine name and the generation token, are cached after their first read. `reset_room()` clears both from the cache. This follows the strategy the WordPress hosting tests recommended (`custom-table-with-transients`, wordpress-develop#11599). The cache group is `WP_Sync_Table_Schema::CACHE_GROUP`, and the check is `wp_using_ext_object_cache()`.

**Passage 10, what the framework is.** Rewrite:

> The framework lives in Gutenberg. Its client is the `@wordpress/sync` package. Its server is `lib/experimental/collaboration/`. It does not know about any particular engine. It provides four things: a sync manager (`createSyncManager`), a registry of engines and a registry of transports that the client and server agree on at startup, the `SyncEngine` interface that an engine implements, and the Yjs library as `wp.sync.Y`.

### A structural note on AGENTS.md

The file mixes three documents: a product description ("What this is", about 230 lines), an operations manual (Setup, Environment, Testing, Diagnostics, Gotchas, about 500 lines), and a changelog of fixed bugs ("Known issues", about 250 lines, much of it marked FIXED). The "Known issues" section repeats material from `CHANGELOG.md`, `docs/plan/history.md`, and `docs/engine-comparison.md`. Each of those files is plainer than the copy in AGENTS.md. Pointing to them instead of repeating them would remove about 400 lines and the five longest sentences.

## docs/*.md and docs/plan/*.md

### What works

- `docs/data-flow.md` defines its two terms before using them: "A **room** is one shared document, usually a post. A **row** is one stored entry in a room's history." No other doc does this.
- `docs/engine-comparison.md` opens with a one-paragraph answer a novice can act on.
- `docs/plan/history.md` and `docs/plan/wontfix.md` state a decision and its reason in two short paragraphs each.
- `docs/plan/README.md` is the clearest statement of the project's writing rules, clearer than the AGENTS.md Language section.

### Hard passages in docs (verbatim)

- `docs/engine-comparison.md`, feature parity table, "Refresh/offline recovery" cell for yjs-server, 90 words in one cell: "Solo edits go out one request after the first queued update — REQUIRED here, not an optimization: a page reload holds no local state to upload, so a room that never saw the solo session's updates would bootstrap the editor back to its stale snapshot, wiping the freshly loaded record (e2e-covered: the solo save-and-reload spec)".
- `docs/engine-comparison.md`, History compaction cell: "live-authoring-sized: coarse captures cost ~3 rows per keystroke, and a trim crossing mid-burst voided the burst's tail — V1 A15". "V1 A15" is a retired internal ticket number.
- `docs/engine-comparison.md`, Known gaps: "Sessions author block-native descriptors: every session proposal carries hash-pinned tamper evidence the server validates once against the plain declared base, then drops before the kses/salvage lanes."
- `docs/transports.md`, the version-counter paragraph is 383 words. One sentence inside it: "The bump is an atomic increment (Redis and Memcached increment in place; the row update is one statement MySQL serializes), and that is what carries the guarantee: if two writers could each turn 5 into 6, a stream whose snapshot fell between their bumps would not wake for the second write until its next catch-up read."
- `docs/architecture-decisions.md`: "The framework's session protocol (opaque `EngineUpdate` envelopes over rows-after-cursor) was inherited from the relay era and imposed on every engine."
- `docs/de-rtc-fidelity.md`, one table cell: "Contested-only pending: a peer's edit landing on a block you are editing raises ONE merge-not-stack pending item resolved by explicit Adopt/Reject. And the commit lane IS the save lane: sessions commit through the autosave endpoint (real saves through the base-version preflight, settle-and-held), the transport carries no proposals at all — advisory announces, on-demand snapshots, review rows, presence."
- `docs/scenarios.md`, scenario A: "Capture then waits for the typing to fall quiet — a deliberate delay that core-data's update ordering forces on us. It compares the editor's blocks against the document state those blocks reflect, and writes typed edits into the outbox at that position in the log." Three glossary words (capture, outbox, log position) in two sentences, no link to the glossary.

### Stale or inconsistent statements found while reading

- `docs/README.md` says: "**See what we plan to build next** → [plan/](plan/README.md) — one file per bug or feature, written in plain language with an example and a way to tell when it is done." `docs/plan/README.md` says the opposite: "Work lives in GitHub Issues." The folder holds reasoning files, not one file per bug.
- `README.md` setup says `cd gutenberg && npm ci --ignore-scripts`. `AGENTS.md` says `npm install --ignore-scripts`. `docs/gutenberg-subtree.md` says `npm ci --ignore-scripts`. Two of three agree; a newcomer will notice.
- `README.md` "Architecture" points at "Gutenberg's `prototypes/sync/ARCHITECTURE.md`". The file exists at `gutenberg/prototypes/sync/ARCHITECTURE.md`, but the README does not say it is inside this repo's `gutenberg/` folder.
- `docs/plan/advisory-channel.md` lists "The advisory channel can be established in three ways" and then marks both 1 and 2 as "(default, `webrtc-advisory`)". It also says "The screen shows them as one 'Transport' list of five entries". The settings file lists six entries (polling, polling with WebRTC, polling with WebSocket, server-sent events, server-sent events via the daemon, WebSocket).
- `docs/engine-comparison.md` "Known gaps" for intent-log ends with "AGENTS.md lists the rest of the residuals." A decision guide should not send a reader to the agent manual.

### Glossary review

The glossary header says: "Docs and code comments use these terms freely." Its definitions are plain. Four definitions use other glossary words without a link: "Escalate — refuse to merge automatically and park the edit instead"; "Disposition — ... applied, parked for review (escalated), or thrown away (voided)"; "Review lane — the whole path a parked edit travels"; "Replan — recompute what the screen should show from the confirmed document plus the outbox". That is fine for a glossary, but each should be a link, since a reader lands on one entry from a search.

**Terms the docs use that the glossary lacks.** Counts are occurrences across `docs/`, `docs/plan/`, and `README.md`, excluding the glossary itself.

| Term | Count | Where it is used without a definition |
| --- | --- | --- |
| stream / receive stream | 110 | transports.md, sse-daemon.md, AGENTS.md. "receive stream" is never defined. |
| canonical (content, doc) | 36 | engine-comparison.md, scenarios.md, architecture-decisions.md. The issue rules table translates it ("the official copy on the server") but the glossary has no entry. |
| proposal / propose | 23 | engine-comparison.md, scenarios.md. Core to de-rtc and never defined. |
| CAS / compare-and-swap / `WP_Sync_Atomic_Option` | 19 | engine-comparison.md, CHANGELOG.md. |
| wire / wire format | 16 | engine-comparison.md ("what travels over the wire"). |
| unit (an undo unit) | 14 | engine-comparison.md, AGENTS.md. |
| solo / alone / company / "company cadence" | 48 combined | advisory-channel.md, transports.md, AGENTS.md. "company" as a noun for "another person present" is the project's own usage. |
| lane (commit, save, kses, property, presence, descriptor, capability, ingest, daemon) | 10+ distinct uses | AGENTS.md, engine-comparison.md, de-rtc-fidelity.md. Only "review lane" is defined. |
| quiet / wake | 15 | advisory-channel.md, transports.md, CHANGELOG.md ("Alone means quiet"). |
| sync-meta / co-location / write-through | 16 | de-rtc-fidelity.md, engine-comparison.md. |
| kses / kses lane / sanitize-and-compensate | 7 | engine-comparison.md. A WordPress reader knows `wp_kses`, but "kses lane" is invented. |
| base version | 4 | engine-comparison.md, data-flow.md. Central to de-rtc. |
| three-way merge | 6 | README.md defines it in passing; the glossary does not. |
| head cursor | 4 | advisory-channel.md. The glossary has "Head-cursor check" but not the noun. |
| hidden tab / background cadence | 5 | transports.md, AGENTS.md. |
| framing | 9 | sse-daemon.md only. Used as "a second framing of the receive stream". |
| probe (discovery probe) | 5 | AGENTS.md, advisory-channel.md. |
| floor (a room's floor) | 4 | AGENTS.md, engine-comparison.md. |
| envelope (room envelope, `_debug` envelope) | 4 | transports.md, AGENTS.md. |
| seam (storage seam, backend seam) | 3 | CHANGELOG.md, AGENTS.md. |
| fence / fenced | 3 | AGENTS.md ("the strict fence", "fenced here"). |
| save lane / commit lane | 3 | AGENTS.md, de-rtc-fidelity.md. |
| SPI | 3 | AGENTS.md, architecture-decisions.md. |
| scenario (A to G) | 30 | Used as a proper noun ("scenario F") across docs. Defined only by scenarios.md's existence. |
| epoch compaction | 2 | AGENTS.md, engine-comparison.md. |
| late joiner / cold join / rejoin | 8 | engine-comparison.md, AGENTS.md. |
| machine writer / engine-unaware writer / out-of-band write | 8 | engine-comparison.md, scenarios.md. |

**Glossary terms almost never used in docs** (zero to two occurrences outside the glossary):

| Term | Occurrences in docs | Note |
| --- | --- | --- |
| Unsaved-changes policy | 0 | The docs and settings say "Unsaved changes" setting. The glossary word "policy" is nowhere else. |
| Seq | 0 in docs (2 in AGENTS.md) | Code term. |
| Replan | 0 in docs (2 in AGENTS.md) | Code term. |
| Head-cursor check | 2 (advisory-channel.md) | Defined, barely used. |
| Observed baseline | 1 (engine-comparison.md) | Points to a comment in `intent-log-manager.ts`. |
| Sequester | 1 (plan/README.md, as an example of a word not to use) | The code uses it; the docs say "held back". |
| Log-shaped engine | 2 | transports.md and architecture-decisions.md. |
| LWW | 2 | engine-comparison.md and architecture-decisions.md. |

Keep these; the glossary also serves code readers. But the gap list above matters more: the words a reader meets most often ("stream", "canonical", "proposal", "lane", "company") are the ones with no entry.

## CHANGELOG.md

The header says who it is for and what belongs in it. Entries under "Unreleased" and "0.0.2" are mostly understandable by a site owner. Three problems:

1. Several entries speak to a developer who already knows the code. A site owner upgrading cannot act on them. Examples: "Awareness gained a drop-in backend seam, the third after the lock and the compare-and-swap: implement `WP_Sync_Awareness_Backend` and return it from the `wp_sync_awareness_backend` filter." And: "A lone editor's updates are held in the browser until company arrives, a save (they are flushed through the room first, so a reload never bootstraps from a room that missed them), or the tab going hidden; meanwhile the tab schedules no polls. De-rtc is exempt (its codec declares `sendsWhileAlone`); the engines' `syncWhileSolo` capability is gone." The second entry is a behavior change a site owner would notice (a lone editor's changes stay in the browser), but it is written so that only a developer can tell.
2. Two entries are over 150 words (182 and 159). The SSE entry packs the transport, the wake mechanism, the hidden-tab rule, the `rows_received_separately` field, and the wp-env hooks into one bullet. A site owner needs the first sentence and the proxy warning.
3. The 0.0.1 section has three "### Added" headings and two "### Changed" headings, interleaved. The reader cannot tell which is the list of additions.
4. The "Pre-release history" section uses internal names: "V1 loop", "DE-RTC Stage 2", "The websocket e2e suite now runs against the real websocket transport". These mean nothing to someone installing a zip.

Arrow use: 11, all "Settings → Collaboration". That is a UI path, not a reasoning chain. Acceptable, but the AGENTS.md rule does not carve out the exception, so either the rule or the usage should say so.

## User-facing strings

### Settings screen (`includes/admin/class-gutenberg-sync-engines-settings.php`)

Plain and good:

- "Unsaved edits are discarded (after confirmation). The next editor continues from the saved post."
- "0 keeps the built-in awareness (live cursors). Any other value replaces cursors with block presence: once per interval each editor names the block it is in, and other editors see an outline and an avatar on that block."
- "Real-time collaboration is turned off, so these settings have no effect yet. Enable the Real-time collaboration experiment on the %s screen."
- The "Test" button messages: "Connected to %s.", "No answer from %s within five seconds.", "Could not connect to %s from this browser."

Not plain. These are the engine descriptions, which a site owner reads to make the one decision the plugin asks of them:

- Line 281: "Concurrent edits merge by operational transform. Conflicts escalate for review." "Operational transform" and "escalate" are undefined. Plain version: "The server combines everyone's changes. When two people change the same thing, it sets the change aside for someone to look at."
- Line 282: "Concurrent edits merge silently via a conflict-free algorithm. No review lane." "Review lane" is a glossary word. Plain version: "The server combines changes automatically, even when two people change the same thing. The later change wins and nobody is told."
- Line 283: "Editors propose revisions against a base version and the server conducts a three-way merge. Conflicts escalate for review." Plain version: "Each editor sends the whole post and says which version they started from. The server combines it with the current version. When two people change the same block, it sets the change aside for someone to look at."
- Line 536: "DE-RTC commit cadence in seconds (0 = every settle)". "Settle" is a glossary word. This is the REST description of the option, so a developer sees it more than a site owner, but it is still the only description.
- Line 737: "The base polling interval. When an advisory channel is connected, the interval raises to <code>25</code> seconds." "Advisory channel" is a glossary word, and it appears in the "Transport" radio labels too ("Polling with a WebRTC advisory channel (default)"). The radio help text explains it indirectly: "Peers connect to each other to share announcements and poll for updates only when needed." That sentence should lead, and "advisory channel" should follow it or be dropped.
- Line 337: "Receives updates over an HTTP stream held open by the server, one PHP worker per stream. Streams wake on Redis notices when a Redis address is configured or a Redis object cache is in use, and by checking a per-room version number every half second otherwise." Accurate. A hosting operator can act on it. A site owner cannot, but this transport is for operators.
- Line 718: "When using the DE-RTC sync engine, the transport only carries peer presence information." "Peer presence information" means "who else is editing". Say that.

### Admin notices

Both are good. The storage one says what happened, what the cause may be, what the plugin does meanwhile, and the exact command to fix it: "Gutenberg Sync Engines could not create its collaboration storage tables (the database user may lack the CREATE TABLE privilege). Real-time collaboration is running on the slower post-meta storage until they exist; run "wp collaboration storage install" once the privilege is granted."

### REST and engine errors (`new WP_Error(`, `__(`)

Mostly plain and short: "Request body is too large.", "Client ID is already in use by another user.", "Collaboration is not enabled.", "This document is too large for real-time collaboration."

Not plain:

- "Sync engine mismatch for room %1$s: the room requires engine %2$s." A user sees this when a tab was opened under a different engine. It should say what to do: reload.
- "The given base seq is outside the room's retained window. Re-read the post and retry against its current state." "Base seq" and "retained window" are internal. The second sentence is good.
- "Clients may only send intent, cancel, or resolution updates to an intent-log room." / "Clients may only send proposal or fetch updates to a de-rtc room." / "Clients may only send update rows to a yjs-server room." These are developer errors and will not reach a site owner. Fine.
- "This collaboration room has grown past its size ceiling; further updates are rejected. Save the post and start a fresh session." Good: it says what to do.
- "Distributed Editing could not merge this save: the document changed under the given base version. The conflicting content was set aside for review." Good.
- The websocket daemon errors are terse and untranslated ("Access token from the future.", "Reserved bits must be zero."). They go to the daemon log, not the screen. Fine.
- Twelve of the messages use the `gutenberg` text domain; the settings screen uses `gutenberg-sync-engines`. Not a prose issue, but translators will notice.

### Conflict-review UI strings in `src/`

`grep -rn "__(" src` finds one translated string in the plugin's own client: "Anonymous User" in `src/awareness/ui/presence-badges.tsx`. The review panel, cards, and notices live in the Gutenberg subtree (`packages/editor` and `packages/core-data`), not in `src/`. The plugin's client sends data to that panel; it owns no review strings. `src/engines/intent-log-manager.ts` calls `createErrorNotice` with a computed message; its text was not sampled. The task's premise (review UI strings in `src/`) does not hold, so no finding here. The subtree panel strings were out of scope.

## Code comments

A subagent sampled 15 comment blocks of 8 or more lines from `src/` and `includes/`, skipping vendored code. Result: 10 explain why in words a newcomer can follow; 5 narrate history or lean on invented words. The 5 cluster in the engine headers (de-rtc and intent-log). Transport and storage comments are the clearest. Across 18,964 non-vendored comment lines: 56 contain the arrow `→`, 4 contain `->` in prose, 10 mention "fuzzer", 3 mention "issue #", none mention "PR #" or "V1". So the problem in comments is vocabulary and sentence length, not history references.

Five that explain why, plainly:

1. `src/providers/http-polling/polling-manager.ts:2308-2338`. "Connection limits are enforced on the first entity to be loaded for sync. This is an inelegant solution to a hard problem: This sync provider and the sync package in general intentionally have no knowledge of the individual entities being synced. Let's say a user opens a document (Entity A) for editing. If you asked the user what they are doing, they would reply 'I'm editing Entity A.'" A worked example, a stated limit, a possible improvement.
2. `includes/storage/class-wp-sync-table-schema.php:10-38`. "The framework's default storage keeps both as post meta on a hidden post per room, which makes every collaboration write invalidate post caches. This plugin keeps them in two dedicated tables instead". Problem, then fix.
3. `includes/transports/class-wp-http-polling-sync-server.php:739-773`. "Two checks, both failing with 409 `rest_sync_engine_mismatch`: 1. Client stamp: ... A stale tab speaking yesterday's engine is fenced here, before any of its updates are stored." Numbered, each with a reason.
4. `src/providers/sse-daemon/sse-daemon-provider.ts:72-86`. "The send queue, recovery, presence and cursor handling are the polling manager's, unchanged — only the endpoint and the credential differ." Says what is shared and what differs.
5. `includes/transports/websocket/class-wp-websocket-sync-server.php:572-586`. "The listener cannot know which framing a connection wants until the request head is read, so every socket starts as a WebSocket candidate". The constraint comes first.

Five that narrate history or assume the author's vocabulary:

1. `src/engines/de-rtc/engine.ts:124-169`, one sentence of 50 words with three nested parentheses: "Conflict review: a proposal the server escalates parks as a durable `parked` row; the entity's review registry presents it through the framework's review surface (panel, notices) via the engine's `review` source (createSyncManager drives the handlers and the resolution verbs from it), and a reviewer restores (overlaying the parked blocks as an ordinary local edit under their own capability, which re-proposes) or dismisses it."
2. `includes/engines/de-rtc/class-wp-de-rtc-autosave-commits.php:9-32`. Opens with an invented project name and two unsourced slogans: "The Save/Sync inversion's commit carrier: de-rtc sessions commit through the ordinary WordPress autosave endpoint instead of transport rows — 'Save is the only commit primitive … wp_update_post / REST, autosaves included', 'Pseudo-realtime is a save/autosave cadence dial, not a second commit channel'." Then: "claims, kses sequestration, per-block salvage, review parking, announce rows, attribution" with none of the six explained.
3. `src/engines/intent-log/rebase.js:318-343`. Arrow chain in prose: "`ownWrites`: frame key → { state: 'applied' } (earlier own frame write accepted; the server frame matches the author's local frame for that key as long as no OTHER actor also wrote it) or { state: 'phantom', atSeq } (an earlier own frame write escalated or voided — the author's local frame contains an effect the server never applied)." This is the frozen core, so an edit must stay in step with the PHP twin; a JSDoc-only edit is allowed.
4. `src/engines/intent-log-manager.ts:230-244`. Metaphor and undefined words: "the seq-0 genesis bootstrap document, derived from the same saved content the editor parsed (covers legacy content whose ids exist only as deterministic genesis mints)" and "every tree the editor hands to update() — its ongoing testimony."
5. `src/engines/yjs-server/session.ts:100-112`. Defines itself against code that no longer exists: "Unlike the relay codec there is no sync_step1/step2 peer dance: the SERVER holds the canonical document." `grep -rn -i 'relay codec' src` finds only this line. The yjs-relay engine was removed. `engine.ts`, `undo.ts`, `constants.ts` in the same folder and `src/providers/http-polling/types.ts` also still describe themselves by contrast with the retired relay.

## Open GitHub issues against the issue rules

`gh issue list --limit 30 --state open` returned 10 open issues. The check was: five sections present and in order, numbered steps in the example, no glossary word above the Notes section, and one paragraph per line.

| Issue | Labels | Shape | Glossary words above Notes | Hard wrap | Verdict |
| --- | --- | --- | --- | --- | --- |
| #148 The editor cannot tell your other device from your other tab | enhancement, agent:parked | 5 sections, 3 steps | none | no | Passes |
| #147 The editor cannot tell a second person from your own second tab | enhancement, agent:in progress | 5 sections, 2 steps | none | no | Passes. "the faster two-person check-in rate" is an undefined phrase but not a glossary word. |
| #123 DE-RTC over WebSocket: a paragraph shows up twice after a collaborator leaves and comes back | agent:needs shaping | 5 sections, 3 steps | none | no | Passes the shape. Still labelled "needs shaping" although fully shaped; the label is stale. The "Example" is a fuzzer command, not a user action, which the rules allow ("a command if there is one") only for the done check. |
| #100 Text typed right after opening a post is silently lost (intent-log) | agent:in progress | 5 sections, 4 steps | none | no | Passes. A model issue. |
| #96 Sync Engine: Merge UI & Exploration | none | Not shaped; 6 custom headings | "escalate" 1, "park/parked" 4, "sequestration" in two headings | no | Human-filed design exploration. The glossary rule binds agents, not reporters. But it carries no `agent:needs shaping` label, so the front door described in `docs/plan/README.md` ("It arrives labelled `agent:needs shaping`") was not applied. |
| #75 Run the chosen sync engine with PHP WebSockets on WPVIP | agent:needs shaping | 2 sections | none | no | Self-declared stub. Correctly labelled. |
| #74 Choose the sync engine we will invest in next | agent:needs shaping | 2 sections | none | no | Self-declared stub. Correctly labelled. |
| #59 Typing quickly in a table still briefly freezes the typist's browser | agent:parked | 5 sections, 2 steps | none | no | Passes. The parked comment requirement is met inside the body ("Which decision is missing, and who makes it"). |
| #55 The saved-HTML note kept for blocks added during a session is deleted as soon as the block changes | agent:parked | 5 sections, 3 steps | "room" 2, both inside shell commands (`wp collaboration rooms list`) | no | Passes. Code is exempt. |
| #44 Decide whether the Automerge library we ship should do any work | agent:parked | 5 sections, 3 steps | "descriptor" 1, inside a file path | no | Passes. |

Violations found: one labelling gap (#96 has no label), one stale label (#123). No shaped issue breaks the glossary rule above its Notes section. Hard wrapping is absent. The issue discipline is the strongest prose discipline in the repo.

## The novice walkthrough

Persona: an engineer who knows WordPress and JavaScript, has never heard of a CRDT, and has not seen this project. Only the docs are followed; nothing is run.

### (a) Understand what the plugin does

1. `README.md`, first two paragraphs. Clear. "An exploratory WordPress plugin for trying out server-aware real-time collaboration in Gutenberg." "This plugin is a decision tool, not a solution." The term "server-aware" is bold and not explained here, but the next sentence explains the idea ("collaboration should run through WordPress, with Core in control").
2. README "Engines". Each bullet gives a plain mechanism and names the technique in parentheses: "(an operational transform engine)", "(a CRDT)", "(a three-way merge)". Good for a novice: the technique name comes after the plain explanation.
3. README "Transports". Mostly clear. Stumble: the paragraph "**The advisory channel.**" introduces a new idea in the middle of the transport list. "An advisory channel connects peers and exchanges only who is present and announcements of new updates (never content)." Readable, but the reader does not yet know why polling needs it, and the sentence before it ("frequent polling costs the server and infrequent polling feels slow") helps.
4. README "Storage". Stumble: "No collaboration write touches post caches." A WordPress engineer knows post caches, so this is acceptable. "Either way, a poll that changes nothing writes nothing." Clear.
5. README "Architecture". Lost here. "Both axes are independent registries with a client/server handshake: the server announces the active engine + transport, the client negotiates against what it has registered, and any mismatch degrades to a post lock rather than corruption." Four unexplained ideas in one sentence (axes, registries, negotiation, post lock as a fallback). The pointer to `prototypes/sync/ARCHITECTURE.md` does not say where that file is.
6. Next step the README offers: none to `docs/`. The README never links `docs/README.md` or `docs/data-flow.md`. A novice who wants more has to open the `docs/` folder on their own. `docs/data-flow.md` is the page they need, and it is the clearest page in the repo.

Outcome: goal (a) is met by the README alone, with one lost paragraph. The best explainer (`docs/data-flow.md`) is not linked from the README.

### (b) Run it with two tabs collaborating

1. README "Requirements": WordPress 7.0 and the Presence API plugin. Clear.
2. README "Setup": four commands. Clear. Stumble: the third line installs and builds a bundled Gutenberg; the README says this is needed but not how long it takes (AGENTS.md says 1 to 2 minutes plus a large install). A novice will think it hung.
3. README "Environment": `npm run env start`. Then: "Alternatively, try it using WordPress Playground... use a local Playground instance: `npm run playground`." Clear.
4. Lost: nothing in the README says how to log in, which URL to open, which account to use, or how to open the same post in two windows as two people. AGENTS.md has this (port 8888; the Playground blueprint adds "a second account (`editor` / `password`)"), but the README does not, and it does not point to AGENTS.md for it. The default wp-env credentials (admin/password) are nowhere in the README.
5. Lost: the README does not say that activating the plugin is what turns collaboration on, nor that both plugins must be active on the dev site. AGENTS.md "Collaboration gate" explains it; the README does not point there.
6. Lost: the README never says "open the same post in two browser windows". The phrase "Two windows on one post collaborate over HTTP polling" is in AGENTS.md's Playground paragraph, not in the README.
7. The "Testing by yourself" section offers a 2,500-character one-line script "if you need to test behavior by yourself". The heading suggests this is how one tests, but it is a typing simulator for a second window. The reader still does not know how to get a second window.

Outcome: goal (b) is not met from the README. The missing steps are: which URL, which credentials, that the plugin must be active, open one post in two windows as two users. All four facts exist in AGENTS.md. A six-line "Try it" section in the README would close the gap.

### (c) Understand which engine to pick

1. README "Comparing the engines" says to run `npm run bench`. No link to `docs/engine-comparison.md`. The novice finds that file by browsing `docs/` or by reading `docs/README.md`.
2. `docs/README.md`, bullet 2: "Pick an engine or transport → engine-comparison.md". Good.
3. `docs/engine-comparison.md`, first paragraph: "Short answer: start with intent-log (it is also the default)." Then one sentence per alternative. A novice can stop here. This is the best BLUF in the project.
4. If they keep reading: "The engines" bullets are fine. "Retired: yjs-relay" is a stumble: "The incumbent design had clients own the document." The reader does not know there was an incumbent.
5. The scorecard table: lost on "Oracle-certified", "unacked outbox intents", "idempotent full-state recovery", "disposition/lineage oracle", "Snapshot-diff binding inherited from the relay". None are defined on the page or linked to the glossary.
6. "Three honest readings of that table" is readable and summarizes the trade.
7. The feature-parity table is for someone who already knows all three engines. The resource-profile table is better: "intent-log handles one edit at a time per post. The second editor's request waits a moment."
8. "Known gaps" is written at AGENTS.md density and ends by sending the reader to AGENTS.md.

Outcome: goal (c) is met in the first 75 lines of `docs/engine-comparison.md`. The rest of the file is for experts. The README should link that file in "Comparing the engines".

### Terms a novice meets with no definition on the page, in order of first encounter

README: server-aware, post lock, registries, negotiates. docs/engine-comparison.md: canonical, incumbent, ingest, dispositions, oracle, outbox, unacked, idempotent, lineage, escalate, review lane, register, LWW, salvage, sequestration, descriptor, announce, synthesized snapshot. The glossary covers about half of them, but neither page links to the glossary at the first use of a term.

## Ranked list of the highest-value prose fixes

1. **Add a "Try it in two windows" section to `README.md`.** Six lines: start the env, open `http://localhost:8888`, log in as `admin`/`password`, confirm both plugins are active, open one post in two browsers (or one as `admin` and one as the second account), type. Link `docs/data-flow.md` for what is happening. This closes the only goal a newcomer cannot reach today.
2. **Link the docs from the README.** "Comparing the engines" should link `docs/engine-comparison.md`. "Architecture" should link `docs/data-flow.md` and name the subtree path of `ARCHITECTURE.md`. Add a one-line "Documentation: see `docs/README.md`".
3. **Split `AGENTS.md`.** Move "What this is" product detail into the docs (most of it is already there), keep a 30-line summary with links. Move "Known issues" bug history to `docs/plan/history.md` and `CHANGELOG.md`, which already hold plainer copies. The file would shrink from 1,115 lines to about 600 and lose its five longest sentences.
4. **Rewrite the 12 bullets over 150 words in `AGENTS.md`.** Start with the 937-word "Transports" bullet, the 700-word e2e-suites paragraph, and the 556-word "de-rtc known gaps" bullet. One idea per sentence, one topic per paragraph. The three rewrites above show the method. Keep the file names and constants; drop the parentheses.
5. **Rewrite the three engine descriptions on the settings screen** (`class-gutenberg-sync-engines-settings.php` lines 281 to 283). This is the one place a site owner makes a decision, and all three strings use glossary words. Also change "(0 = every settle)" at line 536.
6. **Add the missing glossary entries**: stream and receive stream, canonical content, proposal, base version, three-way merge, lane (and stop coining new lanes), company and alone and quiet, CAS, wire, unit, framing, machine writer. Link glossary words to the glossary at their first use in `engine-comparison.md`, `scenarios.md`, and `transports.md`.
7. **Fix the stale statements**: `docs/README.md`'s description of `plan/`; the "five entries" count and the duplicated "(default)" in `docs/plan/advisory-channel.md`; the `npm ci` versus `npm install` mismatch between README and AGENTS.md; "AGENTS.md lists the rest of the residuals" in `engine-comparison.md`; "Unlike the relay codec" in `src/engines/yjs-server/session.ts`.
8. **Move the closing paragraph of `docs/de-rtc-fidelity.md` to its top.** It is the only plain paragraph in the file and it is the BLUF: "One mistake caused nearly every gap in the table above."
9. **Rewrite the CHANGELOG entries that change behavior for a site owner so that a site owner can read them.** The "lone editor's updates are held in the browser" entry and the SSE entry are the two to start with. Keep the developer detail in the PR. Also merge the interleaved "### Added" / "### Changed" headings in 0.0.1 into one of each.
10. **Make the AGENTS.md Language section match `docs/plan/README.md`.** The plan README states the same rules in plainer words, with a translation table ("the room" to "the post everyone is editing"). Copy the table into AGENTS.md or point to it, and say whether the UI path "Settings → Collaboration" is an allowed arrow.
