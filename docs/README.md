# Docs

About an hour's reading, in this order.

**Orientation**

- [engine-comparison.md](engine-comparison.md) — which engine to pick,
  how the three score against the principles, what happens in seven
  situations, cost, and each engine's known gaps.
- [data-flow.md](data-flow.md) — how one edit reaches the other
  editors, in the Gutenberg experiment and under each engine.
- [transports.md](transports.md) — how updates move: polling and the
  advisory channel, server-sent events, the sync daemon's WebSocket,
  what happens to unsaved changes, presence on slow connections, and
  what a host must provide.
- [protocol.md](protocol.md) — the routes, the room envelope, the row
  types per engine, who may do what, and how to add an engine.
- [storage.md](storage.md) — the two tables, the keys each engine
  writes, the object cache, presence, and the lifecycle commands.

**Rules and reference**

- [principles.md](principles.md) — the seven principles the engines are
  judged by, and the early decisions still open.
- [wontfix.md](wontfix.md) — what we decided not to do, and why.
- [traps.md](traps.md) — rules that must not be undone, dead ends, and
  code facts that look wrong but are right.
- [glossary.md](glossary.md) — the project's own words, in plain words.

The pages carry no measured numbers; `npm run bench` produces them on
your hardware. Notable shipped changes are in `CHANGELOG.md`, how to
work in the repo is in `AGENTS.md`, and open work lives in GitHub
Issues (`CONTRIBUTING.md` has the filing rules).
