# Storage

Collaboration rooms live in two tables the plugin owns, not in post
meta. A room is the shared editing session for one post (or one other
synced thing). Who is present in a room, which the code calls awareness,
lives in the Presence API's table when that plugin is recording, and
with the room's other data (or in the object cache) otherwise. This page
lists the tables, the keys each engine writes, what the object cache
holds, and the commands that manage it all.

## The two tables

`WP_Sync_Table_Storage` (`includes/storage/class-wp-sync-table-storage.php`)
is the plugin's implementation of the framework's `WP_Sync_Storage`
interface. It replaces the framework's post-meta default through the
`__unstable_wp_sync_storage` filter, so no collaboration write touches
post caches. It is the only code that reads or writes the tables.

`WP_Sync_Table_Schema` (`includes/storage/class-wp-sync-table-schema.php`)
names the tables and creates, upgrades, and drops them.

### `{prefix}sync_updates`: the update log

One row per stored update. The row id is the cursor: a client remembers
the last id it saw and asks for the rows after it.

| Column        | Meaning                                                            |
| ------------- | ------------------------------------------------------------------ |
| `id`          | Auto-increment row id. Ids only grow and are never reused, even after older rows are trimmed. |
| `room`        | The room name, such as `postType/post:123`.                        |
| `data`        | The encoded update: `{ type, data }` as the engine wrote it.       |
| `created_gmt` | When the row was written.                                          |

Index: `(room, id)`.

Reading rows after a cursor takes the room's highest id first, then
returns rows up to it in id order, so the cursor it reports never skips a
row appended at the same moment. Reads go straight to the database,
never through a cache.

### `{prefix}sync_room_meta`: everything else about a room

One row per room and key. Every write is a single-row insert or update.

| Column       | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| `meta_id`    | Auto-increment id.                                   |
| `room`       | The room name.                                       |
| `meta_key`   | The key (see the lists below).                       |
| `meta_value` | The value, as text.                                  |

Unique index: `(room, meta_key)`.

Keys that start with an underscore are reserved for the storage itself.
Engine keys never start with one.

| Key          | Written by      | Holds                                                                 |
| ------------ | --------------- | --------------------------------------------------------------------- |
| `_engine`    | the storage     | Which engine first wrote the room (its lineage). Write-once: an `INSERT IGNORE` against the unique index makes racing first writers agree on one winner. |
| `_awareness` | the storage     | Who is present, as one list per room, when the Presence API is not holding it and the site has no persistent object cache (see Presence below). |
| `_version`   | the storage     | The room's version counter, when the site has no persistent object cache (see The version counter below). |
| `generation` | the polling transport | The room's generation token: the id of its first row. It changes on every reset, so a client that sees a new value starts over. See [room-lifetime.md](room-lifetime.md). |

Each engine keeps its bookkeeping under its own keys:

| Engine     | Keys                                                                                   |
| ---------- | -------------------------------------------------------------------------------------- |
| intent-log | `intent_log_checkpoint` (the latest full snapshot), `intent_log_floor` (the oldest row still retained) |
| yjs-server | `yjs_server_doc` (the server's copy of the shared document), `yjs_server_checkpoint`, `yjs_server_floor`, `yjs_server_wrappers` (each block's saved HTML wrapper) |
| de-rtc     | `de_rtc_checkpoint`, `de_rtc_floor`, `de_rtc_approved_blocks` (blocks a reviewer approved despite unsafe markup) |

De-rtc also keeps its current content and version claim outside the room
tables, in options rows, because they must be swapped atomically:
`WP_Sync_Atomic_Option` (`includes/class-wp-sync-atomic-option.php`)
does a compare-and-swap against the options table (it changes a value
only if nobody else changed it first), and the `wp_sync_cas_backend`
filter can replace it with Redis or another store that can do the same.
The intent-log engine's per-room lock is an options row too
(`WP_Sync_Room_Lock`), and the `wp_sync_lock_backend` filter can replace
it.

### Rooms need no creation step

There is no per-room parent row, so looking at a room never creates it.
The read-only helpers (`list_rooms`, `get_room_size`, `get_last_updates`,
`get_all_room_meta`, `peek_room`) cannot bring a room into existence.
The presence check that runs on every heartbeat uses `peek_room` for the
same reason: two indexed lookups and no write.

One trap for engine code: `get_cursor()` and `get_update_count()` are
per-request caches that only `get_updates_after_cursor()` refreshes. The
table storage keeps that behavior from the post-meta default on purpose.
Never decide anything from them before a read has run.

## The version counter

Every successful write (an update row, room meta, a reset, and presence
when presence is in the room tables) bumps the room's version counter.
A waiting reader, such as a server-sent events stream, can then ask
"did anything change in these rooms?" with one lookup
(`get_room_versions`). The bump is an atomic increment: Redis and
Memcached increment in place, and the table update is one statement the
database serializes. A reader notes the counter before it reads. If the
counter has a different value next time, it reads again. Nothing depends
on the exact number.

