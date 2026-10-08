# History worth keeping

`CHANGELOG.md` says what shipped. `AGENTS.md` says how to work in this
repo. This file says **why the code is shaped the way it is, and what
has already been tried and failed**, so nobody spends a week
rediscovering it.

Nothing here is a to-do. Everything here is closed. If a line stops
being useful for deciding what to do next, delete it.

## Where this project came from

The plugin was split out of Gutenberg. Gutenberg keeps a generic shell
for collaborative editing and ships no engines and no transports at
all; every engine and transport lives here. Without this plugin active,
collaborative editing is simply off and WordPress falls back to locking
the post. That split is finished, and the copy of Gutenberg in
`gutenberg/` is pinned to the version it was finished against.

Three engines were built so they could be compared under identical
conditions, with the intention of eventually picking one. The public
write-up of that comparison is the [sync engines
rundown](https://collaborativeediting.wordpress.com/2026/08/21/sync-engines-rundown/).

## Decisions that shape the code today

Each of these was contested at the time. Knowing the reason saves you
from undoing it by accident.

**de-rtc saves and syncs through the same path.** A person's edits go
to the server through the ordinary autosave endpoint, not through the
sync channel. The sync channel carries only short notices. This was the
point of the whole engine: if collaborating is just saving, then
anything that can save a post can collaborate, including scripts.

**de-rtc's sync channel must never carry the document.** It used to,
and long sessions ran the server out of memory as messages grew with
the post. Now a notice carries a version number and a fingerprint, and
a client that already matches downloads nothing. If you are ever
tempted to add a document-sized field to that channel, this is the
history that says do not.

**yjs-server stores each block's saved HTML alongside the block.** The
server used to rebuild a block's HTML from what it saw when the post
was first opened, so anything changed later, like an alignment class,
never showed up in the saved post. Now each block carries its own saved
HTML, refreshed when its settings change. **The text inside that copy
is never read** — the live shared text always wins. That rule is what
keeps a stale copy from overwriting someone's typing, and there is a
test whose only job is to prove it.

**de-rtc commits every ten seconds by default.** That is the timing the
original design described, and it measurably cuts requests and
bandwidth. The first release committed after every pause in typing, so
all three engines felt the same; version 0.0.1 moved the default to ten
seconds. The "DE-RTC commit cadence" setting on Settings → Collaboration
still allows 0 for immediate commits.

**Review decisions travel over their own web address, but only for
posts and pages.** That matches where de-rtc saves through the normal
save path. Everything else still sends decisions through the sync
channel. Keeping the two splits identical means there is one rule to
remember instead of two.

**Conflicts are resolved on a card attached to the block**, not in the
sidebar. The sidebar lists them but cannot resolve them, except for
conflicts whose block no longer exists, which would otherwise be
impossible to clear.

**intent-log summarises its history every 500 changes**, not every 100.
The smaller number was crossing mid-typing and throwing away edits that
were still in flight. 500 is sized for how much a person writes in one
sitting.

## Dead ends — do not retry these without new information

**Fixing the mid-typing scramble by changing when history is trimmed.**
Three attempts, all recorded, all partial. Raising the threshold made
it rarer, not gone. Deferring the trim while someone is typing did not
close it either. The remaining fix is to stop the cause: a table
keystroke currently writes three history entries instead of one. See
[#37](https://github.com/WordPress/gutenberg-sync-engines/issues/37).

**Recovering a lost edit by asking the editor for the post's current
state.** The obvious call for this returns nothing for some block
shapes. The working approach is to keep a reference to the last block
tree the editor handed us and re-read that.

**Syncing buffered work the moment the first message arrives.** The
first message is only the first of a burst, and the rest of someone's
history arrives right behind it. Doing the work immediately duplicated
every saved block. It has to wait until the burst is over and then
check whether it is still needed.

**Reading the soak test's per-minute numbers as rates.** They are
running totals. A whole investigation was spent chasing a runaway
request rate that did not exist. Subtract before concluding.

**Making the bundled Automerge library do real work** has not been
tried and is not obviously worth trying. The reasons for and against
are in [#44](https://github.com/WordPress/gutenberg-sync-engines/issues/44).

## How the v1 work was run, and what was worth keeping

Roughly thirty cycles of one bounded task each, on their own branches,
against a fixed written scope. Three practices earned their place and
are now part of how the loop works:

- **Whoever does the work does not get to declare it done.** A separate
  reviewer with no knowledge of the reasoning checked the change
  against its stated acceptance. It caught a test filter that matched
  no tests and therefore passed while testing nothing.
- **Run the stated check exactly as written**, before claiming success.
  Paraphrasing it is how the above got missed the first time.
- **Three failed attempts means stop and write down what you learned.**
  Every dead end above came from that rule. None of them cost a fourth
  attempt.
