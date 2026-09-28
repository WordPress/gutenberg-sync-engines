# Session capture → sanitize → replay

Records real collaboration sessions at the transport seam and replays them
against a live site as real HTTP traffic — a load-generation lane adopted
from the community RTC performance harness
([WordPress/distributed-rtc-performance-testing](https://github.com/WordPress/distributed-rtc-performance-testing)),
speaking **its capture fixture format** so fixtures travel between the two
toolchains. Where the engine benchmark (`tests/benchmarks/`) replays
*synthetic* workloads through the engine seam and the transport benchmark
(`tests/benchmarks/transport/`) drives *two live browsers*, this lane sits
between them: **real captured traffic, replayed at HTTP scale** — repeatable
load with genuine engine payloads, no browsers needed at replay time.

## The workflow

```bash
# 1. CAPTURE (server-side, on a diagnostics-enabled site — see Gating below)
npx wp-env run cli wp collaboration capture start my-session \
    --room=postType/post:42        # omit --room to capture all rooms
#    …collaborate in real editor windows (or run any RTC traffic)…
npx wp-env run cli wp collaboration capture stop
npx wp-env run cli wp collaboration capture export my-session > my-session.json

# 2. SANITIZE (strip user identity + site ids before sharing)
node tests/debugging/replay/sanitize.mjs my-session.json out=my-session-clean.json

# 3. REPLAY (against any site running this plugin with the same engine)
node tests/debugging/replay/replay.mjs my-session-clean.json --speed=1
```

`wp collaboration capture list` shows captured sessions;
`wp collaboration capture drop <id>` (or `--all`) deletes frames.

## The fixture format

The export is the community harness's `capture-export` JSON — one frame per
captured `/wp-sync/` request:

```json
{
  "session_id": "my-session",
  "frame_count": 122,
  "frames": [ {
    "n": 1, "elapsed_ms": 123.4, "client_id": 10001,
    "room": "postType/post:42",
    "request":  { "rooms": [ { "room", "client_id", "awareness", "after", "updates" } ] },
    "response": { "…" }
  } ]
}
```

plus four **additive** top-level keys the community format does not carry
(its sanitizer drops them; ours preserves them): `engine`, `transport`, and
`base_title` / `base_content` — the post state when capture started. This
plugin's engines validate updates against server state (the community
harness's relay endpoint did not), so replay recreates the starting
document from `base_content` before sending frames; without it, intents
that target pre-existing blocks void or escalate instead of applying.

Sanitization (mirroring the community `capture-sanitize`) keeps only
post-room frames, normalizes the room to `postType/post:0` and `after` to
0, and strips awareness (user names/colors) and the captured responses.
**A sanitized fixture still contains the document text** — it lives in the
update payloads and `base_content` by construction. Sanitization removes
*identity*, not content.

## Replay semantics

- **Per-client lanes.** Each captured client's frames replay in order
  against its own live cursor (tracked from each response's `end_cursor`);
  different clients interleave concurrently on the captured schedule, so
  genuinely overlapping requests overlap at replay too.
- **Pacing.** `--speed=1` preserves captured inter-frame timing; `--speed=4` is
  4× faster; `--speed=0` sends as fast as the per-client ordering allows
  (stress mode — the community harness's `POLL_DELAY=0` analog).
- **Retargeting.** Frames replay into a fresh draft post seeded from the
  fixture's base state (or `--post=<id>` to reuse one).
- **Engine fence.** A fixture replays meaningfully only under the engine
  that captured it — the wire vocabulary, room lineage stamp, and
  update-type validation are engine-specific. The tool aborts on a
  mismatch (`--force` overrides; expect voids/409s, which is itself a way
  to observe the rejection path).
- **Awareness.** Captured awareness states replay verbatim; sanitized
  (empty) awareness replays as `null` — a synthetic state without a real
  user object crashes the collaborator-avatar UI of any editor window open
  on the target post.
- **Reporting.** The tool prints status-code and disposition histograms
  (applied/escalated/voided by reason) plus client-side latency
  percentiles, and — when the target site has the diagnostics request log
  (below) — the server-side per-request report. `--json=out.json` writes
  per-frame results.

Run `node tests/debugging/replay/replay.mjs --help` for the full option
list. Environment: `WP_BASE_URL` (default
`http://localhost:8889`), `WP_USERNAME` / `WP_PASSWORD` (default
`admin` / `password`).

## Gating and the server-side metrics

Capture and the per-request benchmark log live in
`includes/diagnostics/` and load only on local/development sites or under
the `GUTENBERG_SYNC_ENGINES_DIAGNOSTICS` constant — never in the
production path. Replayed requests carry the community harness's tags
(`X-RTC-Test`, `X-RTC-Scenario`), so the request log records dispatch
wall/CPU time, `db_queries`, `db_time_ms` (needs `SAVEQUERIES`), memory,
and concurrency per request, readable via `wp collaboration bench-log
report` or the community-compatible `rtc-test/v1` REST routes
(`/log`, `/report`, `/report-all`, `/env`).

## Limitations

- **Responses are not asserted.** Replay reports how the engine settled
  each frame (dispositions), but does not diff replayed responses against
  captured ones — cursors, seqs, and genesis differ across rooms by
  construction. Use the engine benchmark's oracles for convergence claims.
- **Auth is single-user.** All lanes replay under one logged-in user
  (capture records client ids, not sessions). Fine for load and merge
  shape; per-user capability differences don't reproduce.
- **A captured session that started from existing content needs its
  capture to have used `--room=…`** — that's what snapshots
  `base_content`. An unfiltered capture replays onto an empty document,
  which can change how the engine settles early frames.
