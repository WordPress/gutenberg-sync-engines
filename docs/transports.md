# Transports

A transport is how updates move between the editor and WordPress. The
engine is a separate choice: any engine runs over any transport. Every
transport carries the same request (the room envelope in
[protocol.md](protocol.md)); they differ in who holds a connection open
and what that costs the host. Run `npm run bench -- --suite=transport`
for measured latency and idle traffic on your hardware.

| Transport | Edit-to-visible | Idle cost per collaborator | Needs from the host |
| --- | --- | --- | --- |
| `http-polling` (default) | seconds, bounded by the poll interval; under a second when the advisory channel is up | one request per interval, or none while nothing changes | nothing |
| `sse` | the moment a row lands (Redis), or within half a second (storage checks) | one held PHP worker per visible tab with company | a proxy that passes streams through; Redis optional |
| `sse-daemon` | within about a second | one connection in the sync daemon, no PHP worker | the daemon |
| `websocket` | tens of milliseconds | a few frames per heartbeat, plus the daemon | the daemon, and a proxy that passes the WebSocket upgrade |

A post admits <!-- const:DEFAULT_CLIENT_LIMIT_PER_ROOM -->5<!-- /const --> editor
tabs by default, including the joining tab, checked on a tab's first
connection (`sync.pollingProvider.maxClientsPerRoom`). Every transport
falls back to polling when its connection fails, and comes back when it
can. Every setting is explained on the Settings → Collaboration screen
itself. The options are plain WordPress options, so WP-CLI and the REST
settings endpoint can set them: the engine is `wp_sync_engine`, the
transport `gutenberg_sync_engines_transport`, the advisory channel
`gutenberg_sync_engines_advisory_channel`, and the rest start with
`gutenberg_sync_engines_`. `WP_COLLABORATION_TRANSPORT` (constant or
environment variable) takes priority over the stored transport choice,
and the `wp_sync_websocket_url` filter over the daemon address.

## Polling and the advisory channel

Short polling is the transport every host can run: the editor sends
`POST /wp-sync/v1/updates` on a timer with every open room's queued
edits and gets back the rows it has not seen. Beside it, every editor
tab opens an **advisory channel** to the other tabs on its post. The
channel carries presence (who is here) and the sentence "I landed rows,
go and poll", never content. It runs over one of two links, chosen on
the settings screen: WebRTC between the browsers (`webrtc-advisory`, the
default, with the handshake relayed through the WordPress heartbeat and
the polls), or one WebSocket per tab to the sync daemon or to a relay
the host runs (`websocket-advisory`, which reaches tabs WebRTC cannot).

The channel decides how often a tab polls:

1. **When you are alone, the tab stops polling**, except for 30
   seconds after the page loads or regains focus. Its edits stay in the
   browser until someone else arrives, until a save (the edits go
   through the room first), or until the tab is hidden. A reload loses
   them, which is what the editor's own unsaved-changes warning says.
   De-rtc keeps sending its commits anyway. The heartbeat's answer names the room's
   newest row, so a script or WP-CLI saving the post still wakes the
   tab.
2. **When a peer cannot be reached, the tab polls on a timer**: the
   "Polling interval" setting, <!-- const:POLLING_INTERVAL_DEFAULT -->5<!-- /const --> seconds
   by default.
3. **When every peer can be reached, the tab polls only when needed**:
   when it has edits to send, when a peer says it stored new rows, or
   when the heartbeat reports rows it has not seen. No timer.
4. **The channel is a hint only.** It never changes what a tab shows.
   The server's presence records say who is in the post; the channel
   only shows presence faster.
5. **SSE and WebSocket turn the channel off while connected**, because
   they carry everything themselves. The channel comes back while they
   are down.

If the channel fails (it never connects, a peer drops off it, or more
than <!-- const:DEFAULT_MAX_PEERS -->8<!-- /const --> tabs are on one post), the tab polls on its timer as if
there were no channel. Nothing is lost. A hidden tab polls every 25
seconds. The relay a host can run in place of the daemon is in
`examples/advisory-relay/README.md`.

## Server-sent events

Select "Server-sent events" to receive over one long-lived response per
tab that the server writes each change to. The browser still sends its
own edits on the ordinary updates request beside the stream, marked
`rows_received_separately: true`, and the server answers with the
verdicts but no rows. The stream is the only way rows reach the tab, so
no row arrives twice or gets missed. The browser holds such an answer
until the stream has caught up to that point, then applies it.

What a stream waits on is chosen per request:

| Wait | Chosen when | Idle cost per stream |
| --- | --- | --- |
| Redis notice | `WP_SYNC_SSE_REDIS_URL` is set, or a Redis object cache is detected | nothing |
| Version counter in the object cache | any persistent object cache | one memory read twice a second |
| Version counter in the room-meta table | no cache | one indexed query twice a second |

The counter is bumped on every storage write ([storage.md](storage.md)).
Redis carries only the notice, never content, and a Redis that stops
answering falls back to the checks by itself. Every stream response
carries an `X-WP-Sync-SSE-Wait` header naming what it got: `redis`,
`version-cache`, `version-table`, or `reads`.

