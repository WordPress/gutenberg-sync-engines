# Architecture and code review, 2026-10-07

Reviewed at commit `113c5dab1c` (branch `review/arch`). Five reviewers
worked in parallel, one per question, reading the code and docs. Each
wrote a detailed report, kept beside this file in `2026-10-07/`. This
file is the consolidated answer. Every claim featured here was checked
against the code a second time before it was written down.

Nothing was changed in the repository during the review. What was run:
Jest (775 tests), the type check, the intent-log simulator sweep, and
the automerge-php conformance suite. All passed. PHPUnit, the browser
tests, the fuzzer and the benchmarks need a running environment and
were judged from their code and from recent CI runs instead.

Four project words are used throughout. An **engine** is the part that
merges everyone's edits (there are three: intent-log, yjs-server and
de-rtc). A **transport** is the way updates travel between browser and
server. A **room** is one shared document, usually a post. A **row** is
one stored entry in a room's history. Other project words are in
`docs/glossary.md`.

## Bottom line

**The ideas are right. The shape of the code and the docs is not.**

The seven principles, the decision to keep the server in charge, the
plugin-owned tables, and short polling as the base transport would all
survive a rebuild. What would not survive is the count of things.
There are three engines, built to be compared, and the comparison is
finished. The settings screen offers six ways to receive updates. One
2,586-line file handles polling, streaming and the peer channel,
switched by true/false flags. And the operations guide (`AGENTS.md`)
has quietly become the best description of how the system behaves.

The test suite is the strongest part of the project. Everything CI runs
is green, with zero flaky retries in the last three trunk runs. The
cross-language contract for the intent-log engine is real and checked
in both directions. The gaps are suites that exist but never run in CI.

Seven real defects fell out of the reading. None is an architecture
problem; all are listed first because they can be fixed this week.

## 1. Defects found along the way

All confirmed by reading the code. None was executed.

| # | What | Where | Risk |
| --- | --- | --- | --- |
| 1 | The de-rtc review route checks only `edit_posts`. It has no per-post check and does not require `unfiltered_html` when a reviewer restores a block that was held back for unsafe HTML. Restoring marks that HTML as approved for every later edit. An author who cannot post scripts could approve their own. The only check is in the browser. | `includes/engines/de-rtc/class-wp-de-rtc-review-controller.php:65-67`, `class-wp-de-rtc-engine.php:1599-1607` | Security. Needs an issue and a test. |
| 2 | A misplaced parenthesis puts `&&` inside `class_exists()`. The "access token is not configured" notice can never show. If the class were missing, the line would fatal instead of being guarded. | `includes/admin/class-gutenberg-sync-engines-settings.php:918` | Admin UX. One-line fix. |
| 3 | The `sse-daemon` transport reads its stream URL from the websocket URL option, but the settings screen shows that field only when the websocket transport is chosen. An admin who picks "SSE from the daemon" cannot see or change the address it uses. | `class-wp-sync-sse-daemon-transport.php:118`, `settings.php:934` | Admin UX. |
| 4 | Over the websocket transport, the daemon sends `type: 'error'` frames for a 403, a 409 engine mismatch and an invalid room. The browser ignores every frame that is not `type: 'sync'`. A refused room looks connected and silently receives nothing. The websocket client also has no connection limit, so a fourth tab is never refused. | `src/providers/websocket/websocket-manager.ts:378`, daemon `:1700-1717` | Silent failure. |
| 5 | The intent-log read path checks a saved position before any read has filled it. On every fresh request that position reads as zero, so `load_room()` reads and decodes every row in the room on every check-in from a quiet tab. The PHPUnit query-count test does not see this because its storage object keeps the position across dispatches. | `class-wp-intent-log-engine.php:1202`, `class-wp-sync-table-storage.php:477,527` | Performance. Needs a cold-request measurement, then a fix (check after the read, as the other two engines do). |
| 6 | The code that sends de-rtc edits to the server hides every failure without a log and retries forever every 2 s. A save that the server refuses with a 409 reaches the editor as a generic "empty content" error because nothing reads the stored reason. | `src/engines/de-rtc/session.ts:395-411`, `class-wp-de-rtc-base-version-preflight.php:162-168` | Silent failure. |
| 7 | De-rtc never passes the post id when it sets up its "who is editing" tracker and never destroys it on unload. Its check timer keeps running after the post is gone. | `src/engines/de-rtc/engine.ts:295-298,633-641` | Leak. |

