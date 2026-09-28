---
description: Investigate one issue labelled agent:needs shaping and rewrite it into the shaped-issue format — pass an issue number for a single issue, or drive it with /loop to work through the whole queue
---

You are shaping issues for this repo. Someone filed a report in their
own words. Your job is to work out what is actually going on and
rewrite it so that anyone could pick it up.

Read `docs/plan/README.md` for the rules and
`.github/ISSUE_TEMPLATE/shaped-issue.md` for the shape.

## Work out what you are working on

1. If you were given an issue number, use it.
2. Otherwise, anything already assigned to you and not finished:
   ```bash
   gh issue list --assignee "@me" --label "agent:needs shaping" --label "agent:in progress" --state open
   ```
3. Otherwise, ask the human ONCE, with AskUserQuestion: every issue
   waiting on shaping, or specific ones they name. Show them the list
   first:
   ```bash
   gh issue list --label "agent:needs shaping" --state open
   ```
   Then **assign their answer to yourself immediately**
   (`gh issue edit <n> --add-assignee "@me"`, one call per issue). That
   is what makes this a one-time question: from the next invocation on,
   the assignment above answers it and you must not ask again.

Note that the list in step 3 already excludes anything someone else is
shaping, because a claimed issue carries `agent:in progress`. Never take
an issue labelled `agent:in progress` that is assigned to someone else —
someone is on it. If nothing is left, say so and stop rather than
scheduling another wakeup.

## Shape it

Do ONE bounded issue per invocation — under `/loop`, the next
invocation picks up the next one. Anything you learn about a
*different* issue along the way is reported at the end, never acted on
in passing.

**1. Claim it, then read it.**

```bash
gh issue edit <n> --add-label "agent:in progress" --add-assignee "@me"
```

Then `gh issue view <n> --comments`. The reporter's words are
evidence. Do not discard them because they are imprecise —
imprecision is often the symptom. "It goes weird when we both type" is
a real observation.

**2. Investigate before writing.** This is the part that earns the
label change. Read the code, run the reproduction, check the tests. Two
places to look first:

- `docs/plan/history.md` — is this a known dead end, or already explained?
- `docs/` — is this behaving as designed? Some things are deliberate,
  like conflicts resolving silently in yjs-server.

**3. Decide what it actually is**, and say so plainly:

- **A real bug we can act on** → shape it, label `agent:ready`.
- **Real, but a human must decide something first** → shape it, put the
  missing decision near the top, label `agent:parked`, and comment
  saying who decides and what the options are. A park always states
  what it is waiting for.
- **Working as designed** → explain why, in plain language, link the
  doc that says so, and close it. Be gracious: a report that turns out
  to be a misunderstanding is still a documentation problem.
- **Already fixed** → say in which change, and close it.
- **A duplicate** → link the original and close.
- **Not enough to go on** → ask one specific question in a comment and
  leave the label alone. Ask for the smallest thing that would unblock
  you, not a list.

**4. Write the body** to the template's five sections. The example
matters most: numbered steps, real text, what you see, what you
expected. If you reproduced it, use what you actually saw. If you could
not reproduce it, say so honestly and give the closest thing you have,
such as the automated test that does trigger it.

Keep the reporter's own description of the symptom where you can. They
described what it looks like from outside, which is exactly the part
you are least able to invent.

**5. Check it before sending.** Four things, done by reading the
draft, not by feel:

- **Paragraphs are NOT hard-wrapped.** GitHub turns every newline
  inside a paragraph into a visible line break. One paragraph is one
  long line; lists, headings, tables and fenced code keep their own
  lines. Our `.md` files are wrapped, so anything copied out of one
  needs unwrapping first. This is the easiest of these to get wrong,
  because a wrapped draft looks correct in a terminal.
- **All five sections are there**, in order.
- **The example has numbered steps**, real text, what you see, what you
  expected. A description of a scenario is not an example.
- **No jargon above the notes section.** Get the current list — it
  grows as the glossary does, so read it rather than working from
  memory:

  ```bash
  grep -o '^- \*\*[^*]*\*\*' docs/glossary.md | sed 's/^- \*\*//; s/\*\*$//'
  ```

  Search your draft for each one, above the notes heading only. Word
  endings count: "materializes" is "materialize". Words inside file
  paths, commands and code are fine — it is prose that matters. When
  you find one, say what it means instead, or move the whole sentence
  down into the notes.

Say in your report which of these you checked. If you skipped one, say
that too.

**6. Update the issue.**

```bash
gh issue edit <n> --title "<plain-language title>" --body-file draft.md \
  --add-label "agent:ready" --remove-label "agent:needs shaping" \
  --remove-label "agent:in progress" --remove-assignee "@me"
```

Releasing the claim matters as much as making it: a shaped issue nobody
can see is worse than an unshaped one.

Then add a short comment saying what you found and what changed, so the
reporter sees a human-readable answer rather than silently rewritten
text. Two or three sentences.

## Report and pace

Report what you did, in plain sentences: what you found, what you
decided (shaped, closed, parked, duplicate, or a question asked), and
why. Say which of the checks in step 5 you ran, and which you skipped.
An issue you could not reproduce is a finding, not a failure — say so.

Under `/loop` pacing, schedule the next wakeup — soon when there is
more waiting to be shaped, and stop entirely when the queue runs out.

## Rules

- **Editing issues is allowed. Creating them is not**, unless the user
  asked for that specific issue to be filed. Shaping means improving
  what exists. If your investigation turns up a *different* problem,
  say so in your report at the end and let the user decide.
- **Never close an issue you are unsure about.** Closing is a judgement
  with a person on the other end. If it is borderline, shape it and
  raise the question in your report instead.
- **Do not invent reproduction steps.** If you did not run them, say
  which parts are inferred.
- **Do not fix the bug.** Shaping and fixing are different jobs, and
  mixing them means nobody reviewed the shape. The fix happens in
  `/solve-issue`, on a branch, against the issue you just wrote.
- **Write plainly.** Same rule as everything else here: if the word is
  in `docs/glossary.md`, it does not go above the notes section.
- **Never leave a claim behind.** Whatever the outcome — shaped,
  closed, parked, or a question asked — take `agent:in progress` back
  off before you move on. If you stop early, release everything you had
  claimed and say so in your report.
