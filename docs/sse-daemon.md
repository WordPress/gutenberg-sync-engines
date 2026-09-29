# The `sse-daemon` transport

A second framing of the receive stream the `sse` transport already
speaks, opened against the sync daemon instead of a web-tier REST route.
The daemon is the process the `websocket` transport already runs, on the
same port, so this framing adds no port, no TLS termination and no second
service to deploy. The measured shape of every transport is in
[transports.md](transports.md).

## Why a second framing

The `sse` transport holds a PHP worker for the life of every stream, and
it needs Redis to be told the moment a row lands. The `websocket`
transport avoids both, but a WebSocket upgrade is the thing a corporate
proxy, a CDN or a load balancer is most likely to break, and when it
breaks the tab falls back to polling.

`sse-daemon` is the middle: an ordinary chunked HTTP response, which
proxies pass, written by a process that is not a web request. A tab on
this transport holds no PHP worker, and a tab that goes to the background
keeps its stream, because the stream costs the server a connection rather
than a worker.

## What the daemon asks of a framing

Two questions, and they are not the same question:

- **Does the client ever send another message after its request?** A
  socket does; a receive stream does not. Only the idle sweep reads this,
  because `last_seen` cannot advance on a stream, and timing one out would
  end a live stream every `IDLE_TIMEOUT_S`.
- **Is the socket in the read set?** Every socket is, unconditionally. A
  stream never sends a byte, so a readable event on it is the browser
  closing the stream, and that is the only way the daemon learns the
  connection is over.

Conflating the two has a specific signature: streams drop out of the read
set, a dead stream is never reaped, and the idle sweep then removes live
streams instead.

## How a stream is established

The client POSTs a room envelope to the daemon's stream path. The daemon
re-frames that connection from a WebSocket candidate to the stream
framing, authenticates it, and only then writes the `200` and the
`text/event-stream` headers, so a refused request never opens a stream.

The credential is the one the socket path uses: a one-time token minted
over the cookie-authenticated REST route, plus the `logged_in` cookie. A
socket can only carry the token in a subprotocol offer; an ordinary
request sets an `Authorization` header, and the daemon accepts either.
The token is consumed on first sight, so the client mints a fresh one for
every open, and the daemon authenticates a connection once rather than
once per read. A POST body can arrive across several reads, and
re-authenticating on the second read would spend a token that is already
spent, refusing a stream that was about to open.

## What it does not do

- It does not remove the daemon's once-a-second room scan. Rows also land
  through web requests the socket path never sees, so the scan is what
  makes those converge.
- It does not make delivery instant. A change is delivered within about a
  second of the row landing, because the scan is the only thing that
  notices it.
- It does not work without the daemon running. The transport is a
  preference, and short polling remains the fallback.

## Where the code is

- `includes/transports/class-wp-sync-connection.php` — the socket layer
  both framings share.
- `includes/transports/sse/class-wp-sync-sse-connection.php` — the
  `event:`/`data:` framing.
- `includes/transports/sse/class-wp-sync-sse-daemon-transport.php` — the
  web-process half: the stream URL and the transport registration.
- `includes/transports/websocket/class-wp-websocket-sync-server.php` —
  the daemon, which serves both framings.
- `src/providers/sse-daemon/sse-daemon-provider.ts` — the client half.

## Running it

`npm run test:e2e:sse-daemon` starts the daemon with
`--transport=sse-daemon` and runs the daemon-specific specs plus the
shared framing specs. `tests/e2e/specs/sse-framing/` is run by both SSE
lanes, because the framing and the send path are the same for both, and
only the process writing the stream differs.