Likely but not confirmed: an intent-log edit made while the websocket
is still connecting is dropped on the wire, because `sendUpdate` only
calls `connect()` and relies on initial updates that intent-log and
de-rtc return empty (`websocket-manager.ts:213-221`). Worth a test.

## 2. Would a rebuild follow the same principles?

Yes for the principles, no for the shape. The full argument is in
`2026-10-07/q1-architecture.md`.

**Keep.** Server authority over every edit. Conflicts shown to a person
instead of merged silently. Plugin-owned tables with the row id as the
cursor. Short polling as the base, with everything else an upgrade that
falls back to it. The advisory channel as a rumor that never carries
content. Diagnostics that load only in development. Byte-parity vectors
for a merge core that must agree across two languages.

**Change.**

- **One engine, not three.** The project's own history says the three
  engines were built to be compared and then one would be chosen. The
  comparison is published. All three still ship, with a settings
  dropdown, three CI jobs, a fuzz matrix and a benchmark matrix.
- They share 196 lines of PHP and 111 lines of TypeScript and duplicate
  the rest: request handling, the reply format, saving snapshots, the
  debug output (character-identical in all three), HTML safety checks,
  the starting content of a room, "who is editing" tracking, undo, and
  conflict review.
- Intent-log is the default and fits the principles best. De-rtc's one
  unique capability, merging a script's save through the ordinary save
  path, could be carried over. If three must stay for a while, extract
  the shared server code now so they stop drifting apart.
- **A wider engine contract.** The list of functions every server
  engine must provide has five entries, all about passing stored
  changes along. Everything else an engine does (starting content,
  conflict review, HTML safety, save hooks, REST routes, room reset) is
  wired up by the plugin bootstrap instead
  (`class-gutenberg-sync-engines-plugin.php:219-225`). Because the
  contract is too small, one engine's words leaked into the framework:
  `DEFAULT_ENGINE = 'intent-log'`, an `intentId` on every reply that
  says what happened to an edit, intent-log's conflict reasons
  hard-coded in the editor's review panel, and the editor reading
  `metadata.syncId`. The storage interface has the same problem: room
  meta, reset and the engine stamp are found by `method_exists` (about
  20 checks) instead of being members.
- **One receive path.** The site owner picks from six "Transport"
  entries. Combined with the three engines, the relay choices and the
  three ways a waiting stream can be woken, a support engineer can face
  about 30 arrangements. The `sse-daemon` transport has no CI job at
  all. In the browser, SSE is a flag on the polling manager (about 25
  `if (sseMode)` branches), and the websocket manager copied the
  room-syncing code and has drifted (defect 4 above). A rebuild would
  have one shared piece of code for syncing a room, with a swappable
  way to receive updates.
- **Storage written for tables.** The storage interface still works
  like the old post-meta version it replaced. The position and count
  are per-request caches refreshed only by a read (the cause of defect
  5). "Who is editing" is a storage method although it now has its own
  class. Transports check `instanceof WP_Sync_Table_Storage` in four
  places. De-rtc keeps its official document and version claim in
  `wp_options` rows that `reset_room()`, the engine-switch reset and
  `uninstall.php` never touch.
- **One configuration model.** 26 filters in two naming schemes, 10
  stored options plus one virtual, 14 constants, and at least seven
  values each settable three ways with no stated precedence. Several
  limits are hard-coded on both sides and must agree by hand. Uninstall
  removes the two tables and nothing else.
