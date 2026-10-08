# Transports

Transports are a separate axis from engines: the engine decides how
concurrent edits merge, the transport decides how updates move. Engines
run over any transport. Run the transport benchmark
(`tests/benchmarks/transport/`) for measured edit-to-visible latency and
idle traffic on your hardware; the stable shape:

| | edit-to-visible latency | idle traffic per collaborator |
| --- | --- | --- |
| http-polling | seconds-scale (bounded below by the poll interval) | roughly one request per poll interval |
| sse | pushed the moment a row lands (Redis notices), or within half a second (version checks) | one held PHP worker per stream for up to five minutes; without Redis, one small lookup twice a second per stream; needs a proxy that passes streams through |
| sse-daemon | pushed within about a second of the row landing (the daemon rescans each room once a second) | one held connection per stream in the sync daemon; no PHP worker, and no new port or TLS beyond the daemon the websocket transport already runs |
| websocket | tens of milliseconds | a few frames per heartbeat — plus a persistent daemon, TLS termination, and an exposed port |

Sessions allow **five total editor connections by default**, including the
joining editor. Each tab counts as a connection, even for the same user.
Polling, SSE, SSE-daemon, and WebSocket check this limit when the editor
first joins its primary room. A sixth connection gets the connection-limit
error; already admitted editors stay connected. The existing
`sync.pollingProvider.maxClientsPerRoom` filter sets the limit for all these
transports. The session benchmark overrides it in its own browser pages.

**Short polling is the base transport, and an advisory channel sits
beside it.** Every tab editing a post also opens a channel to the other
tabs on that post: by default browser to browser (WebRTC, negotiated
through the heartbeat WordPress already sends from every editor screen),
or, when the site chooses `websocket-advisory`, one socket per tab to the
sync daemon, which relays between the tabs in a room and reaches tabs
that cannot connect to each other directly. Either way the channel
carries presence and the sentence "I landed rows, go and poll", never
content; every read and write stays on the REST sync endpoint. While
every known peer is reachable over it, a tab polls only when it has
something to send, when a peer announces, or when the heartbeat reports
changes from a writer not on the channel. A tab that is alone schedules
no polls and holds its edits until
company arrives, a save (flushed through the room first), or the tab
going hidden. Any tab that cannot reach a peer keeps the cadence in the
table. The transport an admin selects is a preference: SSE and
websocket carry everything while connected and turn the channel off
meanwhile, and short polling is always the fallback. The websocket
transport hands its rooms to short polling whenever its socket is down
and takes them back, at the cursor polling reached, when it reopens. The
reasoning, the rules, and the failure cases are in
[advisory-channel.md](advisory-channel.md).

**What happens to unsaved changes when the last editor leaves** is a
setting (Settings → Collaboration → Unsaved changes), applied above the
engine choice. By default they are discarded: every tab tells the server
when it leaves (a beacon on `pagehide`, or the socket closing), and a
per-post room nobody is in is reset to the saved post, at once when the
last tab leaves or when a new tab arrives and finds nobody there. Every
room response carries a generation token so a tab whose room was reset
under it starts over. The alternative keeps rooms as a shared working
copy. See [room-lifetime.md](room-lifetime.md).

Transport latency is engine-independent (the HTTP rows replicate within
noise under intent-log). One caveat on the axis itself: "engines run
over any transport" is an inherited framework property, not a
principle. It fits the log-shaped engines; for DE-RTC it is part of the
adaptation under review ([architecture-decisions.md](architecture-decisions.md),
item 3) — that engine is allowed to declare its own transport story,
including "manual sync with long delays," without penalty.

The short-polling cadence is tunable: the "Polling interval" field on
Settings → Collaboration (default 5 seconds) slows active-tab polling down to 25 seconds
for hosts that want fewer requests (see
`src/providers/http-polling/README.md` for the exact semantics).

**`sse` and `sse-daemon` are the same stream held by different
processes.** Both send the room envelope once and then receive rows on
one long-lived response. The difference is where that response is
written. `sse` writes it from the web tier, so a PHP worker stays up for
the length of the stream. `sse-daemon` writes it from the sync daemon, on
the port the websocket transport already uses, so a stream costs a
connection there instead of a worker. Three consequences are worth
knowing before choosing between them.

- A tab that goes hidden keeps its `sse-daemon` stream and keeps
  receiving, because there is no worker to release. An `sse` tab drops
  its stream on hide and re-reads on return.
- Rows written through the ordinary WordPress REST endpoint reach a
  daemon stream within about a second, on the daemon's once-a-second
  room rescan, rather than the moment they land. Under `sse` with Redis
  the notice is immediate.
