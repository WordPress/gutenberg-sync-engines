# RTC engine × transport fuzzer

Seeded browser fuzzing for this plugin's real-time collaboration stack,
swept across **every engine × transport combination**. Adapted from the
Gutenberg RTC browser fuzzing pipeline (danluu/gutenberg `try/fuzz`; see its
`docs/explanations/architecture/real-time-collaboration-fuzzing*.md`),
reduced to the parts that find bugs and reshaped around this repo's
pluggable engines and transports.

## One command

```bash
npm run fuzz
```

That runs the default matrix — `{intent-log, yjs-server, de-rtc} ×
{http-polling, sse, sse-daemon, websocket}` — with 5 seeds per combo,
12 actions per seed, 2 collaborating browsers. It starts the TESTS wp-env
(`.wp-env.tests.json`) if needed, flips the engine/transport per combo,
manages the websocket daemon, rechecks failures, and writes a summary.
Exit code is non-zero when any failure reproduces.

Websocket and sse-daemon combos need host port 8787 for a daemon serving the TESTS
database, so the runner removes the dev env's auto-started daemon
(`wp-sync-ws-daemon`, which serves the DEV database) for the duration of
the run; `npm run env start` or `npm run rtc:ws` brings it back.

SSE combos need the Redis container the tests env's `afterStart` hook
starts beside the site; the runner refuses an sse combo without it, since
tabs would silently receive over polling and certify nothing. Sync faults
stay on for sse: a failed stream request is exactly the fallback path.
Both SSE transports must open a stream and receive an event during peer
discovery. A run that only uses polling fallback fails this check.

Common variations:

```bash
npm run fuzz:quick                               # post-change smoke: all engines
                                                 # over http-polling, 2 seeds,
                                                 # no faults/reloads
npm run fuzz -- --seeds=20 --steps=15            # deeper sweep
npm run fuzz -- --engines=yjs-server             # one engine, all transports
npm run fuzz -- --transports=websocket           # all engines, one transport
npm run fuzz -- --users=3                        # adds a seeded late joiner
npm run fuzz -- --no-faults --no-reload          # low-noise convergence-only
npm run fuzz -- --combos=intent-log/http-polling \
    --seed-list=42 --trace=retain-on-failure     # replay one failing seed
npm run fuzz -- --combos=yjs-server/http-polling \
    --seed-list=8 --steps=14 --shrink            # bisect to minimal steps
npm run fuzz -- --profile=undo --transports=http-polling \
    --seeds=10                                   # undo/redo-weighted campaign
npm run fuzz -- --profile=concurrency --burst-rate=0.5   # same-block
                                                 # concurrent-edit campaign
```

