# Entity sync adapter

The plugin registers its entity sync adapter during normal editor startup.
There is no adapter setting or separate bundle. The existing engine and
transport settings still select intent-log, yjs-server, or de-rtc, over HTTP
polling, SSE, or WebSocket.

## Upstream source

The vendored copy includes the changes from Gutenberg commit
`05068f8ec12b665a01fcd66d350cd4579d94ff22` ([PR #83410](https://github.com/WordPress/gutenberg/pull/83410)).
That commit was merged into the existing framework subtree at
`5fcb081b96b50c6fa2186cfb61c1df2855635db9`. This imports the landed API commit;
it does not update the whole subtree to the latest trunk.

The landed API uses `beforeSave` and `afterSave`. It does not include the
`prepareSave` API from our earlier local experiment. The plugin now follows
what merged upstream.

## Startup and saves

`src/index.ts` registers the engines and transports, then calls
`registerPluginEntitySync()`. The normal bundle depends on `wp-core-data`,
so it uses the same API instance as the editor. When collaboration is
turned off, the plugin does not register an entity manager.

The adapter wraps Gutenberg's `createDefaultEntitySyncManager` bridge.
This keeps the existing engine selection, awareness, undo metadata, Yjs
snapshots, connection status, and conflict-review callbacks. Regular saves
also flush held transport updates before the post request. Autosaves keep
the engine's snapshot fields and do not trigger that flush.

The HTTP provider's old save-request middleware has been removed. The
entity callback now owns this step.
De-rtc keeps its separate save middleware, which coordinates its autosave
commit requests with an editor save.

## Local Gutenberg changes still required

The merged interface is internal to core-data. It does not yet expose a
plugin registration point. Our vendored copy makes these changes:

- Expose `registerEntitySyncManager` and `createDefaultEntitySyncManager`
  through the existing locked private API.
- Let the plugin register the entity manager. The upstream bridge no longer
  registers itself during module evaluation; the first registration wins.
- Preserve the framework's engine negotiation and post-lock fallback.
- Move the existing conflict-review callbacks from the record resolver to
  `sync-review.js`, which the bridge uses for each record. Proposal actions
  still reach the same engine instance.

The PHP room server and other framework extensions remain in the vendored
copy. This change does not make the plugin compatible with unmodified
upstream Gutenberg, or remove the need for the subtree.

## Checks

From this checkout:

```sh
npm run build
npm run typecheck
npm run test:js -- --runInBand
npm run test:entity-sync
```

`test:entity-sync` checks types against the vendored API and runs the adapter
checks. They include normal entry-point registration, the real save actions,
real intent-log clients with local undo and redo, cancellation during a
record load, and the real HTTP provider with a simulated server response.
An optional Gutenberg checkout argument checks the types and save actions
against that source instead.

For the vendored code:

```sh
cd gutenberg
npm run typecheck -- packages/core-data/tsconfig.build.json
npm run test:unit -- packages/core-data --maxWorkers=2 --testTimeout=30000
npm run build
```

Browser and PHP integration checks still require the tests WordPress
environment. They must cover editing, saving, reloading, undo, connection
failure, and conflict review with the existing engine/transport settings.

## Remaining API limits

Registration and undo ownership are global. The upstream API calls `update`
before the local edit reaches the store; engines must continue to delay
synchronous corrections. `afterSave` only runs after a successful regular
save, so it cannot release resources acquired before a failed save. The
plugin adapter acquires no such resources.

The HTTP flush waits for a send attempt, including a failed request. Its
five-second timeout is a bound on waiting, not proof that the server accepted
the update.
