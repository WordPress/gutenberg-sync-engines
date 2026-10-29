# Choosing a sync engine

The supported engines are **intent-log** and **yjs-server**. The current default is intent-log. For fast editing on hosts with dedicated infrastructure, the main choice is conflict behavior: intent-log records typed edits and holds conflicting work for review; Yjs merges concurrent text and resolves other clashes automatically.

Both use the same transports and editor interface. Select the engine in Settings → Collaboration (`wp_sync_engine`). Measure both on your own host with `npm run bench -- --suite=engines`; use the seven [principles](principles.md) to assess the results. Test results are evidence for the workloads covered, not a guarantee that no edit can be lost.

## The engines

- **intent-log**: the editor sends short typed edits ("insert 'x' at
  position 4 in paragraph 2") with the point in the history each was
  made against. The server keeps a log, adjusts each edit for the newer
  ones, and holds genuine conflicts for review.
- **yjs-server**: each browser keeps a Yjs document (a CRDT, built to
  merge automatically) and sends binary updates. The server, with the
  vendored y-php library, merges every update into its own copy and can
  therefore check content. Conflicts are settled silently.
  The earlier yjs-relay engine was retired: the server only stored and
forwarded updates it could not read, so it could not check content,
surface a conflict, or report anything to measure. Merging on the
server costs processor time (and, for intent-log, a per-room lock); in
exchange the server can say what happened to every edit, which is what
the review panel, the permission checks and the benchmark's correctness
check are built on.

## Scorecard against the principles

| Principle              | intent-log                                                                                                           | yjs-server                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| P1 server authority    | Meets: every edit authorized, attributed and adjusted on the server.                                                 | Meets: server merges and can check content.                                                                |
| P2 no silent loss      | Meets, one window: edits not yet sent are lost with a tab reload.                                                    | Meets: a race is repaired by re-sending the whole document.                                                |
| P3 conflicts surfaced  | Meets; over-asks on same-paragraph typing (a rate problem).                                                          | Violates, by stated policy: field clashes resolve by last writer wins, nobody told.                        |
| P4 machine writers     | A script that declares the version it read gets a real merge; one that declares nothing bypasses the room unnoticed. | Accepted limitation: outside writes never reach the room.                                                  |
| P5 hosting cost        | Meets: cheapest per edit; handles one edit at a time per post, the way Core takes locks.                             | Partly: no waiting, but the heaviest per edit, and it grows with the document.                             |
| P6 measured            | Meets.                                                                                                               | Meets.                                                                                                     |
| P7 intent and identity | Typed edits and stable block IDs; a durable audit archive is still needed.                                           | Action capture is prototyped; complete semantic audit and durable identity across room resets remain work. |

## What they share and where they differ

|                                   | intent-log                                                                           | yjs-server                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Conflicts                         | Set aside for a person to review in the editor's panel.                              | Merged silently.                                                                      |
| Collaborative undo                | Yes: an undo is a new opposite edit; a pending one is cancelled.                     | Yes: a per-user Yjs undo manager.                                                     |
| Markup the author may not publish | Set aside for review; a reviewer with `unfiltered_html` restores it.                 | Replaced with the cleaned form and the correction sent to everyone; nothing reviewed. |
| Reload and reconnection           | Re-sends exactly; starts again from the last full copy.                              | Re-sends its whole state; the server keeps what it was missing.                       |
| History                           | A full copy every 500 rows; older rows deleted.                                      | A full copy every 100 rows.                                                           |
| Synced fields                     | Title, status, dates, taxonomies, meta, each as its own value.                       | The same, through the Yjs document.                                                   |
| What travels                      | Small JSON edits.                                                                    | Base64 binary updates.                                                                |
| Waiting                           | One edit at a time per post; the next waits briefly, or is told to retry under load. | None.                                                                                 |

## What happens in seven situations

| Situation                                              | intent-log                                                                                                                                      | yjs-server                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| One editor types a sentence                            | Edits captured once typing pauses, sent on the next poll, settled a poll later; undo works throughout.                                          | Each keystroke applies to the local document at once; the diff travels on the next poll. |
| Two editors, different blocks                          | Both apply; nothing needs adjusting.                                                                                                            | Both apply, same result in either order.                                                 |
| Two editors, the same paragraph                        | Merges when each has seen the other's change. Otherwise the later keystrokes are set aside for review: never lost, but asked about too eagerly. | Letters interleave. A field clash resolves by last writer wins, silently.                |
| One types into a block another removes                 | Whichever side arrives second is set aside.                                                                                                     | The edit disappears with the block, silently.                                            |
| Unsafe markup from an author without `unfiltered_html` | Set aside for approval.                                                                                                                         | Cleaned and corrected for everyone.                                                      |
| A script writes the post mid-session                   | With a declared base version: merged. Without: the write goes unnoticed and the session's next save overwrites it.                              | Never noticed; the write is lost.                                                        |
| A lagging client comes back                            | Re-sends; old edits are adjusted for what arrived meanwhile. Unsent edits are lost with a reload.                                               | Re-sends its whole state; under heavy load the server may ask for it once more.          |

## Cost

Intent-log sends small edits and takes a per-room lock. Yjs-server decodes and merges binary updates in PHP, and its cost grows with the document. Dedicated infrastructure can reduce transport delay; it does not remove the cost of either engine's merge work. Measure concurrent typing, saves, large documents, and reconnection separately.

## Semantic review and audit

Intent-log already represents edits as named operations. Its compacted sync history is not a permanent audit archive. Yjs needs a separate semantic record to explain what its binary updates meant. Yjs compaction does not affect a separate record.

The [editing-action prototype](../tests/tools/semantic-capture/README.md) receives Gutenberg actions through the entity provider. It captures local action history and applies simple paragraph text directly to Yjs. Other changes still use block-tree comparison. The history is held in the browser; server verification, durable storage, and complete action coverage remain unfinished for a production audit.

## Architecture after removing DE-RTC

The plugin owns the browser sync manager, engine registry, transport registry, and both engines. Gutenberg supplies one entity provider interface and the editor's shared services. DE-RTC's autosave commit path, timer, review route, Automerge library, positional review targets, client-compaction callbacks, and the separate room-reset hook have been removed. The unused peer-relay test server, provider, and their packages have also been removed.

The remaining shared facilities have active users: intent-log needs conflict review; both engines need save hooks, snapshots, collaborative undo, presence, and room restart handling. WebSocket room scans still deliver writes made through HTTP or another daemon process. Atomic option updates still protect the advisory mailbox. These facilities remain.

The Gutenberg PHP engine and transport interfaces, post-lock fallback, and review UI still differ from the pinned trunk. Moving their ownership is separate work; deleting them now would break the two remaining engines.

## Known gaps

**intent-log**

- Same-paragraph typing while behind on a peer's change is set aside
  for review rather than merged. A PHPUnit test (`wpSyncEscalationCriteria`)
  keeps that rate within a band.
- The engine guesses which version the editor is showing; a wrong guess
  re-sends a block rather than destroying an edit.
- Other people's merged edits reach the editor about a second late,
  because writing them into the editor waits for typing to pause
  (`CAPTURE_SYNC_DELAY`); WordPress's data layer forces that delay.
- An undo not yet sent is lost on reload, and the undone edit comes
  back for everyone.
- An edit typed during the join is kept on an empty post and discarded
  on a post with content.

**yjs-server**

- Under heavy write concurrency the server may ask a client to re-send
  its whole document (`resync-required`); the client heals it with one
  extra round trip.
- Ingest cost grows with document size; a post over 1 MB cannot start a
  session and a room over 8 MB refuses further writes
  (`wp_sync_yjs_server_max_genesis_bytes`, `wp_sync_yjs_server_max_room_bytes`).
- A Group block can come back broken after a reload (issue #38).
- Text typed before the first copy of the document arrives is merged as
  characters only; any other difference is dropped, except on an empty
  post (issue #57).
