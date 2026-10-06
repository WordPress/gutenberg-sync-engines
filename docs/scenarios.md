# How the data flows: scenario narratives

Numbers change; these flows don't. Each narrative traces one concrete
situation through all three engines, and names the principle at stake
(see [principles.md](principles.md)). Read
[engine-comparison.md](engine-comparison.md) first for what each engine
is.

## A. One editor types a sentence (the solo baseline)

- **intent-log**: Keystrokes reach the canvas immediately. Capture then
  waits for the typing to fall quiet — a deliberate delay that
  core-data's update ordering forces on us. It compares the editor's
  blocks against the document state those blocks reflect, and writes
  typed edits into the outbox at that position in the log. The next poll
  sends them. The server takes the room lock, transforms them (nothing
  to do when you are alone), appends the rows, and sends back a verdict
  for each. The client absorbs those rows, and about one poll cycle
  after the typing stops, the edit settles. Undo works the whole time:
  an edit still in flight is cancelled, and one that has settled is
  reversed by a new opposite edit.
- **yjs-server**: Keystrokes apply to the local Y.Doc instantly, so
  undo is armed from the first character. The provider encodes an
  incremental binary update; the next poll delivers it; the server
  decodes the canonical doc, merges, re-encodes, and stores the diff
  row. No lock, no transform.
- **de-rtc**: Keystrokes edit the local document and mark it changed.
  Once the typing settles and no earlier commit is still in flight, the
  client sends its **whole** content, saying which version it was
  written against. That goes through the ordinary autosave endpoint, not
  the room transport — `WP_De_RTC_Autosave_Commits` recognizes the
  commit and handles it. The server three-way-merges it, which when you
  are alone is just a fast-forward. It then claims the next version
  number, stores the canonical content once in the room's chained
  options row, and writes a roughly 200-byte announce carrying the
  version, a hash of the content, and the entity properties. The next
  poll delivers that announce. The
  hash matches what the typist already has, so they move to the new
  version without downloading anything.

## B. Two editors, different blocks (the common concurrent case)

All three merge without losing anything. They differ in *how*, and in
*what travels over the wire*.

intent-log transforms each editor's edits over the other's rows. The
transforms do nothing here, because the two editors' edits touch
different regions. yjs-server's CRDT merges the two updates in either
order with the same result. de-rtc three-way-merges each whole-content
commit against the base version and the current one; each editor is the
only one who changed their block, so both changes land.

The cost is lopsided. Going up, each editor sends their entire document
with every commit. Coming down, each receives an announce whose hash
doesn't match their content, because the other person's work was merged
in, so each downloads one synthesized snapshot of the merged result.
That is P5 and P6 in practice: de-rtc pays in upload bytes and in one
document download per incorporation, but no longer in stored rows.

## C. Two editors, the same paragraph (the policy separator)

- **intent-log**: If each editor has seen the other's change before
  typing again, the positions transform and the two texts merge. The
  residual case is when one editor is still *behind* on the other's
  change to that paragraph. Then the later keystrokes of their burst are
  held for review as a `frame-conflict`. They are parked, never lost,
  and normal merging resumes as soon as the peer's change arrives. This
  is a rate problem: P3 is honored, arguably too eagerly. The
  escalation-criteria fixture polices the rate.
- **yjs-server**: Character-level CRDT merge interleaves both texts
  deterministically; block-attribute (register) collisions resolve by
  silent last-writer-wins. Nothing surfaces to a human (P3 violation,
  documented policy).
- **de-rtc**: The peer's commit is accepted and announced mid-burst. The
  local hash disagrees, so the client downloads the canonical content
  that announce names, as one synthesized snapshot.

  Now the client is stuck between two things it cannot do. It cannot
  merge, because clients never merge. It cannot apply the snapshot as-is
  either, because that would wipe out keystrokes it hasn't sent yet. So
  it *incorporates* instead: it adopts the canonical version of every
  block it hasn't touched, and keeps its own version of the block both
  people changed. Crucially, it also records which version that block's
  text was really written against, and declares it with the next commit
  (the `blockBaseVersions` map).

  That declaration is what lets the server merge the contested block
  from its true base. Concurrent edits to the same block that don't
  overlap merge, and both texts land. Edits that genuinely overlap are
  held for review at block grain, while the rest of the commit lands.
  The silent block-level last-writer-wins this moment used to cause is
  gone.

  The person sees one pending item, not a pile: later peer edits to the
  same block refresh that item rather than stacking up. They resolve it
  by choosing Adopt (take the latest canonical form) or Reject (keep
  mine — and the recorded base keeps the next server merge honest).

  One timing rule protects the burst itself. When the server has merged
  peer work into this client's own accepted commit, a newer version
  exists whose content the client doesn't have yet. Until it does, the
  client holds its commits back. Committing against the dead pre-merge
  base would make the server treat the client's own just-accepted
  keystrokes as someone else's concurrent change and hold them for
  review. The fuzzer caught exactly this eating the tail of any burst
  that straddled a commit round trip.

  Two residuals. An older client that sends no `blockBaseVersions` map
  still presents its changes as if it had been editing alone. And when
  the two sides diverge structurally, the whole commit is still held.

