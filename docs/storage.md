# Storage

Collaboration rooms (one post's shared editing session) live in two
tables the plugin owns, not in post meta. Who is present lives in the
Presence API's table when that plugin is recording, and with the room's
other data otherwise.

## The two tables

`WP_Sync_Table_Storage` (`includes/storage/class-wp-sync-table-storage.php`)
replaces the framework's post-meta default through the
`__unstable_wp_sync_storage` filter and is the only code that touches
the tables. `WP_Sync_Table_Schema` creates, upgrades and drops them.

**`{prefix}sync_updates`**, the update log: `id`, `room`, `data` (the
encoded `{ type, data }` update), `created_gmt`, indexed on
`(room, id)`. A client remembers the last id it saw (its cursor). Ids
only go up and are never reused. A read first finds the room's highest
id and returns rows up to it, so a row written at the same moment is
never missed. Reads go straight to the database.

**`{prefix}sync_room_meta`**, everything else: `meta_id`, `room`,
`meta_key`, `meta_value`, unique on `(room, meta_key)`. Keys starting
with an underscore belong to the storage:

| Key | Holds |
| --- | --- |
| `_engine` | The engine that first wrote the room. Written once; if two requests write it at the same time, the first wins. |
| `_awareness` | Who is present, when the Presence API is not holding it and there is no persistent object cache. |
| `_version` | The room's version counter, when there is no persistent cache. |
| `generation` | The id of the room's first row; changes on every reset, so clients start over. |
| `intent_log_checkpoint`, `intent_log_floor` | intent-log's latest full copy of the document (a checkpoint, saved every so often so older rows can be deleted) and the oldest row still kept (the floor). |
| `yjs_server_doc`, `yjs_server_checkpoint`, `yjs_server_floor`, `yjs_server_wrappers` | yjs-server's server copy of the document, snapshot, floor, and each block's saved HTML. |
| `de_rtc_checkpoint`, `de_rtc_floor`, `de_rtc_approved_blocks` | de-rtc's snapshot, floor, and blocks a reviewer approved despite unsafe markup. |

De-rtc keeps its current content and version claim in options rows,
swapped atomically by `WP_Sync_Atomic_Option` (a compare-and-swap:
change a value only if nobody changed it first; the
`wp_sync_cas_backend` filter can substitute Redis). Intent-log's
per-room lock is an options row too (`WP_Sync_Room_Lock`, replaceable
through `wp_sync_lock_backend`).

There is no per-room parent row, so looking at a room never creates it;
the read-only helpers (`list_rooms`, `get_room_size`,
`get_last_updates`, `get_all_room_meta`, `peek_room`) are safe on every
request.

## The version counter and change notices

Every successful write bumps the room's version counter (an atomic
increment), so a waiting reader such as a server-sent events stream can
ask "did anything change in these rooms?" with one lookup
(`get_room_versions`) and read again when the value differs. Every
write also fires `gutenberg_sync_engines_room_changed` with the room
name; the stream transport sends its Redis notice from it, and a
replacement storage must fire it too.

## What the object cache holds

On a host with a persistent object cache, three things leave the
database. This follows the strategy the WordPress hosting tests
recommended ("custom table with transients"):

- presence kept in the room's own data, when the Presence API is off;
- the version counter;
- the two keys written once per room, `_engine` and `generation`,
  cached after their first read and dropped by `reset_room()`.

Nothing else is cached, because checkpoints and engine documents are
rewritten by several requests at once. An idle poll is read-only either
way: presence timestamps are rounded to ten-second buckets
(`wp_sync_awareness_timestamp_granularity`), and a poll that changes
nothing writes nothing.

## Presence

Who is in a room is read and written only through `WP_Sync_Awareness`.
The `wp_sync_awareness_backend` filter can replace where it is kept.
The plugin's own backend keeps presence in the required Presence API's
`wp_presence` table, one row per tab under a `gse-` client-id prefix.
It is used whenever that plugin reports it can serve
(`wp_presence_is_available()`); otherwise presence falls back to the
room's own data.

The list of editor tabs on a post, which the advisory channel uses to
find peers, has the same kind of backend (`wp_sync_tab_list_backend`):
`gsetab-` rows in the same table, else one transient per room.
`tests/tools/check-presence-api.php` checks the backend against the
real plugin.

## Lifecycle and commands

Activation creates the tables with `dbDelta` and records the schema
version (`gutenberg_sync_engines_db_version`); a newer
`WP_Sync_Table_Schema::DB_VERSION` upgrades them on the next load.
Deactivation leaves the tables and every room alone. Deleting the plugin
(`uninstall.php`) drops the tables on every site. If the tables cannot
be created, the post-meta default stays and an admin notice says to run
`wp collaboration storage install` once the privilege is granted.

`wp collaboration storage status|install|reset|drop` is always
registered under WP-CLI (`reset` deletes every room and keeps the
tables). `wp collaboration rooms list` and
`wp collaboration rooms inspect <room> [--rows=N] [--materialize]`
dump room state read-only, on local or development sites or with the
`GUTENBERG_SYNC_ENGINES_DIAGNOSTICS` constant.
