# Choosing a sync engine

**Short answer: start with intent-log** (it is also the default). It is
the cheapest engine to run, it never loses an edit, and when two people
genuinely clash it stops and asks a human. Choose **de-rtc** if scripts
and plugins also write to your posts, or if you want a slow
save-and-sync rhythm on a cheap host. Choose **yjs-server** if you want
two people to type in the same sentence and have the letters
interleave, and you accept that some clashes get resolved silently with
nobody told.

The engines are judged against the seven principles in
[principles.md](principles.md). The engine is chosen on Settings →
Collaboration, where each choice is explained; under de-rtc the "commit
cadence" there (<!-- const:DE_RTC_COMMIT_INTERVAL_DEFAULT -->10<!-- /const --> seconds
by default) decides how soon others see an edit. This guide carries no
measured numbers,
because they go stale and mislead: run `npm run bench -- --suite=engines`
against a running tests env for the whole comparison on your own
hardware. It fails loudly if any engine loses work, and
`npm run bench -- --certify=10` re-checks that across ten seeds.

## The engines

- **intent-log**: the editor sends short typed edits ("insert 'x' at
  position 4 in paragraph 2") with the point in the history each was
  made against. The server keeps a log, adjusts each edit for the newer
  ones, and holds genuine conflicts for review.
- **yjs-server**: each browser keeps a Yjs document (a CRDT, built to
  merge automatically) and sends binary updates. The server, with the
  vendored y-php library, merges every update into its own copy and can
  therefore check content. Conflicts are settled silently.
- **de-rtc** (Distributed Editing): the browser sends its whole content
  plus the version it started from, through the ordinary autosave
  endpoint. The server three-way-merges it, block by block, and
  announces a new version. Genuine conflicts are held for review.

A fourth engine, yjs-relay, was retired: the server only stored and
forwarded updates it could not read, so it could not check content,
surface a conflict, or report anything to measure. Merging on the
server costs processor time (and, for intent-log, a per-room lock); in
exchange the server can say what happened to every edit, which is what
the review panel, the permission checks and the benchmark's correctness
check are built on.

## Scorecard against the principles

| Principle | intent-log | yjs-server | de-rtc |
| --- | --- | --- | --- |
| P1 server authority | Meets: every edit authorized, attributed and adjusted on the server. | Meets: server merges and can check content. | Meets: server merges every proposal. |
| P2 no silent loss | Meets, one window: edits not yet sent are lost with a tab reload. | Meets: a race is repaired by re-sending the whole document. | Meets: edits set aside for review are stored; refused proposals are re-sent. |
| P3 conflicts surfaced | Meets; over-asks on same-paragraph typing (a rate problem). | Violates, by stated policy: field clashes resolve by last writer wins, nobody told. | Meets: only the blocks that clash are held. |
| P4 machine writers | A script that declares the version it read gets a real merge; one that declares nothing bypasses the room unnoticed. | Accepted limitation: outside writes never reach the room. | Met: cooperating scripts merge, and the server repairs an unaware one's write afterwards. |
| P5 cheap hosting | Meets: cheapest per edit; handles one edit at a time per post, the way Core takes locks. | Partly: no waiting, but the heaviest per edit, and it grows with the document. | Partly: cheap processing, no waiting; upload bytes grow with the document. |
| P6 measured | Meets. | Meets. | Meets. |
| P7 intent and identity | Meets: typed edits and stable block ids. | Fails: snapshot diffs, no stable identity in the merge. | Meets: stable block ids at every depth, merged by identity. |

## What they share and where they differ

| | intent-log | yjs-server | de-rtc |
| --- | --- | --- | --- |
| Conflicts | Set aside for a person to review in the editor's panel. | Merged silently. | Only the clashing blocks are set aside; the rest is applied. |
| Collaborative undo | Yes: an undo is a new opposite edit; a pending one is cancelled. | Yes: a per-user Yjs undo manager. | Yes: an undo re-proposes the earlier form of the block. |
| Markup the author may not publish | Set aside for review; a reviewer with `unfiltered_html` restores it. | Replaced with the cleaned form and the correction sent to everyone; nothing reviewed. | The risky blocks are set aside; the safe rest is applied. |
| Reload and reconnection | Re-sends exactly; starts again from the last full copy. | Re-sends its whole state; the server keeps what it was missing. | Re-proposes its content; a lost send merges as a no-op. |
| History | A full copy every 500 rows; older rows deleted. | A full copy every 100 rows. | A full copy every 100 rows. Content is stored once per room; the rows are 200-byte notices. |
| Synced fields | Title, status, dates, taxonomies, meta, each as its own value. | The same, through the Yjs document. | The same, merged per field with every proposal. |
| What travels | Small JSON edits. | Base64 binary updates. | The whole post up on each commit; a notice down; one snapshot when behind. |
| Waiting | One edit at a time per post; the next waits briefly, or is told to retry under load. | None. | None: a lost version claim re-merges and retries. |

## What happens in seven situations

| Situation | intent-log | yjs-server | de-rtc |
| --- | --- | --- | --- |
| One editor types a sentence | Edits captured once typing pauses, sent on the next poll, settled a poll later; undo works throughout. | Each keystroke applies to the local document at once; the diff travels on the next poll. | Once typing pauses the whole content commits through the autosave endpoint; the typist advances by hash and downloads nothing. |
| Two editors, different blocks | Both apply; nothing needs adjusting. | Both apply, same result in either order. | Both apply; each editor downloads one copy of the merged result. |
| Two editors, the same paragraph | Merges when each has seen the other's change. Otherwise the later keystrokes are set aside for review: never lost, but asked about too eagerly. | Letters interleave. A field clash resolves by last writer wins, silently. | The server merges from the version the block was really edited against. Overlapping edits are set aside per block, and the editor sees one pending item to adopt or reject. |
| One types into a block another removes | Whichever side arrives second is set aside. | The edit disappears with the block, silently. | The whole change is set aside for review. The merge will not guess when one person deletes a block another is editing. |
| Unsafe markup from an author without `unfiltered_html` | Set aside for approval. | Cleaned and corrected for everyone. | The risky blocks set aside; the rest applied. |
| A script writes the post mid-session | With a declared base version: merged. Without: the write goes unnoticed and the session's next save overwrites it. | Never noticed; the write is lost. | With a declared base: merged; a conflict is refused with a 409. Without: a content fingerprint reveals it, and the server merges it as an ordinary update. |
| A lagging client comes back | Re-sends; old edits are adjusted for what arrived meanwhile. Unsent edits are lost with a reload. | Re-sends its whole state; under heavy load the server may ask for it once more. | Re-commits. A base version older than the ones the room keeps is found in post revisions; only one no revision holds is refused and retried. |

## Cost

- **Per edit**, intent-log is cheapest. De-rtc costs a small multiple of
  it (the three-way merge). yjs-server is the most expensive, because it
  decodes, merges and re-encodes the whole document in PHP on every
  request, and it is the only engine whose response time grows with the
  document.
- **De-rtc pays in bytes and requests, not processor time.** Every
  commit uploads the whole content and roughly doubles the typist's
  request rate at real-time cadence. Downloads and storage no longer
  grow with the document: notices are fixed-size, content is stored
  once per room, and only a client whose hash disagrees downloads one
  snapshot.
- **Timing is half the comparison.** At the ten-second save-and-sync
  rhythm de-rtc was designed for, it sets almost nothing aside for
  review, and intent-log becomes the engine that asks most, because it
  asks whenever editors see each other's same-paragraph changes seconds
  late. The benchmark's `save-sync-session` scenario measures that
  rhythm; `editorial-session rounds=3600` runs a full hour.
- **Two costs off the edit path:** what a late joiner downloads (modest
  under all three now) and building post content from the room, which
  no editor save runs but the rooms CLI and benchmarks do; near-free
  under de-rtc, most expensive under yjs-server.

All three engines cope with two people saving at the same moment:
intent-log makes the second request wait a moment, de-rtc redoes the
loser's merge, yjs-server pays the full merge twice and occasionally
asks a browser to re-send its document.

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

**de-rtc**

- Blocks line up by their durable id (`metadata.syncId`) at every depth;
  content whose blocks carry none merges by position, as before.
- Commits upload the whole document and roughly double the request rate
  at real-time cadence; collections and unsupported post types still
  send proposals through the transport.
- A script that calls `wp_update_post` without a base version gets a
  fresh content hash, looks like an aware writer, and is neither merged
  nor healed until the next session save.
- The small bookkeeping block de-rtc embeds in saved content is
  visible to editors without the plugin and in raw front-end markup.
- Two holds on the commit path must stay: a save waits for the
  in-flight commit, and a tab waits for the merged version before
  proposing again (the Traps section of `AGENTS.md`).

## De-rtc and its upstream design

One mistake caused nearly every gap de-rtc had. DE-RTC was designed
around saving: an editor saves, and the saved document is the shared
truth. This plugin was built around a steady flow of small updates,
several times a second. Where the two disagreed, we changed DE-RTC to
fit the flow, and that caused silent overwrites and lost pending edits.
The work since put its own design back: commits go through the autosave
endpoint, the transport carries notices rather than documents, saves
write the sync information through to the post, outside writes are
healed, undo is a new edit rather than a rollback, and the merge core
is a verbatim port of the upstream one. What remains different is
recorded in [principles.md](principles.md) under the decisions still
open.
