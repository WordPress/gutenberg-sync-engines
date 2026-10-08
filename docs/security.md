# Security model

Only a logged-in user who may edit a post can join its room (the shared
editing session for that post). The server checks every edit as it
arrives. Nothing outside WordPress (the sync daemon, a relay, Redis) is
trusted with content it could change. This page lists who may do what,
what each engine checks, the credentials and how long they live, and
what each outside process is trusted with. To report a vulnerability,
see `SECURITY.md` at the repo root.

## Who may join a room

Every sync route requires a logged-in user with the `edit_posts`
capability (a contributor or above). For each room in a request, the
framework then checks that the user may edit that entity
(`WP_Sync_Config::can_user_sync_entity_type`); a request naming a room
the user may not edit is refused with 403 `rest_cannot_edit` and the
list of refused rooms. The daemon runs the same checks for socket
subscriptions and advisory follows, and so does the stream route.

A tab's `client_id` is bound to the user who first used it in a room:
another user's request carrying that id is refused. A tab's presence
token (the per-tab token the advisory channel uses to find peers) is
bound to its user the same way; the server ignores a probe, leave, or
sync request that carries another user's token.

A post admits five editor tabs by default, counted on a tab's first
connection; a sixth is refused.

## What each engine checks

All three engines run on the server, so an edit is checked before it is
stored and before any other editor sees it. The difference is what
happens to markup the author may not publish (anything `wp_kses_post`
would change, for a user without `unfiltered_html`):

| Engine | Markup the author may not publish |
| --- | --- |
| intent-log | The edit is held for review (`requires-unfiltered-html`). A reviewer who has `unfiltered_html` restores it; the restore is the approval. |
| yjs-server | The touched blocks are replaced with their cleaned form and the correction is sent to everyone. Nothing is held for a person to look at. |
| de-rtc | Risky blocks go back to their earlier form and wait for review. The safe parts of the same change are kept. A property value with markup waits on its own. A reviewer with `unfiltered_html` can approve a held block, and approved blocks are remembered for that post. |

Under de-rtc, a save that names its base version goes through the
ordinary autosave endpoint, which checks `edit_post` on that post. The
review route (`/wp-sync/v1/de-rtc/resolve`) checks `edit_posts` only.
It has no per-post check. It also does not require `unfiltered_html`
when a reviewer restores a block held for unsafe markup. The browser's
review panel applies those rules; the route does not. Treat that as a
known gap until it is fixed.

Scripts and plugins that save a post are subject to the ordinary
WordPress capability checks; the room merge adds nothing and removes
nothing there.

## Credentials and their lifetimes

| Credential | Used for | Lives | Notes |
| --- | --- | --- | --- |
| Cookie + REST nonce | Polling, the web-tier stream, the review route, the leave beacon | The WordPress session | Ordinary REST authentication. |
| One-time token | The daemon's socket and stream | Two minutes, spent on first use | Minted at `POST /wp-sync/v1/ws-token` and stored as a transient bound to the user. |
| Access token | The daemon and a host's own relay, when `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` is set | Two minutes, with 30 seconds of clock skew allowed | A JSON Web Token signed with HMAC-SHA256 over the shared secret. |
| Presence token | Finding the other tabs on a post | <!-- const:PRESENCE_TTL -->300<!-- /const --> seconds after the last heartbeat | Stamped when the editor page renders, refreshed by every heartbeat and poll, removed by the leave beacon. Bound to its user. |

The one-time token and the access token:

- Both are sent in the `Sec-WebSocket-Protocol` header (socket) or an
  `Authorization` header (stream), never in the URL, so they stay out of
  access logs.
- For a one-time token the daemon also requires a valid `logged_in`
  cookie, and it checks the request's `Origin` against the site's home
  and admin origins (`wp_sync_websocket_allowed_origins`).
- An access token's claims are `user_id`, `blog_id`, `iss` (the
  install's site address), `rooms` (the post the tab may follow, plus
  the shared lists such as taxonomies), `iat`, and `exp`. Anyone holding
  the secret can mint one, so share the secret only between installs
  that trust each other.
- The daemon skips the cookie check when an access token is valid. So
  if you log a user out, a relayed connection keeps working until its
  token expires, two minutes at most.

The one-time token and the `edit_posts` check are enforced in the
daemon's PHP process, which has WordPress loaded. A relay has no
WordPress; the access token is its whole check.

## What outside processes are trusted with

- **The sync daemon** runs WordPress code and reads and writes the room
  tables, so it is trusted exactly like a web worker. It speaks plain
  `ws://` and `http://` and must sit behind TLS termination. It serves
  one site.
- **A relay** (the websocket advisory channel only) sees who is present
  on a post and passes "go and poll" notices. It never sees content,
  never writes anything, and never calls WordPress. The worst a bad or
  compromised relay can do is cause extra polls or show false presence.
  Who is in a room is decided by the server's presence records, not by
  the channel, and nothing on the channel can change what a tab has
  read or add content.
- **The WebRTC advisory channel** between browsers is the same: display
  data and a hint to poll sooner, with the handshake relayed through
  WordPress (signed-in users only).
- **Redis** carries notices that a room changed, never content. Its
  channel names are unique to each install. Losing it costs nothing but
  the instant wake.
- **The Presence API's table** holds who is present. Its rows are
  display data.

Content always travels over the WordPress REST routes or the daemon,
under the checks above.

## Limits that bound abuse

- Request body 16 MB, 50 rooms per request, 1 MB per encoded update
  (polling and the stream).
- Daemon: <!-- const:DEFAULT_MAX_CONNECTIONS -->512<!-- /const --> connections, <!-- const:DEFAULT_MAX_CONNECTIONS_PER_IP -->20<!-- /const --> per IP, <!-- const:MESSAGE_RATE_LIMIT -->200<!-- /const --> messages per socket per five
  seconds, 200-byte room names, 64-byte presence tokens, 16 KB of
  advisory presence.
- yjs-server refuses to start a session for a post over 1 MB, and stops
  accepting writes to a room over 8 MB.
- Awareness entries expire <!-- const:AWARENESS_TIMEOUT -->30<!-- /const --> seconds after their last write.
