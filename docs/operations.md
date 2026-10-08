# Operating it on a host

This page is for whoever runs the site: what an upgrade, a deactivation,
an uninstall, or an engine switch does; what the transports beyond
polling need from the host; and what to watch. A room, below, is the
shared editing session for one post. Local development setup is in
`AGENTS.md`.

## Upgrade, deactivate, uninstall, downgrade

- **Upgrade.** Replace the plugin files as usual. If the new version
  ships a newer storage schema (`WP_Sync_Table_Schema::DB_VERSION`), the
  tables are upgraded with `dbDelta` on the next load. Edits being
  shared at upgrade time are kept unless a release note says otherwise.
  A stored transport choice that no longer exists is switched to its
  replacement (`http-long-polling` reads as `sse`); an unknown slug falls back to
  polling, and an unknown engine falls back to the first registered
  one.
- **Deactivate.** Collaboration turns off and the editor goes back to
  the one-person post lock. The tables and every room stay in place, so
  reactivating resumes where things were.
- **Uninstall (delete).** `uninstall.php` drops the two tables on every
  site. Unsaved collaborative changes in any room are gone with them;
  saved posts are untouched.
- **Downgrade.** There has been one schema version so far, so an older
  plugin version reads the same tables. Rows written by a newer engine
  protocol may be refused by an older client; the editor then falls
  back to the post lock for that post until the room is reset.
- **Reset everything.** `wp collaboration storage reset` deletes every
  room and keeps the tables. `wp collaboration storage status` shows
  what a site has.

## Switching engines

