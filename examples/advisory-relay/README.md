# Advisory relay (bring your own WebSocket server)

A small WebSocket relay for the plugin's advisory channel, for hosts that
cannot run the plugin's own PHP daemon (`wp collaboration sync-server`)
or already run WebSocket infrastructure elsewhere. It runs anywhere
Node 20+ runs, needs no database and no connection to WordPress, and is
short enough to copy or port to another language. The message formats
and the access token it checks are described below.

What it does: editor tabs on short polling open one socket each. The
relay tells the tabs in a room who is present and passes "I saved a
change, go and poll" notices between them. It never sees post content
and never writes anything. Every read and write of the post stays on
the WordPress REST endpoint.

What it cannot do: tell tabs about changes made by something that is
not a tab (a script, WP-CLI). The plugin's daemon does that with a
database scan; with a relay, the heartbeat's head-cursor check covers
it (up to 10 seconds for a focused tab, up to 2 minutes for a hidden
one).

## Setup

1. Choose a secret (32 or more random bytes, e.g. `openssl rand -hex 32`).
2. On the WordPress side, in `wp-config.php`:

    ```php
    define( 'WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET', '<the secret>' );
    ```

    With a secret configured, the plugin mints signed, two-minute access
    tokens instead of one-time tokens, and the plugin's own daemon accepts
    them too.

    Then, under Settings → Collaboration, choose "Polling with a WebSocket
    advisory channel" and enter the relay's address
    (`wss://relay.example.com`) as the WebSocket advisory server. The
    "Test" button beside it connects from your browser and says whether
    the relay accepted the access token.

3. Run the relay with the same secret:

    ```bash
    npm install ws
    WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET='<the secret>' \
    PORT=8790 node relay.mjs
    ```

    Terminate TLS in front of it. `GET /health` answers `200 OK`.

Environment: `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` (required),
`HOST` (`'localhost'`), and `PORT` (8790).

## One relay for several WordPress installs

One relay can serve several WordPress installs that share its secret.
Each access token names its install (the `iss` claim: the network's
site address, such as `example.com`) and its site within a multisite
network (`blog_id`). The relay keeps a separate list of editors for each
install, site, and room, so tabs from different installs never see each
other, even when their posts have the same id.

Every install that holds the secret can make tokens the relay accepts,
including tokens that name another install. Share the relay and its
secret only between installs that trust each other.

Update every install that shares a relay. Tokens from older plugin
versions do not name their install, so the relay still puts all such
installs in one list, as it did before.

## Trying it locally

The websocket e2e suite runs this relay against the tests site with a
fixed test secret (`npm run test:e2e:websocket -- advisory-relay`). To
try it by hand against the dev site, start the relay with
`npm run rtc:ws:advisory` (it runs with the dev site's secret from
`.wp-env.json`), then under Settings → Collaboration choose "Polling
with a WebSocket advisory channel" and enter `ws://localhost:8790` as
the WebSocket advisory server. The "Test" button beside the field
confirms the connection.

## Protocol

Everything a relay author needs, in any language. Only the advisory
channel can be relayed this way; the websocket transport does engine
work and writes rows, so it always needs the plugin's daemon.

### The access token

Access-token mode is on when a secret is configured on the WordPress side:
the `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` constant, else the environment
variable of the same name, else the `wp_sync_websocket_access_token_secret`
filter. With a secret, `POST /wp-sync/v1/ws-token` (the same route the
websocket transport uses) returns an access token instead of a one-time
token; nothing about the client changes except that it names its
post room in the request body (`{ "room": "postType/post:12" }`) so
the access token can allow it. The plugin's own daemon verifies access tokens too
and skips the cookie check when one is valid, so one switch serves the
daemon and a relay alike. Session revocation then waits out the access token's lifetime
for relayed sockets instead of the daemon's 10-second sweep;
acceptable for a lane that carries no content.

An access token is a JSON Web Token signed with HMAC-SHA256 (`HS256`) over the
shared secret — the shape every JWT library parses. Claims:

```json
{
  "user_id": 4,
  "blog_id": 1,
  "iss": "example.com",
  "rooms": [ "postType/post:12", "postType/*", "taxonomy/*", "root/*" ],
  "iat": 1757300000,
  "exp": 1757300120
}
```

-   `user_id`, `blog_id`: the signed-in user and the site (multisite
    blog id; 1 on a single site). The names match the VIP real-time
    collaboration server's tokens on purpose.