- **Drop the de-rtc tamper check's second copy.** The check is written
  twice, in PHP and in TypeScript: 1,109 lines of TypeScript including
  a hand-written SHA-256, 497 lines of PHP and 75 test fixtures. By its
  own comments it "never affects the merge", and any client can skip it
  by sending nothing. Keeping intent-log in two languages is worth the
  cost; this is not.

**Keep for now, plan the exit.** Bundling a Gutenberg fork inside the
plugin is honest while the SPI is unstable, but it is not an end state.
The list of retained framework changes is scattered, and "defer to a
standalone Gutenberg" has no compatibility check beyond three
interfaces existing.

## 3. Is the documentation complete and current?

Mostly accurate on names and numbers, wrong where things changed
recently, badly layered, and missing the site owner entirely. Details
and an 86-claim audit table are in `2026-10-07/q2-docs.md`.

**Accuracy.** Of 86 claims checked: 63 verified, 16 stale, 5 wrong, 2
unverifiable. The wrong ones cluster:

- Two docs say de-rtc commits "immediately" by default
  (`docs/plan/history.md:52-56`, `docs/de-rtc-fidelity.md:30`). The
  default is 10 seconds.
- `docs/data-flow.md:297` says de-rtc keeps a Yjs document in the tab.
  It does not, and the changelog says so.
- `src/providers/http-polling/README.md` still describes post-meta
  storage, a 1-second cadence and two engines. It is the only place the
  wire envelope is written down.
- `docs/plan/advisory-channel.md` names a file that does not exist
  (`save-flush.ts`), counts five screen entries where six exist, and
  says both "no safety poll" and "25 s safety poll".
- `AGENTS.md` says CI runs on `main`. It runs on `trunk`. It says the
  vendored y-php has one local change; there are two.

**Where text lives.** The stated rule is: `AGENTS.md` is operational,
`docs/` is conceptual, `docs/plan/` is planning, the changelog is
shipped. It does not hold. About 540 of `AGENTS.md`'s 1,115 lines (48%)
repeat a `docs/` page. Others describe how the system behaves but have
no `docs/` page to live in: the SSE hidden-tab rules, the storage cache
strategy, every engine's known gaps, the vendored-library notes. Two
`docs/` pages send readers to `AGENTS.md` for facts. `docs/plan/` holds no plans; it holds
history, a wontfix list and two shipped designs. `docs/README.md` omits
eight prose files and describes `plan/` wrongly. `LOOP.md` says it is
not a ledger while three other files say it is.

**Missing readers.** No page exists for a site owner (install,
activate, pick a transport, verify) or a host operator (upgrade,
uninstall, what breaks when Redis dies, what to monitor). No settings
reference, storage schema, wire-protocol page, security page, or
"how to add an engine" page. Each exists in fragments across four to
six files.

**Consolidation.** The doc reviewer proposed a target structure that is
specific enough to execute:

- Seven new or moved `docs/` pages: getting-started, settings,
  operations, storage, protocol, security, extending,
  vendored-libraries.
- `sse-daemon.md` merged into `transports.md`. `LOOP.md` deleted. The
  polling README cut to pointers. `AGENTS.md` trimmed to 350-400 lines.
- A doc-lint in CI. Paths and option names in backticks must exist in
  the code. Links and anchors must resolve. The index must list every
  doc. Retired terms may appear only beside words like "retired" or
  "removed".

## 4. Are the code paths easy to follow?

Traceable with the map open, not without it. Full hop lists for five use
cases are in `2026-10-07/q3-code-paths.md`.

**Counts.** One keystroke from editor A to editor B's canvas crosses 16
files under intent-log, 17 under yjs-server and 23 under de-rtc, and
changes form 16, 10 and 23 times. In every engine the stored row is
JSON inside JSON inside a JSON column. Opening a post under the default
pair is 28 hops across 17 files.

**The biggest followability cost.** Intent-log, the default engine,
does not use the framework's `createSyncManager`. It is a second,
hand-written manager of 2,436 lines. A reader who starts at the
framework entry point is on the wrong path. This is also why intent-log
re-implements review fan-out, undo wiring and awareness lifecycle that
the framework already provides.

