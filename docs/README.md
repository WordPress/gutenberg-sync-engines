# Docs

Start here if you want to:

- **Pick an engine or transport** →
  [engine-comparison.md](engine-comparison.md) — what each engine is,
  how they score against the principles, feature parity, resource
  shapes, and each engine's known gaps.
- **Understand the rules the engines are judged by** →
  [principles.md](principles.md) — the seven acceptance criteria
  (P1–P7).
- **See what actually happens on the wire** →
  [scenarios.md](scenarios.md) — seven concrete situations (solo
  typing, same-paragraph conflicts, machine writes, deep lag…) traced
  through all three engines.
- **Compare transports** → [transports.md](transports.md) — polling vs
  server-sent events vs websocket, and the operational notes for both.
- **Understand de-rtc's relationship to its upstream design** →
  [de-rtc-fidelity.md](de-rtc-fidelity.md) — the audit of our port
  against the Distributed Editing vision.
- **See what we'd change with hindsight** →
  [architecture-decisions.md](architecture-decisions.md) — four early
  decisions worth revisiting, and what each change would cost.
- **Show presence on a slow connection** →
  [awareness-high-latency.md](awareness-high-latency.md) — the slow
  awareness mode: which block each editor is in, once per interval, as an
  outline and a badge instead of live cursors.
- **Look up a term** → [glossary.md](glossary.md) — the project's own
  vocabulary in plain words.
- **See what we plan to build next** → [plan/](plan/README.md) — one
  file per bug or feature, written in plain language with an example
  and a way to tell when it is done.

The docs above describe how things work today; `plan/` describes what
we intend to change, and `docs/plan/history.md` says why things are the way
they are. Notable shipped changes are recorded in `CHANGELOG.md`. To
regenerate every number behind these docs on YOUR hardware, run
`npm run bench -- --suite=engines` against a running tests env (see
`tests/benchmarks/README.md`; plain `npm run bench` is the host cost
report — what the plugin adds to a server).
