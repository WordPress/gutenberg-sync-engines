# Benchmarks

One command runs everything here:

```bash
npm run bench
```

By default that prints **the host cost report** — the small set of numbers
someone hosting this plugin actually needs, each measured as the difference
against the workflow the plugin replaces:

- extra requests per minute, per person editing (and per idle open tab);
- HTTP body, SSE, and WebSocket payload traffic (KiB/min), excluding
  headers, protocol overhead, compression effects, and WebRTC traffic;
- extra PHP CPU time per minute (not database, Redis, or relay CPU);
- the extra share of one PHP worker held;
- peak PHP memory per request;
- options-cache invalidations per minute (every options-API write
  invalidates the shared options cache on hosts running a persistent
  object cache — the plugin's lock and counter primitives deliberately
  bypass that API, and this row proves it);
- database queries per minute — every query the tagged requests ran,
  from mu-plugin load onward, per person;
- database disk I/O per minute — data-file reads, writes, and fsyncs,
  sampled from the database server's own InnoDB counters at span
  boundaries. Fsyncs measure database durability work; group commit and database
  settings affect how transactions share that work — hold fsyncs/min
  against the host's storage telemetry, not as a direct device IOPS count. The counters are
  server-global, so the rows are trustworthy only when the run is the
  database's only traffic; data-file reads/writes can honestly read 0
  over short spans (reads of 0 mean the working set fit in memory,
  and page writes flush lazily in the background — fsyncs are the
  live signal); true device-level IOPS sits below what any WordPress
  request can see and remains the host's own telemetry. Log
  rows also carry the PHP process's own block I/O
  (`php_io_reads`/`php_io_writes`) — ~0 with a warm opcache, which is
  exactly the column that spikes in the cold-opcache-after-deploy
  scenario;
- logical row storage held per collaborative post at rest, and a derived
  editors-per-worker capacity estimate (whole-job totals for producing
  the same final document land in the `json=` report as `engine.job`).

The workload model follows the lowest-common-denominator assumptions the
plugin itself makes: HTTP short-polling is the default transport because it
works everywhere, every request is an authenticated POST (nothing is HTTP-
cacheable), no object cache is assumed, and the load scales per editor.
Nothing here depends on wp-cron: history is bounded on the write path, so a
quiet site with a cron that never fires holds exactly what the logical room-
storage line reports. This is row payload size, not allocated disk space
including indexes and database overhead.

Reading the report: the editing and idle tables start after editor setup, so
they exclude initial page-load and session-join costs. Tagged setup requests
remain in the raw log. CPU and query measurements start when the measurement
mu-plugin loads; earlier WordPress bootstrap work is excluded. HTTP requests
and WebSocket frames have separate rows. Socket payload bytes include
advisory messages, but only content-sync frames establish that the content
transport is WebSocket.

Server totals are **unavailable**, not zero, when the baseline was not
measured, an SSE stream was used, or a WebSocket was used (including an
advisory socket). SSE shutdown logs cannot divide a request's CPU, queries,
or occupied worker time between phases; persistent socket servers run
outside those logs. Raw request rows are retained for inspection, but the
report suppresses server comparisons, whole-job CPU totals, and capacity
estimates in these cases. Database I/O counters remain separate server-
global measurements; they are not attributed request-log costs. They also
include the measurement logger's own database writes. Use an isolated
database and keep the same measurement setup in both phases.

The JSON report (`schemaVersion: 2`) records content verification, coverage
limits, delivery choice, and polling setting alongside the raw data. Compare
runs only across identical environments. The report measures ONE engine per
run (`engine=`); comparing engines is the engines suite's job.

Fleet planning must use measured rates for the current configuration. The
advisory channel can stop scheduled polling when an editor is alone and
trigger reads on demand when peers are reachable. A missing peer link uses
the configured polling interval instead. The site default is 5 seconds; the
e2e test setup sets 1 second. Do not project daily traffic from the old
fixed 4-second solo / 1-second collaborative cadence.

Run `windows=1` to measure solo editing and idle cost, then measure several
collaborators. Record the delivery choice and configured polling setting from
the JSON report. Multiply each scenario's measured rate by the time and
open-tab count for that scenario across your platform. The host runner does
not yet provide a separate background-tab workload.

