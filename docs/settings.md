# Settings

Everything on **Settings → Collaboration**, with the stored option name,
the default, the allowed range, and what it changes. The screen is per
site, and the options are plain WordPress options, so WP-CLI
(`wp option update …`) and the REST settings endpoint can set them too.

Nothing here has any effect until real-time collaboration is on.
Activating the plugin turns the Gutenberg experiment
(`gutenberg-real-time-collaboration`) on; the screen says so when it is
off.

Two words the table uses: a **room** is the shared editing session for
one post, and the **advisory channel** is a side link between the tabs
on one post that tells them who is present and when to fetch changes.
It never carries content.

## The options

| Setting | Option | Default | Values | What it changes |
| --- | --- | --- | --- | --- |
| Sync engine | `wp_sync_engine` | `intent-log` | `intent-log`, `yjs-server`, `de-rtc` | How the server merges edits from several people. Choosing one is the main decision the plugin asks of a site; [engine-comparison.md](engine-comparison.md) is the guide. Changing it mid-session has a cost, see the note below the table. |
| Transport | `gutenberg_sync_engines_transport` + `gutenberg_sync_engines_advisory_channel` | `http-polling` + `webrtc-advisory` | six choices, below | How updates move between the editor and WordPress. Each radio choice sets two options at once: the transport and the advisory channel. (The form field itself, `gutenberg_sync_engines_delivery`, is never stored.) |
| WebSocket transport server | `gutenberg_sync_engines_websocket_url` | empty | a `ws://` or `wss://` address | Where the websocket transport, and the sync daemon's event stream, connect. Empty means the daemon's own host and port (`WP_SYNC_WEBSOCKET_HOST`, `WP_SYNC_WEBSOCKET_PORT`, defaults `127.0.0.1` and 8787). The `wp_sync_websocket_url` filter takes priority over the option. Shown only for the WebSocket choice. |
| WebSocket advisory server | `gutenberg_sync_engines_advisory_websocket_url` | empty | a `ws://` or `wss://` address | Where the websocket advisory channel connects: the sync daemon, or a relay the host runs ([advisory-channel.md](advisory-channel.md), "Bring your own relay"). Empty means the transport server above. Shown only for the "Polling with a WebSocket advisory channel" choice. |
| Polling interval | `gutenberg_sync_engines_polling_interval` | <!-- const:POLLING_INTERVAL_DEFAULT -->5<!-- /const --> (0 means the default) | 0 to 25 seconds | How often a tab asks WordPress for changes while another editor is present that it cannot reach through the advisory channel. When it can reach every other editor, it asks only when told to. Shown only for the polling choices. |
| DE-RTC commit cadence | `gutenberg_sync_engines_de_rtc_commit_interval` | <!-- const:DE_RTC_COMMIT_INTERVAL_DEFAULT -->10<!-- /const --> | 0 to 300 seconds | Under de-rtc, how often a tab sends its changes to the server. An edit stays private until the next commit, so this, not the polling interval, decides how soon other people see it. 0 sends a commit after every pause in typing. |
| Awareness interval | `gutenberg_sync_engines_awareness_interval` | 0 | 0 to <!-- const:AWARENESS_INTERVAL_MAX -->120<!-- /const --> seconds | 0 keeps the built-in live cursors. Any other value replaces them with block presence: once per interval each editor names the block it is in, and other editors see an outline and an avatar on that block ([awareness-high-latency.md](awareness-high-latency.md)). |
| Awareness channel | `gutenberg_sync_engines_awareness_channel` | `sync` | `sync`, `heartbeat` | Whether the name of the block you are in is sent with the normal sync traffic or on the WordPress Heartbeat request. Heartbeat needs an advisory channel selected, and the plugin then sets the Heartbeat interval on post edit screens to match the awareness interval. Only used when the awareness interval is set. |
| Unsaved changes | `gutenberg_sync_engines_unsaved_changes` | `discard` | `discard`, `keep` | What happens to changes nobody saved when the last editor leaves a post. `discard` resets the shared edits to the saved post; `keep` leaves them in place for the next editor ([room-lifetime.md](room-lifetime.md)). The `gutenberg_sync_engines_room_reset_when_empty` filter overrides it per room. |

Each room remembers which engine started it. After you change engines,
tabs that open a post with an old session are refused until that session
is reset, which under the default "Unsaved changes" setting happens by
itself once everyone has closed the post. See
[operations.md](operations.md).

### The six transport choices

