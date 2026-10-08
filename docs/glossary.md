# Glossary

The project's own vocabulary, in plain words. Docs and code comments
use these terms freely; none of them is standard outside this project
(a few, marked, are standard CRDT/distributed-systems terms).

- **Room** — the shared workspace for one synced thing (usually one
  post). Everyone editing that post is in its room; all their updates
  flow through it. Rooms are named like `postType/post:123`.
- **Row** — one stored entry in a room's history: an edit, a full copy
  of the document, an edit held for review, and so on. Every row has a
  type (see `docs/protocol.md`).
- **Wire / wire format** — what travels between the browser and the
  server: the shape of each request and reply, and the bytes an engine
  puts inside a row.
- **Stream / receive stream** — under the two server-sent events
  transports, the one long-lived response per tab that the server
  writes each change to. The tab still sends its own edits on ordinary
  requests beside it.
- **Canonical (content, document)** — the official copy on the server.
  Every browser's view is brought in line with it. Under de-rtc it
  is one serialized-blocks string per room; under yjs-server it is the
  server's own Yjs document.
- **Proposal / propose** — (de-rtc) a browser's offer of its whole
  content, together with the base version it started from. The server
  merges it; it is never applied as is.
- **Base version** — (de-rtc) the version of the post a browser or a
  script started editing from, named with every proposal or save so the
  server knows what to merge against.
- **Three-way merge** — combining two versions by comparing each with
  the version they both started from, so only real overlaps count as
  conflicts (de-rtc; also what a script's declared base buys it under
  intent-log).
- **Company / alone / quiet** — a tab has company when the server says
  another editor is in its room, and is alone otherwise. A tab that is
  alone stops polling (it is quiet). The heartbeat, WordPress's regular
  check-in from every editor screen, tells it when company arrives, and
  it starts again.
- **Head cursor** — the id of the newest row in a room. The heartbeat
  carries it, and a tab whose own cursor is behind it polls (the
  head-cursor check).
- **Genesis** — the first version of the shared document, built by the
  server from the post's saved content when the first person opens it.
- **Materialize** — turn the shared document back into ordinary
  `post_content` so WordPress can save it.
- **Advisory channel** — the link between the tabs editing one post:
  browser to browser over WebRTC (`webrtc-advisory`, the default) or
  relayed by the sync daemon over a WebSocket (`websocket-advisory`). It
  carries presence and "I landed rows, go and poll" notices, never
  content; nothing on it is trusted for anything but display and a
  decision to poll sooner.
- **Roster** — under `websocket-advisory`, the daemon's in-memory list of
  the tabs following a room (client id, presence token, latest
  presence), sent to every follower whenever it changes. It is the
  channel's coverage answer over that link.
- **Access token** — a signed, two-minute pass WordPress hands an editor tab
  for its socket handshake when a `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` is
  configured: it names the user, the install, the site, and the rooms
  the tab may follow, and any server sharing the secret can check it
  without asking WordPress. It is what lets a host run its own relay
  (`examples/advisory-relay/`) instead of the sync daemon.
- **Signaling** — how tabs find each other and exchange the WebRTC
  handshake: a per-tab presence token and a mailbox, both riding the
  heartbeat WordPress already sends from every editor screen.
- **Head-cursor check** — the heartbeat answer carries the room's newest
  row id; a tab whose own cursor is behind it polls. This is how rows
  written by anyone not on the advisory channel (scripts, WP-CLI, a
  dropped peer) reach a tab that has no poll timer.
- **Coverage** — the advisory channel's answer to "is every peer I know
  about reachable?": every discovered token and every client id in the
  last awareness map has an open channel. Only full coverage lets a tab
  leave the timer cadence.
