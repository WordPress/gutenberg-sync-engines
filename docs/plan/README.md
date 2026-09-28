# How we plan work

**Work lives in GitHub Issues.** Anyone can file one, read one, or
argue with one without a checkout. This folder holds the things that
are not issues: why the code is shaped the way it is
([history.md](history.md)), what we looked at and set aside
([wontfix.md](wontfix.md)), and the rules below.

## The two ways in

**A human files a report.** Two required fields: what happened, and
what you expected. That is a complete report. You do not need to know
how anything works, and you do not need to use our words for things.
It arrives labelled `agent:needs shaping`.

**An agent shapes it.** Someone investigates, works out what is
actually going on, and rewrites the issue body into the full shape
below. The label moves to `agent:ready`. The reporter's original words
stay in the issue's edit history.

That is the whole point of the split: a report costs a person two
minutes, and the expensive part is done by whoever picks it up.

## The shape of a shaped issue

Defined by
[`.github/ISSUE_TEMPLATE/shaped-issue.md`](../../.github/ISSUE_TEMPLATE/shaped-issue.md),
which is the one copy — do not restate it here.

Five sections: what happens now, an example with numbered steps, what
should happen instead, how we will know it is done, and notes for
whoever picks it up.

## The rules

**One issue is one thing.** If the title needs "and", it is two issues.

**Plain language at the top.** The title, the problem, and the example
are read by people meeting this project today. Write for them.

**The deep technical detail goes in the notes section at the bottom.**
It is welcome there, in full. It is not welcome above.

**Every issue has a real example** with numbered steps, real text, what
you saw, and what you expected.

**Every issue says how we will know it is done** — a command if there
is one.

### The jargon rule, and who it binds

If a word is defined in [`docs/glossary.md`](../glossary.md), it is
one of ours. Do not use it in the title, the problem, or the example.
Say what it means instead, and save the precise term for the notes.

Room, genesis, materialize, disposition, void, park, escalate,
register, salvage, sequester, incorporate, announce, checkpoint — all
correct in the code, all wrong at the top of an issue.

| Instead of | Write |
| --- | --- |
| the room | the post everyone is editing |
| the intent was voided | the change was thrown away |
| it escalated / parked | it was set aside for a person to decide |
| a stale base | they were working from an old version of the post |
| canonical content | the official copy on the server |

**This rule binds agents, not reporters.** A person describing their
own problem is plain by default. The risk is entirely ours.

## Do not hard-wrap issue bodies

GitHub renders issue, pull request and comment bodies with hard line
breaks on: every newline inside a paragraph becomes a visible break, so
wrapped text arrives ragged. **One paragraph is one long line.** Lists,
headings, tables and fenced code keep their own lines as usual.

The files in this repo are wrapped at about 72 columns, so text moving
from a file into an issue has to be unwrapped on the way. Text moving
the other way should be rewrapped.

## Checking before you file

Read the draft against four things:

- paragraphs are unwrapped, one line each;
- all five sections present, in order;
- the example has numbered steps, real text, what you saw, what you
  expected;
- no glossary words above the notes section.

For the last one, read the current list rather than working from
memory — it grows:

```bash
grep -o '^- \*\*[^*]*\*\*' docs/glossary.md | sed 's/^- \*\*//; s/\*\*$//'
```

## Labels

Anything an agent maintains carries an `agent:` prefix. Everything else
(`bug`, `enhancement`, `documentation`, engine names) is free for
anyone to use.

| Label | Means |
| --- | --- |
| `agent:needs shaping` | Filed, not yet investigated. The front door. |
| `agent:ready` | Shaped. Someone could pick it up today. |
| `agent:in progress` | A loop cycle is working on it. |
| `agent:parked` | Cannot move forward. |

**Claim an issue before working on it**, whether you are shaping it or
fixing it: add `agent:in progress` and assign yourself, in one call,
before you start. The label hides it from everyone else's list, and the
assignee says who to ask. Release it when you stop, whatever the
reason — a claim nobody took off is invisible to every future run, and
that costs more time than two people colliding ever would.

Several people and agents can work this way at once, on separate
machines or in separate workspaces. They must not share a test
environment: running the PHP tests wipes the database out from under a
running browser suite.

**A parked issue always says what it needs**, in a comment: a decision
from a named person, an answer to a specific question, something else
finished first, or — after three failed attempts — what was tried and
what the next person should do differently. "Parked" with no comment is
not parked, it is abandoned.

Create them once:

```bash
gh label create "agent:needs shaping" -c "#FBCA04" -d "Filed, not yet investigated by an agent"
gh label create "agent:ready"         -c "#0E8A16" -d "Shaped and ready to work on"
gh label create "agent:in progress"   -c "#1D76DB" -d "A loop cycle is working on this"
gh label create "agent:parked"        -c "#5319E7" -d "Cannot move forward; the comment says what it needs"
```

## Working through them

```
/loop /shape-issue     # investigate what was filed, write it up properly
/loop /solve-issue     # work through everything labelled agent:ready
```

Either also takes a single issue number directly (e.g.
`/shape-issue #60`) to work one issue without starting a loop.

`LOOP.md` is the ledger while the loop runs. The queue itself is
GitHub:

```bash
gh issue list --label "agent:ready"
```

## When an issue ships

If the change is significant (a new feature, setting, or extension
point, or a behavior change — not a bug fix or tooling work), add a
`CHANGELOG.md` entry as part of the change, per `AGENTS.md`. Close the
issue. If it taught us something that would save the next person a
week, add a line to [history.md](history.md).
