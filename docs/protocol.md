# The wire protocol

Every transport sends the same request, called the room envelope. The
client names a room (one post's shared editing session), the last row it
saw, and any updates to store. The server answers with the newer rows, a
verdict on each update, and who is present. The transport moves
`{ type, data }` updates without reading them; the active engine gives
them meaning. This page lists the
routes, the envelope, the fields that ride beside it, and the row types
each engine stores. The intent-log vocabulary itself is in
[`src/engines/intent-log/SPEC.md`](../src/engines/intent-log/SPEC.md).

## Routes

All routes need a logged-in user who can edit posts (`edit_posts`) and,
for each room, permission to edit that entity. Routes under `wp-sync/v1`
are REST routes that take the usual cookie and nonce.

| Route | Method | Purpose |
| --- | --- | --- |
| `/wp-sync/v1/updates` | POST | The polling transport: one request carries every open room (see The room envelope). Also the send path for the two server-sent events transports. |
| `/wp-sync/v1/sse` | POST | The server-sent events stream from the web tier: the same room envelope with no updates, answered as a long-lived `text/event-stream` response. A request that carries updates is refused with `rest_sse_read_only`. |
| `/wp-sync/v1/ws-token` | POST | Mints the credential for the sync daemon: a one-time token bound to the user, or, when an access-token secret is configured, a signed access token (body `{ "room": "postType/post:12" }` names the post room it may follow). Answer: `{ token, expires_in }`; both kinds live two minutes. |
| `/wp-sync/v1/de-rtc/resolve` | POST | A reviewer's decision on a de-rtc edit held for review: `room`, `proposalId`, `resolution` (`restored` or `dismissed`), `client_id`. Only posts and pages use it; other content types send a `resolved` row through the transport. |
| `/wp-sync/v1/save` | POST | The framework's own route for saving a persisted CRDT document copy with a post (`room`, `doc`). Registered by the bundled Gutenberg, not by this plugin. |
| `/gutenberg-sync-engines/v1/advisory/leave` | POST | The leave beacon a tab sends on `pagehide`, carrying its presence token and client id, so its presence entry goes at once and an empty room can be reset. |
| `/rtc-test/v1/{log,env,report,report-all,db-io,room-size}` | GET | The per-request benchmark log, in the community performance harness's format. Loaded only on local or development sites or with the `GUTENBERG_SYNC_ENGINES_DIAGNOSTICS` constant. |

The sync daemon (`wp collaboration sync-server`) listens on its own
port, 8787 by default, and serves three things on it:

- A WebSocket for the websocket transport and the websocket advisory
  link. The browser offers `Sec-WebSocket-Protocol: wp-sync, wp-sync-token.<token>`
  and the daemon echoes `wp-sync` alone. The token goes in that header
  rather than the URL so it never reaches an access log.
- The same event stream as `/wp-sync/v1/sse`, for the `sse-daemon`
  transport, as a POST to `<daemon>/wp-sync/v1/sse` that carries the
  token in an `Authorization` header. The daemon answers the
  cross-origin preflight from the same origin allowlist as the socket
  handshake (`wp_sync_websocket_allowed_origins`).
- `GET /health`, which answers `OK` for process managers and tests.

The daemon authenticates a connection once and keeps the result: a
stream's POST body can arrive across several reads, and a one-time token
is spent on first sight.

## The room envelope

One request carries every open room, up to 50. The request body may be
16 MB at most; the client packs to 15 MB and shrinks its budget to a
2 MB floor when the server answers "too large". One encoded update may
be 1 MB at most. The shapes are in `src/providers/http-polling/types.ts`.

Request:

```json
{
	"rooms": [
		{
			"room": "postType/post:123",
			"client_id": 12345,
			"after": 987654,
			"engine": "intent-log",
			"engine_protocol": 2,
			"awareness": { "...": "..." },
			"updates": [ { "type": "intent", "data": "…" } ],
			"presence_token": "…",
			"rows_received_separately": false,
			"debug": false
		}
	],
	"advisory": { "seq": 7, "...": "..." }
}
```

Response:

```json
{
	"rooms": [
		{
			"room": "postType/post:123",
			"end_cursor": 987660,
			"generation": "987001",
			"awareness": { "12345": { "...": "..." } },
			"dispositions": [ { "intentId": "…", "status": "applied" } ],
			"updates": [ { "type": "intent", "data": "…" } ],
			"_debug": { "...": "..." }
		}
	],
	"advisory": { "...": "..." }
}
```

| Field | Meaning |
| --- | --- |
| `after` / `end_cursor` | The storage cursor (a row id). Opaque to the client, which sends `end_cursor` back as `after` on its next request. |
| `client_id` | A number the tab picks for itself. The server binds it to the user who first used it and refuses another user's request carrying it. |
| `engine` / `engine_protocol` | The engine the tab speaks and its protocol version. A tab speaking the wrong engine, or a room whose stored lineage names another engine, is refused with **409 `rest_sync_engine_mismatch`** before anything is stored, and the editor falls back to the classic post lock. Rooms that are not tied to one post (a taxonomy's collection room, for example) are reset instead when a tab speaking the newly chosen engine arrives. |
| `awareness` | This tab's presence state, in; every live tab's state, keyed by client id, out. Entries expire 30 seconds after their last write. |
| `updates` | Engine-owned rows in, stored rows after the cursor out. The transport never reads them. |
| `dispositions` | The engine's verdict on each update the request carried: `{ intentId, status, reason? }` with `status` one of `applied`, `escalated` (held for review), `voided` (thrown away), or `unknown`. Reasons are engine-defined, for example `frame-conflict`, `stale-base`, `requires-unfiltered-html`, `resync-required`, `already-merged`, `cancel-too-late`. |
| `generation` | The room's generation token, the id of its first row. It changes on every reset; a tab that sees a new value drops its room state and starts again from the beginning (cursor 0). See [room-lifetime.md](room-lifetime.md). |
| `presence_token` | The tab's per-tab presence token, sent only on the post's own room. The first request carrying it is the tab's join; under the default "Unsaved changes" setting the server resets a per-post room nobody else is in before serving it. |
| `rows_received_separately` | `true` on a send made beside an open event stream. The server stores the updates and answers with the verdicts and the room's head cursor but no stored rows; the stream stays the only path that delivers rows and moves the cursor. See [transports.md](transports.md). |
| `advisory` | The advisory channel's discovery probe and handshake messages, answered beside the rooms. The same probe also rides the WordPress heartbeat. See [advisory-channel.md](advisory-channel.md). |
| `debug` / `_debug` | `debug: true` asks the engine for a diagnostics envelope, served only when the `wp_sync_debug_enabled` filter allows it (default: `SCRIPT_DEBUG`). The browser inspector `window.wpSync` sets it. |
| `should_compact` | Always `false`. Kept so old clients still work: the retired yjs-relay engine used it to pick a client to shrink the log. |

Other statuses the routes return: **403 `rest_cannot_edit`** when the
user may not edit a room's entity, **413** when the body or a room is
too large (yjs-server also answers 413 when a document is over its size
limits), and **503** when the intent-log room lock or a de-rtc version
claim could not be taken in time, which the client retries.

### Over the socket and the stream

The websocket transport sends the same envelope as a text frame,
`{ "type": "sync", "rooms": [ … ] }`, and receives `type: "sync"`
frames back, sent as soon as new rows are stored. The daemon also sends
`{ "type": "advisory", … }` frames on the advisory link (the roster and
"go and poll" notices; see [advisory-channel.md](advisory-channel.md))
and `{ "type": "error", "code", "message", "rooms" }` when it refuses
something.

The event stream writes each room response as an `event: sync` with the
JSON in `data:`, a `: keepalive` comment at least every five seconds, and
`event: retry` when it ends on purpose. Every stream response carries an
`X-WP-Sync-SSE-Wait` header naming what the stream waited on: `redis`,
`version-cache`, `version-table`, or `reads`.

## Row types per engine

Every stored row is `{ type, data }`. A client may send only the types
marked "client", and a request that sends another type is refused.

### intent-log (protocol 2)

| Type | Sent by | Holds |
| --- | --- | --- |
| `intent` | client | One typed edit, stored after the server transformed it against newer rows. |
| `snapshot` | server | A full copy of the document, saved so a new tab need not replay old rows: the room's first version (genesis) and later checkpoints. |
| `parked` | server | An edit held for review. |
| `voided` | server | A marker that an edit was thrown away, so a redelivery stays harmless. |
| `resolved` | client | A reviewer's decision on a parked edit: `{ proposalId, resolution: restored|dismissed }`, stamped by the server with who and when. |
| `cancel` | client, never stored | Cancels edits the server has not accepted yet (an undo before they were accepted). All or nothing: if any target was already accepted, nothing cancels and the verdict says `cancel-too-late`. |

### yjs-server (protocol 1)

| Type | Sent by | Holds |
| --- | --- | --- |
| `update` | client | One incremental Yjs update, base64-encoded (the V2 format). The server stores only what it did not already have. |
| `snapshot` | server | A full copy of the document, `{ doc: <base64 V2> }`: the first version and each checkpoint. |

### de-rtc

| Type | Sent by | Holds |
| --- | --- | --- |
| `proposal` | client | Whole content against a base version. Posts and pages send their proposals through the ordinary autosave endpoint instead (`base_version`, `block_base_versions`, `clientUpdate`), so this row serves only other content types. |
| `announce` | server | The notice that a new version exists: version, base version, content hash, author, and the merged property values, but no content. About 200 bytes. |
| `fetch` | client, never stored | "My version is behind; send the current content." Answered in the same request with one snapshot row that is built on the fly and never stored. |
| `snapshot` | server | The first version and each checkpoint. |
| `parked` | server | A proposal, or the blocks of it that clashed, held for review. Survives trimming until it is resolved. |
| `resolved` | client | A reviewer's decision on a parked row, as for intent-log. |

Scripts and plugins that save a post can join the merge without
speaking any of this: a save that names the version it read
(`base_seq` for intent-log, `base_version` for de-rtc, over REST or as a
post field) is merged through the room. See
[engine-comparison.md](engine-comparison.md), "How scripts and plugins
join in".