| Choice | Sets | Needs |
| --- | --- | --- |
| Polling | `http-polling`, advisory channel off | Nothing. The editor polls on the interval. |
| Polling with a WebRTC advisory channel (default) | `http-polling`, `webrtc-advisory` | Nothing. Tabs connect to each other, poll only when told to, and fall back to the interval when they cannot connect. |
| Polling with a WebSocket advisory channel | `http-polling`, `websocket-advisory` | The sync daemon or a relay. |
| Server-sent events | `sse`, `webrtc-advisory` as the fallback | A proxy that passes streams through. Redis is optional. |
| Server-sent events (sync daemon) | `sse-daemon`, `webrtc-advisory` as the fallback | The sync daemon. |
| WebSocket | `websocket`, `webrtc-advisory` as the fallback | The sync daemon. |

The three choices that need a daemon or a relay show a "Test" button
that connects from your browser and reports whether the server answered
and accepted the credential. Every choice falls back to polling when its
connection fails; the stored advisory channel is what serves then.

A site that chose the retired long-polling transport (`http-long-polling`)
reads as `sse`; the old advisory value `web-rtc` reads as
`webrtc-advisory`.

## Constants and filters that override the screen

| Name | Kind | Effect |
| --- | --- | --- |
| `WP_COLLABORATION_TRANSPORT` | constant or environment variable | Selects the transport and takes priority over the stored option. An unknown slug falls back to polling. The `wp_collaboration_transport` filter runs after it. |
| `wp_sync_engine_for_room` | filter | Overrides the engine for one room. If the configured engine is not registered at all (a misconfiguration), the first registered one serves instead; today that is yjs-server. |
| `wp_sync_websocket_url` | filter | Replaces the websocket transport server address. |
| `wp_sync_sse_daemon_url` | filter | Replaces the address of the daemon's event stream, for a host that fronts the daemon with TLS or proxies the stream path. |
| `WP_SYNC_WEBSOCKET_HOST`, `WP_SYNC_WEBSOCKET_PORT` | constants | The daemon's address when the server field is empty. |
| `WP_SYNC_SSE_REDIS_URL` | constant | A Redis address for server-sent events to wake on (`redis://`, `rediss://`, or `unix://`). Without it the transport detects a Redis object cache by its `WP_REDIS_*` constants. The `wp_sync_sse_redis_url` filter sees the configured or detected address and may replace it, or return an empty string to keep Redis out. |
| `wp_sync_sse_max_seconds` | filter | Shortens a stream below its five-minute maximum. |
| `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` | constant, environment variable, or the `wp_sync_websocket_access_token_secret` filter | Turns on signed access tokens for the daemon and a relay ([security.md](security.md)). |
| `wp_sync_websocket_allowed_origins` | filter | The origins the daemon accepts connections from: the site's home and admin origins by default. |
| `wp_sync_websocket_max_connections` (<!-- const:DEFAULT_MAX_CONNECTIONS -->512<!-- /const -->), `wp_sync_websocket_max_connections_per_ip` (<!-- const:DEFAULT_MAX_CONNECTIONS_PER_IP -->20<!-- /const -->) | filters | The daemon's connection limits. |
| `gutenberg_sync_engines_advisory_enabled` | filter | Turns the advisory channel off in code. |
| `gutenberg_sync_engines_advisory_channel` | filter | Picks the advisory channel's link (`webrtc-advisory` or `websocket-advisory`). |
| `gutenberg_sync_engines_advisory_ice_servers` | filter | Replaces the STUN list the WebRTC link uses (one public Google STUN server by default). |
| `gutenberg_sync_engines_advisory_max_peers` (<!-- const:DEFAULT_MAX_PEERS -->8<!-- /const -->) | filter | The number of tabs on one post above which the advisory channel turns itself off and everyone polls. |
| `gutenberg_sync_engines_engine_choices`, `gutenberg_sync_engines_engine_descriptions` | filters | Add an engine plugin's name and description to the screen. |
| `sync.pollingManager.pollingInterval`, `sync.pollingManager.pollingIntervalWithCollaborators` | JavaScript filters | Lower (never raise) the two polling cadences. |
| `sync.pollingProvider.maxClientsPerRoom` | JavaScript filter | The number of editor tabs a post admits (<!-- const:DEFAULT_CLIENT_LIMIT_PER_ROOM -->5<!-- /const --> by default, including the joining tab). |

Engine-level limits and filters (checkpoint sizes, yjs-server's
document size gates, the de-rtc review route) are listed in
[extending.md](extending.md).
