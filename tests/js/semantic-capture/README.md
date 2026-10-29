# Editing-action capture prototype

This isolated prototype captures Gutenberg store actions and applies supported plain-text edits to Yjs. It does not change a running editor or either engine.

A [browser prototype](../../tools/semantic-capture/README.md) now connects the same capture code to a real post editor and the yjs-server engine through an opt-in test fixture.

```sh
npm run test:js -- --runInBand semantic-capture
```

Install and build the pinned Gutenberg subtree first, as described in the root AGENTS.md. The test imports its actual block-editor reducer, action creators, selectors, and thunk middleware. Permission answers and the surrounding editor registry are test fixtures. The Jest configuration transforms the ESM-only Markdown dependency loaded by the real block store.

## What it proves

- Attribute capture reads only the addressed blocks. The 1,000-block case reads one paragraph before the action and once afterwards.
- Move events record the actual locations. A move refused before dispatch produces no event.
- A replacement becomes a split event only with explicit command information and a matching simple paragraph result. Generic replacements stay generic.
- Remote updates and initial loading do not create new local events.
- Detached before and after evidence survives later editor resets.
- Two real Yjs documents merge concurrent captured plain-text edits. Duplicate delivery does not duplicate content.
- Separate audit evidence survives deletion, discarded update arrays, and loading a compacted document.

## Files

- `capture.ts` provides middleware that runs after thunk handling. Its reader accepts one clientId at a time; it has no whole-tree read operation. It collects events for later processing and does not dispatch back into the editor.
- `yjs-text.ts` applies a captured plain-text field change in one Yjs transaction. The caller resolves the durable block ID to shared text. It rejects rich HTML and stale text instead of guessing positions.
- `../semantic-capture.test.js` runs the prototype against Gutenberg and Yjs.

## Limits

The fixture supplies command meaning, origin, entity, and stable IDs. It does not implement a public Gutenberg hook, RichText operation capture, entity ownership, durable persistence, or the server audit contract. Split recognition covers only plain paragraphs whose text joins back to the original. Structural changes are captured but are not applied to Yjs or intent-log.

The reader copies affected block attributes; it does not promise constant cost for a large field. Move lookup can inspect sibling order. The read-count test measures the capture layer, not total Gutenberg work or browser latency.

The capture records are untrusted client evidence, held in memory. A production server must authenticate the author and verify the claimed action and accepted effect. The fixture's local event counters and clientId parent locations are not production identity rules.

Unsupported operations create a fallback report. This prototype does not execute fallback or disable the existing engine tree comparison. A production binding must handle stale editor versions, undo, composition input, nested blocks, remote origins, grouped asynchronous commands, and duplicate submission before it replaces the current path.

The review specification is maintained through the drafts workflow in the user's Notes folder as `spec-engine-decision.md`.
