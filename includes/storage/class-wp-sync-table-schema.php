<?php
/**
 * WP_Sync_Table_Schema class
 *
 * @package GutenbergSyncEngines
 */

if ( ! class_exists( 'WP_Sync_Table_Schema' ) ) {

	/**
	 * Owns the plugin's two database tables: their names, their definition,
	 * and their lifecycle (create, upgrade, drop).
	 *
	 * Real-time collaboration keeps two kinds of per-room data: an
	 * append-only log of update rows (the cursor is the row id) and a small
	 * set of per-room values (engine lineage, awareness, engine
	 * bookkeeping such as checkpoints and canonical documents). The
	 * framework's default storage keeps both as post meta on a hidden post
	 * per room, which makes every collaboration write invalidate post
	 * caches. This plugin keeps them in two dedicated tables instead:
	 *
	 * - `{$prefix}sync_updates`: one row per update, `id` is the cursor.
	 * - `{$prefix}sync_room_meta`: one row per (room, key).
	 *
	 * Both are per-site tables (registered on `$wpdb->tables`, so
	 * `switch_to_blog()` re-prefixes them on multisite). Activation creates
	 * them; a plugin update that ships a newer `DB_VERSION` upgrades them
	 * on the next load (`maybe_upgrade()`); deactivation leaves them and
	 * their rows alone; `drop()` (called by `uninstall.php` and by
	 * `wp collaboration storage drop`) removes them.
	 *
	 * Nothing here depends on the collaboration framework: the tables can
	 * be created, inspected, and dropped whether or not Gutenberg is
	 * present. `WP_Sync_Table_Storage` is the only reader and writer of
	 * the rows.
	 *
	 * @since 0.0.1
	 */
	final class WP_Sync_Table_Schema {
		/**
		 * Schema version. Bump it whenever `get_schema()` changes; the
		 * next load runs dbDelta again (`maybe_upgrade()`), which is how a
		 * future migration lands without a re-activation.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const DB_VERSION = 1;

		/**
		 * Option recording the installed schema version for the site.
		 * Written only after the tables are verified to exist, so a
		 * matching value doubles as "the tables are usable".
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const DB_VERSION_OPTION = 'gutenberg_sync_engines_db_version';

		/**
		 * Unprefixed name of the update-log table (`$wpdb->sync_updates`).
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const UPDATES_TABLE = 'sync_updates';

		/**
		 * Unprefixed name of the per-room key/value table
		 * (`$wpdb->sync_room_meta`).
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const ROOM_META_TABLE = 'sync_room_meta';

		/**
		 * Object-cache group for the per-room values the storage serves
		 * from a persistent cache (presence, and the write-once lineage and
		 * generation keys). Per site, never global: `switch_to_blog()`
		 * re-prefixes it like the tables. Flushed whenever every room is
		 * emptied or the tables are dropped.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const CACHE_GROUP = 'wp_sync_rooms';

		/**
		 * Forgets every cached per-room value for the current site.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public static function flush_cache(): void {
			if ( function_exists( 'wp_cache_supports' ) && wp_cache_supports( 'flush_group' ) ) {
				wp_cache_flush_group( self::CACHE_GROUP );
				return;
			}
			wp_cache_flush();
		}

		/**
		 * Registers the table names on `$wpdb` for the current site.
		 *
		 * Runs on every load, before anything reads `$wpdb->sync_updates`
		 * or `$wpdb->sync_room_meta`. Adding the names to `$wpdb->tables`
		 * is what makes `switch_to_blog()` re-prefix them, so the storage
		 * keeps addressing the current site's tables on multisite.
		 * Idempotent.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @return void
		 */
		public static function register_tables(): void {
			global $wpdb;

			foreach ( array( self::UPDATES_TABLE, self::ROOM_META_TABLE ) as $table ) {
				$wpdb->$table = $wpdb->prefix . $table;
				if ( ! in_array( $table, $wpdb->tables, true ) ) {
					$wpdb->tables[] = $table;
				}
			}
		}

		/**
		 * The CREATE TABLE statements, in dbDelta's expected format (two
		 * spaces after PRIMARY KEY, one column or key per line).
		 *
		 * `room` is stored in the clear (no hashing): the framework's room
		 * grammar bounds it well under 191 characters, and readable rooms
		 * make diagnostics trivial. `created_gmt` records when an update
		 * row was appended (last activity for diagnostics; the basis for
		 * any future age-based maintenance).
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @return string[] One CREATE TABLE statement per table.
		 */
		public static function get_schema(): array {
			global $wpdb;

			self::register_tables();
			$charset_collate = $wpdb->get_charset_collate();

			return array(
				"CREATE TABLE {$wpdb->sync_updates} (
	id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
	room varchar(191) NOT NULL,
	data longtext NOT NULL,
	created_gmt datetime NOT NULL default '0000-00-00 00:00:00',
	PRIMARY KEY  (id),
	KEY room_id (room,id)
) $charset_collate;",
				"CREATE TABLE {$wpdb->sync_room_meta} (
	meta_id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
	room varchar(191) NOT NULL,
	meta_key varchar(191) NOT NULL,
	meta_value longtext NOT NULL,
	PRIMARY KEY  (meta_id),
	UNIQUE KEY room_key (room,meta_key)
) $charset_collate;",
			);
		}

		/**
		 * Creates or upgrades the tables for the current site and records
		 * the schema version.
		 *
		 * Running dbDelta is idempotent: on an up-to-date site it changes nothing
		 * (and runs no DDL). The version option is written only once both
		 * tables are verified to exist, so a site without CREATE TABLE
		 * privileges never claims a working install.
		 *
		 * @since 0.0.1
		 *
		 * @return bool Whether both tables exist afterwards.
		 */
		public static function install(): bool {
			require_once ABSPATH . 'wp-admin/includes/upgrade.php';

			foreach ( self::get_schema() as $sql ) {
				dbDelta( $sql );
			}

			if ( ! self::is_installed() ) {
				return false;
			}

			update_option( self::DB_VERSION_OPTION, self::DB_VERSION );
			return true;
		}

		/**
		 * Creates or upgrades the tables on every site of the network.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public static function install_network(): void {
			self::for_each_site( array( __CLASS__, 'install' ) );
		}

		/**
		 * Brings the current site's schema up to `DB_VERSION` when it is
		 * behind (a plugin update, or a site the activation hook never ran
		 * on — a mu-plugin, a copy activated before this version).
		 *
		 * One autoloaded option read per request when nothing is to do.
		 *
		 * @since 0.0.1
		 *
		 * @return bool Whether the schema is usable afterwards.
		 */
		public static function maybe_upgrade(): bool {
			if ( self::is_ready() ) {
				return true;
			}
			return self::install();
		}

		/**
		 * Whether the site records a current schema version — the cheap
		 * (autoloaded option) signal that the tables are usable, for
		 * per-request code paths that must not query the schema.
		 *
		 * @since 0.0.1
		 *
		 * @return bool Whether the recorded version is current.
		 */
		public static function is_ready(): bool {
			return (int) get_option( self::DB_VERSION_OPTION, 0 ) >= self::DB_VERSION;
		}

		/**
		 * Whether both tables exist for the current site (queries the
		 * schema; use `is_ready()` on hot paths).
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @return bool Whether both tables exist.
		 */
		public static function is_installed(): bool {
			global $wpdb;

			self::register_tables();
			foreach ( array( $wpdb->sync_updates, $wpdb->sync_room_meta ) as $table ) {
				// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Schema probe.
				if ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $table ) ) ) !== $table ) {
					return false;
				}
			}
			return true;
		}

		/**
		 * Drops both tables for the current site and forgets the recorded
		 * schema version. Every room's rows go with them.
		 *
		 * This is the programmatic delete: deactivation never calls it.
		 * Note that an ACTIVE plugin recreates its tables on the next load
		 * (`maybe_upgrade()` sees no recorded version), so dropping only
		 * sticks once the plugin is deactivated or uninstalled.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @return void
		 */
		public static function drop(): void {
			global $wpdb;

			self::register_tables();
			foreach ( array( $wpdb->sync_updates, $wpdb->sync_room_meta ) as $table ) {
				// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- The programmatic delete; the name is one of the two registered tables.
				$wpdb->query( "DROP TABLE IF EXISTS `{$table}`" );
			}
			delete_option( self::DB_VERSION_OPTION );
			self::flush_cache();
		}

		/**
		 * Drops the tables on every site of the network.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public static function drop_network(): void {
			self::for_each_site( array( __CLASS__, 'drop' ) );
		}

		/**
		 * Deletes every row of both tables for the current site, keeping
		 * the tables (and their auto-increment counters, so cursors stay
		 * monotonic for any client that is still connected). Every room is
		 * gone afterwards; the next session rebuilds its room from the
		 * saved post.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @return bool Whether both deletes succeeded.
		 */
		public static function delete_all_rows(): bool {
			global $wpdb;

			self::register_tables();
			$ok = true;
			foreach ( array( $wpdb->sync_updates, $wpdb->sync_room_meta ) as $table ) {
				// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- Deliberate wipe of every room; the name is one of the two registered tables.
				$ok = false !== $wpdb->query( "DELETE FROM `{$table}`" ) && $ok;
			}
			self::flush_cache();
			return $ok;
		}

		/**
		 * Runs a callback once per site in the network, inside
		 * `switch_to_blog()`. Paginates site ids so a large network never
		 * loads every site at once.
		 *
		 * @since 0.0.1
		 *
		 * @param callable $callback Runs with each site as the current one.
		 * @return void
		 */
		public static function for_each_site( callable $callback ): void {
			$batch_size = 100;
			$offset     = 0;

			do {
				$site_ids = get_sites(
					array(
						'fields' => 'ids',
						'number' => $batch_size,
						'offset' => $offset,
					)
				);

				foreach ( $site_ids as $site_id ) {
					switch_to_blog( $site_id );
					$callback();
					restore_current_blog();
				}

				$found   = count( $site_ids );
				$offset += $batch_size;
			} while ( $found === $batch_size );
		}
	}
}
