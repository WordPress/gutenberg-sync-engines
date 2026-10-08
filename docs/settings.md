# Settings

Everything on **Settings → Collaboration**: the stored option name,
the default, the range, and what it changes. The options are plain
WordPress options, so WP-CLI and the REST settings endpoint can set
them too. Nothing has any effect until the Gutenberg
`gutenberg-real-time-collaboration` experiment is on, which activating
the plugin does. A room is one post's shared editing session; the
advisory channel is the side link between its tabs
([transports.md](transports.md)).

## The options

| Setting | Option | Default | Values | What it changes |
| --- | --- | --- | --- | --- |
| Sync engine | `wp_sync_engine` | `intent-log` | `intent-log`, `yjs-server`, `de-rtc` | How the server merges edits from several people. Choosing one is the main decision the plugin asks of a site; [engine-comparison.md](engine-comparison.md) is the guide. Changing it mid-session has a cost, see the note below the table. |
| Transport | `gutenberg_sync_engines_transport` + `gutenberg_sync_engines_advisory_channel` | `http-polling` + `webrtc-advisory` | six choices, below | How updates move. Each radio choice sets both options at once. |
| WebSocket transport server | `gutenberg_sync_engines_websocket_url` | empty | a `ws://` or `wss://` address | Where the websocket transport, and the sync daemon's event stream, connect. Empty means the daemon's own host and port (`WP_SYNC_WEBSOCKET_HOST`, `WP_SYNC_WEBSOCKET_PORT`, defaults `127.0.0.1` and 8787). The `wp_sync_websocket_url` filter takes priority over the option. Shown only for the WebSocket choice. |
| WebSocket advisory server | `gutenberg_sync_engines_advisory_websocket_url` | empty | a `ws://` or `wss://` address | Where the websocket advisory channel connects: the sync daemon, or a relay the host runs (`examples/advisory-relay/README.md`). Empty means the transport server above. Shown only for the "Polling with a WebSocket advisory channel" choice. |
| Polling interval | `gutenberg_sync_engines_polling_interval` | <!-- const:POLLING_INTERVAL_DEFAULT -->5<!-- /const --> (0 means the default) | 0 to 25 seconds | How often a tab asks WordPress for changes while another editor is present that it cannot reach through the advisory channel. When it can reach every other editor, it asks only when told to. Shown only for the polling choices. |
| DE-RTC commit cadence | `gutenberg_sync_engines_de_rtc_commit_interval` | <!-- const:DE_RTC_COMMIT_INTERVAL_DEFAULT -->10<!-- /const --> | 0 to 300 seconds | Under de-rtc, how often a tab sends its changes to the server. An edit stays private until the next commit, so this, not the polling interval, decides how soon other people see it. 0 sends a commit after every pause in typing. |
| Awareness interval | `gutenberg_sync_engines_awareness_interval` | 0 | 0 to <!-- const:AWARENESS_INTERVAL_MAX -->120<!-- /const --> seconds | 0 keeps the built-in live cursors. Any other value replaces them with block presence: once per interval each editor names the block it is in, and other editors see an outline and an avatar on that block ([transports.md](transports.md)). |
| Awareness channel | `gutenberg_sync_engines_awareness_channel` | `sync` | `sync`, `heartbeat` | Whether the name of the block you are in is sent with the normal sync traffic or on the WordPress Heartbeat request. Heartbeat needs an advisory channel selected, and the plugin then sets the Heartbeat interval on post edit screens to match the awareness interval. Only used when the awareness interval is set. |
| Unsaved changes | `gutenberg_sync_engines_unsaved_changes` | `discard` | `discard`, `keep` | What happens to changes nobody saved when the last editor leaves a post. `discard` resets the shared edits to the saved post; `keep` leaves them in place for the next editor ([transports.md](transports.md)). The `gutenberg_sync_engines_room_reset_when_empty` filter overrides it per room. |

A post's shared session remembers the engine that began it. After you
switch engines, tabs on an old session are blocked until the session
resets. With the default "Unsaved changes" setting that happens once
everyone closes the post.

### The six transport choices

