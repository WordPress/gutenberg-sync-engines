# Core principles

These seven rules are the acceptance criteria this project is judged
against. They are not aspirations. They synthesize the team's problem
statement and principles. Every engine decision is measured against
them, and every violation is named — including the ones our own porting
choices introduced. See [engine-comparison.md](engine-comparison.md) for
how each engine scores.

- **P1 — The server is the authority.** WordPress stands in the path of
  every update: it checks who sent it, records who, and can read it
  as it arrives. A relay that cannot say who wrote what cannot enforce
  permissions: an admin's save must never make a script tag an author
  injected into the shared document look safe. The retired yjs-relay
  engine failed this principle, and that is why it was retired.
- **P2 — No edit is ever silently lost.** Reloads, network loss, delayed
  saves, out-of-band writes: the design must degrade toward escalation
  and review, never toward disappearance. The benchmark's zero-lost-work
  oracle certifies this per engine on every scenario.
- **P3 — Real conflicts are surfaced, not hidden.** "Conflict-free"
  hides conflicts. When changes overlap meaningfully, the system detects
  it and asks a human, while taking care not to overburden humans with
  constant review. How often an engine asks, on a workload where people
  clash, is measured on purpose: too often means the merge is weak, and
  never means conflicts are being hidden.
- **P4 — Collaboration is not just for humans.** Agents, CLI tools,
  REST/XML-RPC integrations, and plugins must be able to use existing
  WordPress APIs without disrupting collaborative sessions — and ideally
  participate in them meaningfully. A scheduled integration that
  read-modify-writes a post must not erase five minutes of two editors'
  work with no record that a conflict existed.
- **P5 — Cheap hosting is normal hosting.** Functional everywhere,
  progressively enhanced where the host commits resources. Nothing on
  the core path may assume database or process topology beyond what
  WordPress Core itself assumes. Locks, in particular, must be
  implemented the way Core would implement them.
- **P6 — Host economics are measured, not asserted.** Resource usage is
  demonstrated with repeatable benchmarks. The comparison guide
  deliberately carries no numbers (they go stale and mislead); it
  describes stable shapes and points at `npm run bench`.
- **P7 — Capture intent and identity, not snapshots.** Semantic
  operations ("split block", "move block") and stable block identity
  make merges match what the user actually did. Diffing before/after
  snapshots reconstructs a guess — and a guess is what mangles prose
  when edits collide.

## Early decisions still open to revisiting

Three choices made before any engine existed were inherited by all of
them, and the de-rtc port showed their cost. Each is cheap to change
now and expensive later.

- **One wire protocol for every engine.** "Send me the rows after the
  last one I saw" fits the engines that keep a log (intent-log,
  yjs-server) and distorted de-rtc, whose design is built around saves,
  into sending proposals on a poll timer. The change: narrow the engine
  interface to what the principles demand (check, attribute, merge,
  review, produce post content) and let each engine decide what it
  sends and which routes it uses, including none.
- **The official copy lives in plugin storage for every engine.** For
  de-rtc the design says the post itself is the copy, with revisions as
  backup; its saves now write the sync information through to the post,
  but the room tables still hold the working copy (see
  [wontfix.md](wontfix.md)).
- **Every engine over every transport.** Harmless for engines that send
  small updates; harmful for de-rtc, which was designed to send one
  whole document on save. Let an engine say which transports it
  supports, including "none".
