# Adding an engine or a transport

An engine is a PHP class plus a JavaScript adapter, registered through
one filter on each side; a transport is the same shape. Both registries
belong to the bundled Gutenberg framework. This plugin registers its
own three engines and four transports through them, and another plugin
can add a fourth engine or a fifth transport the same way. This page names
the interfaces, the registration points, the optional pieces the
plugin's test tooling looks for, and every hook the plugin offers.

## An engine

**On the server**, implement `WP_Sync_Engine`
(`gutenberg/lib/experimental/collaboration/interface-wp-sync-engine.php`):

| Method | Does |
| --- | --- |
| `get_slug()` | The slug the client and server agree on (`intent-log`, …). |
| `get_protocol_version()` | Bumped on a breaking change to the engine's rows; a client with another version is refused with a 409. |
| `get_update_types()` | The row types the engine accepts from clients and stores. The transport builds its request schema from it; the engine must still refuse types it does not handle. |
| `handle_updates( $room, $client_id, $cursor, $updates, $context )` | Stores one client's updates in order. Returns `[ 'dispositions' => … ]`, a list with one result per update (applied, held for review, thrown away) or null, or a `WP_Error` that fails the whole request. `$context['awareness']` carries who is present. |
| `get_updates_since( $room, $client_id, $cursor, $context )` | Returns the rows after a cursor, with `end_cursor`, `total_updates`, and `should_compact` (unused; always false). |

Two optional methods the plugin's tooling looks for with
`method_exists`: `materialize( $room )`, which turns the room into post
content for the rooms CLI and the benchmarks, and
`flush_room_state_cache()`, which the sync daemon calls so a
long-running process does not keep stale engine state. An
engine with state outside the room rows clears it on the
`gutenberg_sync_engines_room_reset` action. All three engines give a
new room its starting field values from
`WP_Sync_Post_Genesis_Props::for_post()`, so joiners see the same values
under any engine; a new engine should too.

Register it on the `wp_sync_engines` filter, which passes the storage:

```php
add_filter( 'wp_sync_engines', function ( array $engines, WP_Sync_Storage $storage ) {
	$engines[] = new My_Engine( $storage );
	return $engines;
}, 10, 2 );
```

The active engine is the `wp_sync_engine` option (default
`intent-log`), filtered per room by `wp_sync_engine_for_room`. Add the
engine's name and description to the settings screen with
`gutenberg_sync_engines_engine_choices` and
`gutenberg_sync_engines_engine_descriptions`.

**In the browser**, implement `SyncEngine`
(`gutenberg/packages/sync/src/engines/engine.ts`): `slug`,
`protocolVersion`, `createEntity()` and `createCollection()` returning
the per-room cores, and two optional members: `createUndoManager()` for
collaborative undo, and `review` (a `SyncReviewSource`) when the engine
holds edits for a person to decide on; the framework's review panel is
driven from it. Each core exposes a session codec
(`EngineSessionCodec` in `engines/session.ts`) that encodes outgoing
rows, applies received ones, and carries the engine name and protocol
version it adds to each request (`engineSlug`, `engineProtocol`). This
plugin's transports read a few extra optional codec members
(`src/providers/session-extensions.ts`): `onRoomRestart` (what to do
when the room is reset) and `onUpdatesDiscarded` (what to do with
updates the transport had to drop).

Register it through the framework's private API, as `src/index.ts`
does:

```js
import { registerSyncEngine } from './framework';
registerSyncEngine( createMyEngineAdapter() );
```

## A transport

**On the server**, implement `WP_Sync_Transport`
(`gutenberg/lib/experimental/collaboration/transports/interface-wp-sync-transport.php`):
`get_slug()`, `get_protocol_version()`, and `register_routes()`, called
on `rest_api_init` for every registered transport. A transport owns its
routes, its authentication, and when updates are sent, and never reads
update data. Register it on `wp_sync_transports`, which passes the
storage and the engine registry; the active one is selected by
`WP_COLLABORATION_TRANSPORT` (constant, environment variable, or the
`wp_collaboration_transport` filter, which the settings screen feeds).

**In the browser**, register a slug, a protocol version, and a provider
factory:

```js
registerSyncTransport( { slug: 'my-transport', protocolVersion: 1, create: createMyProvider } );
```

The provider factory receives the object type, the object id, and the
session codec, and returns `{ destroy, on, retry? }`. The two stream
transports (`sse`, `sse-daemon`) are the easiest model: they reuse the
polling code and change only how updates are received.

## What the test tooling expects