-   `iss` (issuer, the standard JWT claim) the network site URL without
    its scheme or trailing slash, in lowercase (`example.com`,
	`example.com/blog`). A stored random id would be copied into a
	staging copy of the database. Tokens from plugin versions before
	it have no `iss`; read a missing one as `''` (so those installs
	still share rosters) and refuse any value that is not a string.

    A relay keys its rosters by `iss`, `blog_id`, AND room, never by
    room alone. Room names are not site-qualified and every single site
    is blog 1, so without the others one relay serving several installs
    would put their tabs in one roster and send each install's presence
    and save notices to the other (issue #126). Installs that share a
    relay share its secret, so they must trust each other: each can
    sign a token naming another. The plugin's daemon does not check
    `iss`: it serves one install, and its command-line process can
    compute a different site URL than the web request that made the
    token.
-   `rooms`: what the tab may follow. An entry is an exact room name,
    or `<kind>/*`, which allows every **collection** room of that kind
    — a room name without an object id, such as `taxonomy/category`
    or `root/comment`. WordPress mints the tab's post room plus the
    three wildcards (collection rooms carry presence only over this
    lane). A follow for any other room is refused with an error frame.
    Without this claim a user could watch who is editing any post and
    nudge them to poll — small, but cheap to close. The plugin's daemon
    applies the same rule to advisory follows. Its sync subscriptions
    are not held to the claim: the websocket transport asks for its
    token without a room (one socket syncs every room the editor
    opens), so the daemon checks those against the user's capabilities.
-   `iat`, `exp`: Unix seconds; an access token lives 2 minutes. Verifiers
    allow 30 seconds of clock skew.

The access token rides the handshake the way the one-time token did: the
browser offers `Sec-WebSocket-Protocol: wp-sync, wp-sync-token.<token>`
and the server must echo `wp-sync` alone. (Not the URL: query strings
end up in access logs.) A relay verifies, in this order: the
offer carries `wp-sync` and a `wp-sync-token.` entry; the signature
checks against the secret with a constant-time comparison; the
header's `alg` is exactly `HS256` (refuse `none` and everything else);
`exp` has not passed (with leeway); the claims have the shapes above.
Anything else: refuse the upgrade with `403` before the socket opens.
The access token is the whole of the check: a server without the
secret cannot complete the handshake, and a browser without a token
from WordPress cannot either, so no `Origin` allowlist is needed (the
plugin's daemon keeps one because it also serves the transport).

### The frames

JSON text frames. Tab → relay:

```json
{ "type": "advisory", "room": "postType/post:12", "client_id": 3,
  "presence_token": "abc…", "presence": { … } | null, "announce": "postType/post:12" | "*" }
```

-   The first frame for a `room` **follows** it: check the access token's
    `rooms`, then bind this socket to that `client_id` for the room
    (the roster is the access token's install and site, see `iss`
    above). A
    later frame with a different `client_id` for the same room is a
    protocol violation: close with `1008` (it could impersonate another
    tab). `client_id` is a positive integer; `room` matches
    `^[^/]+/[^/:]+(?::\S+)?$` and is at most 200 bytes.
-   `presence_token` (a string of at most 64 bytes; only the tab's post
    room carries one) and `presence` (an object or `null`, at most
    16 KB) replace what the roster shows for this tab. Either change
    re-sends the roster.
-   `announce` names a room the tab just landed rows in (or `*`):
    relay it to the room's OTHER followers.

Relay → tabs:

```json
{ "type": "advisory", "event": "roster", "room": "postType/post:12",
  "peers": [ { "client_id": 3, "token": "abc…", "presence": { … } | null }, … ] }
{ "type": "advisory", "event": "announce", "room": "<the room named>" }
{ "type": "error", "code": "rest_cannot_edit", "message": "…", "rooms": [ "…" ] }
```

-   Send the full `roster` of a room to every follower whenever it
    changes: a follow, a presence or token change, a socket closing.
    The list includes the receiving tab itself; tabs drop their own id.
-   When a socket closes, drop it from every room it followed and send
    those rosters. A closed advisory socket is NOT a closed tab: the
    tab's presence record and leave beacon stay the polling
    transport's, so a room is never reset because a relay blinked.
-   Error frames are advisory too; the client ignores them. Send one
    rather than closing for an invalid frame, so a bug in one message
    does not cost the tab its roster.

The size limits above are the daemon's; the reference relay keeps
only a payload cap (64 KB) and a ping every 15 seconds, closing a
socket that misses one. A per-socket message budget (the daemon uses
200 per 5 seconds) is a sensible extra for a public relay.

### What a relay does not do

The plugin's daemon scans the database once a second and tells
followers about rows that landed off the channel: a script, WP-CLI, a
tab on the websocket transport. A relay cannot read the database. This
is shipped without a replacement: the heartbeat's head-cursor check
(the heartbeat's head-cursor check) covers exactly this case, at 10 seconds for a focused
tab and up to 120 seconds for a hidden one, the same as under the
WebRTC link. A later option is a `POST` from the REST write path to the
relay; it is not built.

### Adapting the VIP real-time collaboration server

That server (Automattic/vip-real-time-collaboration, Node) already
verifies an HS256 JWT with a shared secret and the same claim names
(`user_id`, `blog_id`, `iat`, `exp`), so its token code is reusable.
The differences to bridge: it reads the token from an `?auth=` query
parameter (read the `Sec-WebSocket-Protocol` offer instead, and echo
`wp-sync`); it names one room per token in `room_name` (read the
`rooms` list and the `<kind>/*` rule); and it speaks Yjs, not these frames (an advisory mode is a
new message handler; `relay.mjs` shows the whole of it). Set
`WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` to the same value as its
`VIP_RTC_WS_AUTH_SECRET`.
