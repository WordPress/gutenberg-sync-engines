# The wire protocol

Every transport sends the same request, the room envelope. The client
names a room (one post's shared editing session), the last row it saw,
and any updates to store. The server answers with the newer rows, a
verdict on each update, and who is present. The transport moves
`{ type, data }` updates without reading them; the active engine gives
them meaning. The intent-log vocabulary itself is in
[`src/engines/intent-log/SPEC.md`](../src/engines/intent-log/SPEC.md).

## Routes

| Route | Purpose |
| --- | --- |
| `POST /wp-sync/v1/updates` | Polling, and the send path for both stream transports: one request carries every open room. |
| `POST /wp-sync/v1/sse` | The event stream from the web tier: the same envelope with no updates, answered as a long-lived `text/event-stream`. |
| `POST /wp-sync/v1/ws-token` | Mints the daemon credential: a one-time token, or a signed access token when a secret is configured. Answer `{ token, expires_in }`. |
| `POST /wp-sync/v1/de-rtc/resolve` | A reviewer's decision on a de-rtc edit held for review (`room`, `proposalId`, `resolution`: `restored` or `dismissed`). Posts and pages only; other types send a `resolved` row. |
| `POST /wp-sync/v1/save` | The bundled framework's own route for saving a CRDT document copy with a post. |
| `POST /gutenberg-sync-engines/v1/advisory/leave` | The leave beacon a tab sends on `pagehide`, so its presence goes at once. |
| `rtc-test/v1/*` | The per-request benchmark log, dev-only (`GUTENBERG_SYNC_ENGINES_DIAGNOSTICS`). |

The sync daemon (`wp collaboration sync-server`, port 8787 by default)
serves the WebSocket (the browser offers `Sec-WebSocket-Protocol:
wp-sync, wp-sync-token.<token>`; the daemon echoes `wp-sync`), the same
event stream at `<daemon>/wp-sync/v1/sse` with the token in an
`Authorization` header, and `GET /health`.

## The room envelope

One request carries up to 50 rooms in at most 16 MB (the client packs
to 15 MB and shrinks to a 2 MB floor on "too large"); one encoded update
is at most 1 MB. Shapes: `src/providers/http-polling/types.ts`.

```json
{ "rooms": [ { "room": "postType/post:123", "client_id": 12345, "after": 987654,
               "engine": "intent-log", "engine_protocol": 2, "awareness": {},
               "updates": [ { "type": "intent", "data": "…" } ],
               "presence_token": "…", "rows_received_separately": false, "debug": false } ],
  "advisory": { "seq": 7 } }
```

```json
{ "rooms": [ { "room": "postType/post:123", "end_cursor": 987660, "generation": "987001",
               "awareness": { "12345": {} },
               "dispositions": [ { "intentId": "…", "status": "applied" } ],
               "updates": [ { "type": "intent", "data": "…" } ] } ],
  "advisory": {} }
```

| Field | Meaning |
| --- | --- |
| `after` / `end_cursor` | The id of the last row the tab saw, sent back as `after` next time (the cursor). |
| `client_id` | A number the tab picks; bound to the user who first used it. |
| `engine` / `engine_protocol` | The engine the tab speaks. If the room was written by another engine, the request is refused with **409 `rest_sync_engine_mismatch`** before anything is stored, and the editor falls back to the post lock. |
| | Shared rooms not tied to one post (a taxonomy's list) are reset instead when a tab speaking the newly chosen engine arrives. |
| `awareness` | This tab's presence state in; every live tab's state out. Entries expire 30 seconds after their last write. |
| `updates` | Engine-owned rows in; stored rows after the cursor out. |
| `dispositions` | The result of each sent update, `{ intentId, status, reason? }`: `applied`, `escalated` (held for review), `voided` (thrown away) or `unknown`. |
| | Reasons are engine-defined, for example `frame-conflict`, `stale-base`, `requires-unfiltered-html`, `resync-required`. |
| `generation` | The id of the room's first row; it changes on every reset, and a tab that sees a new value starts again from the beginning. |
| `presence_token` | The tab's per-tab token, sent on the post's own room; the first request carrying it is the tab's join. |
| `rows_received_separately` | `true` on a send made beside an open event stream: the server stores the updates and answers with the verdicts but no rows. |
| `advisory` | The advisory channel's discovery probe, answered beside the rooms. |
| `debug` / `_debug` | Asks for the engine's diagnostics, served when the `wp_sync_debug_enabled` filter allows (default `SCRIPT_DEBUG`). |

Other statuses: 403 `rest_cannot_edit`, 413 when a body or a room is
too large (yjs-server also for a document over its size limits), 503
when the intent-log room lock or a de-rtc version claim could not be
taken in time, which the client retries. A different 409 comes from
the ordinary post save route: under de-rtc a save that names a base
version and genuinely conflicts is refused with one, and the conflict
is set aside for review.

Over the socket the same envelope travels as `{ "type": "sync", "rooms": [ … ] }`
frames both ways, plus `type: "advisory"` frames on the advisory link
and `type: "error"` frames when the daemon refuses something. The event
stream writes each room response as `event: sync`, a `: keepalive`
comment at least every five seconds, and `event: retry` when it ends on
purpose.

## Row types per engine

Every stored row is `{ type, data }`. A client may send only the types
marked "client".

| Engine | Type | Sent by | Holds |
| --- | --- | --- | --- |
| intent-log (protocol 2) | `intent` | client | One typed edit, stored after the server transformed it against newer rows. |
| | `snapshot` | server | A full copy of the document: the first version and later checkpoints. |
| | `parked` | server | An edit held for review. |
| | `voided` | server | A marker that an edit was thrown away. |
| | `resolved` | client | A reviewer's decision on a parked edit. |
| | `cancel` | client, never stored | Cancels edits the server has not accepted yet; all or nothing. |
| yjs-server (protocol 1) | `update` | client | One incremental Yjs update, base64; the server stores only what it did not have. |
| | `snapshot` | server | A full copy, `{ doc: <base64> }`. |
| de-rtc | `proposal` | client | Whole content against a base version. Posts and pages send theirs through the ordinary autosave endpoint instead (`base_version`, `block_base_versions`, `clientUpdate`). |
| | `announce` | server | Tells tabs that version N exists, with a short fingerprint of its content and the merged property values; about 200 bytes and no content. |
| | `fetch` | client, never stored | "My version is behind"; answered with one snapshot built on the fly. |
| | `snapshot` | server | The first version and each checkpoint. |
| | `parked` / `resolved` | server / client | As for intent-log. |

A script or plugin that saves a post needs none of this. If it names
the version it read (`base_seq` for intent-log, `base_version` for
de-rtc), the server merges its save with other people's edits
([engine-comparison.md](engine-comparison.md)).

## Who may do what

Every route needs a logged-in user with `edit_posts`, and for each room
the framework checks that the user may edit that entity (403 and the
list of refused rooms otherwise). A tab's `client_id` and presence token
are bound to the user who first used them. Every engine checks each
edit on the server before anyone else sees it; what each does with
markup the author may not publish is in
[engine-comparison.md](engine-comparison.md).

| Credential | Used for | Lives |
| --- | --- | --- |
| Cookie + REST nonce | the REST routes | the WordPress session |
| One-time token | the daemon's socket and stream, in a header, never the URL; the daemon also requires the `logged_in` cookie and checks `Origin` against the site's own | two minutes, spent on first use |
| Access token (when `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` is set) | the daemon and a host's own relay: a JWT signed with the shared secret, claims `user_id`, `blog_id`, `iss`, `rooms`, `iat`, `exp` | two minutes; anyone with the secret can mint one |
| Presence token | finding the other tabs on a post | five minutes after the last heartbeat |

The daemon runs WordPress code and writes the room tables, so it is
trusted like a web worker and must sit behind TLS. A relay sees only
who is present and "go and poll" notices; the worst a bad one can do is
cause extra polls or show false presence. Redis carries only change
notices.

One known gap: the de-rtc review route checks `edit_posts` only. It has
no per-post check and no `unfiltered_html` check on a restore. The
browser's review panel applies those rules; the route does not.

## Adding an engine or a transport

An engine is two pieces, registered through one filter on each side:

- A PHP class implementing `WP_Sync_Engine`
  (`gutenberg/lib/experimental/collaboration/interface-wp-sync-engine.php`):
  `get_slug`, `get_protocol_version`, `get_update_types`,
  `handle_updates`, `get_updates_since`. Register it on the
  `wp_sync_engines` filter.
- A JavaScript `SyncEngine`
  (`gutenberg/packages/sync/src/engines/engine.ts`): `createEntity`,
  `createCollection`, and the optional `createUndoManager` and `review`.
  Register it with `registerSyncEngine`, as `src/index.ts` does.
- Give a new room its starting field values from
  `WP_Sync_Post_Genesis_Props`, and register a benchmark profile on
  `wp_sync_bench_authoring_profiles` (`tests/benchmarks/README.md`).

A transport is a `WP_Sync_Transport` (`get_slug`,
`get_protocol_version`, `register_routes`) on the `wp_sync_transports`
filter, plus a provider factory registered with
`registerSyncTransport`. The two stream transports, which reuse the
polling manager and change only how rows are received, are the model.
Every filter and action the plugin offers:
`grep -rn "apply_filters\|do_action" includes`.