Every write also fires the `gutenberg_sync_engines_room_changed` action
with the room name. The server-sent events transport listens to it to
send a Redis notice. A replacement storage must fire it after its own
successful writes to get the same prompt wake. Presence held by the
Presence API bumps no counter, but its backend fires the action itself.

## What the object cache holds

On a host with a persistent object cache (`wp_using_ext_object_cache()`),
three things leave the database. This follows the strategy the WordPress
hosting performance tests recommended ("custom table with transients",
wordpress-develop#11599). The cache group is
`WP_Sync_Table_Schema::CACHE_GROUP` (`wp_sync_rooms`).

- **Presence stored with the room's other data** (the fallback when the
  Presence API is not recording) lives only in the cache, never in a
  row. It expires within seconds anyway, so a cache flush costs one
  poll round trip and nothing else.
- **The version counter** lives only in the cache, as an atomic
  increment, and stays for a month after its last bump.
- **The two write-once keys**, the engine lineage and the generation
  token, are cached after their first read. Both are cleared only by
  `reset_room()`, which also drops the cached copies, so a cached read is
  always the stored value. A missing value is never cached, because the
  room may get its value a moment later.

Nothing else is cached. Checkpoints and engine documents are rewritten
by several requests at once, and the last one to write the cache might
not be the last one to write the database, so the cache could hold old
data. Without a persistent cache every read hits the tables: the
per-request cache would go stale in a long-running process such as the
sync daemon.

An idle poll is read-only either way. The polling transport rounds
presence timestamps to ten-second buckets
(`wp_sync_awareness_timestamp_granularity` filter) and skips the write
when a poll changes nothing. To measure the query count of a poll,
dispatch one under the `query` filter as
`tests/phpunit/wpHttpPollingSyncServer.php` does.

## Presence (awareness)

Who is in a room and what they are doing is read and written only
through `WP_Sync_Awareness` (`includes/class-wp-sync-awareness.php`).
The transports, the advisory channel, and the rooms command all go
through it, never through storage directly. The
`wp_sync_awareness_backend` filter takes a `WP_Sync_Awareness_Backend`,
addressed per client rather than per room, so a backend can write one
client's entry without rewriting anyone else's.

The plugin provides one backend,
`WP_Sync_Presence_API_Awareness_Backend`. It is used whenever the
required Presence API plugin says it can serve
(`wp_presence_is_available()` since Presence API 0.6.0). Presence then
lives in that plugin's shared `wp_presence` table, one row per editor
tab, under client ids with a `gse-` prefix so neither plugin reads the
other's rows. A collaborator in the editor also shows up in the Presence
API's own screens. When the Presence API cannot serve (recording turned
off, no table), presence falls back to the room's own data: the
`_awareness` key, or the object cache on a host that has one.

The list of editor tabs open on a post, which the advisory channel uses
to find peers, has a replaceable backend in the same way:
`WP_Sync_Tab_List_Backend` and the `wp_sync_tab_list_backend` filter. With the Presence API, each tab is
a `gsetab-` row in its table; otherwise one transient per room.

To check the Presence API backend against the real plugin rather than
the test stand-in, run `tests/tools/check-presence-api.php` (usage in
its header).

## Lifecycle

- **Activation** creates the tables with `dbDelta` and records the
  schema version in the `gutenberg_sync_engines_db_version` option.
- **A plugin update** that ships a newer `WP_Sync_Table_Schema::DB_VERSION`
  upgrades the tables on the next load.
- **Deactivation** leaves the tables and every room alone.
- **Deleting the plugin** runs `uninstall.php`, which drops the tables
  on every site. `wp collaboration storage drop` and
  `WP_Sync_Table_Schema::drop()` do the same.
- **If the tables cannot be created** (the database user may lack the
  `CREATE TABLE` privilege), the filter leaves the framework's post-meta
  default in place and an admin notice says so. Run
  `wp collaboration storage install` once the privilege is granted.

## Commands

`wp collaboration storage status|install|reset|drop` is always
registered under WP-CLI. `status` reports the table names, whether they
are installed, the schema version, which storage is active, and the room
and row counts. `reset` deletes every room and keeps the tables.

`wp collaboration rooms list` and
`wp collaboration rooms inspect <room> [--rows=N] [--materialize] [--format=json]`
are read-only diagnostics: every room's engine lineage, row count and
cursor, and one room's row-type histogram, decoded room meta, presence,
and last N rows. They load only under WP-CLI on local or development
sites (wp-env reports `local`) or with the
`GUTENBERG_SYNC_ENGINES_DIAGNOSTICS` constant defined, and never on the
production path.
