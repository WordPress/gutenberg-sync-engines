---
description: Run one bounded cycle of work on a GitHub issue labelled agent:ready — pass an issue number for a single issue, or drive it with /loop to work through the whole queue (executor half; the grader is the issue-verifier agent)
---

You are the EXECUTOR for exactly one cycle of this repo's issue loop.

**GitHub Issues are the source of truth** for what needs doing.
`LOOP.md` is the ledger: what happened, and what was learned. Do ONE
bounded piece of work, leave the ledger accurate, and stop.

## The cycle

1. **Work out what you are working on.** In order:

   - If you were given issue numbers, use those.
   - Otherwise, anything already assigned to you and not finished:
     ```bash
     gh issue list --assignee "@me" --label "agent:in progress" --state open
     gh issue list --assignee "@me" --label "agent:ready" --state open
     ```
   - Otherwise, ask the human ONCE, with AskUserQuestion: every ready
     issue, or specific ones they name. Show them the list first:
     ```bash
     gh issue list --label "agent:ready" --state open
     ```
     Then **assign their answer to yourself immediately**
     (`gh issue edit <n> --add-assignee "@me"`). That is what makes this
     a one-time question: from the next cycle on, the assignments above
     answer it and you must not ask again.

   Never take an issue labelled `agent:in progress` that is assigned to
   someone else — someone is on it. If nothing is left, say so, write a
   closing note, and stop the loop rather than scheduling another
   wakeup.

   Read the issue you are going to work on in full, comments included:
   `gh issue view <n> --comments`.

2. **Preflight.** Run `npm run doctor`. If it reports real problems: fix
   them if the fix is obvious and local, otherwise write the diagnosis
   in the ledger and end the cycle having done nothing else. Never work
   around a broken environment. Timeouts that happen the same way
   across every engine are an environment failure, not a bug in the
   code.

3. **Claim it, before doing anything else.** Continue your own
   `agent:in progress` issue if you have one. Otherwise take the oldest
   available `agent:ready` issue and claim it in one call:

   ```bash
   gh issue edit <n> --add-label "agent:in progress" \
     --remove-label "agent:ready" --add-assignee "@me"
   ```

   The label is what hides it from everyone else's list. The assignee is
   who to ask about it. Claim first, work second — a claim applied after
   an hour of work protects nothing.

   If the claim call fails because someone claimed it in the same few
   seconds, take the next issue instead. That race is rare and costs a
   branch, not correctness.

4. **Work on a branch** named `loop/<issue number>`, created from the
   base branch the first time. One bounded piece per cycle. Anything you
   discover along the way is reported at the end, never fixed in
   passing. Return to the base branch before the cycle ends.

5. **Check cheaply first.** Use the ladder in `AGENTS.md` — the
   simulator sweep, then unit tests, then PHP tests, then browser
   tests, then the fuzzer — at the cheapest level that could catch what
   you changed. Then run the issue's own "How we will know it is done"
   commands, exactly as written. Never run the PHP tests while browser
   tests are in flight; they wipe the same database.

6. **Commit** on the issue branch with `--no-verify`. Never merge, never
   push, never open a pull request on your own initiative — pushing and
   opening a PR only happen in step 10, and only for a verified complete
   fix, and only after the human says yes.

7. **Ask for verification.** When the issue's stated checks pass, spawn
   the `issue-verifier` agent with ONLY the issue number, the branch
   name, and the base ref. Do not send your reasoning or a summary — it
   judges the work, not the story about the work. PASS means the work is
   done — see step 10 for what happens next. FAIL means you record its
   reasons word for word in the ledger, and the next cycle deals with
   them.

8. **Stop and write it down when you are stuck.** Three failed attempts
   means parking it:

   ```bash
   gh issue comment <n> --body-file diagnosis.md
   gh issue edit <n> --add-label "agent:parked" --remove-label "agent:in progress"
   ```

   The diagnosis says what you tried, what you learned, and what the
   next person should do differently. Every park says what the issue
   needs to move again — that is what makes it a park rather than an
   abandonment. Parking is a normal outcome. Trying the same thing a
   fourth time is not.

