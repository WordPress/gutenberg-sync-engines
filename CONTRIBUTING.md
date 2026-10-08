# Contributing to Gutenberg sync engines

Thank you for your interest in contributing. This plugin is
experimental: settings, filters and stored data can change or go away
between versions. Setup and tests are covered in the
[README](README.md#development).

## Coding standards

All code must follow the
[WordPress Coding Standards and best practices](https://developer.wordpress.org/coding-standards/).

- **WordPress**: The minimum required version is 7.0.
- **PHP**: The minimum required version is 7.4.

## Guidelines

- As with all WordPress projects, we want to ensure a welcoming
  environment for everyone. All contributors are expected to follow the
  [Code of Conduct](https://make.wordpress.org/handbook/community-code-of-conduct/).
- All WordPress projects are [licensed under the GPLv2+](LICENSE), and
  all contributions to this plugin will be released under the GPLv2+
  license. You maintain copyright over any contribution you make, and by
  submitting a pull request, you are agreeing to release that
  contribution under the GPLv2+ license.

## Use of AI Tools

You are free to use artificial intelligence (AI) tooling to contribute,
but we ask that you disclose what tooling you are using and to what
extent a pull request has been authored by AI. It is your responsibility
to review and take responsibility for what AI generates.

This repo includes an [`AGENTS.md`](AGENTS.md) file, a
[README for agents](https://agents.md/).

For more, please see the
[WordPress AI Guidelines](https://make.wordpress.org/ai/handbook/ai-guidelines/).

## Filing and shaping issues

Work lives in GitHub Issues. A report needs two things: what happened,
and what you expected. It arrives labelled `agent:needs shaping`; an
agent investigates and rewrites it into the shape in
`.github/ISSUE_TEMPLATE/shaped-issue.md` (what happens now, an example
with numbered steps, what should happen, how we will know it is done,
notes), then moves the label to `agent:ready`. `agent:in progress`
means someone claimed it (add the label and assign yourself in one
step, and release it when you stop); `agent:parked` means it cannot
move and a comment says what it needs.

Write the title, the problem and the example in plain words. If a word
is defined in `docs/glossary.md` it is one of ours and belongs only in
the notes: say "the post everyone is editing", not "the room"; "the
change was thrown away", not "voided"; "set aside for a person to
decide", not "escalated". One issue is one thing. Do not hard-wrap issue
bodies: GitHub shows every newline, so one paragraph is one line.

Agents run the loop with `/loop /shape-issue` and `/loop /solve-issue`
(either also takes an issue number). Cycle notes go on the issue as a
comment; a lesson that would save the next person a week goes in
`docs/traps.md`. Running the PHP tests wipes the test database, so never
share a test environment between two runs.

## Reporting Security Issues

Please see [SECURITY.md](SECURITY.md).
