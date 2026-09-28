<?php
/**
 * Gutenberg_Sync_Engines_Rooms_CLI_Command class
 *
 * @package GutenbergSyncEngines
 */

if ( ! class_exists( 'Gutenberg_Sync_Engines_Rooms_CLI_Command' ) && defined( 'WP_CLI' ) && WP_CLI ) {

	/**
	 * Read-only room diagnostics: enumerate sync storage rooms and dump one
	 * room's server-side state (engine lineage, update rows, cursor,
	 * checkpoints, room meta, awareness).
	 *
	 * A development tool, deliberately kept OUT of the production path: the
	 * plugin only loads this file on local/development sites (or under the
	 * GUTENBERG_SYNC_ENGINES_DIAGNOSTICS constant) — see
	 * Gutenberg_Sync_Engines_Plugin::load().
	 *
	 * Reads go through the plugin's table storage, whose lookups never
	 * create a room (there is no per-room parent row to create), so a
	 * diagnostic read cannot bring a room into existence. Rooms are
	 * stored by name, so listing needs no reverse lookup.
	 *
	 * @since 0.3.0
	 */
	final class Gutenberg_Sync_Engines_Rooms_CLI_Command {

		/**
		 * Lists sync storage rooms.
		 *
		 * ## OPTIONS
		 *
		 * [--format=<format>]
		 * : Output format: table, json, csv, yaml, count.
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration rooms list
		 *     wp collaboration rooms list --format=json
		 *
		 * @subcommand list
		 *
		 * @since 0.3.0
		 *
		 * @param array $args       Positional arguments (unused).
		 * @param array $assoc_args Named arguments.
		 * @return void
		 */
		public function list_rooms( $args, $assoc_args ) { // phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- $args is part of the WP-CLI command signature.
			$rooms = $this->storage()->list_rooms();
			if ( array() === $rooms ) {
				WP_CLI::log( 'No sync storage rooms found.' );
				return;
			}

			$items = array();
			foreach ( $rooms as $room ) {
				$items[] = array(
					'room'        => $room['room'],
					'engine'      => $room['engine'],
					'rows'        => $room['rows'],
					'cursor'      => $room['cursor'],
					'last_update' => $room['last_update_gmt'],
				);
			}

			$format = $assoc_args['format'] ?? 'table';
			WP_CLI\Utils\format_items( $format, $items, array( 'room', 'engine', 'rows', 'cursor', 'last_update' ) );
		}

		/**
		 * Dumps one room's server-side state.
		 *
		 * ## OPTIONS
		 *
		 * <room>
		 * : Room identifier, e.g. `postType/post:123` or `postType/wp_block`.
		 *
		 * [--rows=<count>]
		 * : Also print the last <count> update rows, newest first.
		 *
		 * [--materialize]
		 * : Also print the engine's materialized post content.
		 *
		 * [--format=<format>]
		 * : Output format: summary (default) or json (the full decoded state).
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration rooms inspect postType/post:123
		 *     wp collaboration rooms inspect postType/post:123 --rows=10
		 *     wp collaboration rooms inspect postType/post:123 --format=json
		 *
		 * @since 0.3.0
		 *
		 * @param array $args       Positional arguments: the room identifier.
		 * @param array $assoc_args Named arguments.
		 * @return void
		 */
		public function inspect( $args, $assoc_args ) {
			$room    = (string) $args[0];
			$storage = $this->storage();
			$size    = $storage->get_room_size( $room );
			if ( ! $size['found'] ) {
				WP_CLI::error( "No storage room found for '{$room}' (rooms are only created once a client syncs; check `wp collaboration rooms list`)." );
			}

			$all_rows = $storage->get_updates_after_cursor( $room, 0 );

			$type_counts = array();
			foreach ( $all_rows as $row ) {
				$type                 = (string) ( $row['type'] ?? '(untyped)' );
				$type_counts[ $type ] = ( $type_counts[ $type ] ?? 0 ) + 1;
			}

			$awareness = ( new WP_Sync_Awareness( $storage ) )->entries( $room, WP_HTTP_Polling_Sync_Server::AWARENESS_TIMEOUT );

			$state = array(
				'room'      => $room,
				'engine'    => $storage->get_room_engine( $room ),
				'rows'      => $storage->get_update_count( $room ),
				'cursor'    => $storage->get_cursor( $room ),
				'bytes'     => $size['bytes'],
				'row_types' => $type_counts,
				'awareness' => array(
					'clients' => array_column( $awareness, 'client_id' ),
				),
				'room_meta' => $this->collect_room_meta( $storage, $room ),
			);

			$row_limit = isset( $assoc_args['rows'] ) ? max( 0, (int) $assoc_args['rows'] ) : 0;
			if ( $row_limit > 0 ) {
				$state['last_rows'] = array();
				foreach ( $storage->get_last_updates( $room, $row_limit ) as $raw ) {
					$state['last_rows'][] = $this->summarize_row( $raw['cursor'], $raw['data'] );
				}
			}

			if ( isset( $assoc_args['materialize'] ) && array() !== $all_rows ) {
				$engine_slug = $state['engine'];
				if ( null === $engine_slug || '' === $engine_slug ) {
					$state['materialized'] = '(cannot materialize: room has no recorded engine lineage)';
				} else {
					$engine = ( new WP_HTTP_Polling_Sync_Server( $storage ) )
						->get_engine_registry()
						->get_engine( $engine_slug );
					if ( null === $engine ) {
						$state['materialized'] = "(cannot materialize: engine '{$engine_slug}' is not registered on this site)";
					} elseif ( method_exists( $engine, 'materialize' ) ) {
						$state['materialized'] = $engine->materialize( $room );
					}
				}
			}

			if ( 'json' === ( $assoc_args['format'] ?? 'summary' ) ) {
				WP_CLI::log( (string) wp_json_encode( $state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) );
				return;
			}

			$this->print_summary( $state );
		}

		/**
		 * The storage these diagnostics read. They understand the plugin's
		 * table storage only; a site running on a substitute (or on the
		 * framework's post-meta fallback because the tables are missing)
		 * is told which one it has.
		 *
		 * @since 0.0.1
		 *
		 * @return WP_Sync_Table_Storage Storage.
		 */
		private function storage(): WP_Sync_Table_Storage {
			$storage = gutenberg_sync_engines_storage();
			if ( ! $storage instanceof WP_Sync_Table_Storage ) {
				WP_CLI::error( 'Room diagnostics read the plugin\'s table storage, but the active sync storage is ' . get_class( $storage ) . ' (see `wp collaboration storage status`).' );
			}
			return $storage;
		}

		/**
		 * Prints the human-readable summary of an inspected room.
		 *
		 * @since 0.3.0
		 *
		 * @param array $state Assembled room state.
		 * @return void
		 */
		private function print_summary( array $state ): void {
			WP_CLI::log( "Room:      {$state['room']}" );
			WP_CLI::log( 'Engine:    ' . ( $state['engine'] ? $state['engine'] : '(unstamped)' ) );
			WP_CLI::log( "Rows:      {$state['rows']} (cursor {$state['cursor']}, {$state['bytes']} bytes at rest)" );

			$types = array();
			foreach ( $state['row_types'] as $type => $count ) {
				$types[] = "{$type}×{$count}";
			}
			WP_CLI::log( 'Row types: ' . ( $types ? implode( ', ', $types ) : '(none)' ) );
			WP_CLI::log( 'Awareness: ' . ( $state['awareness']['clients'] ? 'clients ' . implode( ', ', $state['awareness']['clients'] ) : '(empty)' ) );

			if ( array() === $state['room_meta'] ) {
				WP_CLI::log( 'Room meta: (none)' );
			} else {
				WP_CLI::log( 'Room meta:' );
				foreach ( $state['room_meta'] as $key => $summary ) {
					WP_CLI::log( "  {$key}: {$summary}" );
				}
			}

			foreach ( $state['last_rows'] ?? array() as $row ) {
				WP_CLI::log( "  row {$row['cursor']}: {$row['summary']}" );
			}

			if ( array_key_exists( 'materialized', $state ) ) {
				WP_CLI::log( 'Materialized content:' );
				WP_CLI::log( (string) $state['materialized'] );
			}
		}

		/**
		 * Collects and summarizes the room's engine meta (checkpoints,
		 * canonical documents, floors), one line per key.
		 *
		 * @since 0.3.0
		 *
		 * @param WP_Sync_Table_Storage $storage Storage.
		 * @param string                $room    Room identifier; engine
		 *                                       option-row stores (the
		 *                                       de-rtc canonical chain) are
		 *                                       summarized alongside room
		 *                                       meta.
		 * @return array<string, string> Meta key → summary.
		 */
		private function collect_room_meta( WP_Sync_Table_Storage $storage, string $room ): array {
			$summaries = array();
			// The de-rtc canonical chain lives in an options row (the
			// announce model's ordered store), not room meta.
			if ( class_exists( 'WP_Sync_Atomic_Option' ) ) {
				global $wpdb;
				$canonical = WP_Sync_Atomic_Option::read( $wpdb->prefix . 'sync_de_rtc_canonical_' . md5( $room ) );
				if ( is_string( $canonical ) ) {
					$separator                              = strpos( $canonical, '|' );
					$decoded                                = false !== $separator ? json_decode( substr( $canonical, $separator + 1 ), true ) : null;
					$summaries['de_rtc_canonical (option)'] = $this->summarize_room_meta( 'de_rtc_canonical', $decoded );
				}
			}
			foreach ( $storage->get_all_room_meta( $room ) as $key => $decoded ) {
				$summaries[ $key ] = $this->summarize_room_meta( $key, $decoded );
			}
			return $summaries;
		}

		/**
		 * One-line summary of a known engine meta value; unknown keys fall
		 * back to their JSON.
		 *
		 * @since 0.3.0
		 *
		 * @param string $key     Meta key.
		 * @param mixed  $decoded Decoded meta value.
		 * @return string Summary.
		 */
		private function summarize_room_meta( string $key, $decoded ): string {
			if ( is_array( $decoded ) ) {
				$parts = array();
				foreach ( array( 'seq', 'cursor', 'version', 'version_seq' ) as $field ) {
					if ( isset( $decoded[ $field ] ) && is_scalar( $decoded[ $field ] ) ) {
						$parts[] = "{$field} {$decoded[$field]}";
					}
				}
				foreach ( array( 'doc', 'content' ) as $field ) {
					if ( isset( $decoded[ $field ] ) && is_string( $decoded[ $field ] ) ) {
						$parts[] = $field . ' ' . strlen( $decoded[ $field ] ) . 'b';
					}
				}
				if ( isset( $decoded['sync_meta']['version_snapshots'] ) && is_array( $decoded['sync_meta']['version_snapshots'] ) ) {
					$parts[] = 'snapshots ' . count( $decoded['sync_meta']['version_snapshots'] );
				}
				if ( array() !== $parts ) {
					return implode( ', ', $parts );
				}
			}
			if ( is_scalar( $decoded ) ) {
				return (string) $decoded;
			}
			return (string) wp_json_encode( $decoded );
		}

		/**
		 * One-line summary of a stored update row (cursor, type, author,
		 * size, and a payload hint when the inner JSON carries known keys).
		 *
		 * @since 0.3.0
		 *
		 * @param int    $cursor Row cursor (row id).
		 * @param string $raw    Raw stored value (the storage's JSON row).
		 * @return array{cursor: int, summary: string} Row summary.
		 */
		private function summarize_row( int $cursor, string $raw ): array {
			$row       = json_decode( $raw, true );
			$type      = is_array( $row ) ? (string) ( $row['type'] ?? '(untyped)' ) : '(undecodable)';
			$client_id = is_array( $row ) ? (int) ( $row['client_id'] ?? 0 ) : 0;
			$data      = is_array( $row ) && is_string( $row['data'] ?? null ) ? $row['data'] : '';

			$hints   = array();
			$payload = json_decode( $data, true );
			if ( is_array( $payload ) ) {
				foreach ( array( 'type', 'seq', 'version', 'baseVersion', 'reason', 'proposalId', 'intentId', 'checkpoint' ) as $field ) {
					if ( isset( $payload[ $field ] ) && is_scalar( $payload[ $field ] ) ) {
						$hints[] = "{$field}=" . ( is_bool( $payload[ $field ] ) ? 'true' : $payload[ $field ] );
					}
				}
			}

			return array(
				'cursor'  => $cursor,
				'summary' => "{$type} by client {$client_id}, " . strlen( $data ) . 'b'
					. ( $hints ? ' (' . implode( ', ', $hints ) . ')' : '' ),
			);
		}
	}

	WP_CLI::add_command( 'collaboration rooms', 'Gutenberg_Sync_Engines_Rooms_CLI_Command' );
}