`--profile` tilts the seeded action distribution (`undo` or `concurrency`)
without removing the rest of the grammar. The profile is part of the seed's
identity: replay a profiled failure with the same `--profile` flag (the
summary's replay commands include it). Replay commands also keep the user
count, fault and burst rates, lifecycle switches, and any CPU slowdown.

`--help` lists everything. Prerequisites are the standard repo setup
(README/AGENTS.md): plugin `npm install` + `npm run build`, the subtree
built once, and `npx playwright install chromium`.

## Strategy: what we adopted, what we changed, what we dropped

The upstream pipeline is layered: pure CRDT model fuzzers → sync
state-machine fuzzers → a **seeded browser fuzzer** → a long-running
campaign/triage stack. Its core insight, which we keep: *push search into
deterministic layers, keep browser runs seeded and bounded, and assert a
few durable invariants instead of many brittle UI details.*

**Adopted (the browser layer, this directory):**

- **Seeded determinism.** One test = one seed. The seed drives initial
  content, every action, the acting user, milestone placement, and fault
  injection. Browser timing can still vary between replays.
- **Bounded action grammar.** Block insert/edit/move/delete, nested
  groups/lists/quotes, headings, title edits, real keystrokes (typing
  exercises capture paths that programmatic edits bypass — this is what
  surfaced the intent-log echo race), and concurrent same-step edits from
  two browsers. Extended here with **history and tight-timing actions**:
  `undo` / `redo` (dispatched through `core/editor`, the same path the
  toolbar and shortcut take, routed to the engine's collaborative undo
  manager), `type-then-undo-quick` (undo fired 0–900 ms after typing —
  inside intent-log's unsettled-unit window), `edit-then-undo-settled`
  (waits for `hasUndo` before undoing: the deterministic inverse-derivation
  exercise), `concurrent-same-block-edit` (both browsers append to the SAME
  paragraph via the store), `concurrent-type-same-paragraph` (both carets
  at the end of the same paragraph, real keystrokes, fired together), and
  `concurrent-edit-and-undo` (one user undoes while a peer edits — the
  inverse must transform over the peer's rows).
- **Durable invariants.**
  - *Convergence*: after every step all participants expose the same
    normalized title + block tree (`waitForConvergence` from the subtree's
    collaboration fixtures).
  - *Structural validity*: no block may become an invalid-content recovery
    block (`isValid: false`) — the classic engine-genesis failure mode.
  - *No duplication*: every authored marker is unique per authoring op, so
    a marker appearing MORE than once in converged content is content
    duplication — a class convergence checking cannot see (all pages agree
    on the duplicated text): bad undo inverse derivation, a re-pushed
    block, or a capture echo. (Loss is deliberately not asserted: parked
    escalations and documented LWW gaps make absence legitimate.)
  - *Persistence*: a mid-run save milestone plus a final
    save → reload → reconverge round-trip. A server-authoritative engine
    must rebuild the same document for a fresh session; the REST title must
    match the converged state. The full saved content must also match,
    after parsing and serializing both copies with the editor. A live room
    can hide a stale database copy during reload, so this check reads the
    saved post separately.
  - *Session lifecycle*: a seeded mid-run reload of a random participant;
    with `--users=3`, a seeded late join that must be able to *contribute*,
    not just receive.
- **Transient fault injection.** Before some steps the acting page's next
  sync request is delayed (250–1500 ms) or failed with a retryable status
  (429/500/503). Like upstream, no 403s: that is a semantic permission
  signal that legitimately unregisters rooms and only manufactures harness
  false positives.
- **Recheck-based triage.** The runner re-runs failing seeds once (traces
  on) and splits **reproducible** failures from **flaky** ones, then groups
  reproducible failures by normalized signature with a ready-made replay
  command.

**Changed (this repo's architecture):**

- **The matrix is the point.** Upstream fuzzed one merge implementation over
  two transports. Here engines and transports are pluggable, so the runner
  sweeps the cross product: it flips `wp_sync_engine` and
  `gutenberg_sync_engines_transport` on the tests site via wp-cli between
  combos, and empties every room (`wp collaboration storage reset`) so no combo inherits another
  engine's room lineage (rooms are engine-stamped; the websocket daemon
  strips the stamps that let HTTP transports heal stale collection rooms).
- **Engine-neutral oracles.** No `_crdt_document` assertions — that meta is
  an implementation detail of the upstream fork's client-merging engine.
  Convergence, validity, and the reload round-trip apply to any engine.
- **Websocket lane.** The `wp collaboration sync-server` PHP daemon is run
  through the tests env's generated compose file with the port **published**
  (`-p 8787:8787`) and the daemon bound to `0.0.0.0` — an unpublished or
  loopback-bound daemon is silently unreachable from the browser (clients
  retry forever with no error). The daemon is restarted per combo because a
  long-running PHP process caches the engine option at boot. Route-based
  fault injection is disabled on this lane: Playwright routes cannot touch
  WebSocket frames.

**Dropped (deliberately):**

- The campaign/triage stack — tmux supervisors, watchdogs, LLM analysis
  tiers, novelty-guided expansion, CDP coverage, the operation ledger.
  Wrong scale for this repo today; the runbook's *discipline* survives as
  durable artifacts, signature grouping, and replay commands. If a
  long-running campaign is ever wanted, wrap `run.mjs` in a loop — it is
  resumable by construction (each invocation is self-contained).
- The lower fuzz layers (CRDT model / sync state-machine / PHP randomized
  tests). Their equivalents here would target the frozen intent-log core,
  y-php, and the transport servers — worthwhile future work, but the
  engine × transport interaction bugs this harness hunts only exist in the
  full stack.

## Architecture

```
tests/fuzzer/
├── run.mjs                        # matrix runner (npm run fuzz)
├── playwright.config.ts           # fuzz-tuned config (no retries, JSON report)
├── specs/collaboration-fuzz.spec.ts  # the seeded fuzz spec
└── artifacts/                     # gitignored run outputs
    └── fuzz-<timestamp>/
        ├── summary.md             # human summary + failure signatures + replays
        ├── summary.ndjson         # one record per combo × seed
        └── <engine>--<transport>/
            ├── sweep-report.json      # Playwright JSON report
            ├── sweep-artifacts/       # screenshots, fuzz-run.json traces
            ├── recheck-report.json    # failing seeds re-run, traces on
            └── recheck-artifacts/
```

Every test attaches `fuzz-run.json` — the full seeded action/fault/milestone
trace and effective run settings. An action-start entry also identifies an
action that timed out before it could return its result. Empty or incomplete
Playwright reports fail the runner; they cannot count as passing campaigns.
When duplication is detected, the attachment also contains the shared state.
Conflict cards are resolved one at a time through a reachable button; card
positions are read again after each choice.

Run the runner's focused checks with `node --test tests/fuzzer/runner.test.mjs`.

`cases/` keeps reproduction settings and filtered evidence for confirmed
product failures. These are investigation records, not passing tests. See
[`de-rtc-heading-duplication.json`](cases/de-rtc-heading-duplication.json)
for a duplicate block reproduced without a participant leaving or rejoining.

## Choosing a campaign

Start with `fuzz:quick` to check the environment and basic editing. Then
change one source of stress at a time:

-   Use `--profile=concurrency --burst-rate=0.6 --no-lifecycle` to make edits
    arrive before earlier edits settle. Keep faults off for the first run,
    then add them to test retries.
-   Use `--profile=undo` to test changes to local history while peers edit.
-   Use `--users=3` to test a new participant after edits already exist.
-   Test all four transports. A passing polling run does not prove that a
    stream reconnect or socket reconnect works.
-   Use `RTC_FUZZ_CPU_THROTTLE=5` when a failure depends on slow editor updates.

Keep the original failing run before reducing steps or changing settings.
The same seed chooses the same random values, but browser timing and
document-dependent action choices can differ. A replay is evidence of
repeatability, not a guarantee of the same timing. Reducing `--steps` also
changes milestone placement, so it does not preserve the original prefix.

The spec uses the plugin-local collaboration fixtures
(`tests/e2e/config/collaboration-fixtures.ts`) and e2e global setup
(auth, clean state, plugin activation
including the worktree duplicate-mount handling). Engine/transport are set
*outside* the spec by the runner; the spec only reads `RTC_FUZZ_ENGINE` /
`RTC_FUZZ_TRANSPORT` to record them and adapt fault injection.

Joining users log in through a request to WordPress's login endpoint in a
fresh browser context. The login request has a 10-second limit and must
return both the login redirect and an authentication cookie. Editor
navigation has a 30-second limit. Failed setup closes the context and
reports the error without retrying the join. This avoids the login page's
delayed focus change, which could put the password in the username field
and leave the fuzzer waiting for a form submission that never happened.
Run the focused checks with `npm run test:js -- --runInBand collaboration-login`.

## Reading results

- **flaky** (failed once, passed the recheck): usually harness/timing noise
  or a genuinely nondeterministic race. Recurring flaky signatures deserve a
  look — races are real bugs too.
- **reproducible** (failed twice): start from the recheck's Playwright trace
  (`recheck-artifacts/`) and the `fuzz-run.json` action trace; replay with
  the command printed in `summary.md`. Pass `--shrink` to bisect each
  reproduced signature to a minimal `--steps` automatically (the summary's
  replay command then uses the shrunk count). A shrunk run is seeded
  fresh — fewer steps reshuffles milestone placement — so only the failure
  signature is guaranteed to match, not the exact schedule.
- Documented engine capability gaps are excluded up front: the runner's
  `ENGINE_CAPABILITIES` map (run.mjs) disables actions an engine cannot
  sync (currently none; all three engines sync titles) so lanes measure real
  defects, not known limitations. Extend the map when an engine's
  documented capabilities change.
- Before filing anything, check the known-issue families in AGENTS.md —
  e.g. intent-log escalating (rather than merging) later keystrokes typed
  into a paragraph a peer is editing while this editor is behind on their
  change, yjs-server's silent LWW on register conflicts, and the websocket
  daemon's missing engine-stamp fencing. Finding these again validates the
  harness; it does not need a new report.

## Env knobs (spec level)

The runner sets these; direct `npx playwright test
--config tests/fuzzer/playwright.config.ts` invocations can too:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RTC_FUZZ_SEEDS` / `RTC_FUZZ_SEED_START`+`RTC_FUZZ_SEED_COUNT` | `1..3` | Seed selection |
| `RTC_FUZZ_STEPS` | 12 | Actions per seed |
| `RTC_FUZZ_USERS` | 2 | Browsers; 3 adds a seeded late join |
| `RTC_FUZZ_ENGINE` / `RTC_FUZZ_TRANSPORT` | `unknown` | Recorded in traces; `websocket` disables faults |
| `RTC_FUZZ_DISABLE_SYNC_FAULTS` / `RTC_FUZZ_DISABLE_RELOAD` | unset | Noise reduction |
| `RTC_FUZZ_CONVERGENCE_TIMEOUT_MS` | 20000 | Per-step convergence budget |
| `RTC_FUZZ_TRACE` | `off` | Playwright trace mode |
| `RTC_FUZZ_CPU_THROTTLE` | unset | Slow every editor page N× via devtools CPU emulation (reproduces busy-machine races on an idle machine; issue #38 needed 5) |
| `RTC_FUZZ_JSON_REPORT` / `RTC_FUZZ_OUTPUT_DIR` | unset | Runner's result channels |
