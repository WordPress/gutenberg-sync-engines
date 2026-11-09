---
name: Shaped issue
about: A shaped issue that is ready for work by an agent.
labels: [ "agent:ready" ]
---

<!--
This is the shape an issue takes once someone has investigated it.

Agents: `gh issue create --body-file draft.md` bypasses this template,
so copy the headings below into your draft, and check it against the
rules in CONTRIBUTING.md ("Filing and shaping issues") before creating.

DO NOT hard-wrap paragraphs. GitHub turns every newline inside a
paragraph into a visible line break, so wrapped text renders ragged.
One paragraph is one long line; let the browser wrap it. This differs
from our .md files, which are wrapped — the same text needs unwrapping
on its way to an issue. The one that matters: the title, the
problem, and the example are read by people meeting this project today.
If a word is defined in docs/glossary.md, it is one of ours — say what
it means instead, or move the sentence down into the notes.

Delete these comments and every unused heading before filing.
-->

## What happens now

Two or three sentences on what a person doing ordinary work runs into. No jargon. For a feature rather than a bug, describe what people cannot do today. Keep each paragraph on one line.

## Example

Numbered steps someone could follow to see it.

1. Open a post in two windows, signed in as two different people.
2. In window A, do the specific thing.
3. In window B, do the other specific thing.

**What you see:** the wrong result, quoted exactly.

**What you expected:** the result that would be correct.

## What should happen instead

One short paragraph, described the way you would say it to the person who reported it.

## How we will know it is done

The command to run and what passing looks like:

```bash
npm run test:js -- some-pattern
```

If there is no command yet, say what to check by hand and note "needs a
test" below. If this issue is still being shaped, say instead **which
decision is missing** and who makes it.

## Notes for whoever picks this up

The deep detail, as precise as you like: file paths, the mechanism, what has been tried, what is already fixed, dead ends. Link related issues as `#12`.

Check the Traps section of `AGENTS.md` and `docs/wontfix.md` before writing this section — if the approach you are about to suggest is already listed there as a dead end, say so.