- **Benchmarks.** How the engine benchmark speaks to an engine is an
  authoring profile (`WP_Sync_Bench_Authoring_Profile`). It turns the
  workload's abstract edits into the engine's rows and plays the
  client's part between requests. It also says which of the engine's
  refusal reasons count as lost work, and scores the result. Register
  one for a new engine with
  the `wp_sync_bench_authoring_profiles` filter (slug to class name,
  constructed as `new $class( int $post_id, array $workload )`). Without
  one the runner uses a fallback profile that cannot score quality.
  Details: `tests/benchmarks/README.md`.
- **The fuzzer.** `ENGINE_CAPABILITIES` in `tests/fuzzer/run.mjs` maps
  an engine slug to the actions the fuzzer must skip for it (today every
  engine syncs everything, so the map is empty). Extend it when a new
  engine lacks a capability the fuzzer exercises.
- **Browser tests.** A spec that belongs to one engine puts
  `@engine-<slug>` in its describe title; CI runs one job per engine
  with `RTC_E2E_ENGINE=<slug>`.

## Hooks and filters

PHP filters and actions the plugin offers, beside the framework's
`wp_sync_engines`, `wp_sync_transports`, `wp_sync_engine_for_room`,
`wp_collaboration_transport`, and `__unstable_wp_sync_storage`. The
settings and daemon ones are described in [settings.md](settings.md).

| Hook | Kind | Does |
| --- | --- | --- |
| `wp_sync_intent_log_checkpoint_interval` (500), `wp_sync_yjs_server_checkpoint_interval` (100), `wp_sync_de_rtc_checkpoint_interval` (100) | filter, per room | How many rows between the full copies of the document an engine saves before deleting older rows. |
| `wp_sync_yjs_server_max_genesis_bytes` (1 MB), `wp_sync_yjs_server_max_room_bytes` (8 MB) | filter | yjs-server's size gates: no session above the first, no further writes above the second. |
| `wp_sync_awareness_backend` | filter | A `WP_Sync_Awareness_Backend` that holds presence instead of the room array; the plugin returns its Presence API backend here. |
| `wp_sync_tab_list_backend` | filter | A `WP_Sync_Tab_List_Backend` that holds the list of editor tabs on a post. |
| `wp_sync_lock_backend`, `wp_sync_cas_backend` | filter | Replace the intent-log room lock and the atomic options-row swap de-rtc uses with another store (Redis, Memcached). The interfaces state the contract each must keep. |
| `wp_sync_awareness_timestamp_granularity` (10 s) | filter | How coarsely presence timestamps are rounded, which is what lets an idle poll skip its write. |
| `wp_sync_debug_enabled` (`SCRIPT_DEBUG`) | filter | Whether a request may ask for the engine's `_debug` envelope. |
| `wp_sync_sse_redis_url`, `wp_sync_sse_max_seconds`, `wp_sync_sse_daemon_url` | filter | The stream's Redis address, maximum length, and daemon address. |
| `wp_sync_websocket_url`, `wp_sync_websocket_access_token_secret`, `wp_sync_websocket_allowed_origins`, `wp_sync_websocket_max_connections`, `wp_sync_websocket_max_connections_per_ip` | filter | The daemon's address, access-token secret, origin allowlist, and connection limits. |
| `gutenberg_sync_engines_advisory_enabled`, `gutenberg_sync_engines_advisory_channel`, `gutenberg_sync_engines_advisory_ice_servers`, `gutenberg_sync_engines_advisory_max_peers` | filter | The advisory channel's switch, its link, its STUN servers (used to connect browsers directly), and the number of tabs above which it turns off. |
| `gutenberg_sync_engines_room_reset_when_empty` | filter, per room | Overrides the "Unsaved changes" setting. |
| `gutenberg_sync_engines_engine_choices`, `gutenberg_sync_engines_engine_descriptions` | filter | The engines the settings screen lists. |
| `gutenberg_sync_engines_room_changed` | action | Fired after every successful storage write, with the room name. The stream transport sends its Redis notice from it; a replacement storage must fire it. |
| `gutenberg_sync_engines_room_reset` | action | Fired when a room is reset; engines clear state they keep outside the room rows. |
| `gutenberg_sync_engines_sse_redis_failed`, `gutenberg_sync_engines_sse_publish_failed` | action | A configured Redis did not answer, or a notice could not be published. |
| `gutenberg_sync_engines_sse_checkpoint` | action | Fired at points in a stream's life so optional diagnostics can measure a stream's memory use; no handler runs normally. |
| `wp_sync_bench_authoring_profiles` | filter | Benchmark profiles by engine slug (above). |

JavaScript filters (`@wordpress/hooks`):
`sync.pollingManager.pollingInterval`,
`sync.pollingManager.pollingIntervalWithCollaborators` (they can only
make polling faster; a slower value is ignored), and
`sync.pollingProvider.maxClientsPerRoom` (the tab limit per post, 5).
