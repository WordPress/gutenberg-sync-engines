# Debugging and analysis tools

The tools here generate load or validate projections; they do not
answer a product decision, which is what separates them from the
**benchmarks** in `tests/benchmarks/` (run those through
`npm run bench` — see its `--help`). These are deliberately not behind
that entry point: each is invoked directly and documented fully, for
developers and agents rather than plugin evaluators.

- **`soak-transport.mjs`** — the N-window, hour-scale co-editing soak
  (below).
- **`replay/`** — capture real collaboration sessions and replay them
  as repeatable HTTP load, in the community RTC performance harness's
  fixture format. See [`replay/README.md`](replay/README.md).

## The N-window soak (`soak-transport.mjs`)

The transport benchmark (`npm run bench -- --suite=transport`) answers
"what does one edit cost"; the soak answers "what does an hour of real
co-editing cost per user" — the end-to-end validation of the hosting
cost cards' composed projections:

```bash
node tests/debugging/soak-transport.mjs \
    engine=de-rtc transport=http-polling windows=3 soak=3600 \
    json=soak-de-rtc.json
```

N windows share one post; each window owns ONE paragraph and edits only
it in staggered bursts with think time (deterministic jitter — reruns
pace the same), so the run has real multi-writer merge traffic without
constant same-block conflict. Window 0 saves the post periodically
(`save=` seconds; under de-rtc the save carries `base_version` through
the room) and inserts a latency probe every `probe=` seconds that every
other window's in-page watcher stamps on arrival. Wire counters are
sampled per minute per window (`minuteSamples` in the JSON), and the
diagnostics request log — cleared at start, scenario-tagged `soak` —
supplies the server-side totals.

The run FAILS unless every window converges to the identical serialized
document within 90 s of the soak ending. The report is per user-hour
(mean across windows): client requests and KB up/down, server requests,
dispatch ms, CPU ms, and DB queries — the same units the cost cards in
`docs/engine-comparison.md` compose from engine-seam floors, so a run
directly validates (or corrects) the card for that
engine/transport/user-count. Shared plumbing is imported from
`tests/benchmarks/transport/lib.mjs`, so the soak and the transport
benchmark use identical counters, tagging, and server-log collection.
The soak's full argument list is in `soak-transport.mjs`'s header;
it needs the same environment as the transport benchmark (running
wp-env with the plugin active, Playwright's chromium, `WP_BASE_URL` /
`WP_USERNAME` / `WP_PASSWORD`).