- **Generation** — the token a room carries that changes whenever the
  room is reset (its first row's id). A client that sees a different
  generation than it started with knows its rows and cursor are gone
  and bootstraps again from the fresh genesis.
- **Unsaved-changes policy** — the setting that decides a per-post room's
  lifetime: "discard" resets an empty room to the saved post (the
  default), "keep" lets it live on as a shared working copy.
- **Cursor** — a client's position in the room's update history. Opaque
  to clients; they echo it back to say "give me everything after this."
- **Disposition** — the server's verdict on one update: applied, parked
  for review (escalated), or thrown away (voided). Sent back to the
  sender as its receipt.
- **Void / voided** — the server threw the update away, usually because
  the history it was written against is gone. The client is expected to
  redo the work from a fresher state.
- **Park / parked** — set an edit aside, saved but not applied, for a
  person to decide about later (in the review panel). Both engines with
  a review lane (intent-log and de-rtc) store a parked edit in the room
  log as a `parked` row and close it with a `resolved` row.
- **Escalate** — refuse to merge automatically and park the edit
  instead.
- **Review lane** — the whole path a parked edit travels: durable
  storage, the editor's review panel, and the restore/dismiss verbs.
- **Lane** — a name for one kind of traffic and the code path it
  takes: presence (who is here), commit (de-rtc's saves), kses (markup
  checks), property (title, status, and other fields), review (edits
  held for a person). Prefer the plain name of the path over coining a
  new lane.
- **Kses lane / sanitize-and-compensate** — what happens to markup the
  author is not allowed to publish, such as scripts (what `wp_kses_post`
  would strip). Intent-log and de-rtc hold it for review. yjs-server
  replaces the touched blocks with their cleaned form and sends the
  correction to everyone; that is sanitize-and-compensate.
- **Machine writer / engine-unaware writer** — a script, plugin, or
  WP-CLI command that saves a post without going through the editor. An
  aware one names the version it read; an unaware one just saves.
- **Late joiner / rejoin** — a tab that opens a post after a session is
  already running, or comes back after a reload, and must catch up from
  the room rather than from the saved post.
- **Register** — one named field of the post that syncs separately from
  the body: title, status, a taxonomy, one meta key.
- **LWW (last writer wins)** — the later change silently replaces the
  earlier one, with nobody told. (Standard CRDT term.)
- **Salvage** — saving the clean part of an edit and parking only the
  clashing blocks, instead of parking the whole edit (de-rtc).
- **Sequester** — the same idea applied to unsafe markup: risky blocks
  revert to their previous form and park for review; the safe ones
  land.
- **Incorporate** — (de-rtc client) take the server's newer document
  while keeping your own unsent edits: adopt the blocks you haven't
  touched, keep your version of the ones you have.
- **Contest / contested** — a block both you and someone else changed
  at the same time, raised to you as one Adopt/Reject choice.
- **Announce** — (de-rtc) a ~200-byte message saying "version N exists
  and its content hashes to X" — with no content in it. Clients whose
  content already matches advance without downloading anything.
- **Checkpoint** — a periodic full snapshot row the server writes so it
  can trim older history without losing the ability to bootstrap a
  joiner.
- **Trim / compaction** — deleting update rows older than a checkpoint
  so rooms stay bounded.
- **Seq** — (intent-log) the position in the server's edit log an edit
  was written against.
- **Frame** — (intent-log) the region an edit applies to: one block, or
  one field of a block. Two edits conflict when their frames overlap in
  ways the transform rules can't resolve. Defined in
  `src/engines/intent-log/rebase.js`.
- **Outbox** — edits this client has made that the server has not
  confirmed yet.
- **Replan** — (intent-log) recompute what the screen should show from
  the confirmed document plus the outbox.
- **Observed baseline** — (intent-log) the client's best evidence of
  which document state the editor is currently showing, used so
  capture diffs against the right starting point.
- **Capture** — (intent-log) comparing the editor's block tree against
  what it last showed and turning the difference into typed intents.
- **Settle** — an edit reaching its final state: confirmed by the
  server, parked, or voided. Also, in the editor, the pause after a
  burst of typing that the engines wait for before sending.
- **Unit** — (undo) one undo step: the edits one keystroke or action
  made, undone or redone together.
- **CAS (compare-and-swap)** — changing a stored value only if nobody
  changed it since you read it, as one step. De-rtc uses it
  (`WP_Sync_Atomic_Option`) for its version numbers and its official
  content, so two requests cannot both take the same version number.
- **Framing** — the two ways the same receive stream is served: by a
  web request (`sse`) or by the sync daemon (`sse-daemon`). The stream
  looks the same to the browser; only the process writing it differs.
- **Probe (discovery probe)** — a small request a tab sends to find the
  other tabs on the same post. It travels on the heartbeat or on a
  poll, carries the tab's own token and any messages for a peer, and
  comes back with the other tabs' tokens.
- **Floor** — the oldest row a room still keeps after old rows are
  deleted. A client whose cursor is below the floor must start again
  from the latest full copy of the document.
- **Envelope** — the per-room block of a request or response (the room
  envelope), or the engine's diagnostics block inside a response (the
  `_debug` envelope).
- **Epoch compaction** — the unbuilt design for shrinking a yjs-server
  room that has grown past its size limit: start a fresh document and
  drop the old history (see `docs/plan/wontfix.md`).
- **Descriptor / `clientUpdate`** — (de-rtc) tamper evidence a session
  attaches to its commit so the server can verify the commit describes
  the change it claims. Validated once, then dropped; not used for
  merging.
- **Lineage** — which engine first wrote a room. Rooms are stamped with
  it and reject clients speaking a different engine.
- **Log-shaped engine** — an engine whose truth is an append-only list
  of small updates (intent-log, yjs-server), as opposed to de-rtc,
  whose truth is one whole document per version.
- **Oracle** — a benchmark check that decides whether a run was correct
  (for example, "did any edit disappear?").
- **Slow awareness** — the optional mode where editors exchange only the
  block they are in, once per interval, instead of live cursors. See
  `docs/awareness-high-latency.md`.
- **syncId** — the stable identity stamped on each block
  (`metadata.syncId`) so engines can track a block across edits and
  saves.
