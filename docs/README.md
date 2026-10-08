# Docs

Start with the page for what you want to do. Every page in this folder
is listed here.

## Use it

- **Pick an engine or transport** →
  [engine-comparison.md](engine-comparison.md) — what each engine is,
  how they score against the principles, feature parity, resource
  shapes, and each engine's known gaps.

## Run it

- **Compare transports** → [transports.md](transports.md) — polling vs
  server-sent events vs websocket, and the operational notes for each.
- **Serve the event stream from the sync daemon** →
  [sse-daemon.md](sse-daemon.md) — how the `sse-daemon` transport
  works and how it differs from `sse`.

## Understand it

- **See how an edit travels, on one page** → [data-flow.md](data-flow.md) —
  how an edit reaches other editors in the Gutenberg trunk experiment
  and under each engine and transport here.
- **Understand the rules the engines are judged by** →
  [principles.md](principles.md) — the seven acceptance criteria
  (P1–P7).
- **See what actually happens on the wire** →
  [scenarios.md](scenarios.md) — seven concrete situations (solo
  typing, same-paragraph conflicts, machine writes, deep lag…) traced
  through all three engines.
- **Read the wire protocol** → [protocol.md](protocol.md) — the REST
  routes, the room envelope, and the row types each engine stores.
- **See how rooms are stored** → [storage.md](storage.md) — the two
  tables, the room-meta keys each engine writes, the object-cache
  strategy, and where presence lives.
- **Understand the advisory channel** →
  [advisory-channel.md](advisory-channel.md) — the small extra connection
  that tells open tabs when to check for new edits: its rules, failure
  cases, and how to bring your own relay.
- **Know what happens to unsaved changes** →
  [room-lifetime.md](room-lifetime.md) — the "Unsaved changes" setting
  and how a shared editing session is reset.
- **Show who is where on a slow connection** →
  [awareness-high-latency.md](awareness-high-latency.md) — each editor
  reports which block they are in, once per interval, shown as an
  outline and a badge instead of live cursors.
- **Understand de-rtc's relationship to its upstream design** →
  [de-rtc-fidelity.md](de-rtc-fidelity.md) — the audit of our port
  against the Distributed Editing vision.
- **See what we'd change with hindsight** →
  [architecture-decisions.md](architecture-decisions.md) — four early
  decisions worth revisiting, and what each change would cost.
- **Look up a term** → [glossary.md](glossary.md) — the project's own
  vocabulary in plain words.

## Change it

- **Touch a vendored library** →
  [vendored-libraries.md](vendored-libraries.md) — y-php, automerge-php,
  the de-rtc merge core, and the frozen intent-log core: where each
  came from, the local changes, and how each is checked.
- **Read the intent-log spec** →
  [../src/engines/intent-log/SPEC.md](../src/engines/intent-log/SPEC.md).
- **Measure it** → [../tests/benchmarks/README.md](../tests/benchmarks/README.md)
  (the host cost report and the tests that compare engines),
  [../tests/benchmarks/transport/README.md](../tests/benchmarks/transport/README.md)
  (how long an edit takes to show up, per transport),
  [../tests/fuzzer/README.md](../tests/fuzzer/README.md) (random-input
  browser tests), and
  [../tests/debugging/README.md](../tests/debugging/README.md) (long-run
  and session-replay tools).
- **Run a relay of your own** →
  [../examples/advisory-relay/README.md](../examples/advisory-relay/README.md).

## Maintain the framework

- **Understand how the editor's data reaches the engines** →
  [entity-sync-adapter.md](entity-sync-adapter.md) — the default
  adapter, its checks, and what still does not work.
- **Update the bundled Gutenberg framework** →
  [gutenberg-subtree.md](gutenberg-subtree.md) — setup, rebasing,
  updating the pin, and release packaging.

## How we work

- **File or shape an issue** → [plan/README.md](plan/README.md) — the
  rules, the labels, and the flow. The work itself lives in GitHub
  Issues.
- **Learn why the code is shaped this way** →
  [plan/history.md](plan/history.md) — decisions that are closed and
  dead ends not worth retrying.
- **See what we set aside** → [plan/wontfix.md](plan/wontfix.md) —
  ideas we looked at and why they wait.
- **Read the latest architecture and code review** →
  [review/2026-10-07-architecture-review.md](review/2026-10-07-architecture-review.md)
  — five questions answered against the code at one commit, with the
  defects found, ranked recommendations, and the five detailed reports
  beside it.

The pages here describe how things work today. Notable shipped changes
are recorded in `CHANGELOG.md`, and `AGENTS.md` says how to work in the
repo. The pages carry no measured numbers: to produce them on your own
hardware, run `npm run bench` (what the plugin adds to a server) or
`npm run bench -- --suite=engines` (the engine comparison) against
a running tests env; see `tests/benchmarks/README.md`.