| Choice | Sets | Needs |
| --- | --- | --- |
| Polling | `http-polling`, advisory channel off | Nothing. The editor polls on the interval. |
| Polling with a WebRTC advisory channel (default) | `http-polling`, `webrtc-advisory` | Nothing. Tabs connect to each other, poll only when told to, and fall back to the interval when they cannot connect. |
| Polling with a WebSocket advisory channel | `http-polling`, `websocket-advisory` | The sync daemon or a relay. |
| Server-sent events | `sse`, `webrtc-advisory` as the fallback | A proxy that passes streams through. Redis is optional. |
| Server-sent events (sync daemon) | `sse-daemon`, `webrtc-advisory` as the fallback | The sync daemon. |
| WebSocket | `websocket`, `webrtc-advisory` as the fallback | The sync daemon. |

The choices that need a daemon or a relay show a "Test" button. Every
choice falls back to polling when its connection fails. A site that
chose the retired long-polling transport (`http-long-polling`) reads as
`sse`.

## Constants and filters that override the screen

| Name | Kind | Effect |
| --- | --- | --- |
| `WP_COLLABORATION_TRANSPORT` | constant or env | Selects the transport over the stored option (then the `wp_collaboration_transport` filter). |
| `wp_sync_engine_for_room` | filter | Overrides the engine for one room. An unregistered engine falls back to the first registered, yjs-server. |
| `wp_sync_websocket_url` | filter | Replaces the websocket transport server address. |
| `wp_sync_sse_daemon_url` | filter | Replaces the daemon's event stream address. |
| `WP_SYNC_WEBSOCKET_HOST`, `WP_SYNC_WEBSOCKET_PORT` | constants | The daemon's address when the server field is empty. |
| `WP_SYNC_SSE_REDIS_URL` | constant | A Redis address for streams to wake on; without it a Redis object cache is detected. The `wp_sync_sse_redis_url` filter may replace it or return an empty string. |
| `wp_sync_sse_max_seconds` | filter | Shortens a stream below its five-minute maximum. |
| `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` | constant, env, or the `wp_sync_websocket_access_token_secret` filter | Turns on signed access tokens for the daemon and a relay. |
| `wp_sync_websocket_allowed_origins` | filter | The daemon's origin allowlist (the site's own by default). |
| `wp_sync_websocket_max_connections` (<!-- const:DEFAULT_MAX_CONNECTIONS -->512<!-- /const -->), `wp_sync_websocket_max_connections_per_ip` (<!-- const:DEFAULT_MAX_CONNECTIONS_PER_IP -->20<!-- /const -->) | filters | The daemon's connection limits. |
| `gutenberg_sync_engines_advisory_enabled` | filter | Turns the advisory channel off in code. |
| `gutenberg_sync_engines_advisory_channel` | filter | Picks the advisory channel's link (`webrtc-advisory` or `websocket-advisory`). |
| `gutenberg_sync_engines_advisory_ice_servers` | filter | The WebRTC link's STUN servers (one public Google server by default). |
| `gutenberg_sync_engines_advisory_max_peers` (<!-- const:DEFAULT_MAX_PEERS -->8<!-- /const -->) | filter | The number of tabs on one post above which the advisory channel turns itself off and everyone polls. |
| `gutenberg_sync_engines_engine_choices`, `gutenberg_sync_engines_engine_descriptions` | filters | Add an engine plugin's name and description to the screen. |
| `sync.pollingManager.pollingInterval`, `sync.pollingManager.pollingIntervalWithCollaborators` | JavaScript filters | Lower (never raise) the two polling cadences. |
| `sync.pollingProvider.maxClientsPerRoom` | JavaScript filter | The editor tabs a post admits (<!-- const:DEFAULT_CLIENT_LIMIT_PER_ROOM -->5<!-- /const -->, including the joining tab). |

Per-engine limits: `wp_sync_intent_log_checkpoint_interval` (500),
`wp_sync_yjs_server_checkpoint_interval` and
`wp_sync_de_rtc_checkpoint_interval` (100) set how many rows pass
between full snapshots; `wp_sync_yjs_server_max_genesis_bytes` (1 MB)
and `wp_sync_yjs_server_max_room_bytes` (8 MB) are yjs-server's size
gates. The replaceable backends (`wp_sync_awareness_backend`,
`wp_sync_tab_list_backend`, `wp_sync_lock_backend`,
`wp_sync_cas_backend`) are in [storage.md](storage.md).
