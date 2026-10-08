# Glossary

The project's own vocabulary, in plain words. Docs and code comments
use these terms freely; none of them is standard outside this project
(a few, marked, are standard CRDT/distributed-systems terms).

- **Room** — the shared workspace for one synced thing (usually one
  post). Everyone editing that post is in its room; all their updates
  flow through it.
- **Row** — one stored entry in a room's history: an edit, a full copy
  of the document, an edit held for review, and so on. Every row has a
  type (see `docs/protocol.md`).
- **Wire / wire format** — what travels between the browser and the
  server: the shape of each request and reply, and the bytes an engine
  puts inside a row.
- **Stream / receive stream** — under the two server-sent events
  transports, the one long-lived response per tab that the server writes
  each change to. The tab still sends its own edits on ordinary requests
  beside it.
- **Canonical (content, document)** — the official copy on the server.
  Every browser's view is brought in line with it.
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
  alone stops polling (it is quiet).
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
- **Access token** — a signed, two-minute pass WordPress hands an editor
  tab for its socket handshake when a
  `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` is configured: it names the
  user, the install, the site, and the rooms the tab may follow, and any
  server sharing the secret can check it without asking WordPress. It is
  what lets a host run its own relay (`examples/advisory-relay/`)
  instead of the sync daemon.
- **Generation** — the token a room carries that changes whenever the
  room is reset (its first row's id). A client that sees a different
  generation than it started with knows its rows and cursor are gone and
  bootstraps again from the fresh genesis.
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
- **Lane** — a name for one kind of traffic and the code path it takes:
  presence (who is here), commit (de-rtc's saves), kses (markup checks),
  property (title, status, and other fields), review (edits held for a
  person). Prefer the plain name of the path over coining a new lane.
- **Kses lane / sanitize-and-compensate** — what happens to markup the
  author is not allowed to publish, such as scripts (what `wp_kses_post`
  would strip). Intent-log and de-rtc hold it for review. yjs-server
  replaces the touched blocks with their cleaned form and sends the
  correction to everyone; that is sanitize-and-compensate.
- **Register** — one named field of the post that syncs separately from
  the body: title, status, a taxonomy, one meta key.
- **LWW (last writer wins)** — the later change silently replaces the
  earlier one, with nobody told. (Standard CRDT term.)
- **Salvage** — saving the clean part of an edit and parking only the
  clashing blocks, instead of parking the whole edit (de-rtc).
- **Sequester** — the same idea applied to unsafe markup: risky blocks
  revert to their previous form and park for review; the safe ones land.
- **Announce** — (de-rtc) a ~200-byte message saying "version N exists
  and its content hashes to X" — with no content in it. Clients whose
  content already matches advance without downloading anything.
- **Checkpoint** — a periodic full snapshot row the server writes so it
  can trim older history without losing the ability to bootstrap a
  joiner.
- **Trim / compaction** — deleting update rows older than a checkpoint
  so rooms stay bounded.
- **Frame** — (intent-log) the region an edit applies to: one block, or
  one field of a block. Two edits conflict when their frames overlap in
  ways the transform rules can't resolve.
- **Outbox** — edits this client has made that the server has not
  confirmed yet.
- **Capture** — (intent-log) comparing the editor's block tree against
  what it last showed and turning the difference into typed intents.
- **Settle** — an edit reaching its final state: confirmed by the
  server, parked, or voided. Also, in the editor, the pause after a
  burst of typing that the engines wait for before sending.
- **CAS (compare-and-swap)** — changing a stored value only if nobody
  changed it since you read it, as one step. De-rtc uses it
  (`WP_Sync_Atomic_Option`) for its version numbers and its official
  content, so two requests cannot both take the same version number.
- **Floor** — the oldest row a room still keeps after old rows are
  deleted. A client whose cursor is below the floor must start again
  from the latest full copy of the document.
- **Slow awareness** — the optional mode where editors exchange only the
  block they are in, once per interval, instead of live cursors. See
  [transports.md](transports.md).
- **syncId** — the stable identity stamped on each block
  (`metadata.syncId`) so engines can track a block across edits and
  saves.
