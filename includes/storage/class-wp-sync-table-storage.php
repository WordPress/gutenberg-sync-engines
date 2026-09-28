<?php
/**
 * WP_Sync_Table_Storage class
 *
 * @package GutenbergSyncEngines
 */

// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- This class IS the storage layer: every query against the plugin's tables lives here. Update rows and engine bookkeeping never go through an object cache (rooms hold unsaved collaborative content; reads must see every write); only presence and the two write-once room keys do, and only on a host with a persistent cache (see the class docblock).

if ( ! class_exists( 'WP_Sync_Table_Storage' ) ) {

	/**
	 * Room storage over the plugin's dedicated tables
	 * (`WP_Sync_Table_Schema`), replacing the framework's post-meta
	 * default through the `__unstable_wp_sync_storage` filter.
	 *
	 * Update rows append to `{$prefix}sync_updates`; the row id is the
	 * cursor. Engine lineage, awareness, and engine bookkeeping
	 * (`get_room_meta`/`set_room_meta`) are rows of
	 * `{$prefix}sync_room_meta`, one per (room, key), so every write is a
	 * single-row insert or upsert and nothing touches post caches.
	 *
	 * The contract on the WP_Sync_Storage interface holds clause by clause:
	 *
	 * - Cursors only ever grow and are never reused: AUTO_INCREMENT ids,
	 *   which survive `remove_updates_before_cursor()` trims.
	 * - `get_updates_after_cursor()` reads the room's MAX(id) FIRST and
	 *   returns rows up to it in id order, so the cursor it reports never
	 *   skips a row appended concurrently.
	 * - Read-your-writes: plain InnoDB reads on the primary, no cache.
	 * - The lineage stamp is write-once: an INSERT IGNORE against the
	 *   UNIQUE (room, key) index makes racing first writers converge on
	 *   one winner.
	 *
	 * Engines read `$wpdb->insert_id` after `add_update()` for the new
	 * row's cursor — sometimes only after stamping lineage or writing room
	 * meta in between (the yjs-server genesis path). The post-meta default
	 * tolerated that because every write shared one `meta_id` sequence;
	 * here the meta table has its own, and its counter races ahead (an
	 * upsert consumes a value even when it updates). So every write other
	 * than `add_update()` restores `$wpdb->insert_id` to what it was, and
	 * it keeps naming the last update row.
	 *
	 * On a host with a persistent object cache (`wp_using_ext_object_cache()`)
	 * three things leave the database, following the storage strategy the
	 * WordPress hosting tests recommended ("custom table with transients",
	 * wordpress-develop#11599):
	 *
	 * - Awareness (who is present, cursors) lives ONLY in the object cache,
	 *   group `WP_Sync_Table_Schema::CACHE_GROUP`, never in a row. It is
	 *   ephemeral by design (entries expire after seconds), so losing it on
	 *   a cache flush costs one poll round trip and nothing else. Without a
	 *   persistent cache it stays a row of `sync_room_meta`, read fresh on
	 *   every call: the per-request `WP_Object_Cache` would go stale in a
	 *   long-running process such as the websocket daemon.
	 * - The engine lineage stamp and the polling transport's room
	 *   generation token are cached after their first read. Both are
	 *   written once per room lifetime and cleared only by `reset_room()`,
	 *   which also drops the cached copies, so a cached read is always the
	 *   stored value. Absence is never cached (the room may be stamped a
	 *   moment later). No other room meta is cached: checkpoints and
	 *   canonical documents are rewritten under races where the last cache
	 *   writer need not be the last row writer.
	 *
	 * A room needs no creation step (there is no per-room parent row), so
	 * looking at a room never brings it into existence; `get_room_engine()`
	 * and `peek_room_engine()` are the same read. The per-request caches
	 * behind `get_cursor()`/`get_update_count()` are refreshed ONLY by
	 * `get_updates_after_cursor()`, exactly like the post-meta default
	 * (engines rely on that: never gate anything on them before a read).
	 * Instances are built fresh per call by `wp_get_sync_storage()`; the
	 * class keeps no static state.
	 *
	 * @since 0.0.1
	 */
	class WP_Sync_Table_Storage implements WP_Sync_Storage {
		/**
		 * Room-meta key holding the engine lineage stamp. Reserved keys
		 * start with an underscore; engine keys never do.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const ENGINE_KEY = '_engine';

		/**
		 * Room-meta key holding the awareness array.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const AWARENESS_KEY = '_awareness';

		/**
		 * Room-meta key of the room's version counter: bumped after every
		 * successful write so a waiting reader can ask "did anything change?"
		 * with one lookup. With a persistent object cache it lives only
		 * there (an atomic increment), never in a row.
		 *
		 * @since 0.0.2
		 * @var string
		 */
		const VERSION_KEY = '_version';

		/**
		 * How long an untouched version counter stays in the object cache.
		 *
		 * @since 0.0.2
		 * @var int
		 */
		const VERSION_CACHE_TTL = MONTH_IN_SECONDS;

		/**
		 * Room-meta key holding the polling transport's room generation
		 * token (`WP_HTTP_Polling_Sync_Server::GENERATION_META_KEY`). Named
		 * here because it is one of the two write-once keys the storage may
		 * serve from the object cache.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const GENERATION_KEY = 'generation';

		/**
		 * How long a cached awareness array may live without a write.
		 * Every poll rewrites it while anyone is present, so this only
		 * bounds the memory a deserted room holds in the cache.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const AWARENESS_CACHE_TTL = 5 * MINUTE_IN_SECONDS;

		/**
		 * Longest room identifier the `room` column holds.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const MAX_ROOM_LENGTH = 191;

		/**
		 * Cache of cursors by room (highest id seen by the last read).
		 *
		 * @since 0.0.1
		 * @var array<string, int>
		 */
		private array $room_cursors = array();

		/**
		 * Cache of update counts by room (as of the last read).
		 *
		 * @since 0.0.1
		 * @var array<string, int>
		 */
		private array $room_update_counts = array();

		/**
		 * Constructor: makes sure the table names are registered on
		 * `$wpdb` (a no-op after the plugin entry has run).
		 *
		 * @since 0.0.1
		 */
		public function __construct() {
			WP_Sync_Table_Schema::register_tables();
		}

		/**
		 * Notify transports only after a successful write: bump the room's
		 * version counter, then fire the action.
		 *
		 * @since 0.0.2
		 * @param string $room   Changed room.
		 * @param bool   $stored Write result.
		 * @param bool   $bump   Whether to bump the version counter (a reset
		 *                       that just deleted the row leaves its absence
		 *                       as the signal).
		 * @return bool Unchanged write result.
		 */
		private function notify_change( string $room, bool $stored, bool $bump = true ): bool {
			if ( $stored ) {
				if ( $bump ) {
					$this->bump_room_version( $room );
				}
				/**
				 * Fires after room data changes. Subscribers must treat this as
				 * a wake hint and read durable state after the writer finishes.
				 *
				 * @since 0.0.2
				 * @param string $room Room name.
				 */
				do_action( 'gutenberg_sync_engines_room_changed', $room );
			}
			return $stored;
		}

		/**
		 * Bumps the room's version counter with an atomic increment: Redis
		 * and Memcached increment in place, and the row update is one
		 * statement, so two writers can never lose each other's bump. That
		 * atomicity is the guarantee: a reader compares the value with the
		 * snapshot it took before its last read, and a lost bump could let
		 * a reader whose snapshot fell between two bumps sleep through the
		 * second write until its catch-up read.
		 *
		 * @since 0.0.2
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room Room identifier.
		 */
		private function bump_room_version( string $room ): void {
			global $wpdb;

			if ( ! $this->is_storable_room( $room ) ) {
				return;
			}
			if ( wp_using_ext_object_cache() ) {
				$key = $this->cache_key( $room, self::VERSION_KEY );
				wp_cache_add( $key, 0, WP_Sync_Table_Schema::CACHE_GROUP, self::VERSION_CACHE_TTL );
				wp_cache_incr( $key, 1, WP_Sync_Table_Schema::CACHE_GROUP );
				return;
			}
			$last_update_id = $wpdb->insert_id;
			$wpdb->query(
				$wpdb->prepare(
					"INSERT INTO {$wpdb->sync_room_meta} ( room, meta_key, meta_value ) VALUES ( %s, %s, '1' ) ON DUPLICATE KEY UPDATE meta_value = meta_value + 1",
					$room,
					self::VERSION_KEY
				)
			);
			$wpdb->insert_id = $last_update_id; // See the class docblock.
		}

		/**
		 * The version counters of several rooms in one lookup, for a reader
		 * waiting on "did anything change?". Not part of the WP_Sync_Storage
		 * contract; the SSE stream uses it when this storage is active.
		 *
		 * @since 0.0.2
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string[] $rooms Room identifiers.
		 * @return array<string, string|null> Room => counter, null when the
		 *                                    room has never been written (or
		 *                                    was reset).
		 */
		public function get_room_versions( array $rooms ): array {
			global $wpdb;

			$rooms    = array_values( array_filter( array_unique( $rooms ), array( $this, 'is_storable_room' ) ) );
			$versions = array_fill_keys( $rooms, null );
			if ( empty( $rooms ) ) {
				return $versions;
			}
			if ( wp_using_ext_object_cache() ) {
				$keys = array();
				foreach ( $rooms as $room ) {
					$keys[ $room ] = $this->cache_key( $room, self::VERSION_KEY );
				}
				$found = wp_cache_get_multiple( array_values( $keys ), WP_Sync_Table_Schema::CACHE_GROUP );
				foreach ( $keys as $room => $key ) {
					if ( isset( $found[ $key ] ) && false !== $found[ $key ] ) {
						$versions[ $room ] = (string) $found[ $key ];
					}
				}
				return $versions;
			}
			$placeholders = implode( ', ', array_fill( 0, count( $rooms ), '%s' ) );
			$rows         = $wpdb->get_results(
				// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- The placeholders are generated.
				$wpdb->prepare( "SELECT room, meta_value FROM {$wpdb->sync_room_meta} WHERE meta_key = %s AND room IN ( {$placeholders} )", array_merge( array( self::VERSION_KEY ), $rooms ) ),
				ARRAY_A
			);
			foreach ( (array) $rows as $row ) {
				$versions[ $row['room'] ] = (string) $row['meta_value'];
			}
			return $versions;
		}

		/**
		 * Whether a room identifier fits the `room` column. Longer rooms
		 * cannot be stored (MySQL would truncate or reject them), so every
		 * write refuses them and every read treats them as empty.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @return bool Whether the room is storable.
		 */
		private function is_storable_room( string $room ): bool {
			return '' !== $room && strlen( $room ) <= self::MAX_ROOM_LENGTH;
		}

		/**
		 * Adds a sync update to a given room.
		 *
		 * Exactly one INSERT and nothing after it: engines read
		 * `$wpdb->insert_id` right after this call for the new row's cursor.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room   Room identifier.
		 * @param mixed  $update Serializable sync update, opaque to the storage.
		 * @return bool True on success, false on failure.
		 */
		public function add_update( string $room, $update ): bool {
			global $wpdb;

			if ( ! $this->is_storable_room( $room ) ) {
				return false;
			}

			$stored = (bool) $wpdb->insert(
				$wpdb->sync_updates,
				array(
					'room'        => $room,
					'data'        => wp_json_encode( $update ),
					'created_gmt' => current_time( 'mysql', true ),
				),
				array( '%s', '%s', '%s' )
			);
			return $this->notify_change( $room, $stored );
		}

		/**
		 * Gets awareness state for a given room.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @return array<int, mixed> Awareness state.
		 */
		public function get_awareness_state( string $room ): array {
			if ( $this->uses_object_cache() ) {
				if ( ! $this->is_storable_room( $room ) ) {
					return array();
				}
				$cached = wp_cache_get( $this->cache_key( $room, self::AWARENESS_KEY ), WP_Sync_Table_Schema::CACHE_GROUP );
				return is_array( $cached ) ? array_values( $cached ) : array();
			}

			$awareness = $this->read_meta( $room, self::AWARENESS_KEY );
			if ( ! is_string( $awareness ) ) {
				return array();
			}

			$decoded = json_decode( $awareness, true );
			return is_array( $decoded ) ? array_values( $decoded ) : array();
		}

		/**
		 * Sets awareness state for a given room (whole-array, last writer
		 * wins). On a host with a persistent object cache the array is
		 * written to the cache only; see the class docblock.
		 *
		 * @since 0.0.1
		 *
		 * @param string            $room      Room identifier.
		 * @param array<int, mixed> $awareness Serializable awareness state.
		 * @return bool True on success, false on failure.
		 */
		public function set_awareness_state( string $room, array $awareness ): bool {
			if ( $this->uses_object_cache() ) {
				if ( ! $this->is_storable_room( $room ) ) {
					return false;
				}
				$stored = (bool) wp_cache_set(
					$this->cache_key( $room, self::AWARENESS_KEY ),
					array_values( $awareness ),
					WP_Sync_Table_Schema::CACHE_GROUP,
					self::AWARENESS_CACHE_TTL
				);
				return $this->notify_change( $room, $stored );
			}

			return $this->notify_change( $room, $this->upsert_meta( $room, self::AWARENESS_KEY, (string) wp_json_encode( $awareness ) ) );
		}

		/**
		 * Whether presence and the write-once room keys are served from
		 * the object cache: only when the cache outlives the request.
		 *
		 * @since 0.0.1
		 *
		 * @return bool Whether a persistent object cache is in use.
		 */
		private function uses_object_cache(): bool {
			// The flag is unset (null) until wp_start_object_cache() ran, as
			// in the PHPUnit bootstrap: no persistent cache.
			return (bool) wp_using_ext_object_cache();
		}

		/**
		 * The object-cache key for one (room, key) pair. Rooms may hold
		 * characters some cache backends reject, so the room is hashed.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @param string $key  Room-meta key.
		 * @return string Cache key.
		 */
		private function cache_key( string $room, string $key ): string {
			return $key . ':' . md5( $room );
		}

		/**
		 * Whether a room-meta key may be served from the object cache:
		 * only the two written once per room lifetime.
		 *
		 * @since 0.0.1
		 *
		 * @param string $key Room-meta key.
		 * @return bool Whether reads of the key may be cached.
		 */
		private function is_cacheable_key( string $key ): bool {
			return self::ENGINE_KEY === $key || self::GENERATION_KEY === $key;
		}

		/**
		 * Reads a write-once room-meta value through the object cache when
		 * one is in use. Only found values are cached; absence is read
		 * from the table every time.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @param string $key  A key `is_cacheable_key()` accepts.
		 * @return string|null The stored value, or null when absent.
		 */
		private function read_write_once_meta( string $room, string $key ): ?string {
			if ( ! $this->uses_object_cache() ) {
				return $this->read_meta( $room, $key );
			}

			$cache_key = $this->cache_key( $room, $key );
			$cached    = wp_cache_get( $cache_key, WP_Sync_Table_Schema::CACHE_GROUP );
			if ( is_string( $cached ) ) {
				return $cached;
			}

			$value = $this->read_meta( $room, $key );
			if ( is_string( $value ) && '' !== $value ) {
				wp_cache_set( $cache_key, $value, WP_Sync_Table_Schema::CACHE_GROUP );
			}
			return $value;
		}

		/**
		 * Drops the cached copies of a room's presence and write-once keys.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @return void
		 */
		private function forget_room_cache( string $room ): void {
			foreach ( array( self::AWARENESS_KEY, self::ENGINE_KEY, self::GENERATION_KEY ) as $key ) {
				wp_cache_delete( $this->cache_key( $room, $key ), WP_Sync_Table_Schema::CACHE_GROUP );
			}
		}

		/**
		 * Gets the current cursor for a given room: the highest update id
		 * seen by this instance's last `get_updates_after_cursor()`.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @return int Current cursor for the room.
		 */
		public function get_cursor( string $room ): int {
			return $this->room_cursors[ $room ] ?? 0;
		}

		/**
		 * Gets the number of stored updates for a given room, as of this
		 * instance's last `get_updates_after_cursor()`.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @return int Number of updates.
		 */
		public function get_update_count( string $room ): int {
			return $this->room_update_counts[ $room ] ?? 0;
		}

		/**
		 * Retrieves sync updates from a room after the given cursor, in
		 * cursor order.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room   Room identifier.
		 * @param int    $cursor Return updates after this cursor (row id).
		 * @return array<int, mixed> Sync updates.
		 */
		public function get_updates_after_cursor( string $room, int $cursor ): array {
			global $wpdb;

			if ( ! $this->is_storable_room( $room ) ) {
				$this->room_cursors[ $room ]       = 0;
				$this->room_update_counts[ $room ] = 0;
				return array();
			}

			// Capture the room's state FIRST so the reported cursor is
			// race-safe against a concurrent append.
			$stats = $wpdb->get_row(
				$wpdb->prepare(
					"SELECT COUNT(*) AS total_updates, COALESCE( MAX(id), 0 ) AS max_id FROM {$wpdb->sync_updates} WHERE room = %s",
					$room
				)
			);

			$total_updates = $stats ? (int) $stats->total_updates : 0;
			$max_id        = $stats ? (int) $stats->max_id : 0;

			$this->room_update_counts[ $room ] = $total_updates;
			$this->room_cursors[ $room ]       = $max_id;

			if ( $max_id <= $cursor ) {
				return array();
			}

			$rows = $wpdb->get_col(
				$wpdb->prepare(
					"SELECT data FROM {$wpdb->sync_updates} WHERE room = %s AND id > %d AND id <= %d ORDER BY id ASC",
					$room,
					$cursor,
					$max_id
				)
			);

			$updates = array();
			foreach ( (array) $rows as $data ) {
				$decoded = json_decode( (string) $data, true );
				if ( null !== $decoded ) {
					$updates[] = $decoded;
				}
			}

			return $updates;
		}

		/**
		 * Removes updates from a room that are older than the given cursor.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room   Room identifier.
		 * @param int    $cursor Remove updates with id < this cursor.
		 * @return bool True on success, false on failure.
		 */
		public function remove_updates_before_cursor( string $room, int $cursor ): bool {
			global $wpdb;

			if ( ! $this->is_storable_room( $room ) ) {
				return false;
			}

			$deleted = $wpdb->query(
				$wpdb->prepare(
					"DELETE FROM {$wpdb->sync_updates} WHERE room = %s AND id < %d",
					$room,
					$cursor
				)
			);

			return false !== $deleted;
		}

		/**
		 * Gets the sync engine lineage of a room.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @return string|null Engine slug, or null for a room with no lineage.
		 */
		public function get_room_engine( string $room ): ?string {
			$engine = $this->read_write_once_meta( $room, self::ENGINE_KEY );
			return is_string( $engine ) && '' !== $engine ? $engine : null;
		}

		/**
		 * Reads a room's engine lineage without creating anything — which
		 * is what every read does here; kept for the framework's
		 * feature-detected non-creating read (`method_exists`).
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @return string|null Engine slug, or null for no lineage.
		 */
		public function peek_room_engine( string $room ): ?string {
			return $this->get_room_engine( $room );
		}

		/**
		 * Stamps the sync engine lineage of a room, write-once: the UNIQUE
		 * (room, key) index plus INSERT IGNORE means racing first writers
		 * converge on whichever row landed first, and a later call never
		 * overwrites it.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room   Room identifier.
		 * @param string $engine Engine slug.
		 * @return bool True when the room carries a lineage afterwards.
		 */
		public function set_room_engine( string $room, string $engine ): bool {
			global $wpdb;

			if ( ! $this->is_storable_room( $room ) || '' === $engine ) {
				return false;
			}

			$last_update_id  = $wpdb->insert_id;
			$result          = $wpdb->query(
				$wpdb->prepare(
					"INSERT IGNORE INTO {$wpdb->sync_room_meta} ( room, meta_key, meta_value ) VALUES ( %s, %s, %s )",
					$room,
					self::ENGINE_KEY,
					$engine
				)
			);
			$wpdb->insert_id = $last_update_id; // See the class docblock.
			if ( false === $result ) {
				return false;
			}

			return null !== $this->get_room_engine( $room );
		}

		/**
		 * Reads a per-room metadata value (JSON-decoded). Engine-level
		 * bookkeeping (compaction checkpoints, trim floors, canonical
		 * documents) rides here.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @param string $key  Meta key.
		 * @return mixed Decoded value, or null when absent.
		 */
		public function get_room_meta( string $room, string $key ) {
			$value = $this->is_cacheable_key( $key )
				? $this->read_write_once_meta( $room, $key )
				: $this->read_meta( $room, $key );
			if ( ! is_string( $value ) || '' === $value ) {
				return null;
			}

			return json_decode( $value, true );
		}

		/**
		 * Writes a per-room metadata value (JSON-encoded), replacing any
		 * previous value for the key in one atomic upsert.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room  Room identifier.
		 * @param string $key   Meta key.
		 * @param mixed  $value JSON-serializable value.
		 * @return bool True on success, false on failure.
		 */
		public function set_room_meta( string $room, string $key, $value ): bool {
			if ( $this->is_cacheable_key( $key ) ) {
				// Written once per room lifetime; the next read re-primes.
				wp_cache_delete( $this->cache_key( $room, $key ), WP_Sync_Table_Schema::CACHE_GROUP );
			}
			return $this->notify_change( $room, $this->upsert_meta( $room, $key, (string) wp_json_encode( $value ) ) );
		}

		/**
		 * Resets a room: deletes its update rows, engine lineage stamp,
		 * awareness, and room meta. A room with nothing stored is already
		 * reset.
		 *
		 * Only safe for REBUILDABLE rooms (change feeds like global
		 * collection/taxonomy rooms). A per-post entity room can hold
		 * unsaved collaborative content; callers own that distinction (see
		 * the polling transport's engine-switch reset).
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room Room identifier.
		 * @return bool True when the room holds no data afterwards.
		 */
		public function reset_room( string $room ): bool {
			global $wpdb;

			unset( $this->room_cursors[ $room ], $this->room_update_counts[ $room ] );

			if ( ! $this->is_storable_room( $room ) ) {
				return true;
			}

			$this->forget_room_cache( $room );

			$updates = $wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->sync_updates} WHERE room = %s", $room ) );
			$meta    = $wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->sync_room_meta} WHERE room = %s", $room ) );

			// The version row went with the meta: its absence is the change a
			// reader sees. A cached counter is kept and bumped instead.
			return $this->notify_change( $room, false !== $updates && false !== $meta, (bool) wp_using_ext_object_cache() );
		}

		/**
		 * Reads one raw meta value.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room Room identifier.
		 * @param string $key  Meta key.
		 * @return string|null Raw stored value, or null when absent.
		 */
		private function read_meta( string $room, string $key ): ?string {
			global $wpdb;

			if ( ! $this->is_storable_room( $room ) || '' === $key ) {
				return null;
			}

			$value = $wpdb->get_var(
				$wpdb->prepare(
					"SELECT meta_value FROM {$wpdb->sync_room_meta} WHERE room = %s AND meta_key = %s LIMIT 1",
					$room,
					$key
				)
			);

			return is_string( $value ) ? $value : null;
		}

		/**
		 * Inserts or replaces one meta value in a single statement.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room  Room identifier.
		 * @param string $key   Meta key.
		 * @param string $value Raw value to store.
		 * @return bool True on success, false on failure.
		 */
		private function upsert_meta( string $room, string $key, string $value ): bool {
			global $wpdb;

			if ( ! $this->is_storable_room( $room ) || '' === $key || strlen( $key ) > self::MAX_ROOM_LENGTH ) {
				return false;
			}

			$last_update_id  = $wpdb->insert_id;
			$result          = $wpdb->query(
				$wpdb->prepare(
					"INSERT INTO {$wpdb->sync_room_meta} ( room, meta_key, meta_value ) VALUES ( %s, %s, %s ) ON DUPLICATE KEY UPDATE meta_value = %s",
					$room,
					$key,
					$value,
					$value
				)
			);
			$wpdb->insert_id = $last_update_id; // See the class docblock.

			return false !== $result;
		}

		/*
		 * ------------------------------------------------------------------
		 * Read-only helpers for diagnostics (the rooms CLI, the room-size
		 * probe). Not part of the WP_Sync_Storage contract; they keep every
		 * query against the tables inside this class.
		 * ------------------------------------------------------------------
		 */

		/**
		 * Lists every room that holds anything, with its lineage and log
		 * statistics.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @return array<int, array{room: string, engine: string, rows: int, cursor: int, last_update_gmt: string}> Rooms, alphabetical.
		 */
		public function list_rooms(): array {
			global $wpdb;

			$rooms = array();

			$engines = $wpdb->get_results(
				$wpdb->prepare(
					"SELECT room, meta_value FROM {$wpdb->sync_room_meta} WHERE meta_key = %s",
					self::ENGINE_KEY
				)
			);
			foreach ( (array) $engines as $row ) {
				$rooms[ $row->room ] = array(
					'room'            => $row->room,
					'engine'          => (string) $row->meta_value,
					'rows'            => 0,
					'cursor'          => 0,
					'last_update_gmt' => '',
				);
			}

			$meta_rooms = $wpdb->get_col( "SELECT DISTINCT room FROM {$wpdb->sync_room_meta}" );
			foreach ( (array) $meta_rooms as $room ) {
				if ( ! isset( $rooms[ $room ] ) ) {
					$rooms[ $room ] = array(
						'room'            => $room,
						'engine'          => '',
						'rows'            => 0,
						'cursor'          => 0,
						'last_update_gmt' => '',
					);
				}
			}

			$stats = $wpdb->get_results(
				"SELECT room, COUNT(*) AS row_count, MAX(id) AS max_id, MAX(created_gmt) AS last_created FROM {$wpdb->sync_updates} GROUP BY room"
			);
			foreach ( (array) $stats as $row ) {
				if ( ! isset( $rooms[ $row->room ] ) ) {
					$rooms[ $row->room ] = array(
						'room'            => $row->room,
						'engine'          => '',
						'rows'            => 0,
						'cursor'          => 0,
						'last_update_gmt' => '',
					);
				}
				$rooms[ $row->room ]['rows']            = (int) $row->row_count;
				$rooms[ $row->room ]['cursor']          = (int) $row->max_id;
				$rooms[ $row->room ]['last_update_gmt'] = (string) $row->last_created;
			}

			ksort( $rooms, SORT_STRING );
			return array_values( $rooms );
		}

		/**
		 * Size of one room at rest: update rows, and the bytes its update
		 * and meta rows hold.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room Room identifier.
		 * @return array{found: bool, rows: int, cursor: int, bytes: int} Statistics; `found` is false for a room holding nothing.
		 */
		public function get_room_size( string $room ): array {
			global $wpdb;

			$empty = array(
				'found'  => false,
				'rows'   => 0,
				'cursor' => 0,
				'bytes'  => 0,
			);
			if ( ! $this->is_storable_room( $room ) ) {
				return $empty;
			}

			$updates = $wpdb->get_row(
				$wpdb->prepare(
					"SELECT COUNT(*) AS row_count, COALESCE( MAX(id), 0 ) AS max_id, COALESCE( SUM( LENGTH(data) ), 0 ) AS byte_count FROM {$wpdb->sync_updates} WHERE room = %s",
					$room
				)
			);
			$meta    = $wpdb->get_row(
				$wpdb->prepare(
					"SELECT COUNT(*) AS row_count, COALESCE( SUM( LENGTH(meta_key) + LENGTH(meta_value) ), 0 ) AS byte_count FROM {$wpdb->sync_room_meta} WHERE room = %s",
					$room
				)
			);

			$update_rows = $updates ? (int) $updates->row_count : 0;
			$meta_rows   = $meta ? (int) $meta->row_count : 0;
			if ( 0 === $update_rows && 0 === $meta_rows ) {
				return $empty;
			}

			return array(
				'found'  => true,
				'rows'   => $update_rows,
				'cursor' => $updates ? (int) $updates->max_id : 0,
				'bytes'  => ( $updates ? (int) $updates->byte_count : 0 ) + ( $meta ? (int) $meta->byte_count : 0 ),
			);
		}

		/**
		 * The cheapest non-creating look at a room: whether anything is
		 * stored for it, and the ids of its first and newest update rows.
		 *
		 * This is what the presence lane and the generation token read on
		 * every heartbeat, so it stays at two indexed lookups (no row
		 * scan, unlike get_room_size()) and never writes.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room Room identifier.
		 * @return array{found: bool, first_cursor: int, cursor: int} `found` is false for a room holding nothing (no rows, no meta); the cursors are 0 for a room without rows.
		 */
		public function peek_room( string $room ): array {
			global $wpdb;

			$empty = array(
				'found'        => false,
				'first_cursor' => 0,
				'cursor'       => 0,
			);
			if ( ! $this->is_storable_room( $room ) ) {
				return $empty;
			}

			$updates = $wpdb->get_row(
				$wpdb->prepare(
					"SELECT COALESCE( MIN(id), 0 ) AS first_id, COALESCE( MAX(id), 0 ) AS max_id FROM {$wpdb->sync_updates} WHERE room = %s",
					$room
				)
			);
			$first   = $updates ? (int) $updates->first_id : 0;
			$cursor  = $updates ? (int) $updates->max_id : 0;
			if ( $cursor > 0 ) {
				return array(
					'found'        => true,
					'first_cursor' => $first,
					'cursor'       => $cursor,
				);
			}

			$has_meta = (int) $wpdb->get_var(
				$wpdb->prepare(
					"SELECT 1 FROM {$wpdb->sync_room_meta} WHERE room = %s LIMIT 1",
					$room
				)
			);
			if ( 1 === $has_meta ) {
				return array(
					'found'        => true,
					'first_cursor' => 0,
					'cursor'       => 0,
				);
			}
			return $empty;
		}

		/**
		 * The newest update rows of a room, raw, newest first.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room  Room identifier.
		 * @param int    $limit How many rows.
		 * @return array<int, array{cursor: int, data: string}> Rows with their cursor and stored JSON.
		 */
		public function get_last_updates( string $room, int $limit ): array {
			global $wpdb;

			if ( ! $this->is_storable_room( $room ) || $limit <= 0 ) {
				return array();
			}

			$rows = $wpdb->get_results(
				$wpdb->prepare(
					"SELECT id, data FROM {$wpdb->sync_updates} WHERE room = %s ORDER BY id DESC LIMIT %d",
					$room,
					$limit
				)
			);

			$result = array();
			foreach ( (array) $rows as $row ) {
				$result[] = array(
					'cursor' => (int) $row->id,
					'data'   => (string) $row->data,
				);
			}
			return $result;
		}

		/**
		 * Every engine-level meta value of a room, decoded, keyed by meta
		 * key. The reserved lineage, awareness, and version rows are left out.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room Room identifier.
		 * @return array<string, mixed> Decoded values by key.
		 */
		public function get_all_room_meta( string $room ): array {
			global $wpdb;

			if ( ! $this->is_storable_room( $room ) ) {
				return array();
			}

			$rows = $wpdb->get_results(
				$wpdb->prepare(
					"SELECT meta_key, meta_value FROM {$wpdb->sync_room_meta} WHERE room = %s AND meta_key NOT IN ( %s, %s, %s ) ORDER BY meta_key ASC",
					$room,
					self::ENGINE_KEY,
					self::AWARENESS_KEY,
					self::VERSION_KEY
				)
			);

			$meta = array();
			foreach ( (array) $rows as $row ) {
				$meta[ (string) $row->meta_key ] = json_decode( (string) $row->meta_value, true );
			}
			return $meta;
		}
	}
}
