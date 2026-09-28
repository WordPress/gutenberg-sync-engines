# Choosing a sync engine and transport

**Short answer: start with intent-log** (it is also the default). It is
the cheapest engine to run, it never loses an edit, and when two people
genuinely clash it stops and asks a human. Choose **de-rtc** if scripts
and plugins also write to your posts, or if you want a slow
save-and-sync rhythm on a cheap host. Choose **yjs-server** if you want
two people to type in the same sentence and have the letters interleave
— and you accept that some clashes get resolved silently, with nobody
told. The rest of this guide explains those trade-offs.

The engines are judged against the seven principles in
[principles.md](principles.md); [scenarios.md](scenarios.md) traces
concrete situations through all three engines;
[transports.md](transports.md) covers transports, which are a separate
choice.

This guide carries no measured numbers, because they go stale and
mislead. To produce them on your own hardware, run
`npm run bench -- --suite=engines`
against a running tests env. It prints the whole decision matrix — a
comparison table per scenario, plus hosting cost cards — and fails loudly
if any engine loses work. `npm run bench -- --certify=10` re-checks the
never-lose-work guarantee across ten seeds per engine.

## The engines

- **intent-log**: The server owns the document and every edit is a typed
  intent the server transforms against the log, so it can say exactly how
  every edit settled. It parks genuine conflicts for human review instead
  of auto-merging them.
- **yjs-server**: The server owns the document AND it is a CRDT. The
  vendored y-php library merges every update into a canonical room
  document server-side, the server compacts by itself and materializes
  post content, while clients keep the CRDT machinery inherited from the
  retired relay engine (same wire documents, same undo).
- **de-rtc**: The server owns the document and clients never merge.
  Each client proposes its WHOLE content against the version it last
  incorporated, and the server three-way-merges every proposal. Most
  edits merge cleanly, and genuine conflicts escalate for a human
  decision instead of auto-merging.
  ([de-rtc-fidelity.md](de-rtc-fidelity.md) audits this port against
  its upstream design.)

**Retired: yjs-relay**: The incumbent design had clients own the document.
The server stored and forwarded opaque CRDT updates it could not inspect.
Its shared client modules live on in `src/engines/yjs/` (constants, doc
schema, snapshot, undo), and yjs-server's wire documents remain
byte-compatible with rooms it wrote. Where the relay appears below it is
as historical context.

## One architectural choice drives everything

- **Merging on the server** costs processor time, and for intent-log a
  per-room lock as well. In exchange, the server can *see* what happened
  to every edit. That buys per-edit verdicts (applied, held for review,
  or thrown away), a correctness check in the benchmark, a review lane
  for conflicts, and permission checks at the moment an edit arrives. An
  author without `unfiltered_html` has their raw HTML held for someone
  who does have it to approve; the server is not passing along bytes it
  cannot read. This is P1 made concrete.
- **Merging on the clients**, as the retired yjs-relay did, made the
  server nearly free: append a row, read rows. In exchange the server
  could see *nothing*. No merge outcomes, no way to surface a conflict,
  no permission checks on content before it was saved, and no quality
  numbers to benchmark — the harness printed "NOT SERVER-OBSERVABLE"
  rather than inventing them. That blindness, plus rooms that grew
  without limit once abandoned, is why the relay was replaced by
  yjs-server.

None of the three remaining engines is strictly better; they price the
same work differently. The scorecard and tables below are how the price
shows up.

## Scorecard: engines against the principles

