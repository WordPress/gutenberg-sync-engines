# Traps

Things that have bitten before. Each is a fact about this codebase or
its tools that is easy to get wrong and expensive to rediscover. Read
this before a big change. The environment and test traps are in
`AGENTS.md`; these are about the code.

## Rules that must not be undone

- **De-rtc's sync channel must never carry the document.** It used to,
  and long sessions ran the server out of memory as messages grew with
  the post. A notice now carries a version number and a content hash,
  and a client that already matches downloads nothing. Never put a
  `content` entry into de-rtc's list of synced properties: it silently
  re-sends the whole document with every notice.
- **A de-rtc tab waits for the merged version before it sends its next
  change.** When the server merges other people's work into a tab's
  change, a newer version exists that the tab does not hold yet
  (`pendingOwnMergeSeq`, the flag that says the tab is waiting, is set).
  A change built on the old version makes
  the server treat the tab's own accepted keystrokes as a conflict and
  hold them back; the end of what the person typed was lost with no
  warning on slow hosts. `tests/js/engines/de-rtc/announce.test.ts`
  pins it.
- **An editor save under de-rtc waits for the session's in-flight
  commit** (`prepareForSave`), so a save can never conflict with the
  session's own commit. The fuzzer found that one.
- **yjs-server stores each block's saved HTML beside the block, but
  never reads the text inside that copy.** The live shared text always
  wins; a test exists only to prove it. Without that rule a stale copy
  overwrote someone's typing.
- **intent-log saves a full snapshot every 500 changes, not 100.** The
  smaller number crossed mid-typing and threw away edits still in
  flight.
- **De-rtc commits every ten seconds by default.** Setting it to 0
  commits after every pause in typing; that was the first release's
  default, changed because ten seconds measurably cuts requests.
- **Four pieces of code are frozen: do not edit them casually.**
  - The intent-log core (`src/engines/intent-log/`) is kept identical
    to its PHP twin (`includes/engines/intent-log/`) through JSON test
    vectors kept in two copies, `tests/js/engines/intent-log/test-vectors/`
    and `tests/phpunit/test-vectors/`. Regenerate with the
    `tests/tools/` generators and always update both. A JSDoc-only edit
    is fine.
  - The de-rtc merge core (`includes/engines/de-rtc/merge-core.php`) is
    a verbatim port; its two local changes are marked `DELTA`.
  - y-php (`includes/lib/y-php/`) carries two deliberate local changes
    to preserve when re-vendoring: the `composer.json` platform pin to
    PHP 7.4, and the rewritten
    `includes/lib/y-php/src/Lib0/StringDecoder.php` (decoding used to
    slow down sharply as documents grew).
  - automerge-php's runner leaves `PORTING_STATUS.json` alone unless
    `AUTOMERGE_PHP_UPDATE_STATUS=1` is set. Two of its 680 tests fail
    under a PCRE2 older than 10.43, which distribution PHP builds link;
    check `php -r 'echo PCRE_VERSION;'` before blaming the library.

## Dead ends: do not retry these without new information

- **Fixing jumbled fast typing by changing when old log entries are
  deleted.** Three attempts, all partial. Deleting later made it rarer;
  waiting until nobody is typing did not close it. The
  remaining fix is the cause: a table keystroke writes three history
  entries instead of one (issue #37).
- **Recovering a lost edit by asking the editor for the post's current
  state.** The obvious call returns nothing for some block shapes. Keep
  a reference to the last block tree the editor handed over and re-read
  that.
- **Syncing buffered work the moment the first message arrives.** The
  first message is only the first of a burst, and the rest arrives right
  behind it. Acting at once duplicated every saved block. Wait until the
  burst is over, then check whether the work is still needed.
- **Reading the soak test's per-minute numbers as rates.** They are
  running totals. Subtract before concluding.
- **Writing a change into the editor from inside `SyncManager.update()`.**
  core-data hands the sync manager the edits BEFORE it saves them, and
  every editor edit carries the editor's own block tree, so that save
  replaces any `editRecord` made during the call. This is
  deterministic, not a race. A change that reacts to the editor's own
  edits must be written later, after the call returns (intent-log
  waits until typing pauses; see `scheduleEditorSync`). Changes written
  from a transport callback work normally. The symptom is an editor
  whose blocks silently never get their syncIds.

## Code facts that look wrong but are right

- **A room remembers the engine that first wrote it**, and the
  transport answers HTTP 409 to a tab speaking another engine. Rooms
  not tied to one post are reset when a tab speaking the new engine
  arrives; per-post rooms are not, because they can hold unsaved
  content.
- **The storage's `get_cursor()` and `get_update_count()` are
  per-request caches refreshed only by `get_updates_after_cursor()`**,
  kept that way from the framework's post-meta default on purpose. Do
  not decide anything from them before a read has run.
- **The first copy of a post's blocks the server builds (genesis) must
  set `isValid: true`** on every block, or the editor renders them as
  invalid-content recovery blocks.
- **`src/awareness/registry.ts` must register the `gseBlock` presence
  field in every mode.** A peer can send the field at any time, and
  core-data throws on an unknown field.
- **The block name for slow awareness is sent with the presence data
  that already travels.** Under SSE, `announceLocalAwarenessChange`
  (`src/providers/advisory/announce.ts`) sends it beside the stream.
  Under the Heartbeat channel an advisory channel must be selected. The
  e2e spec turns the advisory channel off for its duration.
- **A page whose post already has five tabs is refused** ("Too many
  editors connected"), checked once on the page's first connection.
  Give extra test tabs their own post, or raise
  `sync.pollingProvider.maxClientsPerRoom`.
- **The daemon authenticates a stream once per connection.** A stream's
  POST body can arrive across several reads and the one-time token is
  spent on first sight; authenticating again refuses a stream that was
  already accepted. The symptoms: the daemon logs `Handshake rejected:
  Missing, expired, or mismatched token.`, the browser reports the
  stream POST as a CORS failure, and the client retries with a fresh
  token and succeeds.
- **The polling manager's "safety poll" comments are stale.** There is
  no safety timer: a tab alone schedules no polls after its 30-second
  discovery window, and a tab that can reach every peer polls on
  demand.
