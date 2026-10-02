# Advisory relay (bring your own WebSocket server)

A small WebSocket relay for the plugin's advisory channel, for hosts that
cannot run the plugin's own PHP daemon (`wp collaboration sync-server`)
or already run WebSocket infrastructure elsewhere. It runs anywhere
Node 20+ runs, needs no database and no connection to WordPress, and is
short enough to copy or port to another language. The message formats
and the access token it checks are described in
[`docs/plan/advisory-channel.md`](../../docs/plan/advisory-channel.md)
under "Bring your own relay".

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
