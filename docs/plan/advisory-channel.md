# Plan: a base transport, an advisory channel, and discovery on the heartbeat

Status: implemented on branch `transport-layers` (2026-09-02, revised 2026-09-03). This file
keeps the reasoning; the code is the reference for details.

## The idea

Short polling is the base transport everyone has. It moves:

-   base presence (who is in the room):
    -   author IDs, names, avatars (everything needed to show the "who is here" list)
    -   signaling and offers for WebRTC handshakes
-   enhanced presence (cursors, selections)
-   document updates

Short polling can implement every facet of collaboration, albeit slowly.
This base transport can be enhanced in two ways:

### Advisory channel

The advisory channel moves:

-   base presence (who is in the room):
    -   author IDs, names, avatars (everything needed to show the "who is here" list)
-   announcements:
    -   "the server has new rows, go and poll"

The advisory channel can be established in three ways:

1. Via WebRTC, using signaling on short polling requests / responses. (default,
   `webrtc-advisory`)
2. Via WebRTC, using signaling on the heartbeat. (default, `webrtc-advisory`)
3. Via a WebSocket to the plugin's sync daemon (`websocket-advisory`). Each tab
   opens one socket; the daemon keeps an in-memory roster per room, relays
   presence and notices between the tabs in it, and never carries a row. This
   replaces the WebRTC mesh while retaining the base short polling transport,
   and reaches tabs WebRTC cannot (a symmetric NAT without TURN, a blocking
   extension, tabs on different networks) at the price of running the daemon.

A client who successfully connects to an advisory channel can poll on demand, rather
than on a short timer. A "backup" timer is still needed to catch updates from peers
who are not on the channel (e.g., bots or WP CLI commands that save directly against
the server), but it can be much slower than the default short polling cadence.

Since we will only be providing signaling and (public) STUN servers for the default
WebRTC channel, the advisory channel must be considered optional. If it cannot be
established, the client falls back to polling on a short (configurable) timer.

An example sequence using the default WebRTC advisory channel (offer on
discovery: an offer is tied to one peer connection, so a tab publishes
its token first and offers once it knows whom to offer to):

-   User A opens a post in one tab. It polls with a "genesis update" as
    well as its signaling token. Nobody else is there, so A settles on
    the slow safety poll (25 s) and its heartbeat (10 s).
    -   Any edits made by the user are queued until another user is
        present (flushed before a save and when the tab goes hidden).
