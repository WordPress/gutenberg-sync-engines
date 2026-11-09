# Things we decided not to do

Each item says what the idea is and why it waits. The reason matters
more than the idea: it tells you whether the reason still holds when
you come back. Open work lives in GitHub Issues; nobody should start on
one of these without filing an issue first.

- **Shrinking a long yjs-server session's stored history.** A room's
  stored document grows as people edit. A size ceiling stops it getting
  out of hand, but nothing shrinks a room that has grown large. *Why it
  waits:* shrinking needs a second change with it: keeping the
  server's main copy current as edits arrive instead of rebuilding it
  each time. Both change the same code and need the same answer for
  what open editors do when the document changes under them.
- **Storing the shared document in the post itself.** Today the shared
  working copy lives in its own tables. The original Distributed Editing
  design keeps it in the post content, with revisions as the backup.
  Every de-rtc save already writes the sync information into the post.
  *Why it waits:* it changes where the truth lives for every engine, so
  it is its own project.
- **Four intent-log limits we accept.** Edits not yet sent are lost if
  the tab reloads (undo makes this visible). Typing into a paragraph a
  colleague is editing, before their change has arrived, sends the later
  keystrokes to review instead of merging them. A script cannot send
  typed edits directly; it can only save with a declared starting
  version. A script that overwrites a post without one goes unnoticed.
  *Why they wait:* each is understood, none loses work silently, and
  they are the price of the design rather than defects in it.
- **A review lane for yjs-server.** When two people set the same thing
  to different values, the later one silently wins. *Why it waits:*
  this is decided, not deferred. The settings screen says so and a test
  pins it. Conflict review needs conflict detection first, which this
  engine's design is built to avoid. The same applies to showing people
  what was stripped from their content for safety: it is cleaned
  silently.
- **Quieter review cards when there are many.** The pending-edit cards
  sit open in the canvas; with many conflicts at once that could get
  busy. *Why it waits:* nobody has hit it yet.
- **Sending our changes upstream.** Three things we carry belong
  elsewhere: our changes to the bundled Gutenberg, the speed fix in the
  vendored y-php library, and a fix for a login race in a test helper.
  *Why it waits:* each means talking to another project, a person's job.
- **Sending a lone editor's changes right away instead of holding
  them.** A tab editing alone keeps its changes in the browser until
  someone else arrives, a save, or the tab going hidden. Sending them
  after the usual short delay would be simpler and make each change
  durable sooner, at one request per typing burst. *Why it waits:*
  holding is what the default "discard unsaved changes" setting needs,
  where the shared session follows saves. If that setting ever flips to
  "keep", take the simplification in the same change.
- **New engines, new transports, a history slider, and
  hover-to-see-who-wrote-this.** Not planned. The last two have their
  data available already; no interface work is scheduled.
- **Making the bundled Automerge library do real work.** The shipping
  de-rtc merge never calls it. *Why it waits:* the reasons for and
  against are in issue #44.
