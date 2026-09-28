# Changelog

Significant changes to this plugin, newest first: new features, new
settings or extension points, and behavior that is removed or works
differently. Bug fixes, tests, developer tooling, refactors, and docs are
not listed here as highlights. Add entries under **Unreleased** as part
of the change itself; when a version ships they move under its heading,
followed by the full list of pull requests merged since the previous
release, which the release script generates from the commit history.

## Unreleased

## 0.0.2 — September 2026

### Added

-   Server-sent events transport (`sse`) over ordinary WordPress requests:
    one long-lived response per tab that the server writes each change to,
    with cursor-based recovery after any interruption. Streams wake on Redis
    Pub/Sub notices when `WP_SYNC_SSE_REDIS_URL` is set or a Redis object
    cache is in use, and otherwise by checking a per-room version number
    every half second (in the object cache when there is one, else in the
    room-meta table). A tab that is alone, or hidden behind another tab,
    holds no stream. A tab that types keeps its stream open: edits go out
    on the updates request beside it, marked `rows_received_separately: true` (a new
    optional request field), and the stream stays the only path that
    delivers rows ([#106](https://github.com/Automattic/gutenberg-sync-engines/issues/106)).
    Local Redis starts and is removed through wp-env
    lifecycle hooks. Needs a proxy that passes streams through; see
    `docs/transports.md`.
-   Awareness gained a drop-in backend seam, the third after the lock and
    the compare-and-swap: implement `WP_Sync_Awareness_Backend` and return
    it from the `wp_sync_awareness_backend` filter. The interface is per
    client rather than per room, so a backend can write one client's entry
    without rewriting anyone else's. The room array remains the default.
-   The list of editor tabs open on a post, which the advisory channel
    finds peers in, gained the same kind of seam: implement
    `WP_Sync_Tab_List_Backend` and return it from the
    `wp_sync_tab_list_backend` filter. On a site running the Presence API
    plugin, each tab is now its own row in that plugin's table, so two
    tabs checking in at once can no longer drop each other. One transient
    per room remains the default
    ([#113](https://github.com/Automattic/gutenberg-sync-engines/issues/113)).
-   On a site running the Presence API feature plugin, that plugin's
    shared `wp_presence` table now holds awareness. Each client is one row
    upserted in place, so two clients polling in the same instant cannot
    drop each other, and a host without a persistent object cache behaves
    like one with it. A collaborator in the editor also shows up in Who's
    Online and the post list. Both sides speak `postType/{type}:{id}`, so
    rooms need no mapping. This plugin's rows carry a `gse-` client id
    prefix. Collaboration returns to the room array whenever the Presence
    API cannot serve it, whether because the plugin is deactivated, its
    table was never created or recording is switched off, and on
    `remove_all_filters( 'wp_sync_awareness_backend' )`. Presence API
    0.6.0 or newer answers that in one call; older versions are still
    supported through the checks it had at the time.

### Removed

-   The long-polling transport (`http-long-polling`). Server-sent events
    replace it: the same held request, now a stream with keepalives, up to
    five minutes long, and woken by Redis when available. A site that had
    chosen long polling is moved to server-sent events; the
    `wp_sync_long_poll_max_wait_ms` filter is gone.

### Changed

-   Intent-log now preserves formatting and safe deletions across concurrent
    paragraph splits, including repeated splits and joins. Each edit keeps
    one outcome, and undo covers all affected paragraphs. Protocol 2 requires
    open editors using the previous version to reconnect with updated assets.

-   Every awareness read and write in the plugin now goes through one
    `WP_Sync_Awareness` class, where the transports, the advisory channel
    and the rooms CLI each carried their own copy. Reads now exclude
    expired entries everywhere, which they did not on the client id
    ownership check, in `has_live_awareness_besides()` or in
    `wp collaboration rooms`. The store itself is unchanged.

### All changes since v0.0.1

-   SSE: keep the stream open while sending updates ([#121](https://github.com/WordPress/gutenberg-sync-engines/pull/121))
-   CI: split the e2e job into one job per engine ([#124](https://github.com/WordPress/gutenberg-sync-engines/pull/124))
-   Fuzzer: stop getting stuck behind DE-RTC's pending card ([#122](https://github.com/WordPress/gutenberg-sync-engines/pull/122))
-   Add maintainers ([#116](https://github.com/WordPress/gutenberg-sync-engines/pull/116))
-   Correct host benchmark measurements ([#108](https://github.com/WordPress/gutenberg-sync-engines/pull/108))
-   SSE: a hidden tab holds no stream ([#107](https://github.com/WordPress/gutenberg-sync-engines/pull/107))
-   SSE: fall back to the short-polling cadence when no stream can be opened ([#110](https://github.com/WordPress/gutenberg-sync-engines/pull/110))
-   Add a server-sent events transport and retire long polling ([#105](https://github.com/WordPress/gutenberg-sync-engines/pull/105))
-   Keep Presence API collaborators alive and stand down without its table ([#104](https://github.com/WordPress/gutenberg-sync-engines/pull/104))
-   Add a drop-in awareness backend seam and a Presence API backend on it ([#102](https://github.com/WordPress/gutenberg-sync-engines/pull/102))
-   Route every awareness read and write through one class ([#103](https://github.com/WordPress/gutenberg-sync-engines/pull/103))
-   Cleanup README and clarify purpose ([#101](https://github.com/WordPress/gutenberg-sync-engines/pull/101))
-   Update bundled Gutenberg from trunk ([#99](https://github.com/WordPress/gutenberg-sync-engines/pull/99))
-   Try the plugin on WordPress Playground: `npm run playground` and a public blueprint ([#98](https://github.com/WordPress/gutenberg-sync-engines/pull/98))

## 0.0.1 — September 2026

### Changed

-   The DE-RTC commit cadence now defaults to 10 seconds, the
    Distributed Editing operating point, instead of committing on every
    settle; set it to 0 on Settings → Collaboration for the old
    behavior.

-   The polling interval now defaults to 5 seconds instead of 1, and 0
    (the first release's "built-in cadence") means that default. It only
    applies while a peer is out of the advisory channel's reach: with
    every peer reachable, tabs poll on demand. Sites that want the old
    cadence set the interval to 1 on Settings → Collaboration.

-   Collaboration rooms are now stored in two plugin-owned database
    tables, `{prefix}sync_updates` and `{prefix}sync_room_meta`, instead
    of as post meta on hidden `wp_sync_storage` posts, so collaboration
    writes no longer invalidate post caches. Activating the plugin
    creates the tables (a plugin update upgrades them on its next load);
    deactivating it leaves them and every room in place; deleting the
    plugin drops them, as does `wp collaboration storage drop` or
    `WP_Sync_Table_Schema::drop()` from code. `wp collaboration storage
    status|install|reset` manage them. Rooms already held in post meta
    are not migrated: those posts stay behind unused, and every room
    rebuilds from its saved post on the next session.

-   On a site with a persistent object cache (Redis, Memcached), who is
    present in a room is now kept in the object cache instead of the
    database, following the storage strategy the WordPress hosting
    performance tests recommended. A poll that changes nothing no longer
    writes to the database at all, and with a persistent cache it runs
    two queries instead of seven. A cache flush costs one poll round trip of presence
    and nothing else. Sites without a persistent cache keep using the
    tables and still gain the skipped writes.

### Added

-   Slow awareness, for connections too slow for live cursors: Settings →
    Collaboration gains an "Awareness interval" (0 keeps the built-in
    cursors) and an "Awareness channel" (the sync transport, or WordPress
    Heartbeat as a separate request stream). With an interval set, each
    editor reports which block its selection is in, checked once per
    interval and sent when it changes. Other editors see Gutenberg's
    block outline and avatar badge on that block instead of a cursor.
    When several editors share a block, the outline keeps the color of
    whoever arrived first and the avatars stack, spreading out on hover
    to show every name. A block that has not reached an editor yet shows
    nothing until it arrives. See `docs/awareness-high-latency.md`.

-   An advisory channel between the browser tabs editing one post: a
    direct WebRTC link, discovered and negotiated through the heartbeat
    WordPress already sends and through the sync polls themselves,
    carrying who is present and "new changes, go and poll" notices,
    never content. With every peer reachable over it, tabs poll only on
    demand: when they have something to send, when a peer announces,
    or when the heartbeat reports changes from a writer not on the
    channel (a script, WP-CLI). A tab that cannot reach a peer keeps
    the timer cadence. A lone tab keeps its 4-second cadence for 30
    seconds after loading and after regaining focus, so a second person
    is found within seconds, then schedules nothing.
    Filters:
    `gutenberg_sync_engines_advisory_enabled`,
    `gutenberg_sync_engines_advisory_ice_servers`,
    `gutenberg_sync_engines_advisory_max_peers`; console:
    `wpSync.advisory()`. See `docs/plan/advisory-channel.md`.

-   Settings → Collaboration: one "Transport" list replaces the transport
    select. Its entries are polling, polling with a WebRTC advisory
    channel (the default), polling with a WebSocket advisory channel,
    long polling, and WebSocket; each stands for a transport and an
    advisory channel, so the pairs that would conflict (a WebSocket
    transport with a WebSocket advisory channel) cannot be chosen. The
    two stay separate options for WP-CLI and scripts
    (`gutenberg_sync_engines_transport`,
    `gutenberg_sync_engines_advisory_channel`: `webrtc-advisory`,
    `websocket-advisory`, or empty for off).

-   A host can run its own WebSocket relay (Node, Go, a hosted
    service) for the advisory channel instead of the plugin's PHP
    daemon, with no database access: configure a
    `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` (constant, environment variable,
    or the `wp_sync_websocket_access_token_secret` filter) and the token
    route hands each editor tab a signed, two-minute access token (a JSON Web
    Token, HS256) naming the user, the site, and the rooms the tab may
    follow, which the relay checks with the shared secret alone. The
    plugin's daemon accepts access tokens too. Two server URL fields on
    Settings → Collaboration, each with a "Test" button that connects
    from the browser, say where tabs connect: the WebSocket transport
    server (the sync daemon; empty keeps the host and port constants,
    and the `wp_sync_websocket_url` filter still wins) and the WebSocket
    advisory server (a relay of your own; empty means the sync daemon).
    `examples/advisory-relay/` is
    a reference relay to run or port; `docs/plan/advisory-channel.md`
    documents the access token and the message formats
    ([#92](https://github.com/Automattic/gutenberg-sync-engines/issues/92)).

-   The advisory channel can run over a WebSocket instead of WebRTC
    (`websocket-advisory`): each tab opens one socket to the same sync
    daemon the WebSocket transport uses (`wp collaboration
sync-server`), and the daemon relays presence and "go and poll"
    notices between the tabs in a room without ever carrying content.
    Short polling stays the transport. This reaches tabs that cannot
    connect to each other directly (a strict NAT without TURN, a
    blocking extension, different networks). A stored `web-rtc` choice
    from the first release still reads as WebRTC. Filter:
    `gutenberg_sync_engines_advisory_channel`.

-   The websocket transport falls back to short polling whenever its
    socket is not open (the daemon unreachable, the token refused, the
    socket dropped, or an attempt still not open after 5 seconds) and
    takes over again when it reconnects, resuming where polling left
    off. Before, a tab with no socket simply never synced.

### Added

-   An "Unsaved changes" setting on Settings → Collaboration decides
    what happens when the last editor leaves a post: discarded (the
    default; the saved post and its autosaves are the only durable copy,
    and the post's shared working copy is reset to the saved post when
    the last editor leaves or when a new editor finds nobody there) or
    kept as a shared working copy the next editor continues from. Every
    room response now carries a generation token so an editor whose
    shared copy was reset under it starts over from the saved post
    instead of failing silently. Filter:
    `gutenberg_sync_engines_room_reset_when_empty`; action:
    `gutenberg_sync_engines_room_reset`. See `docs/plan/room-lifetime.md`.

### Changed

-   A lone editor's updates are held in the browser until company
    arrives, a save (they are flushed through the room first, so a
    reload never bootstraps from a room that missed them), or the tab
    going hidden; meanwhile the tab schedules no polls. De-rtc is exempt (its codec declares `sendsWhileAlone`); the
    engines' `syncWhileSolo` capability is gone.

### Added

-   Activating the plugin now turns on Gutenberg's real-time collaboration
    experiment, so collaboration works right after activation instead of
    needing a second trip to the Gutenberg → Experiments screen. Other
    experiments are left as they are, and the experiment checkbox keeps
    working afterward. Network-wide activation turns it on for every site
    ([#82](https://github.com/Automattic/gutenberg-sync-engines/issues/82)).
-   Under the de-rtc engine, every block now carries a durable identity
    (`metadata.syncId`), the same scheme the intent-log engine uses.
    Blocks of a saved post get a deterministic id from the post id and
    the block's position, computed identically by the server and by
    each editor, so nobody has to agree on it over the wire; blocks
    added during a session get a random id in the editor; blocks
    written by scripts that know nothing about identity adopt the id
    of the block they replaced and get a fresh one when they are new.
    The ids live in the block delimiters, so they persist into the
    saved post, survive a reload, and let the editor keep a block's
    internal id across incoming updates instead of remounting it.
-   Under the de-rtc engine, edits inside nested blocks now merge
    block by block. Two people editing different paragraphs inside the
    same Group both land, a paragraph added inside a container lands
    next to the one it followed, a block moved elsewhere keeps the edit
    a peer made to it, and a deletion wins over a concurrent edit with
    that edit held for review instead of lost. Before, the server lined
    blocks up by their top-level position and treated a Group as one
    unit, so any two edits inside the same Group parked one of them.
    Only a true clash on the same block is held back now, and the
    review card attaches to that block wherever it sits. The same
    identity drives three more things: an author without permission
    to publish raw HTML has only the risky block itself held back
    (not the whole container it sits in), the "who last edited this"
    record credits the block that changed rather than its container,
    and undo reverts a nested edit in place, removes a block you added,
    or brings back one you deleted.
-   Release automation: a "Create release PR" workflow (pick patch, minor, or
    major) opens a version-bump PR; merging it into trunk triggers a release
    workflow that builds and publishes a ready-to-install plugin zip as a
    GitHub release.
-   The release zip is self-contained: it bundles the pinned, built Gutenberg
    plugin, and the plugin now loads that bundled copy automatically when no
    other Gutenberg is present.
-   Polling interval setting on Settings → Collaboration for the HTTP
    short-polling transport (1-25 seconds; 0 keeps the defaults). Sets how
    often each editor asks the server for updates while collaborating; solo
    editing keeps its slower default unless the chosen interval is longer.
-   The storage backend is now swappable end to end. The framework gains a
    `wp_get_sync_storage()` factory behind a `__unstable_wp_sync_storage` filter, and
    every plugin code path obtains storage through it (via
    `gutenberg_sync_engines_storage()`), so a drop-in plugin can substitute
    Redis or another backend in one place. The framework storage also gains
    a non-creating lookup (`peek_room_engine` — looking at a room no longer
    creates it) and a real `reset_room()`; three plugin code paths that each
    re-implemented the non-creating lookup by hand (including one raw SQL
    delete) now use them. The storage interface documents the contract a
    substitute must uphold.
-   The per-room lock and the compare-and-swap primitive each gained a
    drop-in backend seam: implement `WP_Sync_Lock_Backend` or
    `WP_Sync_CAS_Backend` and return it from the `wp_sync_lock_backend` /
    `wp_sync_cas_backend` filter (for example, memcached locks). The
    interfaces document the correctness rules; the options-table
    implementations remain the defaults.

### Changed

-   Both engines with a review lane now store an edit set aside for review
    under the same row type, `parked` (intent-log wrote `proposal`, de-rtc
    wrote `proposal-parked`). The `resolved` row is unchanged. The name
    shows in the browser wire inspector and the `wp collaboration rooms`
    diagnostics; rooms written before this change are not migrated.
-   Adopt and Reject decisions now travel only over their own REST route,
    for every content type. The server rejects the older way (folded in
    with ordinary sync messages) and the browser no longer falls back to
    it; a decision that fails to send reopens in the review panel so it
    can be retried
    ([#40](https://github.com/Automattic/gutenberg-sync-engines/issues/40)).
-   Real-time collaboration is now turned on by the **Real-time
    collaboration** Gutenberg experiment instead of the Settings → Writing
    checkbox, following the framework
    ([WordPress/gutenberg#80658](https://github.com/WordPress/gutenberg/pull/80658)).
    Collaboration is off until that experiment is enabled, and the old
    `wp_collaboration_enabled` option is deleted on upgrade. Settings →
    Collaboration now says so when collaboration is off.
-   Conflict review plumbing moved into the framework: an engine now hands
    `createSyncManager` a `review` source and the manager drives the review
    panel, cards, and notices from it. The plugin's review-manager decorator
    (a workaround for the manager dropping the review handlers) is deleted;
    the de-rtc adapter composes the plain manager.

### Removed

-   The de-rtc engine no longer reads the transition-era data written
    before the announce model: the protocol-1 `content` rows and the
    `de_rtc_doc` room meta. Rooms written before that model are not
    migrated (the plugin has no installed base); reset them instead. The
    polling transport's deprecated `COMPACTION_THRESHOLD` constant is
    gone too (compaction has been engine-owned since 7.2.0).
-   `restoreProposalWithChanges()` (modify-before-adopt): API-only, never
    called by anything. To return together with its review-panel UI when a
    "suggested edits" feature starts.

### All changes since v0.0.0

-   Add simplified block level awareness, testing options ([#95](https://github.com/Automattic/gutenberg-sync-engines/pull/95))
-   Storage: keep presence in the object cache and make idle polls read-only ([#94](https://github.com/Automattic/gutenberg-sync-engines/pull/94))
-   Let a host run its own WebSocket relay for the notices between editor tabs ([#93](https://github.com/Automattic/gutenberg-sync-engines/pull/93))
-   Advisory channel: a WebSocket link beside WebRTC (webrtc-advisory, websocket-advisory) ([#91](https://github.com/Automattic/gutenberg-sync-engines/pull/91))
-   Storage: move rooms from post meta to plugin-owned tables ([#88](https://github.com/Automattic/gutenberg-sync-engines/pull/88))
-   Unsaved changes: a setting for what happens when the last editor leaves a post ([#89](https://github.com/Automattic/gutenberg-sync-engines/pull/89))
-   Transports: Short polling as base transport, a WebRTC advisory channel between tabs, and WebSocket as an upgrade transport ([#87](https://github.com/Automattic/gutenberg-sync-engines/pull/87))
-   CI: run the automerge-php conformance suite in the official php image ([#86](https://github.com/Automattic/gutenberg-sync-engines/pull/86))
-   Changelog: write highlights by hand, let git supply the rest ([#85](https://github.com/Automattic/gutenberg-sync-engines/pull/85))
-   DE-RTC: Durable block identity and merging inside nested blocks ([#84](https://github.com/Automattic/gutenberg-sync-engines/pull/84))
-   Activating the plugin turns on the real-time collaboration experiment ([#83](https://github.com/Automattic/gutenberg-sync-engines/pull/83))
-   intent-log core: type-check the JS core with checkJs and drop the drifting .d.ts sidecars ([#81](https://github.com/Automattic/gutenberg-sync-engines/pull/81))
-   Move Node-only intent-log tooling out of src; parseArgs for CLI scripts ([#79](https://github.com/Automattic/gutenberg-sync-engines/pull/79))
-   Review lane: one row type, `parked`, for both engines ([#77](https://github.com/Automattic/gutenberg-sync-engines/pull/77))
-   de-rtc: compare blocks by saved form, so authorship credits only changed blocks ([#80](https://github.com/Automattic/gutenberg-sync-engines/pull/80))
-   de-rtc: drop protocol-1 content rows and the other transition code ([#78](https://github.com/Automattic/gutenberg-sync-engines/pull/78))
-   Host cost report: one command that measures what real-time collaboration adds to a server ([#73](https://github.com/Automattic/gutenberg-sync-engines/pull/73))
-   de-rtc: never mistake a room's own genesis content for external work ([#71](https://github.com/Automattic/gutenberg-sync-engines/pull/71))
-   intent-log: keep a just-created block on the editor's clientId ([#66](https://github.com/Automattic/gutenberg-sync-engines/issues/66)) ([#69](https://github.com/Automattic/gutenberg-sync-engines/pull/69))
-   Add testing instructions for console script ([#67](https://github.com/Automattic/gutenberg-sync-engines/pull/67))
-   websocket: make Ctrl+C actually stop the sync server ([#68](https://github.com/Automattic/gutenberg-sync-engines/pull/68))
-   de-rtc: pin restored unfiltered-html approvals so they stop refreezing the post ([#65](https://github.com/Automattic/gutenberg-sync-engines/pull/65))
-   Send complete fixes to the human, rename issue commands, tune language rule ([#63](https://github.com/Automattic/gutenberg-sync-engines/pull/63))
-   de-rtc: record that approval of a risky block is one-shot ([#41](https://github.com/Automattic/gutenberg-sync-engines/issues/41)) ([#61](https://github.com/Automattic/gutenberg-sync-engines/pull/61))
-   diagnostics: materialize a room with its own recorded engine, not the site's current one ([#62](https://github.com/Automattic/gutenberg-sync-engines/pull/62))
-   yjs-server: fill registered attribute defaults at genesis ([#38](https://github.com/Automattic/gutenberg-sync-engines/issues/38)) ([#54](https://github.com/Automattic/gutenberg-sync-engines/pull/54))
-   intent-log: clone documents with a plain-data walk, not structuredClone ([#58](https://github.com/Automattic/gutenberg-sync-engines/pull/58))
-   LOOP.md: lesson — element-in-DOM locator timeouts mean a stalled main thread
-   de-rtc: one way to send Adopt and Reject decisions ([#40](https://github.com/Automattic/gutenberg-sync-engines/issues/40)) ([#53](https://github.com/Automattic/gutenberg-sync-engines/pull/53))
-   de-rtc: keep poll-failure recovery off the commit lane ([#51](https://github.com/Automattic/gutenberg-sync-engines/pull/51))
-   Review in the SPI, swappable storage backends, and a dead-code sweep ([#49](https://github.com/Automattic/gutenberg-sync-engines/pull/49))

## Pre-release history

The plugin's first published GitHub release is 0.1.0, produced by the
release workflow. The milestones below predate it: they were internal
version numbers on paper, never packaged or tagged, and were retired when
release automation landed (the plugin sits at 0.0.0 until that first
release ships).

### V1 loop (August 2026)

-   DE-RTC commit cadence setting (seconds; 0 commits on every settle).
-   DE-RTC Stage 2: sessions commit through the ordinary autosave endpoint;
    the transport carries advisories (~200-byte announce rows), not documents.
-   Fixed a DE-RTC commit hold that dropped the tail of a typing burst when
    the burst straddled a commit round trip.
-   Fixed intent-log losing an edit made during the join round trip on an
    empty room.
-   Collaborative undo in all three engines; cross-engine conflict review
    (intent-log manager, DE-RTC parked proposals in the framework review
    panel); shared genesis property seeding.
-   The websocket e2e suite now runs against the real websocket transport.
-   `composer lint` clean; zero-warning baseline.

### Engines, transports, diagnostics (August 2026)

-   Third engine: `de-rtc` (Distributed Editing's save-centric model; merge
    core ported verbatim from wordpress-develop).
-   Second engine: `yjs-server` (server-authoritative CRDT on vendored
    y-php); the client-merging `yjs-relay` engine was retired.
-   Transports: `http-polling` (default), `http-long-polling`, `websocket`.
-   Diagnostics: `npm run doctor`, the `window.wpSync` wire inspector,
    `wp collaboration rooms`, session capture/replay, the browser fuzzer,
    and the benchmark harnesses.

### Initial split from Gutenberg (August 2026)

-   Initial split from the Gutenberg framework: this plugin owns all engines
    and transports; the framework keeps the engine-neutral substrate. First
    engine: `intent-log`. Settings → Collaboration screen for choosing the
    active engine and transport.
