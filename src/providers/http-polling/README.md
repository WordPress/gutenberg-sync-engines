# HTTP polling transport

The default sync transport: a periodic `POST /wp-sync/v1/updates` that
carries typed updates and presence for every open post in one request.
The transport is engine-neutral: it moves `{ type, data }` updates
without reading them and leaves their meaning to the active engine.

What it does, and why, is documented once:

- The room envelope, its fields, the limits, and the permission checks:
  `docs/protocol.md`.
- The polling cadence (quiet when alone, the interval when a peer is
  out of reach, on demand when every peer is reachable), the advisory
  channel, and the failure cases: `docs/advisory-channel.md` and
  `docs/transports.md`.
- What happens to a room when the last editor leaves:
  `docs/room-lifetime.md`.

## Files

- Server: `includes/transports/class-wp-http-polling-sync-server.php`
  registers the route, checks limits and permissions, and passes each
  post's data to the active engine. The two server-sent events
  transports extend it.
- Client: `http-polling-provider.ts` (per-room provider lifecycle),
  `polling-manager.ts` (the single polling loop, the queues, presence,
  and the stream rules the SSE transports reuse), `config.ts`
  (intervals, limits, retry schedules), `types.ts` (wire types),
  `utils.ts` (queues and API helpers). The advisory channel is in
  `../advisory/`.