Each room remembers the engine that first wrote it. After you change
the engine, a tab that opens a post whose room was written by the old
engine is refused with a 409, and that editor falls back to the post
lock. Rooms that are not tied to one post (a taxonomy's or a pattern
category's shared list) are reset automatically when a tab speaking the
new engine arrives, because they are rebuildable. Per-post rooms keep
the stricter rule, since they can hold unsaved content.

Under the default "Unsaved changes" setting a per-post room is reset to
the saved post as soon as the last editor leaves. So the block clears
itself once everyone closes the post. To clear a room by
hand, reset the storage (above), or on a development site inspect it
with `wp collaboration rooms inspect <room>`.

## What each transport needs

| Transport | Needs from the host |
| --- | --- |
| Polling (default) | Nothing. Every host can run it. The WebRTC side link between tabs needs the browsers to reach a STUN server, and falls back to the polling timer when they cannot (see the note below). |
| Server-sent events | A proxy chain that passes streams through unbuffered, and a PHP worker pool sized for one held worker per visible tab that has company. Redis is optional (below). |
| Server-sent events (sync daemon) | The daemon, below. No held PHP worker. |
| WebSocket | The daemon, and a proxy that passes the WebSocket upgrade. |

The STUN server is a public Google one by default; the
`gutenberg_sync_engines_advisory_ice_servers` filter replaces the list.

### Proxies, buffering, and timeouts (server-sent events)

A stream only works when every hop between PHP and the browser passes
bytes through as they are written. This is the one requirement the
stream adds over polling, and the usual reason it "does not work" on a
host where polling does.

- **Response buffering.** The route sends `X-Accel-Buffering: no` and
  `Cache-Control: no-cache, no-store, no-transform`. nginx honors the
  first, `proxy_buffering` and `fastcgi_buffering` included. Other
  proxies, CDNs, and page caches need their own setting to leave
  `text/event-stream` responses unbuffered and uncached.
- **Compression.** Compression buffers. Exclude `text/event-stream`
  from gzip and brotli at the proxy and in Apache's `mod_deflate`;
  PHP's `zlib.output_compression` must be off for the route.
- **Timeouts.** PHP's `max_execution_time` shortens a stream: the server
  ends it five seconds before the limit. PHP-FPM's
  `request_terminate_timeout`, a proxy's read timeout, or a load
  balancer's idle timeout can end it earlier. Every end is safe: the
  browser reconnects from the last row it applied. A keepalive comment
  every five seconds keeps idle-timeout counters from firing on quiet
  streams.
- **Worker pools.** Size the PHP worker pool for one held worker per
  open editor tab on top of ordinary traffic. Tabs that are alone on a
  post close their stream, and so do hidden tabs (they poll every 25
  seconds instead and reopen the stream when visible again), so the
  count is the number of visible tabs that have company.

When a stream cannot be opened at all, the browser falls back to polling
and retries the stream with a growing wait, so with a misconfigured
proxy the editor still works, over polling. A proxy that accepts
the stream but buffers it is the worse case: the browser sees no
keepalive, gives up after 25 seconds, and retries. If a host cannot pass
streams through, choose polling with an advisory channel instead.

### Redis (optional)

With a Redis address (`WP_SYNC_SSE_REDIS_URL`, or a Redis object cache
the plugin detects) a stream is written the moment a change lands.
Without one, each stream checks a per-room version number twice a
second: in the object cache if the site has a persistent one, else in
the room-meta table. Both work; Redis saves the checks.

Redis only carries wake-up signals, never content. Each install uses
its own channel names (from the database host and name, the table
prefix, and the site id), so installs can share one Redis without
hearing each other. A Redis that
stops answering is reported through the
`gutenberg_sync_engines_sse_redis_failed` action and the stream falls
back to the version checks by itself; the browser never has to fall back
to polling for it. A Redis cluster, replica set, or sentinel group is
not detected (the plugin's small client does not speak them); set a
single endpoint by hand if one exists. Keep the address server-side.

### The sync daemon

`wp collaboration sync-server [--host=…] [--port=…]` is a PHP
command-line process that never ends. It serves the websocket transport,
the websocket advisory channel, and the daemon's event stream on one
port (8787 by default), and answers `GET /health` with `OK`.

- **Keep it out of the web worker pool.** There it would hold a worker
  forever, which is the cost the daemon transports exist to avoid.
- **Start it with a process manager** (systemd, supervisord, or its own
  container) that restarts it after a crash or a deploy, and point a
  health check at `/health`.
- **Put the web server or load balancer in front of it.** Let it handle
  TLS and pass one path to the daemon's local port, so no new port is
  open to the internet and no plain `ws://` leaves the machine. On that
  path, turn off response buffering, allow reads longer than the
  daemon's <!-- const:IDLE_TIMEOUT_S -->45<!-- /const -->-second idle timeout, and pass the WebSocket upgrade
  headers. Enter the public `wss://` address as the "WebSocket transport
  server" setting; the daemon's event stream uses the same address (or
  the `wp_sync_sse_daemon_url` filter).
- **It needs only the database** (and the object cache, if the site has
  one). Web requests and the daemon never talk to each other. They
  share the same database tables, and the daemon finds new rows on a
  once-a-second scan. So it can run on a web server or on its own
  machine.
- **Restart it now and then.** PHP was not built for processes that run
  for days. A scheduled restart is cheap: tabs reconnect from the last
  row they received and lose nothing.
- **Run one daemon per site** unless you have tested more. Each
  connection must stay on the daemon it opened, and the websocket
  advisory channel keeps its list of who is present in the daemon's
  memory, so tabs on different daemons do not see each other there.
- **Limits.** 512 connections, 20 per IP address, 200 messages per
  socket per five seconds; the first two are filters
  (`wp_sync_websocket_max_connections`,
  `wp_sync_websocket_max_connections_per_ip`).

A host that cannot run its own processes, as on most managed WordPress
hosting, should use polling or the web-tier stream instead. A host that
already runs WebSocket servers can run its own relay in place of the
daemon, but only for the advisory channel
([advisory-channel.md](advisory-channel.md), "Bring your own relay",
and `examples/advisory-relay/`). The websocket transport itself always
needs the plugin's daemon.

## What to watch

- `wp collaboration storage status`: the tables, the schema version,
  which storage is active, and the room and row counts. Row counts stay
  limited: every engine saves a full copy of the document every 100 or
  500 rows and deletes the older rows.
- The daemon's `GET /health`.
- The `X-WP-Sync-SSE-Wait` header on every stream response: `redis`,
  `version-cache`, `version-table`, or `reads`. If you configured Redis
  and see `version-table`, the connection is not being used.
- On a development site, `wp collaboration rooms list` and `inspect`
  show every room's engine, size, and last rows, and the plugin records
  lock timeouts, edits held for review, repairs, and row deletions
  through Query Monitor's `qm/debug` action.
- The host cost benchmark (`npm run bench`) measures what the plugin
  adds to a server for a chosen number of editors; point it at a staging
  copy of the real host to size worker pools.

Two sizes to know: yjs-server refuses to start a session for a post
above 1 MB and refuses further writes to a room that grew past 8 MB
(both filters, see [extending.md](extending.md)); the other engines have
no size gate but their merge cost grows with the document.