- A stream request authenticates with a one-time token in an
  `Authorization` header (`/wp-sync/v1/ws-token`) rather than the REST
  nonce `sse` sends, because the daemon is a separate process with no
  WordPress request context. The daemon listens on its own port, so the
  request is cross-origin and preflighted; the daemon answers the
  preflight from the same origin allowlist the socket handshake uses.

It needs the same proxy that passes streams through, and the same daemon
the websocket transport runs.

Two websocket specifics. The one-time auth token rides the
`Sec-WebSocket-Protocol` offer list rather than the URL query string,
because query strings end up in server and proxy access logs. And
plaintext `ws://` must never leave a dev box; terminating TLS in front
of the daemon is the operator's job, and the `wss://` address goes in
the "WebSocket transport server" field on Settings → Collaboration (or
the `wp_sync_websocket_url` filter, which wins). The advisory channel
has its own "WebSocket advisory server" field, for a relay; empty means
the daemon.

The advisory channel's websocket link can end at a server that is not
the plugin's daemon. With a `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET`
configured, each tab carries a signed, two-minute access token (a JSON Web
Token, HS256) that a relay checks with the shared secret and no call
to WordPress; `examples/advisory-relay/` is a Node relay a host can run
as is or port, and `docs/advisory-channel.md` ("Bring your own
relay") lists the access token claims and the message formats. The daemon
accepts access tokens too. The websocket *transport* cannot be relayed this
way: it does engine work and writes rows.

The websocket-only e2e suite runs against
the real transport: it selects the websocket transport on the tests
site, publishes the `wp collaboration sync-server` daemon, and restores
the previous transport at teardown (`npm run test:e2e:websocket`). For
hour-scale per-user costs with a convergence gate, run the soak harness
(`tests/debugging/soak-transport.mjs`).

## Server-sent events

Select **Server-sent events** in Settings → Collaboration. This transport
runs through ordinary WordPress REST requests: the browser opens one
long-lived response per tab and the server writes each change to it. It
needs no sync daemon or PHP Redis extension. Each open receive stream
occupies a PHP web worker for its whole length.

Redis is optional. What a stream sleeps on is chosen per request, in this
order:

| Wait | Chosen when | Cost per open stream while idle |
| --- | --- | --- |
| Redis Pub/Sub notice | `WP_SYNC_SSE_REDIS_URL` is set, or a Redis object cache is in use (its `WP_REDIS_*` constants name the server) | nothing: the stream is written the moment a row lands |
| Version counter in the object cache | a persistent object cache of any kind (Memcached included) | one memory read twice a second |
| Version counter in the room-meta table | no cache at all | one indexed query twice a second |

The version counter is a number the room storage bumps after every
successful write (updates, room meta, a reset, and presence when presence
is kept in the room storage). Presence kept in the Presence API's
`wp_presence` table, the default, bumps no counter, so each counter check
also reads the presence of the stream's rooms and wakes the stream when
it differs from what was last sent. The stream reads the counters of all
its rooms in one lookup. It notes them just before each read, and reads
again when any has changed since. So a write that happens while it reads
still wakes the next check. Storage is the truth and every cursor comes
from a storage read, never from the counter. How the counter is stored
and bumped is in [storage.md](storage.md). A storage other than the
plugin's tables (through the storage filter) has no counters, and the
stream checks it by reading the new rows and the presence list for each
room, twice a second.

A configured Redis that does not answer is reported through the
`gutenberg_sync_engines_sse_redis_failed` action and the stream falls back
to the version checks by itself; the browser never has to fall back to
polling for it. Configuring Redis, and what it is and is not trusted
with, is in [operations.md](operations.md).

### What the host must provide

A stream only works when every hop between PHP and the browser passes
bytes through as they are written: no response buffering, no
compression on `text/event-stream`, and timeouts longer than a stream.
The settings per proxy, the worker-pool rule, and what happens when a
proxy buffers anyway are in [operations.md](operations.md). In short: a
stream that cannot be opened at all degrades to polling, and a stream
that is accepted but buffered is aborted by the browser after 25
seconds and retried.

For local use, both wp-env configs start a Redis container beside
WordPress and point `WP_SYNC_SSE_REDIS_URL` at it; `AGENTS.md`
(Environment) has the commands, the object-cache drop-in switch, and
how the benchmarks pin what a stream waits on.

Redis Pub/Sub channels are namespaced by the database host and name, table
prefix, and multisite blog ID, followed by the room name. Installations with
different databases can share one Redis instance without receiving each other's
notices, and one site reached through several hostnames still shares one
channel. Redis carries only notices; document storage stays in WordPress.

On a host without a Redis object cache, set `WP_SYNC_SSE_REDIS_URL` (or the
`wp_sync_sse_redis_url` filter) to a private Redis address to get the
instant wake; the settings screen says so next to the choice when no Redis
is configured or detected. `redis://user:password@host:6379` supports Redis
ACL credentials, `rediss://` uses TLS, and `unix:///path/to/redis.sock` a
local socket. Keep this value server-side.

The browser opens a POST stream with normal WordPress cookies and REST nonce
headers. It shares one stream across its current rooms. The server subscribes
to each Redis channel **before** reading stored updates. Edits, presence, and
room resets queue notices from the table storage; notices publish after the
writer finishes. Redis never stores document content. A replacement storage
must emit `gutenberg_sync_engines_room_changed` after its own successful writes
to get prompt notifications.

Streams send JSON room responses in `sync` events, with a comment heartbeat
at least every five seconds while waiting. They end after at most five
minutes (`wp_sync_sse_max_seconds` can shorten this), then the browser
reauthorizes and resumes from its last applied room cursors. A storage catch-up
read every twenty seconds, within the same request,
also covers a process killed after a database write but before its
Redis publish. Redis restart, deploy, and truncated SSE events cannot remove
stored edits. A disconnected browser's unsent edits retain the existing
engine recovery rules; a page reload can still lose unsent local edits.

For the first second after a tab joins a room it receives over ordinary
requests: the editor registers its rooms one by one at load and the tab's
presence fills in right after, and each would otherwise close and reopen
the stream. Once the room set has been still for a second, one stream opens
covering all of it. Local edits go out on the normal `/updates` request
BESIDE the stream, which stays open while the tab types. Each such
request is marked `rows_received_separately: true`: the server stores the edits and
answers with its verdicts and the room's head cursor, but with no stored
rows. The stream is the only path that delivers stored rows and moves a
room's cursor, so nothing is delivered twice or skipped. The browser holds
the answer until the stream has carried the cursor to that head (the
write's own storage notice wakes the stream, so that is one round trip)
and then applies it after the rows, the order every engine relies on. A
cursor move rides the same request when it changes, checked once a
second, so it never reopens the stream either. Redis failures switch receiving
to polling (only a stream that cannot be opened at all does this; a Redis
outage is handled server-side by the storage checks); the browser retries
SSE after five seconds, and each further failure in a row doubles that
wait, up to one minute. A tab alone in its room
closes its stream once the discovery window after load passes, exactly as the
other HTTP transports go quiet, so an idle solo tab holds no PHP worker; the
heartbeat's company report reopens it. A hidden tab holds no stream either:
when the tab goes into the background it drops the stream and receives over
ordinary requests every twenty-five seconds, the cadence short polling uses
for a hidden tab, and it reopens the stream at once when it is visible
again. A hidden tab that is also alone goes quiet like any other. Every twenty seconds the stream
refreshes presence only for a client still
listed in the room, using its current state. It does not recreate an entry
removed by a leave or room reset. Five-second heartbeat comments reset the
browser's twenty-five-second inactivity timeout; a silent connection is aborted.

The server shortens the stream to five seconds below a positive PHP execution
limit. This is a conservative cap; PHP execution time is not always elapsed
time. A host's PHP-FPM or proxy timeout can end the request earlier, and the
browser reconnects with a fresh storage read.

Benchmark on the test site's actual port (wp-env may choose another):

```sh
WP_BASE_URL=http://localhost:8889 npm run bench -- --suite=transport --transport=sse --engine=intent-log --trials=30 --json=/tmp/sse.json
```

The transport and host benchmarks count SSE response bytes as they arrive,
including streams that later get interrupted. Reports distinguish successful
SSE streams from attempted requests and polling fallback. A trial shows
few streams (one per tab, renewed at the stream's length) beside many
small `/updates` posts, one per batch of edits. Server request
metrics recorded at dispatch do not include the later stream wait; use the
host benchmark's whole-request measurements for PHP occupancy. Short runs can
end before a held request is logged at shutdown.

Add `--recovery` to the transport benchmark to interrupt the receiving tab,
accept an edit while it is offline, and require it to catch up without a reload.
The JSON report includes the recovery time separately from normal edit latency.

The sse-only e2e suite (`npm run test:e2e:sse`) selects this transport on the
tests site for its duration and restores the previous one afterwards. It needs
the Redis container the tests env starts, and refuses to run without it, so
that it certifies the Redis wake rather than the storage checks. The fuzzer
sweeps `sse` with the same rule.

## Server-sent events from the sync daemon

The `sse-daemon` transport is the same stream the `sse` transport
speaks, opened against the sync daemon instead of a web-tier REST route.
The daemon is the process the `websocket` transport already runs, on the
same port, so this adds no port, no TLS termination, and no second
service to deploy. Running the daemon on a host is in
[operations.md](operations.md).

### Why a second way to serve the stream

The `sse` transport holds a PHP worker for the life of every stream, and
it needs Redis to be told the moment a row lands. The `websocket`
transport avoids both, but a WebSocket upgrade is the thing a corporate
proxy, a CDN, or a load balancer is most likely to break, and when it
breaks the tab falls back to polling.

`sse-daemon` is the middle: an ordinary chunked HTTP response, which
proxies pass, written by a process that is not a web request. A tab on
this transport holds no PHP worker, and a tab that goes to the
background keeps its stream, because the stream costs the server a
connection rather than a worker.

### How a stream is established

The client POSTs a room envelope to the daemon's stream path
(`/wp-sync/v1/sse` on the daemon's address). The daemon first reads the
start of each request. If it asks for a WebSocket, the daemon opens a
socket; if it is a plain POST, the daemon opens a stream. It
authenticates the request, and only then writes the `200` and the
`text/event-stream` headers, so a refused request never opens a stream.

The credential is the one the socket path uses: a one-time token minted
over the cookie-authenticated REST route, plus the `logged_in` cookie. A
socket can only send the token in its connection request; an ordinary
request can use an `Authorization` header. The daemon accepts both.
The token is spent on first sight, so the client mints a fresh one for
every open. A POST body can arrive across several reads, and the daemon
authenticates a connection once and keeps the result, because
re-authenticating on the second read would spend a token that is already
spent and refuse a stream that was about to open. The symptoms of
getting that wrong, for anyone touching the daemon: it logs `Handshake
rejected: Missing, expired, or mismatched token.`, the browser reports
the stream POST as a CORS failure (a 403 carries no CORS headers), and
the client logs `Error posting sync update, will retry with backoff`
and then succeeds on the retry with a fresh token.

Two rules inside the daemon are easy to mix up. The daemon closes
quiet connections after 45 seconds. A socket sends more messages, so
silence means it is dead; a stream never sends anything, so silence is
normal. Streams must not be timed out on silence, or every live stream
ends after 45 seconds. Separately, the daemon must keep watching every
stream for a close signal from the browser, because that signal is the
only way it learns a stream is over. If it stops watching, dead streams
stay open and the quiet-connection check closes live ones instead.

### What it does not do

- It does not remove the daemon's once-a-second check of each room's
  edit log. Some changes arrive through web requests the daemon never
  sees, so this check is how they reach a stream.
- It does not make delivery instant. A change is delivered within about
  a second of being saved, because the check is the only thing that
  notices it.
- It does not work without the daemon running. The transport is a
  preference, and short polling remains the fallback.

### Where the code is

- `includes/transports/class-wp-sync-connection.php`: the socket layer
  the socket and the stream share.
- `includes/transports/sse/class-wp-sync-sse-connection.php`: the
  `event:` and `data:` framing.
- `includes/transports/sse/class-wp-sync-sse-daemon-transport.php`: the
  web-process half, the stream URL and the transport registration.
- `includes/transports/websocket/class-wp-websocket-sync-server.php`:
  the daemon, which serves both.
- `src/providers/sse-daemon/sse-daemon-provider.ts`: the client half,
  which tells the polling manager that a stream holds no worker
  (`setSseStreamHoldsWorker( false )`) so a hidden tab keeps it.
- In `src/providers/http-polling/polling-manager.ts`, the stream rules
  both SSE transports share: `sseStreaming()` (false while the tab is
  hidden under `sse`), `handleVisibilityChange` and `abortParkedStream`
  (the deliberate close on hide, which logs no failure),
  `SSE_SETTLE_MS` (for the first second after a room joins, the tab
  uses ordinary requests, so a page that joins several rooms at load
  opens one stream, not many), `heldTails` (the server's reply to an
  edit sent beside the stream; the client holds it until the stream
  has caught up to the same point in the edit history), and
  `updatesInFlight` (one send at a time). On the server,
  `READ_FROM_HEAD` in `process_room_request` is how a
  `rows_received_separately` request is answered without rows.

`npm run test:e2e:sse-daemon` starts the daemon with
`--transport=sse-daemon` and runs the daemon-specific specs plus
`tests/e2e/specs/sse-framing/`, which both SSE test runs share, because
only the process writing the stream differs.
