# Plan: what happens to unsaved changes when the last editor leaves

Status: implemented on branch `room-lifecycle` (2026-09-08), with the
policy as one switch. This file keeps the reasoning; the code is the
reference for details. The product question itself is still open on the
P2 thread "How should RTC treat unsaved changes?" (2026-09-04).

## The question

While people edit together, their unsaved changes are shared live through
the room (the plugin's storage for one post's session). What should
happen to those changes when the last editor leaves?

- **Discard.** The saved post, with its autosaves, is the only durable
  copy. When the last editor leaves, the room is reset to the saved post
  and unsaved work disappears, exactly as the editor's "You have unsaved
  changes" warning says. This is how WordPress works with collaboration
  off. (Option 1 on the P2.)
- **Keep.** The room lives on as a shared working copy. A later session,
  by anyone, continues from it. (Option 2 on the P2.)

Both need the same machinery: a way for the server to reset a room, and
a way for a client that still holds the old room to notice and start
over. They differ in one rule: whether an empty room is reset. So the
plugin builds the machinery once and makes the rule a switch.

## The switch

Settings → Collaboration → "Unsaved changes":

- **Discarded when the last editor leaves** (default). The saved post is
  the only durable copy.
- **Kept as a shared working copy.** Rooms live on.

The `gutenberg_sync_engines_room_reset_when_empty` filter overrides the
setting per room. The option is `gutenberg_sync_engines_unsaved_changes`
(`discard` or `keep`), exposed over REST so tests can flip it.

The default is "discard" because it honors the warning the editor already
shows, matches the DE-RTC engine's design (saves are the sync point), and
adds no interface. Whether to flip it is the P2's decision, not the
plugin's; see the P2 thread for the arguments on each side and
[wontfix.md](wontfix.md) for why solo edits are held rather than sent.

## The machinery, engine-neutral

**A generation token.** Every room response carries the room's
generation: the row id of its first row, which changes on every reset
because ids are site-wide monotonic. The polling and websocket managers
compare it with what they saw at bootstrap; on a change they tear the
session down and register the room again, so the engine client runs its
ordinary bootstrap against the fresh genesis. Each engine's client
handles the restart its own way (`onRoomRestart` in
`src/providers/session-extensions.ts`): intent-log through its horizon
reset, de-rtc by treating a new generation as newer regardless of
version, yjs-server with a fresh document.

**Who is in the room.** The advisory presence lane
(`includes/class-gutenberg-sync-engines-advisory-presence.php`) already
keeps a per-tab token stamped at page render, refreshed by every
heartbeat and every poll, and removed by a leave beacon on `pagehide` (or
a closed socket under the websocket transport). Under this plan the sync
transports also stamp the token on the post's room requests
(`presence_token`), so the server knows a tab's FIRST sync request: its
join.

**The reset rule**, applied only to per-post rooms and only under
"discard":

- On a join that finds nobody else present (no other live token, no
  other live sync awareness), the room is reset to the saved post before
  the joiner is served. This covers crashes and expired tokens.
- On the last leave (beacon or socket close), the room is reset right
  away, so a reload or a later opener lands on what was saved. The
  beacon carries the session's client id so the tab's own awareness
  entry is dropped at once and cannot hold the room open.
- Later requests from the same tab never reset anything, including a
  re-bootstrap from cursor 0 after a restart: that tab is the room's
  participant.

**Engines with state outside the room's rows** clear it on the
`gutenberg_sync_engines_room_reset` action. De-rtc forgets its canonical
chain and version-claim options rows; without that a reset room resumed
from its stale canonical and served a reloading tab nothing.

## How it composes with the held solo queue

A lone tab holds its edits in the browser and flushes them before a save
and when the tab goes hidden (docs/plan/advisory-channel.md). Under
"discard" the two rules meet cleanly:

- Reload or close: hiding fires first and starts the flush, `pagehide`
  cancels it and sends the leave beacon, the room resets. Nothing lands
  in the room on the way out.
- A real tab switch: the flush lands the held work in the room; the tab
  stays present, so the room keeps it. If the tab then crashes, its
  token expires and the next joiner's arrival resets the room. The
  editor's own autosave is the recovery path, as the warning says.
- Save: the held work is flushed through the room first, then the post
  is written. The room and the saved post agree at that moment.

Under "keep" the same flows leave the room alone; the flush on hide is
what makes a later reload find the edits.

## What "keep" still lacks

The switch makes rooms durable. It does not build the product surface
the P2 lists as necessary for a shared working copy to be safe: an
explicit revert-to-saved control (the reset machinery here is its
mechanism; a button is not), a warning to a joining solo editor when the
working copy is ahead of the saved post (needs one engine SPI method,
"is this room ahead of the saved post"), and an unload warning that fires
only for unsynced changes (a framework change). Those follow if the
decision flips; none is needed under "discard".

## Tests

- PHPUnit: `tests/phpunit/gutenbergSyncEnginesAdvisoryPresence.php`
  (last leave resets, another tab or a live session keeps, a join into an
  abandoned room resets, the same tab's later requests never reset,
  collection rooms are never reset, the setting and the filter both keep,
  a never-written room is not created by a reset, the leave route reports
  the reset, a reset de-rtc room rebuilds from the saved post);
  `tests/phpunit/wpHttpPollingSyncServer.php` (a join resets and the
  generation changes; generation stability).
- Jest: the generation restart in both managers; the presence token on
  the post's room only; the leave beacon's client id.
- e2e: `tests/e2e/specs/collaboration-unsaved-changes.spec.ts`, once per
  engine: reload lands on the saved post; a save keeps what was saved;
  under "keep" a reload lands on the shared working copy.
