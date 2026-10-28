# Conflict review

When two people change the same part of a post at the same moment, the
server may keep one change and set the other aside for a person to
decide. This page is how that decision is shown and applied: the one
record shape every engine publishes, the cards and dialogs in the
editor, what each engine does with a decision, and the rules that hold
it together. The code is in `src/review/`.

## What a person sees

- A block whose change was set aside becomes a **card** in its place:
  "This block has conflicting edits." with a "Review conflict" button
  and a word-level preview of the difference. The block is read-only
  until someone decides. When the record covers several neighbouring
  blocks, the card sits on the first one and the others are hidden
  from the editing area until the decision; the card shows all of them.
- "Review conflict" opens the **merge dialog**. It shows the proposed
  version and the current version, each highlighted against the
  version both started from (the base), and a "Merged result" below
  that the reviewer can edit. Each version has "Restore this version".
  Accept applies the merged result for everyone.
- A **table** gets the same dialog with grids instead of text, and a
  suggested merge as the starting result.
- A block held back by the security filter (`wp_kses`, the
  `unfiltered_html` capability) shows a **held block card** with the
  held markup as inert text. A person allowed to publish unfiltered
  HTML can open it, then approve, edit, or remove the block.
- A change with no block to show it on, such as a post title or a
  proposed new block, is listed in the **"Changes to review"** panel in
  the document sidebar, with "Use proposed" and "Keep current".
- The card waits while its author is still typing in the block (1.2
  seconds of quiet, 20 seconds at most), but only when the engine
  promises that the later typing joins the same record. Other windows
  show the card at once.
- An open dialog follows a change a collaborator makes meanwhile. The
  merged result follows too, unless the reviewer already edited it. A
  notice says which happened.
- A decision made against content that changed since is refused. The
  card stays, nothing is written, and a notice asks the reviewer to
  look again.

## One record for every engine

`src/review/types.ts` defines the record. An engine publishes its open
conflicts as records and takes decisions back; the engine applies every
decision, and the review code never writes to the post itself.

A record carries:

- `kind`: `merge` (the server could not merge the change) or
  `sequestration` (the change needs the `unfiltered_html` capability).
- the author of the proposed side;
- the target: a run of blocks (their durable block ids, the parent, the
  index, and a count that is 0 for a proposed new block) or a post
  field;
- three sides as serialized block content, or as text for a field:
  `proposed`, `current`, and `base` (null when the engine no longer has
  the starting version);
- `followsTyping`, the promise that the author's later typing in the
  same blocks joins this record.

A decision is `accept` with the merged content, or `dismiss`. An
accept also names the `current` side the reviewer saw. The outcome is
`resolved`, `stale` (the content changed first, nothing was written),
or `failed` (the decision did not reach the server).

Each engine registers one source (`src/review/conflicts.ts`,
`registerConflictSource`) through the shared per-post helper in
`src/review/entity-source.ts`. The helper keeps the list for each post,
and the engine tells it when a record opens, closes, or changes a side.

## The review code

| Piece | Job |
| --- | --- |
| `src/review/conflicts.ts` | The registry: sources, the open list per post, and `resolveConflict`, which refuses an accept as `stale` when the record's `current` moved on, before the engine sees it. On a refusal it wakes the subscribers, so the card and dialog show the newer content. |
| `src/review/entity-source.ts` | The per-post helper every engine uses to publish records. |
| `src/review/typing-hold.ts` | The typing wait: 1.2 seconds of quiet, 20 seconds at most. |
| `src/review/revisions-diff.ts` | Unlocks the editor's revision comparison, and says whether it exists (`hasBlockDiff`, `hasCodeDiff`). |
| `src/review/views.ts` | A block type can replace the dialog for its own conflicts. The table block does. |
| `src/review/hooks/review-cards.jsx` | The editor filter that swaps a conflicted or held block for its card. It stands down inside a review dialog (`ReviewSurface`). |
| `src/review/hooks/span-blocks.jsx` | Hides the later blocks of a multi-block record while its card is up, with their editing mode disabled. |
| `src/review/components/` | The cards, the merge dialog, the table dialog, the held-block dialog, the sidebar panel, and the text comparison used when the revision comparison is missing. |

Each dialog is keyed on its record id, so when a different record takes
the same block while a dialog is open, the dialog starts over for the
new one rather than carrying the merged result built for the old one.

The components are JavaScript with type checking off; the registries
and types are TypeScript. The tests are in `tests/js/review/`.

