# Sync prototype (graduated)

The planning documents of the intent-log prototype, written while it lived
under `prototypes/sync/` in Gutenberg. The engine graduated to the sync
stack and — with the whole engine/transport layer, the framework's PHP
(`includes/framework/`) and the conflict review UI (`src/review/`) — now
lives in this plugin: the client engine (bridge/manager/session), the
frozen cross-language core (`src/engines/intent-log/` — engine modules,
SPEC.md, jest suites, simulator, frozen vectors, generator/sweep tools),
and the PHP twins (`WP_Intent_Log_Document`, `WP_Intent_Log_Planner`).

Gutenberg keeps only a bare contract: the collaboration gate on the server
and the private `registerEntitySyncProvider` seam in core-data. The
documents below describe the design as it was planned and reviewed, and
still name Gutenberg paths and packages that have since moved here; read
them as history, not as a map of the current tree.

The documents:

- `ARCHITECTURE.md` — the three-plane integration design (transport /
  engine / bridge), the swappable-engine constraints, and per-phase status.
- `INTEGRATION.md` — the Redux-mapping analysis, the disposition of the
  `core-data` crdt\* utilities, and the text-intent capture design.
