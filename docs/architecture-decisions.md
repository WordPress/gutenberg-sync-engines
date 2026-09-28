# Architectural decisions to revisit

This plugin has no external users; severity is cheap now and expensive
later. These are the load-bearing early decisions the
[fidelity audit](de-rtc-fidelity.md) and the
[scorecard](engine-comparison.md) put in question, each with the change
we would scope.

1. **One wire protocol for every engine.** The framework's session
   protocol (opaque `EngineUpdate` envelopes over rows-after-cursor)
   was inherited from the relay era and imposed on every engine. It
   fits log-shaped engines (intent-log, yjs-server); it visibly
   reshaped DE-RTC — save-centric semantics were squeezed into
   poll-cadence proposals, which is where the LWW and the loss of
   pending edits came from. Revisit: narrow the engine SPI to
   principle-level obligations (authorize, attribute, merge, review,
   materialize) and let each engine own its wire surface. An engine
   that wants its own REST routes — or no live transport at all —
   should be able to say so. Feeds the deeper Save/Sync inversion (a
   post-v1 direction; see [plan/wontfix.md](plan/wontfix.md)).
2. **Canonical state lives in plugin room storage for every engine.**
   Room meta was chosen for plugin containment (it now rides the
   plugin's own `sync_room_meta` table rather than post meta on a hidden
   storage post, which changes the cost, not the shape). For the
   log-is-truth engines it is a reasonable substrate. For de-rtc it inverted the
   vision: the canonical document is supposed to BE the post, with
   sync-meta riding `post_content` and revisions as the backup
   mechanism. De-rtc's co-location (write-through) and self-healing
   have since been restored, so de-rtc now passes
   [scenario F](scenarios.md); intent-log and yjs-server still fail it.
   What remains of this revisit: make the storage substrate an engine
   decision and complete the inversion for de-rtc (room rows demote to
   a transport cache) as part of the deeper Save/Sync inversion.
3. **We assumed every engine should work over every transport.** That
   assumption is harmless for intent-log and yjs-server: both send a
   steady stream of small updates, so it does not matter whether those
   updates travel by polling or by socket. It is actively harmful for
   de-rtc, which was designed to send one whole document when an editor
   saves — possibly minutes apart, possibly on a button press. Forcing
   that shape into a once-a-second poll is what made de-rtc send its
   whole document over and over. Revisit: let an engine say which
   transports it supports, including "none — I sync when the user
   asks". Stop treating "works over any transport" as a feature worth
   damaging an engine to keep.
4. **Client machinery reuse across engines.** de-rtc's client rides a
   `Y.Doc` editor bridge purely to reuse the shared Yjs awareness
   plumbing (the borrowed local-snapshot undo it once forced has been
   replaced by revert-edit undo). The CRDT dependency the vision says
   clients don't need remains; the descriptor lane is the natural
   coupling point for moving de-rtc's client onto the editor's
   semantic actions instead of a shadow CRDT.
