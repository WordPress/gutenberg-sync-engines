# Glossary

The project's own vocabulary, in plain words. Docs and code comments
use these terms freely; none of them is standard outside this project
(a few, marked, are standard CRDT/distributed-systems terms).

- **Room** — the shared workspace for one synced thing (usually one
  post). Everyone editing that post is in its room; all their updates
  flow through it. Rooms are named like `postType/post:123`.
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
  configured: it names the user, the site, and the rooms the tab may
  follow, and any server sharing the secret can check it without
  asking WordPress. It is what lets a host run its own relay
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
  server, parked, or voided.
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
