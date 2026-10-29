# Browser editing-action prototype

This prototype runs in the WordPress post editor with yjs-server. It adds an Editing history panel and a JSON download. Simple changes to one plain-text paragraph update the corresponding Yjs text directly. The normal block-tree merge is skipped for those changes. Moves, splits, rich text, batched edits, stale text, and unsupported changes keep the existing sync path.

The history describes local actions observed in this tab. It is not a server-verified audit, and it is not retained after a reload. Download the history before closing the tab. Block IDs are shared within the Yjs session; the prototype does not establish durable identity across room resets.

## Build

The required editor interface and action observer are included in the pinned Gutenberg subtree. Build the subtree first with its usual `npm ci --ignore-scripts` and `npm run build`. Then, from this plugin checkout:

```sh
npm run build
node tests/tools/semantic-capture/build.mjs
npm run env:tests start
GSE_SEMANTIC_PROTOTYPE=1 npm run test:e2e -- semantic-capture
```

The build script bundles only the development history panel. The fixture does not replace Gutenberg scripts or register another Gutenberg observer. Completed actions arrive through the plugin's `registerEntitySyncProvider` registration, alongside the record, save, and undo callbacks. Normal browser suites skip the prototype unless the environment variable is set. The prototype test restores the fixture's previous activation state and the engine setting.

## Try it manually

On the local tests site, activate **Gutenberg Test Plugin, Semantic Capture Prototype** in Plugins and select **yjs-server** in Settings → Collaboration. Collaboration must be enabled in Gutenberg's experiments. Open a saved post with two plain paragraphs. Open that post as another editor in another browser session.

1. Type in a paragraph. The other editor should receive the change. Open Editing history at the bottom right to see the recorded action and targeted-edit count.
2. Press Enter in the middle of a plain paragraph. The history should show a split. Splits at a paragraph's edge currently use an insertion path and are not labelled as splits by this prototype.
3. Use the block toolbar to move a paragraph. The history should show the old and new positions.
4. Download history to inspect the captured evidence. Receiving a peer's update should not create a local action entry.

Deactivate the fixture to return to the normal sync path. The engine's optional prototype binding does nothing when the fixture is absent. Use only a local development site for this fixture.

## Evidence and limits

The browser test uses actual keyboard input, the block toolbar, two authenticated users, and the existing PHP yjs-server. It checks targeted text application in both directions, split and move results, and the absence of false local entries when a peer's changes arrive. The [isolated tests](../../js/semantic-capture/README.md) also check capture reads in a 1,000-block document and separate audit evidence after Yjs compaction.

The framework observer sees completed reducer actions, including actions dispatched inside thunks. Its callback has the owning registry and old and new state. The split command attaches its meaning to the replacement action. No public dispatch function is replaced.

The browser binding matches a captured event to the exact block-array object passed to the engine and checks the entity, block identity, position, and old text before applying it. If those checks fail, it uses the existing path. It does not write back into the editor from the observer. The engine processes the remaining non-block changes as usual.

This is limited to the top-level post editor. Nested entity ownership, full composition-input coverage, grouped asynchronous actions, move conflict semantics, durable audit persistence, and server verification remain design work. Unsupported content actions are not a complete audit stream. The history copies affected block attributes, so long paragraphs still have a cost proportional to their size. No production latency or capacity claim is made.

The plugin now owns the sync manager and engine/transport registries in `src/sync/`. Gutenberg's original sync package has been restored, apart from an extra connection-error code. PHP integration, review UI, and the existing Yjs block conversion still have subtree changes. The normal conversion remains the fallback for operations this prototype does not support.