## What each engine does

**intent-log** builds records from its own history of edits
(`src/engines/intent-log-conflicts.ts`). Set-aside edits by one person
on the same block or field are one record. A block record covers one
run of neighbouring blocks, from the first block the edits touch to the
last, and widens to a block another person split off or merged in the
meantime. The base is the document at the oldest edit's position in
the history; the proposed side is the author's edits replayed onto it,
at the position the author typed them, with the blocks in between read
from the current document. Accept writes the merged result as a new
edit under the reviewer's account and closes the set-aside edits behind
it. There is no server route: the result is an ordinary edit the server
merges or sets aside. The server remembers each person's set-aside
edits between requests (the planner's seed, see
`src/engines/intent-log/SPEC.md`), so the typing that follows a
set-aside keystroke is set aside into the same record instead of
landing at the wrong place, and a clash sets the whole typing burst of
that request aside rather than letting its first keystroke through.
When another person removed the conflicted block in the meantime, an
accepted result puts it back where it sat, next to the neighbours that
survived.

**de-rtc** stores each set-aside block together with its base form, so
the dialog has all three sides. Its route (`POST
/wp-sync/v1/de-rtc/resolve`) takes `accepted` with the merged content,
replaces the blocks and closes the record in one request, and refuses
with HTTP 409 `review_stale` when the record's blocks changed between
the version the client names and the current one. Restoring a held
block needs the `unfiltered_html` capability, the same as accepting
one, because restoring marks the held markup as approved. A field that
is not text, such as the categories list, is stored as its real value.
The current side of a block record is read from the newest content the
server announced, never from the author's own document, which still
holds the set-aside text. A newer record from the same person on the
same blocks replaces the older one. While a person has an open record,
their waiting text is sent at the first pause in typing instead of at
the commit interval.

**yjs-server** never raises a merge conflict, because the CRDT merges
everything. It holds markup the security filter strips: the cleaned
block lands at once and the stripped markup is kept as a hold, one open
hold per author and block, until a reviewer approves, edits, or
discards it over `POST /wp-sync/v1/yjs-server/resolve`. A hold follows
its block by id, so a cleaned or approved block keeps its id. Removing
the block closes the hold. Open holds survive the server's routine
deletion of old rows, and the closing row is stored before the server
forgets the hold.

Both routes check that the caller can edit the room's post
(`WP_Sync_Review_Permissions`), the same check the sync transport
makes, and approving held markup needs `unfiltered_html`.

## Rules every engine follows

1. Conflict data reaches the editor through the registry, never
   through a new data store.
2. The engine applies the decision and closes the record. The review
   code never writes to the post.
3. A decision lands only on what the reviewer saw. The registry refuses
   an accept whose `current` moved on; de-rtc and yjs-server make the
   same check on the server. Dismiss is never refused.
4. A record is published again when a side changes, not only when it
   opens or closes.
5. `followsTyping` is a promise that later typing joins the record. Only
   then does the card wait. de-rtc promises it on every block record,
   intent-log on `merge` block records, yjs-server never.
6. The dialogs mount block editors whose blocks carry the same ids as
   the document, so everything inside a dialog is wrapped in
   `ReviewSurface`, or cards would render inside the dialog.
7. The bundled Gutenberg differs from its pin by one thing only: the
   editor package exports its revision comparison. A standalone
   Gutenberg does not have it, so the dialogs check `hasBlockDiff` and
   `hasCodeDiff` and fall back to a text comparison. A new use of those
   names needs the same check.

## Known gaps

- The base can be missing: intent-log drops the history at clean-up,
  and de-rtc has none for post fields or for the two-people-at-once
  case it shows as Adopt/Reject. The dialog says so.
- The typing wait also delays the card in a reviewer's window when
  their cursor is in the block.
- The hidden blocks of a multi-block record are still in the document.
  The list view shows them, disabled, and a drag there can still move
  one.
- Only intent-log widens a record to a block someone split off.
- A decision that fails for a reason other than changed content brings
  the card back with no message.
- After a dismiss under intent-log, the author's next keystrokes open a
  new record until their editor notices the clash.
- Under yjs-server the dialog's current side is the cleaned block as
  the server last recorded it, not the live block, so the first
  approval after a collaborator's edit is refused once.
- A table comparison lines cells up by position when labels cannot do
  it, so it cannot follow a row or column inserted in the middle.
- yjs-server does not sync Custom HTML markup, so its common real case
  cannot be shown yet.