**Files that are too large.** Ten files over 1,200 lines. Two hide
state machines:

- `polling-manager.ts` (2,586 lines) has 36 module-level mutable
  variables, 16 of them booleans and 6 timers. The code never names its
  modes. It works out the current mode again from five or six flags on
  each call. Four separate variables all mean "check for updates now".
- `intent-log-manager.ts` (2,436 lines) has a 715-line `loadEntity`
  with six nested handlers and a 331-line `update`. Its 26-field entity
  state encodes six phases as flag combinations.

The three PHP engines (1,690 to 2,908 lines) share one skeleton written
three times. Several blocks are byte-identical. None of this is frozen
code. `class-wp-de-rtc-engine.php` has 48 methods for a 5-method
interface, a 300-line `ingest_proposal`, and writes the commit pipeline
twice (once for ingest, once for healing external saves).

**Transports.** The http-polling and websocket clients duplicate the
room envelope, generation restart, row application and token minting.
On the server, the request schema, permission check and "read since
cursor, attach awareness, attach generation" step exist three times
(REST, SSE, daemon). The daemon's errors lose their HTTP status and
payload on the wire.

**Vocabulary.** Mostly consistent. Six words carry two or three
meanings each. "Frame" is both a region of an edit and a wire message.
"Register" is both a synced field and the act of registering an engine.
"Version" is both de-rtc's document version and the storage change
counter. "Snapshot" is both a stored row type and de-rtc's never-stored
answer. "Proposal" is both a de-rtc submission and an intent-log edit
awaiting review. "Announce" is both a de-rtc row type and the peer
channel's "go and poll" message, which prose and the UI also call
notice, nudge or announcement.

**Comments.** 30 to 54 percent of lines. About two thirds of the
history narration states an invariant the code depends on and should
stay. The rest ("found by the fuzzer on...") belongs in
`docs/plan/history.md` or in the name of the test that pins it.

**Dead code.** The y-websocket peer-relay fixture lane (a setup file, a
fixture plugin still mounted by wp-env, and a daemon script no script
runs). The client compaction-request lane that no engine answers. The
typed `syncWhileSolo` flag, which nothing reads because the manager
reads an untyped `sendsWhileAlone`. Thirteen exports with no importer.

## 5. Does the prose follow the guidelines?

Public prose yes, internal prose no. Scorecards and measurements per
document are in `2026-10-07/q4-prose.md`.

**Good.** `README.md`, `docs/data-flow.md`, `docs/plan/history.md`,
`docs/plan/wontfix.md`, `docs/plan/README.md` and
`docs/gutenberg-subtree.md` follow the rules. `docs/data-flow.md` is the
best page for a newcomer: it defines room and row in one sentence each
before using them. `docs/engine-comparison.md` has the best opening
line in the repo ("Short answer: start with intent-log"). The shaped
GitHub issues are the strongest prose discipline in the project: 8 of
10 pass every rule.

**Bad.** `AGENTS.md` breaks every rule it sets at its top. Measured:
mean sentence 20.5 words with a maximum of 135; 32 sentences over 40
words; 341 parenthetical asides in 103 paragraphs; 131 em dashes; 9
arrow chains; 12 bullet paragraphs over 150 words, the largest 937. It
uses the project's invented words from line 35 and first names the
glossary at line 393. The word "lane" is used for ten different things;
the glossary defines one.

**The settings screen.** The one place a site owner decides, and all
three engine descriptions use glossary words: "escalate for review"
(send to a person to look at), "No review lane" (no conflict review),
"operational transform" (merges edits by adjusting positions), and
"(0 = every settle)" (after every pause in typing).

**The glossary.** Plain, but about 25 frequently used terms have no
entry: stream, canonical, proposal, base version, lane, company, quiet,
CAS, wire, framing. Four entries are nearly unused.