## D. Edit versus remove (one client types into a block another removes)

intent-log holds back whichever side arrives second. If the removal
lands first, the trailing keystrokes are parked as `target-deleted`. If
the text lands first, both apply and the text disappears along with the
removed block.

yjs-server holds back nothing. CRDT deletion dissolves the edit together
with the block, the same way every time, and invisibly.

de-rtc holds back the most. The removal shifts the base under the whole
commit, and that structural divergence is exactly the case per-block
salvage refuses to guess at, so the trailing commit is held whole —
roughly one per contended pair. Per-block salvage did remove the
*collateral damage* from rounds with no structural change.

The benchmark's `remove-contention` scenario measures exactly this
spread.

## E. An author without `unfiltered_html` pastes risky markup (P1)

- **intent-log**: The intent escalates at ingest as requiring approval
  and parks; a privileged reviewer's accept IS the approval.
- **yjs-server**: The offending blocks are replaced with their
  kses-sanitized form and the compensating delta broadcasts. WordPress's
  filter-on-save semantics at per-update grain. The markup that was
  stripped is held for review: a privileged reviewer approves it, which
  puts it back, or discards it.
- **de-rtc**: Per-block sequestration, upstream's model: exactly the
  risky blocks revert to their base form and park for review while the
  safe remainder of the commit merges and lands. Restore re-proposes
  them under the RESTORER's capability, so restore is the approval.
  Whole-proposal escalation remains the fallback for freeform
  boundaries.

## F. An out-of-band machine write lands mid-session (P4 — de-rtc solves it; the others don't)

A scheduled integration fetched the post before the session and writes
back its modified copy while two editors are collaborating.

- **de-rtc**: a *cooperating* integration passes
  `base_version` with its save and gets a genuine three-way merge
  through the room — concurrent session work survives, conflicts
  reject the save with a 409 (and park for review). An *unaware*
  integration is healed after the fact: the next room access detects
  the write — an aware save's embedded `content_hash` matches its own
  content; this one doesn't — and heals it as an ordinary collaborative
  update.
  What healing does depends on what the integration wrote back. If it
  round-tripped the embedded sync-meta, the server merges from that
  base, and the editors' concurrent work survives alongside the
  integration's changes. If it replaced the content with no meta at all,
  the room converges to the post state as accepted, and the previous
  canonical stays in history. A stale copy heals nothing, because a
  rollback guard stops it. And an edit that collides with concurrent
  session work is held for review. Connected editors see the outside
  change arrive just like any peer's edit.
- **intent-log**: a *cooperating* integration declares
  `intent_log_base_seq` and its save diffs into typed intents — the
  session's concurrent work merges by transform, register collisions
  park for review, and the save lands as the merged canonical. An
  *unaware* intent-log writer still bypasses the room: canonical
  diverges from `post_content` and the session's next materializing
  save clobbers the write — this engine has no divergence-detection
  stamp yet (an accepted v1 residual).
- **yjs-server**: the room never learns about the write in either
  variant — the content-loss scenario stands, as this engine's
  accepted, documented limitation (a diff-to-CRDT lane would invent
  semantic operations no writer expressed).

## G. A lagging client comes back (deep lag, reload, reconnection)

- **intent-log**: Exact re-send, idempotent by intentId; old intents
  transform over everything that landed meanwhile. If the room compacted
  past the client's cursor, it re-bootstraps from the retained
  checkpoint (undo stacks clear — inverse derivation needs the log).
  The one P2 window: outbox intents that were never acked die with a
  reloading tab; the loss is visible when it was an undo (the undone
  edit resurrects).
- **yjs-server**: Re-bootstrap from snapshot + tail; the client uploads
  its own full state as an ordinary update — idempotent, the server
  diffs out what it already has. Under racing lock-free ingests a client
  can be asked to resync (`resync-required` void). The client heals it
  with the same full-state upload, one extra round trip; the upload
  carries the voided edit too, so nothing is lost.
- **de-rtc**: The client re-commits its doc's current state; if the
  lost send actually landed, the re-commit merges as a no-op (and its
  announce's hash confirms it). A stale
  base within the engine's 20-version snapshot window is fine — that is
  what the three-way merge is for, though the staler it gets the more
  ends up held for review. Past that window, the server mines post
  revisions for the base, since every aware save embeds its own snapshot
  window. So even very old bases usually still merge. Only a base that
  no revision carries is thrown away as `unknown-base-version`, and then
  the client retries against a fresher one: download the canonical as a
  single synthesized snapshot, rebase, commit again. The benchmark
  models one retry per edit. Nothing is lost either way.
