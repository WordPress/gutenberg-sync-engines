# Fidelity to the DE-RTC vision

The de-rtc engine is a port of a *design*, not just of code — and the
design has an author. This document audits our adaptation against the
vision stated in [Distributed Editing with unlimited
Codex](https://collaborativeediting.wordpress.com/2026/07/02/distributed-editing-with-unlimited-codex/)
and, secondarily, against the wordpress-develop prototype. The
standard, per project direction: **compromises made so DE-RTC fits this
plugin's protocol or transports are not acceptable.** It is fine for
DE-RTC to work differently from the other engines, and fine for it not
to support every transport. "Faithful" below means the vision survived
our port; "corrupted" means our adaptation replaced a vision element
with something protocol-convenient. Most rows now read "Restored" —
this is largely a completed-work record, kept because it explains WHY
the engine works the way it does.

| Vision element | The vision / prototype | Our port | Verdict |
| --- | --- | --- | --- |
| Save and Sync are distinct, deliberate operations; "pending edits" are the unit of adoption | Editors confirm their own changes and *choose* to adopt others'; sync may be polled, socketed, or run manually with long delays | Contested-only pending: a peer's edit landing on a block you are editing raises ONE merge-not-stack pending item resolved by explicit Adopt/Reject. And the commit lane IS the save lane: sessions commit through the autosave endpoint (real saves through the base-version preflight, settle-and-held), the transport carries no proposals at all — advisory announces, on-demand snapshots, review rows, presence. The commit cadence is the settle cycle, and the 10 s dial is now a setting (Settings → Collaboration) | **Restored.** Adopt and Reject decisions travel over their own REST route — the only way in for every content type; the old transport row is rejected ([#40](https://github.com/Automattic/gutenberg-sync-engines/issues/40)) |
| Sync metadata co-located with saved `post_content` (a `wp/post-sync-meta` pseudo-block); revisions become a backup mechanism | The document's history travels with the post; any writer that round-trips content carries the lineage; recovery mines revisions and autosaves | Restored as write-through: every save of a de-rtc-roomed post embeds the room's sync-meta (upstream's exact grammar) at the content edge, revisions copy it, and genesis adopts it back — resuming the version lineage after a room reset. Room meta remains the *working* store; the full inversion (post as sole durable store) is a recorded future direction ([architecture-decisions.md](architecture-decisions.md), item 2) | **Restored (write-through)** |
| Self-healing when unaware writers mangle the document | The server detects CRDT/content divergence, recovers from revisions or autosaves, and appends a repairing edit so "operations which would otherwise wipe-out a post appear as any other collaborative update" | Restored: room load detects out-of-band `post_content` writes (the co-location `content_hash` stamp is the tell), three-way-merges meta-carrying external edits with concurrent session work, converges to meta-less replacements, refuses to roll back stale copies, and parks genuine conflicts for review | **Restored** ([scenario F](scenarios.md#f-an-out-of-band-machine-write-lands-mid-session-p4--de-rtc-solves-it-the-others-dont)) |
| Arbitrarily long offline editing still recombines | Old bases recoverable via the co-located history and revision copies | Restored: a base past the room's 20-version window resolves from post revisions (each aware save embeds its own snapshot window, hash-verified), so deep-lag proposals merge with intervening work intact; only a base no revision carries still voids | **Restored** |
| Undo/redo "never undo, but rather apply revert edits"; a history slider scrubs versions | Explicitly offered to RTC: "This could easily be adopted by RTC" | Restored: de-rtc's undo derives revert edits from the client's OWN accepted canonical rows (per-block, with an untouched-since guard so peer work is never collateral) and applies them as ordinary dirty edits that propose like any change; redo re-applies the reverted delta. The history-slider UI remains future editor UX | **Restored** |
| Reviewers can modify before adopting | The prototype's review schema carries `reviewed_block_source` ("modify-and-adopt"); approvals are hash-pinned | Removed for now: an API-only version (`restoreProposalWithChanges()`) existed briefly but nothing ever called it — the review panel offers plain restore/dismiss and the framework's restore verb carries no content parameter. Bring it back together with the panel UI work when a "suggested edits" feature starts, so the API and its caller land as one piece | **Not carried (deliberate)** |
| Per-edit authorship: "hover over a user's avatar and highlight the changes they applied" | Range-grain attribution; the prototype shipped authorship-focus overlays | Data surface restored: announce rows carry the server-stamped author user id, and the client derives block-grain "who last touched this" from row-vs-base diffs at zero extra wire cost (`engine.authorship.getBlockAuthorship()`; structural shifts reset to unknown rather than lie). The hover overlay is future editor UX; range grain could draw on the descriptor lane's operation evidence | **Restored (data)** |
| Per-block kses sequestration — "accept partial edits, adopting the safe parts" | Prototype-proven | Restored as the shipping capability lane | **Faithful** |
| The shipping merge is the hand-written block-aware three-way merge; Automerge backs only the legacy lane | Same | Same — ported verbatim as a frozen call-graph closure | **Faithful** |
| Optimistic concurrency; no database lock | Base-version preflight, hash validation, merge-and-retry on the save path | Lock-free again: accepted proposals atomically claim their version advancement and a lost claim reloads + re-merges (`WP_Sync_Atomic_Option` CAS) | **Restored** |
| Clients need no CRDT library; Gutenberg couples via semantic Redux actions | Stage 3 of the development plan | The client rides a `Y.Doc` editor bridge (awareness reuse); sessions author the block-native descriptor but the doc bridge itself remains a CRDT editor adapter | **Adaptation debt narrowed.** The Y.Doc bridge remains ([architecture-decisions.md](architecture-decisions.md), item 4) |
| Cheap-host cadence is a feature: "that $3/mo host … can still support multiple concurrent edit sessions polling … once every ten seconds" | Polling interval scales to the host's comfort; presence is separate from content | Measured fairly now: the `save-sync-session` scenario runs every engine at the vision's cadence — where de-rtc escalates nothing and intent-log becomes the escalation-heavy engine (its stale-observation residual), inverting the per-second ranking. The commit-cadence and polling-interval dials are both exposed on Settings → Collaboration; the default stays immediate so all three engines feel alike, and ten seconds is the documented recommendation for a constrained host | **Measured** |

One mistake caused nearly every gap in the table above. DE-RTC was
designed around saving: an editor finishes a change, saves it, and the
saved document is the shared truth. This plugin was built around a
different idea: a stream of small updates flowing through a shared
room, several times a second. When the two ideas disagreed, we changed
DE-RTC to fit the stream — and that is where the silent overwrites and
the lost "pending edits" came from. The work recorded in this table put
DE-RTC's own design back.