**The novice walkthrough.** An engineer who knows WordPress but not
CRDTs can learn what the plugin does from the README and pick an engine
from the first 75 lines of `docs/engine-comparison.md`. They cannot find
out how to see two tabs collaborating: the URL, credentials, plugin
activation and "open one post in two windows" exist only in `AGENTS.md`,
which the README never points to. The README links two operational
docs and neither `docs/README.md`, `docs/data-flow.md` nor
`docs/engine-comparison.md`.

## 6. Are the tests and benchmarks sound?

Yes, and they are the strongest part of the project. The gaps are
suites that exist but never run in CI. Counts, samples and the CI
assessment are in `2026-10-07/q5-tests.md`.

**What runs and passes.** Jest: 63 suites, 775 tests, 4 seconds, no
skips, no `.only`, no snapshots. Type check: 2 seconds. Simulator sweep
at full size: 17,114 intents, all oracles green, 4 seconds.
Automerge-php: 680 of 680. CI: nine jobs, 13 minutes wall, nothing
allowed to fail. The last three successful trunk runs show zero flaky
retries in any browser lane.

**Quality.** The suite tests behavior, not implementation. Names read
as a specification ("both users typing on an EMPTY post converge
without deleting each other", "never applies an event cut off by a
killed PHP process"). Mocks replace neighbors, never the thing under
test. Flakiness is being fixed at the root (a bounded login request
with its own regression test, CPU-throttle knobs to reproduce slow
hosts, per-keystroke delays that make a race deterministic) rather than
papered over. The one known intermittent has an issue and a stated
rate. The weak spot is 33 fixed sleeps in the browser specs, used as
"nothing more happened" windows; they are commented as deliberate and
are the first thing a slow host will break.

**The contracts.** The intent-log vectors are one frozen artifact kept
in two byte-identical copies, replayed by both Jest and PHPUnit, with a
parity test that fails when only one copy is regenerated. Sound. The
de-rtc descriptor contract is one-directional: PHP generates the
fixture and only TypeScript replays it, so a PHP-side change is
invisible until someone regenerates. The simulator oracles check real
properties (convergence of acked and optimistic state, no lost intents,
verifiable effects, attribution), not snapshots.

**Not in CI.** The `sse-daemon` browser lane (5 tests; the only
transport with no CI record). The fuzzer (manual only; no last-run
record anywhere). The full-size sweep (CI runs a fifth of it inside
Jest). The fuzzer's own runner test.

**Benchmarks.** Sound single-run method: three repetitions, one
warm-up, p50/p90/p99 with standard deviation, an environment stanza, a
compare script that warns when workloads differ. CI enforces only the
rule that no edit is ever lost. No number is tracked over time, so a 2x
regression in ingest cost would be found only by a person running the
suite by hand. The "number-free docs" policy is right for the docs but
it hides that there is no backing series.

**First impression.** `npm test` fails with "Missing script". The
sweep prints a Node module-type warning before its result. Two files
that define the frozen contract cite paths that no longer exist.
`AGENTS.md` names the wrong CI branch.

**Untested surfaces.** `webrtc-link.ts` (723 lines, no direct unit
test), the `sse-daemon` transport end to end, the slow-awareness UI
(842 lines, one browser test), and about 860 lines of WP-CLI commands
with no tests.

## 7. Ranked recommendations

Merged across the five reviews and ordered by value for cost. Size: S
is a day, M a week, L several weeks.

**This week (S).**

1. Fix defects 1 to 7 in section 1. File an issue for defect 1 first.
2. Add the `sse-daemon` lane and the full-size sweep to CI. Add an
   `npm test` script that runs the no-Docker layers. Fix the Node
   module warning.
3. Fix the five wrong doc statements and the stale paths in the two
   frozen-contract test headers.
4. Add a "Try it in two windows" section to the README and link
   `docs/README.md`, `docs/data-flow.md` and
   `docs/engine-comparison.md` from it.
5. Rewrite the three engine descriptions on the settings screen in
   plain words.
6. Delete the dead y-websocket fixture lane, the compaction-request
   lane and the thirteen unused exports.

**This month (M).**

7. Decide the engine question in writing. Either retire two engines or
   extract the shared server base (request boilerplate, read envelope,
   checkpoint tail, debug stash, kses helper, genesis skeleton) so the
   three stop drifting. Deleting is cheaper than extracting; extracting
   is cheaper than three more months of parallel fixes.
8. Execute the documentation consolidation in `q2-docs.md` section 6:
   move behavior text out of `AGENTS.md` into owned `docs/` pages, add
   the site-owner and operator pages, delete `LOOP.md`, and add the
   doc-lint to CI.
9. Share the room envelope and restart between the http-polling and
   websocket clients, and fix the websocket error-frame and connection-
   limit gaps while there.
10. Surface the de-rtc failure paths: log commit failures with a
    backoff, return the stored save error instead of "empty content",
    check the announce-row store result.
11. Make the de-rtc descriptor contract two-directional with a PHPUnit
    replay, or drop the descriptor lane (section 2).
12. Run `fuzz:quick` on a schedule and upload its summary. Upload one
    benchmark JSON per CI run and compare against the previous trunk
    run with a loose threshold.
13. Add the missing glossary entries and link glossary words at first
    use in the three densest docs.

**This quarter (L).**

14. Widen the engine and storage contracts in the framework (genesis,
    review, reset, save-path participation, route registration; room
    meta, reset, versions, change notice). Rename `intentId` and the
    review vocabulary to engine-neutral names. This is one framework PR
    and it makes every other refactor cheaper.
15. Make the polling manager's state explicit: a named receive mode and
    a named send lane set in one place, then split the file into
    request builder, room envelope, cadence, page lifecycle and errors.
    The 3,000 lines of cadence tests are the protection.
16. Split `class-wp-de-rtc-engine.php` along its fourteen jobs with one
    shared commit step and value objects for proposal, state,
    disposition and announce.
17. Split `intent-log-manager.ts` into properties, baseline (as a class
    with named phases), recovery, review and collections. Write a
    design note on running intent-log through `createSyncManager`
    before touching that.
18. One configuration model: one prefix, one documented precedence,
    a stored delivery option, shared limits emitted into page settings.

**Do not touch.** The intent-log JS core and its PHP twins,
`merge-core.php`, the vendored libraries, and the `gutenberg/` subtree.
Their costs (untyped arrays, an unreachable Automerge branch, whole-tree
work per keystroke in core-data) are known and are either frozen by
contract or belong upstream.

## 8. Things that look wrong but are right

Listed so the next reviewer does not re-open them.

- **A lone tab holds its edits in the browser.** It is what the default
  "discard unsaved changes" policy needs. If the policy flips, take the
  simplification in the same change (`docs/plan/wontfix.md`).
- **De-rtc commits through the autosave endpoint, not the sync
  channel.** That is the engine's point: anything that can save can
  collaborate, including scripts.
- **The 1.2-second capture delay in intent-log.** core-data hands the
  sync manager an edit before committing it, so a push made inside
  `update()` is overwritten. Deterministic, not a race.
- **A saved snapshot every 500 rows for intent-log, 100 for the
  others.** Saving that often landed mid-typing and cancelled edits
  that were still being sent.
- **yjs-server registered first although intent-log is the default.**
  Registration order only decides the fallback for a misconfigured
  slug.
- **Collection rooms reset on an engine switch while post rooms keep
  the fence.** Collection rooms are rebuildable feeds; post rooms can
  hold unsaved content.
- **yjs-server has no review lane.** A decided non-goal, not a gap.
- **Two byte-identical copies of the intent-log vectors.** Each sits
  with the suite that replays it, and the parity test is what fails
  when only one is regenerated.
- **Diagnostics never load in production.** A deliberate gate with a
  constant to opt in.

## 9. Not verified

- Whether defect 5 costs what the reading suggests under the table
  storage on a real request. The pattern is confirmed; the cost is not
  measured.
- Whether the websocket connecting-window edit loss happens in
  practice.
- Whether defect 1 is reachable from the editor UI. It is reachable
  over REST by the code.
- The size of the framework fork relative to upstream trunk.
- Any performance number. The benchmarks were not run.