-   User B opens the same post in another tab. It polls with a "genesis
    update" as well as its signaling token. The response lists the other
    tokens in the room (A's) and says someone else is present, so B polls
    at the company cadence.
-   A learns of B on its next tick (heartbeat or safety poll; up to
    10 s — nothing B does can bring that forward). A now has company: it
    releases its queued updates and polls at the company cadence.
-   The lower token initiates: it creates an offer and sends it with its
    next request (a poll when the loop is active, else a heartbeat beat
    forced by `connectNow()`). The other tab receives it on its next
    poll, about a second later, and answers the same way.
-   A and B now send base presence and announcements to each other over
    the WebRTC advisory channel, and both drop to on-demand polling plus
    the safety poll.
-   When User A makes an edit, it sends the update to the server via
    short polling, plus an announcement over the advisory channel to
    User B that there are new rows to poll.

### Preferred transport

Short polling is always available as the fallback. When an admin
selects another transport (SSE, websocket), that is their
PREFERRED transport: it moves everything the base transport does while
it is connected, and the client stops polling on the base transport and
the advisory channel meanwhile. An example is the `websocket`
transport, which moves all updates and presence over a single socket
connection, so no advisory channel is needed while it is up.

If the preferred transport fails to connect, or is disconnected after a
successful connection, the client falls back to short polling (and, if
enabled, the advisory channel) until it is back.

## Plugin settings

Two stored options, chosen through one list:

1. Transport: `http-polling` (default), `sse`, or `websocket` (the
   long-polling transport was retired in favor of `sse`, which is the
   same held request as a stream). The default short-polling transport is always available
   as a fallback.
2. Advisory channel: `webrtc-advisory` (default), `websocket-advisory`,
   or off. An advisory channel reduces polling by signaling to peers when
   updates are available. It serves whenever short polling does, so under
   a preferred transport it is only active while that transport is down.
   The WebSocket link needs the same daemon the WebSocket transport uses
   (`wp collaboration sync-server`), or a host's own relay ("Bring your
   own relay" below); a tab that cannot open its socket keeps the timer
   cadence, exactly like a tab whose WebRTC failed.

The screen shows them as one "Transport" list of five entries (see
"What exists now"), because the two options can conflict: a WebSocket
transport with a WebSocket advisory channel looks configured and does
nothing. Beside them: the WebSocket transport server URL (the daemon;
empty means the `WP_SYNC_WEBSOCKET_HOST`/`PORT` constants, and the
`wp_sync_websocket_url` filter overrides it for hosts that configure in
code), the WebSocket advisory server URL (a relay; empty means the
daemon), and the polling interval (default 5 seconds).

## The rules, stated plainly

1. **Short polling is the base transport everyone has.** One transport
   slug is announced. There is no mesh of transports. A site can prefer
   another transport (SSE, websocket) that carries everything
   while connected; short polling is always the fallback.
2. **The advisory channel is a rumor.** A nudge carries a room name and
   nothing else. Nothing in it moves the cursor, applies a row, or
   proves who wrote what. Presence over the channel is display data,
   never authority: who is *in* the room is decided by the server's
   presence records, not by the channel. The "who is here" list is the
   union of the server's answer and the channel's; a peer whose WebRTC
   failed is still a person in the room.
3. **Alone means quiet.** While the server says nobody else is in this
   post's room, the tab schedules no polls (the heartbeat's head-cursor
   check catches a script or WP-CLI saving the post meanwhile), except
   for 30 s after the page loads and after the tab regains focus, when
   it keeps the 4 s solo cadence: those are the moments a second person
   most often turns up, and the heartbeat alone would take up to 10 s
   to notice them. Updates are queued until another peer arrives, and
   flushed before a save and when the tab goes hidden (see "Solo
   editing" below). De-rtc is exempt: its commits ride the autosave
   lane and its undo stack is its own accepted rows, so it keeps
   sending.
4. **Company without coverage means today's cadence.** If anyone is in
   the room whom this tab cannot reach over the channel, the tab polls
   at the configured interval. "Anyone" means every presence token the
   heartbeat reports AND every client id the last poll's awareness map
   reported. Both lists must be covered by an open channel. Otherwise a
   peer whose WebRTC failed would write rows nobody polls for.
5. **Full coverage means poll on demand, with no timer.** With every
   known peer reachable, the tab polls when it has updates to send
   (debounced), when a peer announces (coalesced, with a floor), and
   when a heartbeat answer reports the room's head cursor ahead of its
   own. That last check catches writers who are not on the channel at
   all: scripts, WP-CLI, a peer whose channel dropped mid-write, a
   taxonomy term created from another screen. It rides the heartbeat
   WordPress already sends (10 s focused, 120 s blurred), so a
   backgrounded tab notices such a write up to two minutes late; that
   lag is accepted, nobody is looking at it. There is no safety poll.
   The answer also names the engine the site resolves for the room, so
   a mid-session engine change makes the tab poll into the server's
   fence instead of never noticing.
6. **Discovery and signaling ride polling and the heartbeat.** Each editor tab has a
   per-tab token, stamped when the page renders and refreshed every
   heartbeat. The polling and heartbeat answer lists the other tokens in the room,
   says whether anyone else is there, and delivers any handshake
   messages addressed to this tab. A handshake message rides the next
   poll when the loop is active (about a second at the company
   cadence), else the sender calls `wp.heartbeat.connectNow()`; the
   receiver still sees it on its own next request. Messages are kept
   until the request that carried them is answered and re-queued when
   it fails; every probe carries a sequence number so a slow answer
   overtaken by a newer one cannot regress the peer list; every message
   carries an id so a retried duplicate is ignored. The description goes
   out at once and candidates trickle behind it. The server files
   messages in a compare-and-swap options row, so concurrent senders
   and a take cannot lose one; rows are named by room, so the ones no
   live token owns are swept once a minute, even after the token record
   itself has expired.
7. **A preferred transport switches the channel off, but only while
   connected.** SSE does this explicitly; websocket does it by
   construction (the polling manager has no rooms while the socket
   serves them). The channel comes back while the transport is down.

## Solo editing: held updates

A lone tab holds its updates until company arrives. Two cases matter:

-   **A peer joins.** The joiner bootstraps from the room without the
    held edits, the lone tab learns of the joiner on its next tick,
    releases its queue, and the engine merges the release as a late
    concurrent batch. The joiner converges on its next poll. This is a
    late merge, not a clobber.
-   **Save, then reload.** This is the real trap: a save writes the post
    while the room never saw the edits, and the reload bootstraps from
    the stale room over the freshly loaded post. So the queue is flushed
    BEFORE any save (an `apiFetch` middleware on the entity's REST
    route, the same seam de-rtc's `prepareForSave` uses), and when the
    tab goes hidden (a hidden tab cannot answer a joiner for up to
    120 s). An unsaved edit lost on reload is the editor's own
    unsaved-changes warning doing its job.

Cursors and selections stay on the base transport by decision: over the
channel they would point at content positions the receiver has not yet
polled for. Rethinking awareness for low-latency lanes is out of scope.
The one exception is slow awareness's block name (`gseBlock`, see
[awareness-high-latency.md](../awareness-high-latency.md)): it names a
block rather than a position, and a receiver that does not hold that
block yet shows nothing until it arrives, so it rides the presence lane.

What happens to the room when the last editor leaves is a separate
switch, [room-lifetime.md](room-lifetime.md).

## What exists now

Server (`includes/class-gutenberg-sync-engines-advisory-presence.php`):

-   Per-tab presence tokens in a transient per room (never in sync
    storage: presence reads must not create a room's storage post).
    Stamped at editor page render, refreshed on every heartbeat, removed
    by a leave beacon on `pagehide`, expired after 300 s (a hidden tab's
    heartbeat slows to 120 s, so the TTL must span two beats).
-   The probe answer (`answer_probe`), shared by the heartbeat filter
    (`heartbeat_received`) and the poll route: records the token,
    stores outgoing handshake messages in per-recipient mailboxes (size
    and count capped, short expiry), and answers with the other tokens in
    the room, whether anyone else is present (tokens plus live sync
    awareness), and this tab's mailbox.
-   Page-render settings under `window._gutenbergSyncEnginesSettings
.advisory`: room, token, whether others are present, the STUN list
    (filterable), the peer cap, and the enabled flag.

Client:

-   `src/providers/advisory/signaling.ts`: the probe and mailbox, with
    two carriers: the heartbeat, and the sync poll itself (the request's
    `advisory` field, answered alongside the rooms) whenever the loop is
    active, which makes the handshake about two seconds at the company
    cadence. Discovered peers, "others present", send/receive handshake
    messages, the leave beacon.
-   `src/providers/advisory/channel.ts`: the channel the polling manager
    sees, whichever link is underneath: the presence overlay, the notice
    and coverage listeners, the presence loop, the on/off switch. It picks
    the link from the page settings (`link.ts` is the seam).
-   `src/providers/advisory/webrtc-link.ts`: the WebRTC mesh. One peer
    connection and one data channel per discovered tab. The tab with the
    lower token initiates; the offer or answer goes out at once and
    candidates trickle behind it on the next carrier, buffered by the
    receiver if they overtake the description. Messages:
    `hello` (client id), `presence`, `announce`, `bye`. Coverage is
    computed from discovered tokens and the last awareness map.
-   `src/providers/advisory/websocket-link.ts`: one socket per tab to the
    sync daemon — or to a host's own relay in access-token mode ("Bring your
    own relay" below) — opened with the same token handshake as the
    websocket transport (the socket URL rides the page settings under
    `websocket-advisory`). Frames: the tab follows its post's room
    (`{type: 'advisory', room, client_id, presence_token}`), sends its
    presence on the same frame when it changes, and announces writes
    (`announce: <room>` or `*`); the daemon answers every roster change
    with the room's full roster (client id, token, latest presence per
    follower) and relays notices to the other followers. Coverage is the
    roster: every discovered token and every client id in the last
    awareness map must be on it. A dropped socket reconnects with
    backoff and replays the tab's presence; nothing on the daemon side
    is written to storage, and a dropped advisory socket is NOT a closed
    tab (the leave beacon and awareness stay the polling transport's).
-   `includes/transports/websocket/class-wp-websocket-sync-server.php`:
    the daemon's advisory mode (`handle_advisory_message`): a follower is
    permission-checked like a sync subscriber and bound to one client id;
    the once-a-second room scan now reads one head cursor per room and
    tells followers when rows landed off the channel (a script, WP-CLI, a
    websocket-transport peer), once per batch.
-   `src/providers/http-polling/polling-manager.ts`: the cadence rules
    above, the held queues (released by company, a flush before a save
    via `save-flush.ts`, or the tab going hidden; codecs declaring
    `sendsWhileAlone` are exempt), the announce-after-send, the base
    presence overlay (per client, on top of the poll response's copy),
    and the stream disable hook.
-   Settings → Collaboration: one "Transport" list whose entries are
    (transport, advisory channel) pairs — polling; polling with a
    WebRTC advisory channel (default); polling with a WebSocket advisory
    channel; server-sent events; WebSocket — so the conflicting pairs cannot
    be chosen. SSE and WebSocket store WebRTC as the fallback
    channel. The stored options stay `gutenberg_sync_engines_transport`
    and `gutenberg_sync_engines_advisory_channel`. Two server URL fields
    (transport server, advisory server) with "Test" buttons show only
    for the entries that need them; the polling interval only for the
    polling entries.
-   `src/providers/websocket/websocket-manager.ts`: the websocket
    transport as a preferred transport. While its socket is open it
    moves everything; whenever it is not (token refused, daemon
    unreachable, socket dropped) each room is PARKED with the polling
    manager at the cursor the socket had reached, and reclaimed at the
    cursor polling reached when the socket reopens, carrying whatever
    polling never sent (`pollingManager.releaseRoom`). One lane serves a
    room at a time, so nothing is replayed across the handoff. A
    connection attempt that has not opened after 5 s parks the rooms
    too, while it keeps trying: a black-holed port can take the browser
    tens of seconds to give up on. If the socket drops while a reclaim
    is waiting on polling, the room goes back to polling at the cursor
    polling reached instead of binding to the dead socket.
-   `src/engines/de-rtc/session.ts`: announces after a commit lands
    through the autosave lane, since those rows never pass through the
    polling manager.

## Bring your own relay

Status: implemented (issue #92, 2026-09-08). The reference relay is
`examples/advisory-relay/relay.mjs` (Node, one dependency: `ws`); this
section is everything a relay author needs, in any language.

The websocket link does not have to end at the plugin's PHP daemon. A
host that cannot run a long-lived PHP process, or that already runs
WebSocket servers in Node or Go, can enter a relay of its own as the
"WebSocket advisory server" on the settings screen. The relay is small because the lane is small: it
tells the tabs in a room who is present and passes "go and poll"
notices between them. It never sees content, writes nothing, and never
calls WordPress — the one thing it must do on its own is decide whether
a connection comes from a signed-in user who may follow the rooms it
asks for. WordPress settles that by handing each tab an **access token**.

Only the advisory lane can be relayed this way. The websocket
*transport* does engine work and writes rows; it always needs the
plugin's daemon.

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
  "rooms": [ "postType/post:12", "postType/*", "taxonomy/*", "root/*" ],
  "iat": 1757300000,
  "exp": 1757300120
}
```

-   `user_id`, `blog_id`: the signed-in user and the site (multisite
    blog id; 1 on a single site). The names match the VIP real-time
    collaboration server's tokens on purpose. A relay keys its rosters
    by `blog_id` AND room, never by room alone: room names are not
    site-qualified, so one relay (and one secret) serving several
    WordPress sites would otherwise put two sites' tabs in one roster
    and send each site's presence to the other. The access token refusal
    already keeps a tab's presence away from a server without the
    secret; this keeps it away from the wrong site behind a shared
    one.
-   `rooms`: what the tab may follow. An entry is an exact room name,
    or `<kind>/*`, which allows every **collection** room of that kind
    — a room name without an object id, such as `taxonomy/category`
    or `root/comment`. WordPress mints the tab's post room plus the
    three wildcards (collection rooms carry presence only over this
    lane). A follow for any other room is refused with an error frame.
    Without this claim a user could watch who is editing any post and
    nudge them to poll — small, but cheap to close.
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
    (the roster is the access token's site's, see `blog_id` above). A
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
(rule 5 above) covers exactly this case, at 10 seconds for a focused
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

## Failure behavior

The rule: **the client behaves as if the channel did not exist, then
uses it to poll sooner and to show presence faster.**

-   Channel never connects (no STUN reachable, symmetric NAT without
    TURN, WebRTC disabled by a privacy extension): coverage stays false;
    today's cadence; nothing lost. TURN is deliberately not required.
-   A peer drops off the channel: coverage flips false on the
    `connectionstatechange`; the timer cadence resumes at once.
-   A handshake message lost with a failed request: it is re-queued
    for the next carrier; a lost answer times out the offer after 15 s
    and the initiator offers again.
-   Nudge dropped: the next heartbeat answer reports the room ahead and
    the tab polls (10 s focused, up to 120 s blurred).
-   Nudge storm: the coalescing delay and the floor bound polls per
    second; the server's existing size and room caps do the rest.
-   Heartbeat suspended (10 minutes idle) or the tab hidden (120 s
    cadence): the established channel survives; renegotiation waits for
    focus; the token expires after 300 s if the tab never beats again,
    and peers stop counting it.
-   More peers than the cap (8): the channel stands down and everyone
    polls. Full mesh is N(N-1)/2 connections; document editing rarely
    gets there.
-   The presence lane is missing (no `wp.heartbeat`, no per-post editor
    screen such as the site editor): the polling manager keeps its
    always-on cadence. Nothing about today's behavior changes there.
-   Under `websocket-advisory`: the daemon is down or refuses the token:
    coverage stays false, the tab keeps the timer cadence and retries
    with backoff (1 s doubling to 30 s). The socket drops mid-session:
    the roster is forgotten, coverage flips false at once, and the
    reconnect replays the tab's presence. The daemon restarts: every
    tab reconnects and the rosters rebuild from their follow frames;
    rows landed meanwhile are the head-cursor check's business. A
    dropped advisory socket never counts as a closed tab: awareness
    and the leave beacon stay the polling transport's, so a room is
    never reset because a relay blinked. SSE switches the
    link off exactly as it does WebRTC.
-   Queued work never waits for a slow timer. A coverage flip re-evaluates
    a pending timer; if that would replace a 1 s timer with the 25 s
    safety timer while updates are already queued (the intent-log undo
    spec caught exactly this: an undo's inverse intents sat unsent for
    25 s), the delay is cut to the on-demand send delay instead. The
    cadence rules decide how often to LOOK for rows; queued rows go out
    promptly regardless.

## What the client must never assume

-   That a nudge means new rows exist. Poll and find out.
-   That no nudge means nothing happened. Compare the head cursor the
    heartbeat reports with your own.
-   That the channel knows who is in the room. The server does.
-   That the channel is authenticated the way the REST endpoint is.
-   That a peer on the channel is the only peer. Check the awareness map.

## Tests

-   Jest: `tests/js/providers/advisory/` (signaling payloads and
    mailbox; a two-tab mesh over a fake `RTCPeerConnection` wired through
    an in-memory signaling loop; the websocket link over a fake socket:
    token handshake, roster overlay, coverage, notices, reconnect and the
    transport switch; coverage rules), and the polling manager
    cadence rules (quiet when alone, wake on company, on-demand polls
    under coverage, safety poll, announce coalescing, stream disable).
-   PHPUnit: `tests/phpunit/gutenbergSyncEnginesAdvisoryPresence.php`
    (token record and expiry, others-present from tokens and awareness,
    mailbox relay with caps, permission fence, leave route, page-render
    settings including the chosen link),
    `tests/phpunit/wpWebSocketAdvisory.php` (the daemon's advisory mode:
    roster, presence relay, notices to the other followers only, the
    scan's one-announce-per-batch, a dropped follower, permissions and
    the client-id binding, nothing written to storage), and
    `tests/phpunit/wpWebSocketAccessToken.php` (access-token mode: the signed
    access token's claims and expiry, tampered / foreign / `alg: none`
    access tokens refused, the rooms rule, the route's grants and refusals,
    the daemon accepting an access token without a cookie).
-   e2e: `tests/e2e/specs/http-only/collaboration-advisory-channel.spec.ts`
    (two tabs connect over the channel and an edit still propagates;
    idle polling drops to the safety cadence) and, on the daemon lane,
    `tests/e2e/specs/websocket-only/collaboration-websocket-advisory.spec.ts`
    (the same over the websocket link, with short polling selected for
    its duration) and
    `collaboration-websocket-advisory-relay.spec.ts` (the same again
    with the example Node relay standing in for the daemon: the config
    runs `examples/advisory-relay/relay.mjs` on port 8790 with a fixed
    test secret, and the spec activates the
    `tests/e2e/plugins/advisory-relay-access-token.php` fixture, which
    configures that secret and points the socket URL at the relay).
