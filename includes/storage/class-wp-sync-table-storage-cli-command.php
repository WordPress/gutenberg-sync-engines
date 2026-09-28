<?php
/**
 * WP_Sync_Table_Storage_CLI_Command class
 *
 * @package GutenbergSyncEngines
 */

if ( ! class_exists( 'WP_Sync_Table_Storage_CLI_Command' ) && defined( 'WP_CLI' ) && WP_CLI ) {

	/**
	 * Lifecycle commands for the plugin's storage tables: inspect, create
	 * or upgrade, empty, and drop them.
	 *
	 * Deactivating the plugin never removes the tables; `drop` and
	 * `uninstall.php` are the two ways they go. Always registered under
	 * WP-CLI (unlike the room diagnostics, which are development-only),
	 * because a site needs these to manage its own data.
	 *
	 * @since 0.0.1
	 */
	final class WP_Sync_Table_Storage_CLI_Command {

		/**
		 * Shows whether the tables exist, the recorded schema version, and
		 * how much they hold.
		 *
		 * ## OPTIONS
		 *
		 * [--format=<format>]
		 * : Output format: table, json, csv, yaml.
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration storage status
		 *
		 * @since 0.0.1
		 *
		 * @param array $args       Positional arguments (unused).
		 * @param array $assoc_args Named arguments.
		 * @return void
		 */
		public function status( $args, $assoc_args ) { // phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- $args is part of the WP-CLI command signature.
			global $wpdb;

			WP_Sync_Table_Schema::register_tables();
			$installed = WP_Sync_Table_Schema::is_installed();

			$rooms = 0;
			$rows  = 0;
			if ( $installed ) {
				$listed = ( new WP_Sync_Table_Storage() )->list_rooms();
				$rooms  = count( $listed );
				foreach ( $listed as $room ) {
					$rows += $room['rows'];
				}
			}

			$active = function_exists( 'wp_get_sync_storage' ) ? get_class( wp_get_sync_storage() ) : '(collaboration framework not loaded)';

			$items = array(
				array(
					'key'   => 'tables',
					'value' => $wpdb->sync_updates . ', ' . $wpdb->sync_room_meta,
				),
				array(
					'key'   => 'installed',
					'value' => $installed ? 'yes' : 'no',
				),
				array(
					'key'   => 'schema_version',
					'value' => (int) get_option( WP_Sync_Table_Schema::DB_VERSION_OPTION, 0 ) . ' (current: ' . WP_Sync_Table_Schema::DB_VERSION . ')',
				),
				array(
					'key'   => 'active_storage',
					'value' => $active,
				),
				array(
					'key'   => 'rooms',
					'value' => (string) $rooms,
				),
				array(
					'key'   => 'update_rows',
					'value' => (string) $rows,
				),
			);

			WP_CLI\Utils\format_items( $assoc_args['format'] ?? 'table', $items, array( 'key', 'value' ) );
		}

		/**
		 * Creates the tables, or upgrades them to the current schema.
		 * Idempotent; the same step activation runs.
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration storage install
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public function install() {
			if ( ! WP_Sync_Table_Schema::install() ) {
				WP_CLI::error( 'The storage tables could not be created. Check that the database user may CREATE TABLE.' );
			}
			WP_CLI::success( 'Storage tables are installed at schema version ' . WP_Sync_Table_Schema::DB_VERSION . '.' );
		}

		/**
		 * Empties every room (all update rows and room meta), keeping the
		 * tables. Rooms rebuild from the saved posts on the next session;
		 * unsaved collaborative content in open sessions is lost.
		 *
		 * ## OPTIONS
		 *
		 * [--yes]
		 * : Skip the confirmation prompt.
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration storage reset --yes
		 *
		 * @since 0.0.1
		 *
		 * @param array $args       Positional arguments (unused).
		 * @param array $assoc_args Named arguments.
		 * @return void
		 */
		public function reset( $args, $assoc_args ) { // phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- $args is part of the WP-CLI command signature.
			if ( ! WP_Sync_Table_Schema::is_installed() ) {
				WP_CLI::success( 'No storage tables to reset.' );
				return;
			}
			WP_CLI::confirm( 'Delete every collaboration room on this site? Unsaved collaborative content in open sessions will be lost.', $assoc_args );

			if ( ! WP_Sync_Table_Schema::delete_all_rows() ) {
				WP_CLI::error( 'Resetting the storage tables failed.' );
			}
			WP_CLI::success( 'Every room was deleted; the tables remain.' );
		}

		/**
		 * Drops the tables and forgets the recorded schema version — the
		 * programmatic delete. While the plugin stays active it recreates
		 * empty tables on the next load; deactivate or uninstall it first
		 * for the drop to stick.
		 *
		 * ## OPTIONS
		 *
		 * [--yes]
		 * : Skip the confirmation prompt.
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration storage drop --yes
		 *
		 * @since 0.0.1
		 *
		 * @param array $args       Positional arguments (unused).
		 * @param array $assoc_args Named arguments.
		 * @return void
		 */
		public function drop( $args, $assoc_args ) { // phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- $args is part of the WP-CLI command signature.
			WP_CLI::confirm( 'Drop the collaboration storage tables on this site? Every room and its rows will be gone.', $assoc_args );

			WP_Sync_Table_Schema::drop();
			WP_CLI::success( 'Storage tables dropped. An active plugin recreates them (empty) on its next load.' );
		}
	}

	WP_CLI::add_command( 'collaboration storage', 'WP_Sync_Table_Storage_CLI_Command' );
}
