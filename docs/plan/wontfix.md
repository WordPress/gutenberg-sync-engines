# Things we decided not to do yet

These are real ideas that we have looked at and set aside. They are not
issues, and nobody should start one without filing it as an issue
first.

Each one says why it is waiting. "Why" matters more than the idea: it is
what tells you whether the reason still holds when you come back.

## Letting a very long editing session shrink its stored history

The yjs-server engine keeps growing its stored copy of a post as people
edit. There is a ceiling that stops a post getting out of hand, but no
way to compact one that has grown large. The design for compacting it
exists.

**Why it is waiting:** compacting is half of one job, and the other half
is keeping the official copy up to date as edits arrive rather than
rebuilding it each time. Both change the same thing, and both need the
same answer for what open editors do when the ground moves under them.
Doing one without the other means doing the hard part twice.

## Storing the shared document in the post itself

Today the shared working copy lives in its own storage, separate from
the post. The original Distributed Editing design keeps it in the post
content, with revisions as the backup. We restored part of that: every
save writes the sync information into the post. The full version would
make the post the only durable copy.

**Why it is waiting:** it changes where the truth lives for every
engine, not just de-rtc. It is a foundational choice, worth its own
project.

One thing that would improve if we did it: a plugin that saves a post
without declaring which version it started from currently looks
well-behaved to the server, and neither merges nor repairs until the
next session save.

## Four known intent-log limits we accept

- Edits that have not yet reached the server are lost if the tab
  reloads. Undo makes this visible, because someone watches text they
  just restored disappear.
- Typing into a paragraph a colleague is editing, while you have not yet
  received their change, sends your later keystrokes to review instead
  of merging them. Nothing is lost, but it asks a person a question it
  could have answered.
- There is no direct way for a script to send typed edits. Scripts can
  save with a declared starting version, which is turned into edits for
  them, but at a rougher grain.
- When an unaware script overwrites a post, intent-log has no way to
  notice.

**Why they are waiting:** each is understood, none loses work silently,
and all four are documented. They are the price of the design rather
than defects in it.

## A review lane for yjs-server

When two people set the same thing to different values in yjs-server,
the later one silently wins and nobody is told.

**Why it is waiting:** this one is decided, not deferred. It is stated
on the settings screen and pinned by a test. Building conflict review
for this engine means first building conflict detection, which its
design is specifically built to avoid needing. That is a research
project, not a feature.

The same applies to showing people what was stripped out of their
content for safety reasons. Today it is stripped and corrected silently.

## Quieter review cards when there are many

The pending-edit cards sit open in the canvas. With many conflicts at
once, that could get busy. The idea is to collapse them to a single line
after the first few.

**Why it is waiting:** we do not know that it is a problem. It needs
someone using it in anger first.

## Sending our changes back upstream

Three things we carry that ideally live elsewhere: our changes to the
copy of Gutenberg inside this repo, a speed fix to the y-php library,
and a fix for a login race in a test helper we work around locally.

**Why they are waiting:** each means talking to another project, which
is a person's job rather than an agent's.

## Sending a lone editor's changes right away instead of holding them

A tab editing alone holds its changes in the browser until another
editor arrives, a save, or the tab going hidden. The simpler design
sends them after the usual short delay: it removes the save middleware,
the hidden-tab flush, the pause state, and the waiters, and it makes
each change durable sooner. The cost is one request per typing burst
while alone.

**Why it is waiting:** holding is the shape the "discard" unsaved-changes
policy needs ([room-lifetime.md](room-lifetime.md)), where a room follows
saves and unsaved work is exactly what the editor's own warning says it
is. Reviewers were right that sending is simpler; we chose holding on
purpose. If the policy flips to "keep", take the simplification in the
same change.

## New engines, new transports, and two pieces of interface

Not planned. The history slider and the hover-to-see-who-wrote-this
interface both have their data available already, but no interface work
is scheduled.