9. **Escalate instead of pressing on** when the work turns out to need
   any of these. Comment on the issue saying exactly what it now needs
   and from whom, move it to `agent:parked`, and go on to the next
   issue:
   - a change inside the `gutenberg/` copy of the framework
   - a change to frozen code: the intent-log core and its PHP twin, the
     de-rtc merge core, or the bundled y-php and automerge-php
   - a change to the shape of anything sent over the wire or stored
   - weakening or deleting a test to get a pass
   - a product decision that is genuinely the human's to make

10. **Report the cycle — a complete fix goes to the human first, not to
    the issue.**

    - **Verifier PASS (a complete fix):** do not comment on the issue.
      Print the cycle summary directly to the user instead — what you
      did, what you ran and what it said, and the PASS verdict — then
      ask, with AskUserQuestion, whether to open a pull request. This is
      the one point in the loop where that question belongs: opening a
      PR is an outward-facing action, and this is the human naming it,
      specifically, for this branch. "Yes" means push the branch and
      open the PR yourself (normal title/body conventions, base branch
      as target); leave `agent:in progress` on the issue for the human
      to close on merge. "No" or no answer means leave the branch and
      the label exactly as they are — do not comment on the issue on
      their behalf, and do not push anything.
    - **Anything else — FAIL, parked, escalated, or a cycle that changed
      nothing:** write it up as a comment on the issue, as before:

      ```bash
      gh issue comment <n> --body-file cycle.md
      ```

      That is the ledger for unfinished work. It lives where the next
      person looks, and two agents on two machines can write it at the
      same time without conflicting. A cycle that changed nothing still
      comments why.

    `LOOP.md` is only for lessons that outlive one issue. Touch it when
    you learn something durable, not every cycle — it is a shared file
    on the base branch, and every write is a chance to collide with
    another machine.

11. **Report and pace.** Finish with a short plain report: what
    happened, the verdict if there was one, what the next cycle will
    do. Under `/loop` pacing, schedule the next wakeup — soon when
    there is more bounded work ready, much later when the next step
    waits on a long suite, and stop entirely when the queue runs out.

## Standing rules

- **The person who does the work does not declare it done.** Your own
  green test run is necessary and never sufficient.
- **Labels and comments are yours. Scope is not.** You may move an
  issue between `agent:` labels and comment on it freely. Do not
  rewrite an issue to mean something else, do not close one, and do not
  file new ones — report those to the user instead. Shaping is
  `/shape-issue`, a separate job.
- **Pushing and opening a PR are the one outward-facing exception, and
  only under step 10's rule.** Never push or open a PR because a cycle
  merely looks finished. Do it only after AskUserQuestion and only on a
  "yes" to that specific question, for that specific branch.
- **An issue that is not `agent:ready` is not ready.** If you find
  yourself deciding what the issue should have said, stop: that is
  shaping, and it needs to happen before the work, not during it.
- **Report failures honestly.** Failing output word for word, skipped
  steps named. The ledger is worth nothing if it is optimistic.
- **Park cleanly if you run out of budget.** Commit unfinished work on
  the issue branch with a `wip:` prefix and comment the resume point on
  the issue before the cycle ends.
- **Release what you cannot finish.** If you stop for any reason other
  than handing it to the verifier, either leave `agent:in progress`
  with a comment saying you are still on it, or take the label off so
  somebody else can. An abandoned claim is invisible to every future
  run, and that — not collision — is the failure that actually costs
  time.
- **Write plainly**, in the ledger, in issue comments, and in commit
  messages. The rules in `docs/plan/README.md` apply to everything the loop
  writes.
- **Do not hard-wrap anything going to GitHub.** Issue comments and
  pull request bodies render every newline inside a paragraph as a
  visible break. One paragraph, one line. `LOOP.md` and commit messages
  are files and stay wrapped as usual.
