# LOOP.md — lessons that outlive one issue

**This is not a per-cycle ledger.** Each cycle writes itself up as a
comment on its own issue, which is where the next person looks and
which two machines can write at once without colliding. This file is
only for things that outlive one issue: how the loop itself should be
run, and what it has learned the hard way.

Touch it rarely. It is a shared file on the base branch, so every write
is a chance to collide with someone else's machine.

**The queue is not here.** It is GitHub Issues:

```bash
gh issue list --label "agent:ready"        # waiting to be worked
gh issue list --label "agent:in progress"  # being worked now
gh issue list --label "agent:needs shaping" # filed, not investigated yet
```

Anything claimed carries `agent:in progress`, and its assignee is who
to ask about it.

**Base branch:** trunk

## How to run it

```
/loop /shape-issue   # turn filed reports into issues anyone could pick up
/loop /solve-issue   # work through everything labelled agent:ready
```

Either command also takes a single issue number directly (e.g.
`/solve-issue 56`) when you want to work one issue without starting a
loop. One issue per branch, named `loop/<issue number>`. One bounded
piece of work per cycle. The full protocol is in
`.claude/commands/solve-issue.md`; the writing rules are in
`docs/plan/README.md`; the standing repo rules are in `AGENTS.md`.

## Working alongside other people and agents

Several people and agents can run this at once, on separate machines or
in separate workspaces with their own test environments. The rules that
make that safe are small:

- **Claim before working.** `agent:in progress` plus assigning
  yourself, in one call, before the first line of work. The label hides
  the issue from everyone else's list; the assignee says who to ask.
- **Release what you do not finish.** An abandoned claim is invisible
  to every future run. That, not two agents colliding, is the failure
  that actually costs time. If you find a claim that looks stale, check
  with its assignee before taking it.
- **Never share a test environment.** Running the PHP tests wipes the
  database out from under a running browser suite. One workspace, one
  environment, one consumer at a time.
- **Write cycle notes on the issue, not here.**

Parked issues (`agent:parked`) each carry a comment saying what they
are waiting for.

## How a cycle writes itself up

As a comment on its own issue, in this shape:

```
- Did: <one bounded piece of work, in a sentence or two>
- Checked: <the commands run and what they said>
- Verifier: PASS / FAIL — <reasons if FAIL> (or "not requested")
- Next: <what the following cycle will do>
```

The v1 run that came before this is summarised in
`docs/plan/history.md`. Its cycle-by-cycle record is in this file's git
history and is not worth reading unless you are studying the loop
itself.

## Lessons

Things this loop learned the hard way. Keep them short, and move
anything that stops being about *process* into `docs/plan/history.md` or
`AGENTS.md`.

- Run an issue's stated check exactly as written before claiming it
  passes. A test filter that matches nothing exits successfully and
  looks green.
- Check `git log <base>..<branch>` before asking for verification.
  Another session can commit onto the branch you are on, and the
  verifier will fail the whole issue for someone else's change.
- Rebuild the plugin bundle before any browser-based check. Unit tests
  do not need it; anything involving a real browser does, and a stale
  bundle produces evidence for code you did not write.
- Do not switch branches while a background build for that branch is
  running. The build reads whatever is on disk when it gets there.
- A Playwright wait timing out while the element sits in the DOM means
  the page's main thread is stalled, not that the test tooling broke:
  the locator machinery rides the page's own event loop. Before
  blaming the test, measure stalls — the collaboration fixtures'
  `RTC_E2E_CPU_THROTTLE` / `RTC_E2E_CPU_PROFILE` knobs reproduce
  busy-machine flakes on an idle machine and attach the long-task
  timeline and a CPU profile to every failure (built for issue #37).