| Principle | intent-log | yjs-server | de-rtc |
| --- | --- | --- | --- |
| P1 server authority | **Meets.** Typed intents authorized, attributed, and transformed at ingest | **Meets.** Server merges and materializes; per-update dispositions | **Meets.** Server merges every proposal; per-proposal dispositions with version lineage |
| P2 no silent loss | **Meets, one window.** Oracle-certified; unacked outbox intents die with a tab reload (undo makes the loss visible) | **Meets.** Oracle-certified; races heal via idempotent full-state recovery | **Meets.** Oracle-certified; escalations park durably, voided proposals re-propose |
| P3 conflicts surfaced | **Meets.** Per-field review lane; over-escalates on same-paragraph bursts (a rate problem, not silence) | **Violates, by documented policy.** Field clashes resolve by silent last-writer-wins and there is no review lane. Said out loud on the settings screen; pinned by the escalation-criteria fixture | **Meets.** Only the blocks that actually clash are held for review ([note](#p3-how-de-rtc-holds-back-only-what-clashes)) |
| P4 machine writers | **Met for read-modify-write.** A script that declares the version it read gets a real merge; one that declares nothing still bypasses the room ([note](#p4-how-scripts-and-plugins-join-in)) | **Accepted limitation.** Ingest speaks binary CRDT updates; a diff-to-CRDT lane would be semantically worse, not just costly | **Met.** Cooperating scripts merge through the room, and unaware ones are healed afterwards ([note](#p4-how-scripts-and-plugins-join-in)) |
| P5 cheap hosting | **Meets.** Cheapest per-ingest CPU; Core-style options-row lock, topology-safe | **Partly.** No lock (good); heaviest per-ingest CPU, and it grows with document size | **Partly.** Cheap CPU; lock-free optimistic claims, topology-safe; upload bytes still grow with document size |
| P6 measured economics | **Meets.** Real wire format in its benchmark profile | **Meets.** Real wire format; convergence oracle | **Meets.** Real wire format; disposition/lineage oracle |
| P7 intent & identity | **Meets.** Typed intents end-to-end; syncIds persist in saved `post_content` and round-trip genesis | **Fails.** Snapshot-diff binding inherited from the relay; no semantic operations, no stable identity in the merge | **Meets.** Every block carries a durable syncId (the same scheme as intent-log, persisted in `post_content`), the server merges block-for-block at every depth by that identity, and each commit carries tamper evidence ([note](#p7-what-de-rtc-sends-with-each-commit)) |

### Notes on the longer verdicts

#### P3: how de-rtc holds back only what clashes

When two people's edits clash, de-rtc holds back just the blocks that
actually clash. Everything else in the edit lands normally. Blocks are
matched up by their durable identity (the syncId every block carries),
at any depth: two people editing different paragraphs inside the same
Group both land, a block added inside a container lands next to the
block it followed, a block moved somewhere else keeps the edit a peer
made to it meanwhile, and a deletion wins over a concurrent edit with
that edit held for review rather than lost. Only when the two sides
disagree about the *order* of the same blocks inside one container is
that container held back; a disagreement about the order of top-level
blocks falls back to the positional rule, which holds the whole edit
back. Content whose blocks carry no identity (classic content between
blocks, a document that never went through the editor) merges
positionally, exactly as before.

Each client also records which version every block it kept was really
written against, and sends that with its next commit (the
`blockBaseVersions` map). That is what makes it safe for two people to
edit the same block at once. If their changes don't overlap, both land.
If they do overlap, the block is held for review. One residual: an older
or simpler client that doesn't send this map presents its changes as
though it had been editing alone.

#### P4: how scripts and plugins join in

**intent-log** handles the read-modify-write case. A script passes
`intent_log_base_seq` with its save (`base_seq` over REST) to name the
version it read. The server compares the save against that version,
matching blocks by their stored syncId, and turns the difference into
ordinary typed edits. Live editors' concurrent work merges in, genuine
clashes are held for review, and the save lands as the merged result. A
script that does *not* declare a base still bypasses the room, and
intent-log has no way to notice that it happened.

**de-rtc** handles both kinds of script. A cooperating one passes
`base_version` with its save — from WP-CLI, a plugin, or the REST
`base_version` parameter on posts and pages — and gets a real three-way
merge through the room, with per-block salvage and review parking. If it
genuinely conflicts, the save is rejected with a 409 that explains why. A
script that knows nothing about collaboration is healed after the fact;
[scenario F](scenarios.md) walks through how.

#### P7: what de-rtc sends with each commit

Block identity and rich-text operations live in the merge core. On top of
that, each session builds a short description of its own change and sends
it with the commit: hashes of the content before and after, plus
fingerprints of the operations. The server rebuilds the same description
from the version the client declared, and rejects the commit if the two
disagree (`de_rtc_sync_meta_tampered`). Seventy-five PHP-generated test
vectors keep the two implementations byte-identical.

This description never affects the merge — outcomes are the same with or
without it. It is an integrity check, which makes it really a P1 concern.

### Three honest readings of that table

- **intent-log** is the closest fit to the principles today. Its main
  risk is a rate problem, not a design problem: same-paragraph bursts
  can over-escalate while an editor is behind on a peer's change. The
  escalation-criteria fixture polices that rate as a policy band.
- **yjs-server** is a deliberate P3/P7 trade: it buys the lowest
  escalation rate and lock-free ingest by hiding conflicts. That is a
  defensible *policy* only if we say it out loud everywhere the engine
  is offered — and we do: silent register-LWW is the engine's formal,
  documented policy, stated on the settings screen and pinned by the
  escalation-criteria fixture. Revisiting that decision starts with
  building conflict detection, a research project the CRDT's design
  premise resists.
- **de-rtc** is the engine whose upstream vision aligns best with P3/P4
  — and restoring that vision after our port damaged it was a program,
  not a patch. It is essentially complete: the
  [fidelity audit](de-rtc-fidelity.md) records what each restoration
  did. The UI and cadence work it once waited on has since shipped.

## Feature parity

| Area | intent-log | yjs-server | de-rtc |
| --- | --- | --- | --- |
| Conflict handling | Transform on the server; genuine conflicts park in the editor's review panel (escalation notice, marker chip, durable resolutions — e2e-verified) | Silent CRDT auto-merge, but ON THE SERVER — outcomes observable, still no review lane (conflict DETECTION is the undesigned prerequisite) | Three-way merge on the server; genuine conflicts PARK as durable `parked` rows and present in the same review panel (restore re-proposes under the reviewer; dismiss resolves; retention survives compaction — e2e-verified) |
| Collaborative undo | Inverse intents over the accepted log (`src/engines/intent-log-undo.ts`): per-user undo/redo, transformed over peers' rows, conflicts park for review. Armed immediately: a still-pending unit CANCELS (outbox + a wire-chasing `cancel` row; a lost race resurrects the unit as a settled candidate), a settled unit inverts | Per-peer undo manager (`src/engines/yjs/undo.ts`, inherited from the retired relay) | Revert-edit undo (the vision's model): undo derives a revert from the client's own accepted canonical rows (per-block, untouched-since guard) and proposes it as an ordinary new change; redo re-applies the reverted delta |
| Refresh/offline recovery | Server materializes the document; queued intents are memory-only. Solo edits go out one request after the first queued update (the transport never holds a lone editor's queue), and discarded unsent work surfaces an editor notice | Server holds the canonical doc; a rejoining client re-bootstraps from the retained snapshot + tail and uploads its own state idempotently. Solo edits go out one request after the first queued update — REQUIRED here, not an optimization: a page reload holds no local state to upload, so a room that never saw the solo session's updates would bootstrap the editor back to its stale snapshot, wiping the freshly loaded record (e2e-covered: the solo save-and-reload spec) | Server holds canonical content + version snapshots; a rejoining client re-bootstraps from the retained snapshot and fetches one canonical snapshot when the announced version is ahead of it. Un-acked local edits re-propose (the server merges); the save-centric model keeps the room tracking saves, so a solo save-and-reload survives regardless (verified) |
| Error recovery | Exact re-send; ingest is idempotent by intentId | Full-state recovery update, IDEMPOTENT server-side (the server diffs out what it already has — redelivery settles as a benign `already-merged` void); the server explicitly requests it with a `resync-required` void when an update's dependencies are missing from the room | Recovery re-proposes the doc's current state; if the lost send landed, the re-proposal merges as a no-op |
| History compaction | Server checkpoints every 500 intent rows and trims (live-authoring-sized: coarse captures cost ~3 rows per keystroke, and a trim crossing mid-burst voided the burst's tail — V1 A15) | Server checkpoints every 100 rows and trims — abandoned rooms stay bounded | Server checkpoints every 100 rows and trims (same retention invariant) |
| Genesis | Server, from post content | Server, from post content — deterministic build, so racing initializers merge idempotently | Server, from post content — deterministic, and ADOPTS an upstream DE-RTC sync-meta block if one is embedded (version lineage continues) |
| Capability enforcement | At ingest (kses lane; escalation for `unfiltered_html`-gated content parks for approval — restore by a privileged reviewer IS the approval) | At ingest, sanitize-and-compensate: blocks a filtered author's batch touched that kses would rewrite are REPLACED with their sanitized form and the compensating delta broadcasts (filter-on-save semantics; nothing parks — coarser than intent-log by design) | At ingest, per-block SEQUESTRATION (upstream's model): risky blocks revert to their base form and park for review while the safe remainder of the proposal merges and lands; markup-bearing property values park per property; restore under a privileged reviewer approves. Whole-proposal escalation remains the fallback (freeform boundaries) |
| Synced entity properties | The framework's full set as per-name registers: the scalar whitelist (title, excerpt, slug, status, comment_status, ping_status, format, sticky, author, featured_media, date, template), attached taxonomies (whole term-ID arrays by rest_base), and registered post meta (per-key `meta.<key>` registers, `_crdt_document` excluded). Collection rooms implement the framework's save-notification contract (per-client save registers), so a newly created term reaches every peer's term list by refetch | Whatever the sync config maps into the CRDT (the full framework set, including per-key post meta and taxonomies), and genesis seeds the same shared REST-shaped property map the other engines seed; collection rooms carry the savedAt state key for the same refetch contract | The full flattened register map rides every proposal beside the content (title, scalars, taxonomies, `meta.<key>`); the server three-way-merges per property against the base version — sole-writer changes and agreements apply, concurrent divergent writes park per property for review. Genesis seeds the shared property map |
| Presence/awareness | Yes (shared Yjs-free awareness doc) | Yes (Yjs awareness, relayed opaquely — the server does not decode it) | Yes (Yjs awareness over the doc bridge, relayed opaquely) |
| Server observability | Dispositions, debug envelope, benchmark quality metrics | Per-update dispositions, CRDT convergence oracle, materialization | Per-proposal dispositions (applied/escalated/voided with reasons), version lineage, materialization |
| Materialize to post_content | Yes (server-side; block identity persists as `metadata.syncId` and round-trips genesis) | Yes (server-side, from the canonical doc) | Trivially — the canonical document IS post content |
| Wire format | Small human-readable JSON intents | Opaque base64 binary (V2) + JSON snapshot rows | Human-readable JSON: whole-content commits up (via the autosave endpoint), constant-size announce advisories down, with on-demand synthesized snapshots for behind clients (upload bytes scale with document size; rows do not) |

## Resource profile

| Concern | intent-log | yjs-server | de-rtc |
| --- | --- | --- | --- |
| Per-ingest CPU | Replay from checkpoint + transform planning — the cheapest of the three | Load + merge + re-encode the canonical y-php doc — the dominant cost of the three, scales with document size | Parse + three-way merge of three content strings (pure PHP over `parse_blocks` trees) — cheap at benchmark sizes, scales with document size |
| Locking | Per-room Core-style options-row lock (`WP_Sync_Room_Lock`, the upgrader pattern: atomic INSERT IGNORE + TTL; 5 s wait budget, contenders get a retryable 503). One claim/release pair of DB writes inside every timed request — the engine benchmark's `calibration` block exists to subtract it. Topology-safe by construction | None — CRDT merge needs no total order; the update log is the source of truth and a lost canonical-save race is repaired from it on the next load | None — lock-free optimistic version claims (`WP_Sync_Atomic_Option` CAS): an accepted proposal atomically claims v(n+1), a lost claim reloads + re-merges, exhaustion returns the retryable 503. Upstream's validate-and-retry model, restored |
| Idle reads | Cheap by design (rows after cursor; no reconstruction) | Cheap (the canonical doc is never touched on the read path) | Cheap (rows after cursor; canonical untouched) |
| Storage growth | Bounded: checkpoint + trim every 500 rows | Bounded: server checkpoint + trim every 100 rows, no client needed | Bounded: server checkpoint + trim every 100 rows, and accepted proposals store ~200-byte ANNOUNCE rows (version + content hash; canonical content lives once per room, fetched on demand) — row bytes no longer scale with document size, closing the PHP-memory cliff the hour-scale soak found under the old full-content rows |
| Row contents | Small JSON intents + periodic full-document checkpoint rows | Base64 V2 diffs (server strips what it already had) + full-state snapshot rows, plus the canonical doc in room meta | Constant-size `announce` advisories (version + canonical content hash + merged property registers) and tiny `fetch` requests; canonical content lives ONCE per room in a chained options row, and a behind client's fetch is answered with one synthesized, never-stored snapshot. Version snapshots ride room meta |

All three engines cope with two people saving at the same moment. They
each pay for it differently:

- **intent-log** handles one edit at a time per post. The second
  editor's request waits a moment. Under heavy load a request may be
  told "try again". Nothing ever has to be re-sent.
- **de-rtc** never makes anyone wait. If two edits arrive together, the
  loser redoes its merge against the newer document — the server does
  that merge work twice. Nothing has to be re-sent. Only sustained
  heavy load turns into a "try again".
- **yjs-server** never makes anyone wait either, but every simultaneous
  request pays the full merge cost, and occasionally the server asks a
  browser to send its whole document again. That is one extra round
  trip; nothing is lost.

### Why this guide has no numbers

Numbers vary by machine, PHP build, and code revision, and stale numbers
mislead harder than no numbers at all. Run `npm run bench -- --suite=engines`
for figures
from your own hardware. What follows are the stable shapes those figures
make concrete.

**Cost per edit.** intent-log is the cheapest. de-rtc costs a small
multiple of it, which is the price of the three-way content merge.
yjs-server is the most expensive, because it decodes, merges, and
re-encodes the whole canonical document in PHP on every request. It is
also the only engine whose response time grows as the document grows. For
scale, the retired append-only relay sat at the timer floor. Read that as
"negligible", and as the price of a server that observes nothing.

**Where de-rtc pays is bytes and requests, not processor time.** Every
commit sends the session's whole content up, through the ordinary
autosave endpoint. Those commit requests roughly double how many requests
each typist makes at pseudo-realtime cadence.

The download and storage side no longer grows with the document. Accepted
work broadcasts a fixed-size announce. Canonical content is stored once
per room. Only a client whose content hash disagrees downloads a
document, and it gets one synthesized snapshot. The person actively
typing advances by hash and downloads nothing at all.

One fairness caveat: the session scenarios run at the benchmark's
real-time poll cadence, which measures de-rtc as we adapted it rather
than as it was designed. The `save-sync-session` scenario measures the
save-and-sync cadence the design intended, and the two profiles differ.

**What is real in every profile.** All three engines' payload and storage
byte counts come from their actual wire formats — nothing is estimated.
All three converge with **zero lost work** on every scenario. Their
escalation policies differ visibly on the same contended workload:
intent-log holds back individual fields, de-rtc holds back individual
blocks (and holds a whole edit only for structural changes), and
yjs-server holds back nothing at all.

### What a session-length run shows

Single workloads miss the time dimension. The session scenarios add it.

Under `structural-churn` — people inserting and removing blocks while
others type — the conflict policies separate hardest. intent-log and
yjs-server merge everything cleanly. de-rtc holds back a share of
commits, because structural divergence is exactly what per-block salvage
refuses to guess at, so those conflicts are held whole. Since salvage
landed, the non-structural share lands its clean blocks and the overall
rate dropped markedly; run the scenario for the current share. Nothing is
lost on any engine.

`remove-contention` isolates the edit-versus-remove clash on its own.
`field-sync` separates the same policies at field grain.
[scenarios.md](scenarios.md) describes what actually happens on the wire
in each case.

Under a ten-minute, three-person `editorial-session` (joins, typing
bursts, per-second polling, autosaves), intent-log's service time stays
flat and de-rtc's stays nearly flat. De-rtc's stored room tail is
fixed-size advisories now, so the megabyte-scale growth the old
full-content rows produced here is structurally gone, and a joiner
downloads one synthesized snapshot instead of that tail. **yjs-server's
ingest cost grows with the accumulating document.** Run
`editorial-session rounds=3600` for the full hour before concluding
anything about long sessions.

And run `save-sync-session` before concluding anything about de-rtc at
all. At the ten-second save-and-sync cadence the design intended, the
escalation ranking inverts. De-rtc surfaces only a small share of held
blocks, because staggered saves rarely truly collide and per-block
salvage absorbs most of what does. intent-log becomes the
escalation-heavy engine, because its same-paragraph residual bites
hardest when editors see each other's changes seconds late. Cadence is
not a detail. It is half the comparison.

The escalation-criteria fixture
(`tests/phpunit/wpSyncEscalationCriteria.php`) pins these shapes as
policy bands. Note that counting escalations alone undercounts de-rtc:
under per-block salvage a commit can report success while some of its
blocks are held for review. The honest measure is escalations plus held
rows, and that is what the fixture measures.

### Two costs that are easy to miss

Both live off the edit path, and the benchmark reports both.

**What a late joiner downloads** — a cold read at cursor 0, which is what
a fresh visitor pulls to enter a room a session has been running in.
Modest under all three engines since the announce change. De-rtc's
retained tail is fixed-size advisories, and the joiner's actual content
arrives as one synthesized snapshot, rather than the full-content tail
that used to make this read the largest by a wide margin.

**The save path** — `materialize()` on a cold engine, the way a real save
request runs it. Cheap under intent-log. Near-zero under de-rtc, because
the canonical document *is* the post content. Most expensive under
yjs-server, which decodes the whole canonical document from scratch. The
ingest figures never show that cost, because within a single request the
engine keeps the decoded document cached.

The benchmark also reports peak memory per ingest request. That is the
number a constrained PHP-FPM pool actually runs out of memory on.
De-rtc's is the largest at benchmark sizes.

## Known gaps and qualifications

Residual facts that color conclusions but don't rise to work items of
their own (open work lives in GitHub Issues), grouped by engine.

### intent-log

- **Same-paragraph typing can be held for review instead of merging**
  ([scenario C](scenarios.md)). The race that used to corrupt text on
  the canvas is fixed. Capture now compares the editor's blocks against
  the document state those blocks actually reflect, and writes its edits
  at that position in the log (see "THE OBSERVED BASELINE" in
  `src/engines/intent-log-manager.ts`). What remains is a *rate*
  problem, not a correctness one, and the escalation-criteria fixture
  polices it. AGENTS.md lists the rest of the residuals.

### yjs-server

- **Under heavy write concurrency the server can ask a client to
  resync** ([scenario G](scenarios.md)). Measured with
  `npm run bench -- --concurrency=8`: most runs settle fully applied with
  zero voids, the occasional run a handful of benign `resync-required`
  voids that heal by full-state upload. intent-log showed zero voids
  under the same load, paying with measured lock queueing instead.
  De-rtc has no lock, so it pays by re-merging and retrying. At hammer
  cadence some of those contenders end up held for review or thrown
  away as stale-base rather than waiting their turn. Both outcomes are
  visible and retryable, and the same check confirms nothing is lost.
  It is exactly what an optimistic validate-and-retry design does under
  contention it was never meant to queue. The benchmark treats
  `resync-required` as benign and `invalid-payload` as real loss that
  fails the run.
- **Ingest cost is real and scales with document size**, and the save
  path is worse (a cold request decodes the whole canonical doc;
  `materialize_us` in the benchmark). This used to be an order of
  magnitude worse: the dominant cost was a quadratic in the vendored
  y-php V2 string decoder, fixed 2026-08-18 by a marked DELTA in
  `includes/lib/y-php/src/Lib0/StringDecoder.php` (held to byte-parity
  by the conformance suite). The remaining one-decode-two-encodes per
  request is the structural floor for a server-authoritative CRDT in
  per-request PHP.
- **Rooms are size-gated at both ends**: genesis refuses to initialize
  above `wp_sync_yjs_server_max_genesis_bytes` (default 1 MB; RTC never
  activates, writes 413), and a room that GROWS past
  `wp_sync_yjs_server_max_room_bytes` (default 8 MB) rejects further
  writes with 413 while reads/saves continue. What the ceiling cannot
  do is shrink an over-limit room — epoch compaction, which would, is
  parked as post-v1 work.
- **Container blocks can come back broken after a reload** — a Group
  block occasionally returns as invalid-content recovery with an empty
  saved copy ([#38](https://github.com/Automattic/gutenberg-sync-engines/issues/38)).
  Materialization fidelity itself is fixed: each block now carries its
  own saved HTML, and the genesis rich-text defect was fixed by the
  selector-sourced split.

### de-rtc

- **Identity, not position, is how blocks line up.** Every block of a
  de-rtc room carries `metadata.syncId`: the saved post's blocks get a
  deterministic id from the post id and block path (the same function
  the intent-log engine and the editor-side stamper use, so every
  party derives it alone), blocks born in the editor get a random id
  there, and blocks from scripts adopt the base's id at their path or
  get a fresh one as they become canonical. The server merges by that
  identity at every depth and parks only the blocks that truly clash;
  the client incorporates, contests, restores and anchors review cards
  by it too. The kses lane for authors without `unfiltered_html`
  reverts or drops only the risky block itself, wherever it sits, and
  the safe rest of the same container lands. Authorship credits the
  block that actually changed, at any depth, and revert-undo reverts a
  block's own form in place, removes a block the row inserted, and
  brings back one it deleted, next to the sibling it followed.
- **Document-size costs live on the commit path, not in storage.**
  Stored rows are fixed-size advisories now, and a later joiner
  downloads one synthesized snapshot. The old tail that grew with the
  document — once a multiple of intent-log's stored bytes, and the
  largest thing a joiner had to download — is structurally gone. Three
  things still grow with the document: what each commit uploads, the
  answer a behind client downloads, and the processor time and memory
  each merge takes. Run `long-form` at your own document sizes before
  concluding anything. Deep lag behaves differently again: clients that
  rarely read have more of their work held for review, and once they
  fall past the 20-version snapshot window the server mines post
  revisions for their base. Only a base no revision carries is thrown
  away and retried ([scenario G](scenarios.md)).
- **Sessions author block-native descriptors**: every session proposal
  carries hash-pinned tamper evidence the server validates once against
  the plain declared base, then drops before the kses/salvage lanes.
  Machine writers and the save lane stay descriptor-less by design (the
  server's engine-unaware-writer lane derives operations); merge
  behavior is identical either way.
- **Sync-meta co-location residuals**: the `wp/post-sync-meta`
  pseudo-block is visible to non-collaborative editors and in raw
  front-end markup (upstream's protection periphery is unported), and
  autosave REST writes update the autosave revision directly without
  re-embedding.
- **The plain-save blind spot**: a script that calls `wp_update_post`
  without `base_version` passes through the co-location filter and gets
  a fresh, matching `content_hash` stamp. That makes it look like an
  aware writer, so it is neither merged nor healed, and the room drifts
  apart from the post until the next session save. Two kinds of writer
  are covered: those that declare a base (merged) and those that bypass
  the filter entirely (healed). Handling this third kind properly
  belongs to the deeper Save/Sync inversion, which is post-v1 work.
- **Commit POSTs roughly double the per-typist request rate** at
  pseudo-realtime cadence (bytes collapsed under the announce model;
  request counts did not), and collections plus unsupported post types
  keep the transport proposal lane as a fallback.

### All engines

- **Genesis blocks must set `isValid: true`** or the editor renders
  them as invalid-content recovery blocks (has bitten).