It runs two real-browser phases against a live site (the tests env: `npm run
env:tests start`). The **baseline** is the same number of people producing
the same document the old way — editing in series with the plugin
deactivated: each person completes a fixed typing script, saves, and hands
off (the post lock forces exactly this turn-taking today). Then the **sync**
phase: the plugin active and the same `windows=` people collaborating live
on the chosen engine, typing the same scripts — so both phases must finish
with the same paragraph text. The script is built before typing: a slower
browser takes longer rather than producing fewer edits. Before each save,
every open editor must contain the expected text; a REST read then verifies
the saved post. Missing, duplicate, reordered, or extra text, typing errors,
and failed saves abort the run without a cost report. Engine-specific block
metadata is excluded from this text check. The measured editing duration
includes catch-up and save verification. The RESULTS section prints two
markdown tables (editing, then idle), columns baseline/sync/delta/delta-%,
followed by the summary stats (room storage, derived capacity). The run
opens by stating the configuration it resolved (engine, transport,
durations, polling), marking defaults. Arguments target what you need:
`--engine=` (one per run — comparing engines is `--suite=engines`),
`--transport=`, `--windows=`, `--edit-seconds=`/`--idle-seconds=`,
`--polling-interval=` to override the HTTP short-polling interval for the
run (restored afterwards), `--metrics=` to print only some rows, `--json=`
for the full data — `npm run bench -- --help` prints the complete list. The
server-side columns come from the whole-request measurement mu-plugin
(`tests/benchmarks/host/mu-bench-log.php`, mapped into mu-plugins by this
repo's wp-env configs), which measures every tagged request even with the
plugin deactivated; that is what makes CPU, worker, and memory true over-
baseline deltas. One trap: it is a single-FILE mount, and Docker file mounts
go stale when git deletes or recreates the file (checking out an older
commit, rebasing) — if the report says the mu-plugin recorded nothing,
restart the env.

Local wp-env results describe that environment only. Point `WP_BASE_URL`
(with `WP_USERNAME`/`WP_PASSWORD`) at a staging copy of the real hosting,
install the mu-plugin, and define `GUTENBERG_SYNC_ENGINES_DIAGNOSTICS` to
measure that environment. The baseline temporarily deactivates the plugin;
use a disposable site or staging copy.

The editors-per-worker line is an estimate from measured request duration.
It assumes no queueing and reserves no spare capacity.
`npm run bench -- --suite=engines --concurrency=N` measures engine and
database contention through parallel CLI processes. It does not test the web server or PHP
worker queue. Neither number is a tested hosting limit.

Two more **benchmarks** live behind `--suite=` — measurements that inform
a real decision (which engine, which transport):

| Suite               | What it is                                                    |
| ------------------- | ------------------------------------------------------------- |
| `--suite=engines`   | The engine-decision matrix and invariant sweeps — the harness documented in the rest of this README. `--scenarios=`, `--certify=`, and `--concurrency=` exist only in this suite, so passing any of them selects it without `--suite=` (CI's certify job invokes it that way). |
| `--suite=transport` | Two-browser edit-to-visible latency + wire traffic per transport (`transport/README.md`). |

The **debugging and analysis tools** — lanes that generate load or
validate projections rather than answer a decision — live in
`tests/debugging/` (see its README). They are deliberately NOT
reachable through `npm run bench`:

```bash
node tests/debugging/soak-transport.mjs \
    engine=de-rtc windows=3 soak=3600      # N-window hour-scale soak that
                                           # validates the cost cards
                                           # end to end
node tests/debugging/replay/replay.mjs \
    my-session-clean.json --speed=1        # replay a captured session as
                                           # real HTTP load
```

## Community-harness compatibility

The measurement plumbing deliberately speaks the community RTC
performance harness's conventions
([WordPress/distributed-rtc-performance-testing](https://github.com/WordPress/distributed-rtc-performance-testing)),
so numbers and fixtures travel between the two toolchains:

- the same request tags (`X-RTC-Test`, `X-RTC-Scenario`,
  `X-RTC-Approach`, `X-RTC-Poll-Delay`, `X-RTC-Update-Size`, with query
  fallbacks), the same server-side log columns, and the same
  `rtc-test/v1` REST surface (`/log`, `/env`, `/report`,
  `/report-all`) with the same report table layout — the community
  repo's report tooling reads a site running this plugin natively;
- the same capture fixture format in `replay/` (our additive keys —
  `engine`, `transport`, `base_title`, `base_content` — are dropped by
  the community sanitizer and preserved by ours).

Divergences, each deliberate:

- **Approach auto-label.** When a client sends no `X-RTC-Approach`,
  rows are labeled `<engine>/<transport>` — the axis this plugin
  compares — instead of the community's storage-approach labels.
  Additive: an explicit label always wins.
- **Tagged autosave requests are measured too.** De-rtc sessions
  commit through the ordinary autosave endpoint, so their merge cost
  lives on that route; the community harness's relay had no such path.
  Untagged requests are unaffected.
- **Three extra log columns and two extra routes.** Rows carry
  `option_writes` (options-API writes during the measured window —
  the cache-invalidation count) and `php_io_reads`/`php_io_writes`
  (the PHP process's own block I/O via getrusage); the namespace adds
  `/room-size` (storage held by one room) and `/db-io` (the database
  server's disk-I/O counters — the mu-plugin also answers a tagged
  `_rtcdbio` probe with the same counters, which is how the baseline
  phase samples them while the plugin is deactivated). All additive;
  the community report tooling ignores what it does not know.
- **The MU-plugin is optional.** With
  `tests/benchmarks/host/mu-bench-log.php` in mu-plugins (this repo's
  wp-env configs map it), measurement covers the whole request from
  mu-plugin load — the community model — for ANY tagged request, even
  with the plugin deactivated. Without it, the REST lane alone
  measures, starting at plugin load, so `total_cpu_ms` slightly
  understates full-request CPU; `cpu_ms` (dispatch only) is unaffected
  either way.
- **The host report's baseline is "the same site with the plugin
  deactivated"**, not the community's ambient baseline of tagged empty
  polls — a host evaluates against a site without the plugin. The
  transport suite still runs the community-convention baseline phase,
  so its server-side tables normalize the community way.
- **The engines suite has no community equivalent.** It measures the
  engine seam in-process (below); its JSON reports are this repo's own
  format.

---

# The engines suite (`--suite=engines`)

Compares server sync engines **through the production seam** — the same
`WP_Sync_Engine::handle_updates()` / `get_updates_since()` calls the polling
transport makes — so the numbers are the real engine's, not a model's. It
exists to make the architecture decision (which engine, or keep both) a
matter of evidence.

Engines are resolved through the framework's registry (the
`wp_sync_engines` filter), so **any engine registered by an active plugin is
benchmarkable by slug** — run with an unknown slug to list what's
registered. This plugin registers three:

- **`intent-log`** (`WP_Intent_Log_Engine`) — server-authoritative: the
  server transforms each edit against the log, so it can report exactly how
  every edit settled.
- **`yjs-server`** (`WP_Yjs_Server_Engine`) — server-authoritative CRDT:
  the server (via the vendored y-php) merges every update into a canonical
  room document, compacts by itself, and materializes post content.
- **`de-rtc`** (`WP_De_RTC_Engine`) — server-governed three-way merges:
  clients propose whole content against a named base version; the server
  merges each proposal with the ported DE-RTC merge core and announces
  each accepted version; genuine conflicts escalate.

(A fourth engine, `yjs-relay` — a dumb relay whose merge happened in each
client's CRDT — has been removed; historical numbers for it remain below
as context.)

HOW the runner speaks to an engine is an **authoring profile** — a
first-class SPI (`WP_Sync_Bench_Authoring_Profile`) that owns everything
engine-specific: translating the workload's abstract edits into the
engine's wire vocabulary, playing the client's part between requests
(applying read responses, tracking observed state, answering compaction
nominations), classifying void reasons, and scoring quality with an oracle
matched to the engine's merge semantics. The measurement loop
(`WP_Sync_Bench_Runner`) is engine-neutral: it times whatever requests the
profile hands it. Profiles are resolved by engine slug through
`WP_Sync_Bench_Profiles`; an engine plugin can register its own via the
`wp_sync_bench_authoring_profiles` filter (mapping slug to a class
constructed as `new $class( int $post_id, array $workload )`).

This plugin ships three dedicated profiles. The **intent-log profile**
speaks typed intents authored from each client's observed base and scores
quality with the disposition-based oracle. Its client model is
read-driven: each simulated client advances its observed head, register
versions, and per-field text lengths
by decoding the rows the engine actually delivered
(intent rows advance the head one seq each; snapshot rows reset it to
their seq), exactly as the production client derives its baseSeq, and in
the single-process runner every read asserts the decoded state matches
the shared disposition model — so a read path that dropped or mangled a
row fails the run as a convergence failure instead of drifting silently.
Tail-positioned typing authors its insert offsets in EDITOR-TREE
coordinates: the read-observed field length PLUS the length of the
client's own applied-but-unread edits, because the engine's transform
shifts offsets only over priors from OTHER actors (the author's canvas
already contains its own pending edits — authoring from the delivered
length alone lands a deep-lagged client's tail insert mid-token, which
is exactly how the laggy-newsroom convergence gate caught the modeling
gap).
It also models the client's floor-reset recovery: a compaction checkpoint
raises the retention floor mid-round and stale-voids the intents authored
below it, which the production client answers by re-deriving the work
from its editor tree. The profile re-authors each such edit once as a
follow-up ingest after the client's next read, skipping edits whose
target block no longer exists in the observed state (a real client
cannot retype into a block that left its canvas). The **yjs-server profile**
speaks **real Yjs**: each simulated client holds a y-php document, authors
genuine incremental V2 updates (text inserts into the paragraph's content
Y.Text; align set on the attributes Y.Map — exactly what the editor's
session codec sends), and applies read responses into its document;
payload and storage bytes are therefore REAL for this engine, and quality
is scored with a CRDT oracle (see below). The **de-rtc profile** speaks
whole-content proposals: each simulated client keeps a local working copy
and its base version (base = last version applied to the doc, the client
adapter's rule; an APPLIED proposal advances it at settle time, mirroring
the accepted row the polling transport returns in the same response as
the dispositions), adopts the server's canonical snapshots on read, and —
because retry is part of that protocol — re-proposes edits the engine
voided at an aged-out base as a coalesced follow-up proposal against the
base it just observed (one retry per edit); payload and storage bytes are
REAL and scale with document size, and quality is scored with a
disposition + version-lineage oracle (see below). Every other engine gets
the **opaque-relay fallback profile** — relay-convention
`update`/`compaction` blobs with quality reported as not
server-observable. A third-party relay-style engine benchmarks
meaningfully out of the box; an engine with its own wire vocabulary will
void the generic updates, and the dispositions/storage counts will show
that rather than fake a result — its plugin should register a real profile
instead.

## What it measures

**Cost** (all engines):

- `service_us` — per-request service time of `handle_updates` (p50/p90/p99/
  max/mean, reported in ms), measured with `hrtime()` and pooled across
  measured repetitions (warmup reps are excluded). Storage is swapped for an
  in-memory implementation, so this mostly isolates *engine* CPU (the
  intent-log planner and replay; the relay's append) from database I/O —
  with one deliberate exception: the intent-log ingest holds a Core-style
  options-row lock (`WP_Sync_Room_Lock`) for the length of each request
  (its transform log is order-dependent), so each of its samples includes
  one claim/release pair of real DB writes; de-rtc's optimistic version
  claim adds one CAS write per accepted proposal (yjs-server and the
  relay pay neither). The reported `calibration` block times the lock
  pair and a bare `SELECT 1` in the same environment so the number can
  be decomposed.
- `read_us` / `idle_poll_us` — per-request time of `get_updates_since`,
  split into catch-up reads (during and after the session) and idle polls
  (nothing new to deliver). Idle polls dominate request volume in a live
  deployment, so their cost is reported on its own.
- `join_us` — the later-joiner read: a COLD `get_updates_since` at cursor 0
  by a client that was never in the session, after all the session's
  history — what a fresh visitor pays to enter the room (snapshot + tail,
  per the engine's retention). Its response size is reported as
  `payload_bytes.join_response_*`: the payload that visitor downloads,
  which differs sharply per engine (full-content rows vs binary diffs).
- `materialize_us` — the save path: `materialize()` timed on a FRESH
  engine instance per sample (a save request starts with no per-request
  room cache). Engines without the materialize convention report null.
- `memory.ingest_peak_bytes` / `memory.materialize_peak_bytes` — peak PHP
  memory allocated on top of the baseline during the worst ingest and the
  cold materialize (via `memory_reset_peak_usage()`, PHP 8.2+; null
  otherwise) — the number a constrained PHP-FPM pool actually OOMs on.
- `payload_bytes` — request and response sizes of the engine-level updates
  payload (the transport envelope and awareness add overhead on top).
- `storage.rows` / `storage.bytes` — how the room grows. This is measured
  exactly even though storage is in-memory, because growth is a real
  differentiator — but of a different KIND per engine: the intent log
  checkpoints and trims on the server; the relay relies on a client to
  compact (the engine nominates the lowest-id session member once the room
  passes 50 rows). The runner plays that compactor's part — it submits a
  synthetic full-state snapshot whenever a read answers `should_compact` —
  so relay growth reflects a session with live clients, not an abandoned
  room. `storage.followups` counts protocol follow-up ingests generally
  (the relay's compaction snapshots; de-rtc's stale-base retry proposals;
  intent-log's floor-reset re-authoring after a compaction checkpoint);
  their requests and dispositions are included in cost and quality.
  `storage.trims` counts history-trim events — every engine's checkpoint
  path trims once per checkpoint (as does an accepted relay compaction),
  so the server's checkpoint cadence is visible per engine instead of
  hiding as unlabeled spikes in `service_us` p99.

**Quality** — policy-correct, and only where the server can observe it:

- `dispositions` — for the intent log, the count of edits that were
  `applied` (merged), `escalated` (set aside for human review), or `voided`.
- `escalation_rate` — escalated / total. This is **reported, not
  penalized**: sending a genuine conflict to review is the point, not a
  failure.
- `lost_work` — edits that were dropped without being applied or preserved
  for review (a `voided` with a non-benign reason; each authoring profile
  classifies which void reasons are benign for ITS engine). The project's
  policy is *never lose work*; this asserts it. It is `0` in every scenario
  here.
- `converged` — the materialized document matches the engine's own account
  of the session: every `applied` edit's unique token appears in the content
  exactly once, no `escalated` edit's token leaked into the content, the
  block structure is intact, and each block's final attribute value is the
  last applied write in server order. Failures are itemized in
  `quality.convergence_failures`.

For `yjs-server`, quality is scored with a **CRDT oracle** matched to CRDT
semantics: after full catch-up every simulated client's document must be
identical (the convergence guarantee), every applied text token must appear
in the server-materialized content exactly once (text merges are lossless —
nothing lost), the block structure must be intact, and the materialized
attribute registers must equal the converged CRDT value. Attribute
conflicts resolve by CRDT rules (deterministic, but NOT server arrival
order) rather than escalating, so `escalated` is always 0 for this engine —
that is the policy difference with intent-log, reported honestly: the same
contended workload that intent-log sends to review, yjs-server silently
last-writer-wins.

For `de-rtc`, quality is scored with a **disposition + lineage oracle**:
applied tokens appear in the canonical exactly once, escalated (parked)
tokens not at all, structure intact, each align register equal to the last
applied write that actually CHANGED it against its own base (three-way
merges preserve untouched registers, so a no-op write must not move the
expectation), the broadcast `content` rows chain v(N)→v(N+1) with no gaps
and match the applied dispositions exactly, and after full catch-up every
client's adopted copy equals the materialized canonical. Two accounting
notes: de-rtc escalates the WHOLE proposal (its escalation grain is a
proposal, not a single register write — rates are not directly comparable
with intent-log's per-intent grain), and `voided`/`unknown-base-version`
is NOT lost work — it is the protocol asking the client to retry against
a fresher base, which the profile models (the retry's settlement is what
counts).

**Entity-field registers** (the `set_property`, `set_terms`, and
`set_meta` ops) never materialize
into post content, so their oracles use the engine's other observables.
Intent-log: concurrent writes to the same property escalate the later
writer (`property-conflict`, the attr-conflict analog); the profile
asserts every client's wire-decoded property state — what a production
editor would display — equals the last applied write in server order.
Yjs-server: register conflicts resolve by CRDT rules (deterministic, NOT
server order), so the oracle asserts all-client convergence plus that
each register converged to a value somebody actually wrote. De-rtc: a
conflicting property parks as its OWN `parked` row
(`property-conflict`) while the proposal it rode in still reports
`applied` — the engine's escalation grain for fields is a property, not
the proposal, so field conflicts do NOT appear in the `escalated`
disposition count; the profile mirrors the engine's per-property
three-way rule and asserts the canonical property map on every broadcast
row, the caught-up clients' adopted maps, and the parked rows all match
that model exactly. The de-rtc client re-carries its FULL property map on
every proposal (production behavior), so field sync also adds real bytes
to every de-rtc request.

All three field ops are the same register lane; only the naming and
transport shape differ. `set_terms` writes a taxonomy's whole term-ID set
to the register named by its rest_base (`categories`, `tags`), as a
numerically-sorted array — the engines compare term sets
order-insensitively, exactly like the shipping clients and the genesis
seed normalize them. `set_meta` writes a registered-meta register:
intent-log and de-rtc carry it as a flat `meta.<key>` register, while the
CRDT codec nests it per key under the document's `meta` Y.Map. The
harness registers the meta palette's keys before genesis
(`WP_Sync_Bench_Workload::register_bench_meta()`) because synced meta IS
registered meta — that is what puts the `meta.<key>` registers (and the
CRDT's nested meta map) in every engine's genesis seed.

For an engine that merges on the client (the retired `yjs-relay` did, and
the opaque-relay fallback profile models one), quality is reported as
**not server-observable**: there is no PHP CRDT in the loop to score
convergence or conflict outcome, so the harness says so rather than
inventing a number.

### Why not a "merge retention" score

An earlier harness scored quality as *silent-merge retention*: how much
concurrently-typed content survived an automatic server merge. That rewards
last-write-wins — precisely the behaviour this project rejects, because it
silently discards one editor's work. Under that metric a lossy engine that
quietly overwrites can outscore one that surfaces the conflict. This harness
inverts it: the signal is **nothing lost**, with conflicts *surfaced for
review* (an outcome, not a demerit).

## Scenarios

| Slug                  | Shape                                                        |
| --------------------- | ----------------------------------------------------------- |
| `solo-typing`         | One editor, one document. Baseline cost, no contention.     |
| `long-form`           | One editor, ~600 chars per paragraph (~5 KB at defaults). Does cost scale with document size? Combine with `fill=` for a sweep. |
| `parallel-paragraphs` | N editors, each in their own paragraph. Clean concurrency.  |
| `contended-paragraph` | N editors restyling the SAME block. High escalation.        |
| `mixed-newsroom`      | Mostly parallel, ~25% of rounds collide on one block.       |
| `laggy-newsroom`      | Mixed newsroom, but the last client reads only every 10th round: stale bases, deep transforms, heavy catch-up reads. |
| `structural-churn`    | Concurrent block INSERTS and REMOVALS alongside typing — the block-structure stress the pure-typing scenarios never exercise. |
| `remove-contention`   | One client types into an inserted block while ANOTHER client concurrently removes it (the edit-vs-remove conflict class, where the three merge policies differ most sharply). |
| `field-sync`          | Entity-field register writes (scalar properties, taxonomy term sets, post meta) alongside typing: clean parallel field sync, plus ~25% of rounds where every client writes the SAME register — the register-contention analog of `contended-paragraph`, on the field traffic PR #22 added. |
| `editorial-session`   | A wall-clock session, one round per second: staggered joins/leaves, typing bursts with think-time pauses, every present client polling every round, an autosave every 60 rounds. `rounds=3600 clients=3` is a one-hour three-user session. |

The workload speaks seven operations: `text` (a keystroke batch into a
genesis paragraph, or, in `remove-contention`, into an inserted block
addressed by `block_id`; each carries a seeded abstract position — `head`
or `tail` — that the profiles map to engine coordinates from the client's
own observed state, so typing is not all offset-0 prepends: intent-log
authors the intent's offset from the client's editor-tree field length
(read-observed plus its own pending edits), the
yjs profile inserts at the corresponding index in the client's own
Y.Text, and de-rtc splices before the closing tag; the token-counting
oracles are position-independent, and under correct transforms a token
can never split mid-token — a split would surface as a missing-token
convergence failure), `attr` (an align restyle), `set_property` (an
entity-property register write — slug, template, …, the field-sync
traffic PR #22 added; title/excerpt are deliberately excluded because the
CRDT codec models them as merging Y.Text, not registers), `set_terms` (a
taxonomy's whole term-ID set, on the rest_base-named register), `set_meta`
(a registered-meta `meta.<key>` register), `insert_block`
(a new paragraph), and `remove_block` (of a block the same client
inserted earlier; `remove-contention`: any client's earlier insert).
Register contention is modelled on align and on entity fields because
concurrent *text* inserts merge cleanly (the text interleaves — correct,
not a conflict). Structural
discipline keeps the oracles decidable: attr edits target genesis
paragraphs only (identified by delimiter-terminated markers
`Paragraph N;`, never removed), inserted blocks carry unique markers, and
each block is removed at most once. In most scenarios text edits also stay
on genesis paragraphs and removals target only the remover's own earlier
inserts, so every marker's presence in the final document follows purely
from the engine's dispositions. `remove-contention` deliberately relaxes
both rules to produce concurrent edit-into-a-removed-block conflicts and
stays decidable through a scoping rule the profiles share: a text token is
expected in the materialized content iff its edit applied AND its target
block's final state is alive, both facts the dispositions already
determine. Same seed ⇒ same workload.

Clients author from the state observed at their own last read, so a laggy
client's `baseSeq` genuinely lags the server head. After the rounds, every
client catches up, then polls the idle room 25 times — the steady-state
request a live deployment mostly serves.

## Running

The fastest way to the whole decision picture is the one-command runner
(needs the tests wp-env running — `npm run env:tests start` — with the
subtree built; it activates the plugins itself):

```bash
npm run bench -- --suite=engines     # every engine x the decision matrix
                                     # (steady concurrency, deep-lag
                                     #  settlement, structural churn, remove
                                     #  contention, field-sync registers, a
                                     #  10-minute wall-clock session), with
                                     #  comparison tables and hosting cost
                                     #  cards; FAILS on any lost work or
                                     #  convergence failure
npm run bench -- --engines=de-rtc --scenarios=editorial-session
npm run bench -- --certify=10        # invariant sweep: 10 seeds x engines x
                                     # adversarial scenarios + both save-lane
                                     # sessions — certifies "no edit is ever
                                     # silently dropped" at scale; CI runs
                                     # --certify=3 on every push/PR
npm run bench -- --transport=sse --cache=redis --wake=cache
                                     # the host report on a Redis-backed
                                     # site (the Redis Object Cache drop-in
                                     # goes in for the run and comes out
                                     # after), with SSE streams pinned to
                                     # the version counter in the cache;
                                     # --cache=none --wake=table is the
                                     # no-cache host, --wake=auto lets a
                                     # detected Redis wake the streams.
                                     # The report records the wait the
                                     # streams actually got.
```

Multi-process concurrency measurement is OPT-IN behind one flag:

```bash
npm run bench -- --concurrency=4     # 4 worker processes, same room, REAL
                                     # table storage: latency including
                                     # genuine lock waits and 503s, vs a
                                     # 1-worker uncontended baseline
```

It complements the modeled queueing on the hosting cost card: the model
composes measured service times with the workload's concurrency histogram
(cheap, deterministic); the measurement runs truly parallel processes against
the shared database (real, noisy, and the only way to exercise the
engines' actual race behavior — its first run caught yjs-server voiding
most updates under 4-writer contention; see
`docs/engine-comparison.md`). No quality oracles run in this mode — it is
a latency and failure-mode probe, with dispositions and void reasons
reported for context.

JSON reports land in `bench-results/`. Individual runs go through wp-cli
directly — the engines need WordPress (`get_post`, `serialize_block`, and a
`$wpdb` for the ingest lock), so run inside the environment under test.
Options are bare `key=value` tokens — wp-cli would claim `--flags` itself.

```bash
wp eval-file tests/benchmarks/benchmark.php \
    engine=intent-log scenario=mixed-newsroom \
    rounds=200 clients=4 paragraphs=8 seed=42

# Head-to-head: run every engine over the same scenario and seed.
for e in intent-log yjs-server de-rtc; do
  wp eval-file tests/benchmarks/benchmark.php \
      engine=$e scenario=contended-paragraph rounds=200 clients=4 seed=42
done

# Document-size sweep: fill= pads every genesis paragraph to ~N chars
# (8 paragraphs x fill=6000 is a ~48 KB document).
for kb in 0 750 6000 60000; do
  wp eval-file tests/benchmarks/benchmark.php \
      engine=yjs-server scenario=solo-typing rounds=50 fill=$kb json=size-$kb.json
done

# A one-hour three-user session (one round per second; join/leave, typing
# bursts, idle polling, autosaves). Heavy under yjs-server — start with
# rounds=600 (ten minutes) to see the growth trend.
wp eval-file tests/benchmarks/benchmark.php \
    engine=intent-log scenario=editorial-session rounds=3600 clients=3 reps=1
```

Under wp-env, the plugin is mounted at
`wp-content/plugins/<checkout-dir-name>`:

```bash
npx wp-env run cli --env-cwd=wp-content/plugins/$(basename "$PWD") \
    wp eval-file tests/benchmarks/benchmark.php engine=intent-log
```

Each run executes `reps=3` repetitions of the identical workload and
discards `warmup=1` of them (autoload, opcache, and first-lock costs land
there); timing percentiles pool the measured reps, and per-rep means with a
stddev expose run-to-run spread. Counted metrics are asserted identical
across reps. Add `json=out.json` to also write the full report, which
includes an `environment` stanza (PHP/WP/DB versions, opcache) and the
`calibration` block — always quote those when comparing runs from different
machines.

### The hosting cost card

Wall-clock scenarios (currently `editorial-session`, where one round is
one second) additionally emit a `hosting` stanza — the same measurements
composed into the units a capacity plan multiplies out:

- **requests, PHP-CPU-seconds and engine wire MB per user-hour** —
  client-seconds of presence are counted exactly (every present client
  reads once per round), so the numbers normalize across session shapes;
- **sustained CPU core share** for the whole session — how much of one
  core this session consumed end to end;
- **storage at rest** after the session and **the join payload** the next
  visitor downloads.

The card covers the ENGINE seam only: the transport envelope, HTTP
headers (~0.5–1 KB/request) and awareness traffic add overhead on top —
the transport benchmark (`tests/benchmarks/transport/`) measures those
per-collaborator rates on a live site, and multiplying ITS idle rate into
the card's per-user-hour numbers is the full steady-state bill. A third
lane, `tests/debugging/replay/`, captures REAL editor sessions at the
transport seam and replays them as HTTP load (community-harness fixture
format; see its README) — repeatable full-stack traffic with genuine
engine payloads, complementing this harness's synthetic workloads. Composing
micro-measurements this way still assumes requests don't queue (see
Limitations); a browser-driven multi-client soak to validate the
projections end-to-end is the known remaining gap.

### Comparing runs

`compare.js` renders any number of `json=` outputs side by side — engine
runs, transport-benchmark runs (`tests/benchmarks/transport/`), or a mix;
each kind gets its own table, one column per run:

```bash
node tests/benchmarks/compare.js intent.json relay.json            # console
node tests/benchmarks/compare.js intent.json relay.json md=1      # Markdown
```

It warns when engine runs used different workloads (scenario/seed/rounds/
clients/paragraphs) or environments (PHP/DB/opcache) — those numbers are
not directly comparable, and the warning says so instead of silently lining
them up.

## Reading the results

Representative run (`mixed-newsroom`, 150 rounds, 4 clients, 8 paragraphs;
wp-env Docker, PHP 8.3 / MariaDB — quote your own `environment` +
`calibration` stanzas with any numbers you report):

| Metric              | intent-log       | yjs-relay (retired)    | yjs-server             | de-rtc                 |
| ------------------- | ---------------- | ---------------------- | ---------------------- | ---------------------- |
| service ms (mean)   | ~0.7 (incl. ~0.1 lock pair) | ~0.0005 (timer floor) | ~41 (canonical-doc load/merge/save per ingest) | ~2.0 (content three-way merge, incl. lock pair) |
| service ms (p99)    | ~2.0             | ~0.008                 | ~96                    | ~3.7                   |
| idle poll ms (mean) | ~0.0003          | ~0.0002                | ~0.0003                | ~0.0003                |
| storage rows        | 302 (server checkpoints + trims) | 30 (11 scripted client compactions) | 102 (server checkpoints + trims; no client help) | 204 (server checkpoints + trims) |
| storage bytes       | ~117 KB (JSON intents + checkpoints) | (synthetic) | ~61 KB (binary diffs + snapshots) | ~466 KB (every accepted proposal stores a FULL content row) |
| trims (checkpoints) | 3                | —                      | 6                      | 5                      |
| join (cold read)    | ~0.24 ms, ~113 KB payload | —             | ~0.08 ms, ~60 KB payload | ~0.52 ms, **~452 KB payload** (the retained full-content tail) |
| materialize (cold save path) | ~2.2 ms | n/a (no document)     | **~187 ms** (decode the whole canonical doc; the in-session ingest keeps it cached, a fresh save request does not) | ~0.0004 ms (the canonical IS post content) |
| ingest peak memory  | ~0.9 MB          | —                      | ~1.0 MB                | ~1.6 MB                |
| quality             | 450 applied, 150 to review, **0 lost**, content-verified converged | not observable | 600 applied, **0 lost**, all-client CRDT convergence verified | 480 applied, 120 to review, **0 lost**, lineage-verified converged |

Document-size scaling (`long-form`, one editor in a ~5 KB document, 100
rounds): intent-log mean service ~0.42 ms; de-rtc ~2.7 ms with ~5.9 KB
request payloads (the whole document travels in every proposal — both its
merge time and its wire/storage bytes scale with document size);
yjs-server ~36 ms (the canonical-doc rebuild dominates regardless of edit
size). The `laggy-newsroom` scenario (one client reading every 10th round;
part of the engines-suite matrix, at mixed-newsroom size) settles
differently per engine and loses nothing on any of them: intent-log
absorbs stale bases with deeper transforms (~24% escalated, 38 benign
voids, 13 floor-reset re-authoring follow-ups, heavier catch-up reads —
and its deep-stale tail inserts are what force the profile's editor-tree
offset coordinates; see the profile description above); de-rtc escalates
slightly more than in mixed-newsroom (~24% vs 20% — cumulative
stale-base proposals conflict more often), while its base stays mostly
fresh even between rare reads — every applied proposal advances it at
settle, like the shipping codec whose transport returns the accepted row
with the ack — so its retry lane (`unknown-base-version` voids +
`followups`) fires on the RECONNECT shape instead: a deep read gap under
sustained register contention, where escalations never advance the base
until it ages out of the engine's 20-version snapshot window (see the
deep-read-gap PHPUnit test for the deterministic construction).

Structural churn (concurrent inserts/removals + typing, 60 rounds, 4
clients) is where conflict POLICIES separate hardest: intent-log and
yjs-server merge all 240 edits cleanly (transform and CRDT both handle
structure), while de-rtc escalates ~49% of proposals (whole-document
proposals against a structurally-shifting base are exactly what its
three-way merge refuses to auto-resolve) — still zero lost work, all
engines convergence-verified through the marker oracle.

Remove contention (one client types into an inserted block another
client concurrently removes; 60 rounds, 4 clients) separates the
policies on the edit-vs-remove class specifically: **intent-log
escalates the trailing edit** (~12% of edits escalate, the trailing
keystrokes parking as `target-deleted`; when the text lands first, both
apply and the token legitimately vanishes with the removed block),
**yjs-server escalates nothing** (CRDT deletion semantics dissolve the
edit with the deleted block; deterministic, but the conflict is never
surfaced), and **de-rtc escalates the whole trailing proposal** (~22%;
its proposal grain sends the entire document state to review, not just
the contested edit). All three: zero lost work, convergence-verified
under the target-scoped token oracle. This scenario is also where
intent-log's floor-reset retry lane fires visibly (`followups` > 0):
checkpoints stale-void in-flight seed inserts, and the profile re-authors
them like the production client would.

Field sync (entity-property, taxonomy-term, and post-meta register
writes alongside typing; 60 rounds, 4 clients) separates the
register-conflict policies at FIELD grain: **intent-log escalates each
later concurrent writer per register** (54 of 240 edits, ~22%, parking
as `property-conflict`), **de-rtc parks a conflicting property as its
own review row while the proposal it rode in still applies** (only 4
whole-proposal escalations, ~2% — field conflicts deliberately do not
appear in its `escalated` count; see the register-oracle notes above),
and **yjs-server resolves every register by silent CRDT last-writer-wins**
(0 escalations). Register traffic is also the cheapest ingest for every
engine (~0.5 / ~5.5 / ~0.8 ms mean for intent-log / yjs-server / de-rtc
— no text transform, no content merge). All three: zero lost work, every
register's final wire state verified against the engine's own account.

A ten-minute `editorial-session` (600 rounds, 3 clients, joins/bursts/
saves; ~850 requests) shows the session-lifetime behavior single scenarios
miss: intent-log holds a flat ~0.7 ms mean throughout; **yjs-server
degrades as the document grows** (p50 ~100 ms, p90 ~260 ms, p99 ~300 ms
by session end — every ingest rebuilds the ever-larger canonical doc, and
in-session cold saves run ~218 ms); de-rtc stays ~3.1 ms mean but its room
tail reaches **~1.2 MB** — which is also the payload the NEXT visitor
downloads to join. Escalations in the realistic mix: 0 (yjs-server,
silent), ~0.1% (intent-log — bursty non-overlapping typing rarely
collides; 1 of 851 edits), ~6% (de-rtc, whole-proposal grain), with
de-rtc's retry lane firing for late joiners whose genesis base aged out.
All three: **0 lost**, converged. The hosting cost cards from the same
run: intent-log 1.4 CPU-s / 2.2 MB wire per user-hour with 62 KB to
join; de-rtc 5.8 CPU-s / 33.9 MB per user-hour with 1.2 MB to join;
yjs-server 219 CPU-s per user-hour (~6% of a core per present user) with
87 KB to join.

The comparison the decision turns on:

- **intent-log** spends real server CPU per request (it transforms and plans
  the merge) and in return keeps storage bounded through checkpointing and
  gives a server-side, policy-correct quality signal — nothing lost, every
  conflict surfaced for review. Under a `contended-paragraph` load (4
  editors on one block) it escalates ~74% and still loses nothing.
- **yjs-relay (retired)** was a near-free relay, but the merge cost and
  conflict outcome lived on the client where the server could not see
  them, and the server could not compact (it had no document to snapshot)
  — it depended on a live client volunteering. In a room whose clients
  left or never volunteered, storage grew one row per edit forever. Its
  `storage.bytes` and snapshot sizes in the table are synthetic (see
  Limitations).
- **yjs-server** buys back the relay's missing server authority (bounded
  storage without client help, observable convergence, materialization)
  while keeping CRDT merge semantics and needing NO ingest lock — but at
  the price of loading, merging, and re-encoding the canonical y-php
  document on every ingest: tens of ms per request at this document size
  in pure PHP, roughly 55× intent-log's transform. Its idle polls and
  reads stay as cheap as the relay's (pure row reads — the canonical doc
  is never touched on the read path). That ingest cost scales with
  document size, so `long-form` runs matter before drawing conclusions.
- **de-rtc** sits between them on CPU (~3× intent-log per ingest, ~20×
  cheaper than yjs-server at this size) and buys the same escalate-honest
  conflict policy as intent-log — but it pays in BYTES, not cycles: whole
  documents travel in every proposal and every accepted proposal stores a
  full content row (~4× intent-log's row bytes here, and both scale
  linearly with document size). Its escalation rate on the same contended
  workload is lower than intent-log's (~56% vs ~74% under
  `contended-paragraph`: its block-level three-way grain escalates a
  conflicting proposal once where intent-log's versioned registers
  escalate every later writer), and a client that reads rarely
  escalates more and eventually needs the retry lane — the deep-lag
  behaviors are where the engines differ most, so run `laggy-newsroom`
  before concluding.

## Limitations

- **Single-process, no queueing model.** This measures per-request service
  time and growth, not tail latency under a saturated worker pool. The
  DE-RTC harness's multi-process request-queue simulation could be layered
  on top of these engine adapters later. The hosting cost card inherits
  this: its CPU/request totals are exact for the session it measured, but
  under real concurrency the lock-holding engines (intent-log, de-rtc)
  additionally queue on the per-room lock, which the card cannot see. A
  browser-driven multi-client soak (extending
  `tests/benchmarks/transport/` beyond two windows) validating the card's
  projections end-to-end is the known remaining verification gap.
- **Opaque-relay quality is unmeasured here** by construction (a
  client-merging engine's merge runs in browser clients, outside the
  harness), not by omission. This limitation does not apply to yjs-server:
  its profile IS the y-php client oracle.
- **Opaque-relay payloads are synthetic.** Per-edit updates and compaction
  snapshots are size-modelled blobs (a few dozen bytes per keystroke batch;
  a snapshot proportional to accumulated document size), not real Yjs
  binary. On that profile `payload_bytes` and `storage.bytes` are therefore
  order-of-magnitude estimates; `storage.rows` and the compaction cadence
  are exact.
- **In-memory storage** understates absolute per-request time (no real DB
  round-trip for reads/writes) but keeps the *engine* comparison clean;
  storage growth is exact. For end-to-end latency including MySQL, point
  the runner at `WP_Sync_Table_Storage` instead.
- **The intent-log lock and de-rtc version claim ARE real DB I/O inside
  `service_us`** (a claim/release options-row pair per intent-log
  request; one CAS write per accepted de-rtc proposal), so their
  absolute timings move with the environment's DB latency — a Docker MySQL
  and a local socket differ by an order of magnitude. Use the
  `calibration.lock_pair_p50_ms` figure to subtract it out, and never
  compare `service_us` across environments without the `environment` +
  `calibration` stanzas.
- **Opaque-relay service times sit near the timer floor** (single-digit
  µs): they say "an append-only relay's server cost is negligible", not
  anything more precise.
- **The de-rtc client model is deliberately simplified in two places.**
  Escalated proposals are reverted from the simulated client's local copy
  (production keeps the author's copy on screen pending a human decision;
  the harness reverts so later proposals stay clean and the oracle can
  assert the conflict stayed OUT of the canonical), and EVERY applied
  proposal advances the client's base at settle time — a fast-forward
  apply advances the version only, a server-merged apply adopts the
  canonical. That is sound because the runner is synchronous (the
  canonical at settle IS the just-applied version), and it is what
  production does: the polling transport returns the accepted row in the
  same response as the dispositions, so the shipping codec's base advance
  is row-driven and immediate. Without it, a client that reads rarely
  would re-propose already-applied content against a pre-apply base, and
  the engine genuinely duplicates the re-proposed text when the merge
  regions have drifted apart (head-only workloads masked this — the
  cumulative proposals always escalated; mixed head/tail insert positions
  surfaced it). Each edit is
  retried once; a second stale-base void parks it (never silently drops
  it), and score() flags any edit left unsettled.