The stream's rules: for the first second after a room joins, the tab
uses ordinary requests, so a page that joins several rooms at load opens
one stream. A tab that is alone closes its stream after its discovery
window, exactly as polling goes quiet. A hidden tab drops its stream
under `sse` (a PHP worker is held for as long as the stream is open) and
polls every 25 seconds instead; under `sse-daemon` it keeps it, because
a stream costs the daemon a connection rather than a worker. Streams end
after five minutes at most (`wp_sync_sse_max_seconds`) and five seconds
before PHP's execution limit; every end is safe, because the browser
reconnects from the last row it applied. A keepalive comment goes out at
least every five seconds; a silent connection is aborted by the browser
after 25 seconds. When a stream cannot be opened at all, the browser
polls and retries the stream after five seconds, doubling up to one
minute.

### The same stream from the sync daemon

`sse-daemon` is the same stream written by the sync daemon (the process
the websocket transport runs) instead of a web request. It holds no PHP
worker, and an ordinary chunked HTTP response passes proxies that block
a WebSocket upgrade. The client POSTs the room envelope to
`/wp-sync/v1/sse` on the daemon's address with a one-time token in an
`Authorization` header; the daemon authenticates once per connection,
then writes the `200` and the `text/event-stream` headers, so a refused
request never opens a stream. The daemon learns of new rows on its
once-a-second check of each room's edit log, which is why delivery takes
about a second, and it needs the daemon running; polling remains the
fallback.

## WebSocket

The websocket transport moves everything over one socket per tab to the
sync daemon (`wp collaboration sync-server`), authenticated with a
one-time token offered in the `Sec-WebSocket-Protocol` header rather
than the URL, so it stays out of access logs. Whenever the socket is
down (token refused, daemon unreachable, dropped, or not open within
five seconds) polling carries on from the last row the socket
delivered, and the socket takes over again from the last row polling
delivered when it reopens. Only one of them serves a room at a time, so
no row repeats. Plain `ws://` must never leave a dev box;
the `wss://` address behind TLS goes in the "WebSocket transport server"
setting.

## When the last editor leaves

What happens to unsaved changes when the last editor leaves a post is
the "Unsaved changes" setting. By default they are discarded: every tab
tells the server when it leaves (a beacon on `pagehide`, or the socket
closing), and a per-post room nobody is in is reset to the saved post,
at once on the last leave or when a new tab arrives and finds nobody
there. Every room response carries a generation token (the id of the
room's first row), so a tab whose room was reset under it starts over
from the saved post. The alternative, `keep`, lets the room live on as
a shared working copy. Engines that keep data elsewhere clear it on the
`gutenberg_sync_engines_room_reset` action. Rooms not tied to one post
(a taxonomy's list) are never reset this way.

## Presence on a slow connection

Live cursors only work when every editor holds the same document and
updates arrive before the other person moves on. Over polling every few
seconds they always show a spot someone has left. Intent-log and
de-rtc have no shared document to place them in at all. The "Awareness
interval" setting replaces cursors with block presence: once per
interval each editor names the block its selection is in (`gseBlock`),
sent only when it changes, and other editors see Gutenberg's block
outline and an avatar badge on that block. The name travels with
whatever already carries presence (the sync transport by default, or
the WordPress Heartbeat when "Awareness channel" says so, which then
needs an advisory channel selected). A name for a block the receiver
does not hold yet shows nothing until the block arrives.

## What a host must provide

- **Polling:** nothing. The WebRTC link needs the browsers to reach a
  STUN server (a public Google one by default;
  `gutenberg_sync_engines_advisory_ice_servers` replaces the list) and
  falls back to the timer when they cannot.
- **Server-sent events:** every hop between PHP and the browser must
  pass bytes through as written.
  - The route sends `X-Accel-Buffering: no` (nginx honors it) and
    `Cache-Control: no-cache, no-store, no-transform`. Other proxies,
    CDNs and page caches need their own setting to leave
    `text/event-stream` unbuffered and uncached.
  - Exclude it from gzip and brotli, which buffer, and keep PHP's
    `zlib.output_compression` off for the route.
  - PHP-FPM's `request_terminate_timeout`, a proxy's read timeout or a
    load balancer's idle timeout end a stream early. That is safe.
  - Size the PHP worker pool for one held worker per visible tab that
    has company.
  - A proxy that accepts a stream but buffers it is the worst case: the
    browser sees no keepalive, aborts after 25 seconds and retries.
    Choose polling instead.
  - Redis is optional: `redis://`, `rediss://` or `unix://` in
    `WP_SYNC_SSE_REDIS_URL`. A cluster or sentinel is not detected.
- **The sync daemon** (`sse-daemon`, `websocket`): a PHP command-line
  process that never ends, on port 8787 by default, answering
  `GET /health`. Keep it out of the web worker pool. Start it with a
  process manager that restarts it, put the web server in front of it
  for TLS and pass one path to its local port (unbuffered, reads longer
  than its <!-- const:IDLE_TIMEOUT_S -->45<!-- /const -->-second idle timeout, WebSocket upgrade headers passed).
  It needs only the database (and the object cache, if any): web
  requests and the daemon share the room tables and never talk to each
  other. Restart it now and then; tabs reconnect from the last row they
  received. Run one daemon per site. Limits: <!-- const:DEFAULT_MAX_CONNECTIONS -->512<!-- /const --> connections,
  <!-- const:DEFAULT_MAX_CONNECTIONS_PER_IP -->20<!-- /const --> per IP,
  <!-- const:MESSAGE_RATE_LIMIT -->200<!-- /const --> messages per socket per five seconds. A host that cannot run its
  own processes should use polling or the web-tier stream.

Upgrading, deactivating and uninstalling the plugin are described in
[storage.md](storage.md); switching engines mid-session in
[protocol.md](protocol.md).
