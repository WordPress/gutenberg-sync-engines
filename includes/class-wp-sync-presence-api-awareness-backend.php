<?php
/**
 * WP_Sync_Presence_API_Awareness_Backend class
 *
 * @package gutenberg-sync-engines
 */

if ( ! class_exists( 'WP_Sync_Presence_API_Awareness_Backend' ) ) {

	/**
	 * Holds awareness in the Presence API plugin's shared `wp_presence`
	 * table instead of this plugin's room array, as `gse-`-prefixed rows so
	 * that plugin's own rows are read by neither side.
	 *
	 * @since 0.0.2
	 */
	final class WP_Sync_Presence_API_Awareness_Backend implements WP_Sync_Awareness_Backend {
		/**
		 * The client id prefix this plugin's rows carry.
		 *
		 * @since 0.0.2
		 * @var string
		 */
		const CLIENT_PREFIX = 'gse-';

		/**
		 * What fraction of the caller's window an entry may spend unwritten,
		 * low enough that several refreshes can be missed before it expires.
		 *
		 * @since 0.0.2
		 * @var int
		 */
		const REFRESH_FRACTION = 3;

		/**
		 * Whether the Presence API is present, has its table and is recording,
		 * since missing any of the three makes every room look deserted and
		 * the room array should serve instead.
		 *
		 * @since 0.0.2
		 *
		 * @return bool Whether this backend can serve.
		 */
		public static function is_available(): bool {
			if ( ! function_exists( 'wp_get_presence' )
				|| ! function_exists( 'wp_set_presence' )
				|| ! function_exists( 'wp_remove_presence' )
			) {
				return false;
			}

			// One public answer since Presence API 0.6.0. Older versions only
			// answer it through functions marked private, so fall back to those.
			if ( function_exists( 'wp_presence_is_available' ) ) {
				return wp_presence_is_available();
			}

			return ( ! function_exists( 'wp_presence_has_table' ) || wp_presence_has_table() )
				&& ( ! function_exists( 'wp_presence_recording_enabled' ) || wp_presence_recording_enabled() );
		}

		/**
		 * Every live entry in a room, aged again here because a site's
		 * `wp_presence_default_ttl` filter can override the caller's window.
		 *
		 * @since 0.0.2
		 *
		 * @param string $room    Room identifier.
		 * @param int    $timeout Age in seconds past which an entry is gone.
		 * @return array<int, array<string, mixed>> Entries, lowest client id first.
		 */
		public function entries( string $room, int $timeout ): array {
			$now     = time();
			$entries = array();

			foreach ( wp_get_presence( $room, $timeout ) as $row ) {
				if ( ! str_starts_with( (string) $row->client_id, self::CLIENT_PREFIX ) ) {
					continue;
				}

				$updated_at = (int) strtotime( $row->date_gmt . ' UTC' );
				if ( $now - $updated_at >= $timeout ) {
					continue;
				}

				$entries[] = array(
					// Columns come back as strings; client ids compare strictly.
					'client_id'  => (int) substr( (string) $row->client_id, strlen( self::CLIENT_PREFIX ) ),
					'state'      => is_array( $row->data ) ? $row->data : array(),
					'updated_at' => $updated_at,
					'wp_user_id' => (int) $row->user_id,
				);
			}

			return self::sorted( $entries );
		}

		/**
		 * Entries in client id order, the order every caller expects.
		 *
		 * @since 0.0.2
		 *
		 * @param array<int, array<string, mixed>> $entries Entries to order.
		 * @return array<int, array<string, mixed>> The same entries, ordered.
		 */
		private static function sorted( array $entries ): array {
			usort(
				$entries,
				static function ( array $a, array $b ): int {
					return $a['client_id'] <=> $b['client_id'];
				}
			);

			return $entries;
		}

		/**
		 * Records one client's awareness state, refreshing the row once it has
		 * spent its share of the caller's window unwritten and skipping
		 * otherwise, so an idle poll stays read-only.
		 *
		 * @since 0.0.2
		 *
		 * @param string               $room      Room identifier.
		 * @param int                  $client_id The client's sync id.
		 * @param array<string, mixed> $state     The state to store.
		 * @param int                  $user_id   The WordPress user behind it.
		 * @param int                  $timeout   Age in seconds past which an
		 *                                        entry is gone.
		 * @return array<int, array<string, mixed>> The room's live entries.
		 */
		public function put( string $room, int $client_id, array $state, int $user_id, int $timeout ): array {
			$now     = time();
			$entries = $this->entries( $room, $timeout );
			$refresh = max( 1, intdiv( $timeout, self::REFRESH_FRACTION ) );

			foreach ( $entries as $index => $entry ) {
				if ( $entry['client_id'] !== $client_id ) {
					continue;
				}

				// What comes back from the table has been through JSON, so it is
				// compared encoded rather than against what went in.
				if ( $now - $entry['updated_at'] < $refresh
					&& $entry['wp_user_id'] === $user_id
					&& wp_json_encode( $entry['state'] ) === wp_json_encode( $state )
				) {
					return $entries;
				}

				unset( $entries[ $index ] );
				break;
			}

			// The explicit timestamp turns off the Presence API's own write
			// skip, which runs as long as the caller's whole window and so
			// would let a live client reach the edge of it unwritten.
			if ( wp_set_presence( $room, self::CLIENT_PREFIX . $client_id, $state, $user_id, gmdate( 'Y-m-d H:i:s', $now ) ) ) {
				self::changed( $room );
			}

			// The room as it now stands, without reading it a second time.
			$entries[] = array(
				'client_id'  => $client_id,
				'state'      => $state,
				'updated_at' => $now,
				'wp_user_id' => $user_id,
			);

			return self::sorted( $entries );
		}

		/**
		 * Removes one client's entry.
		 *
		 * @since 0.0.2
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id The client's sync id.
		 * @param int    $timeout   Age in seconds past which an entry is gone.
		 * @return array<int, array<string, mixed>> The room's live entries.
		 */
		public function forget( string $room, int $client_id, int $timeout ): array {
			if ( wp_remove_presence( $room, self::CLIENT_PREFIX . $client_id ) ) {
				self::changed( $room );
			}

			return $this->entries( $room, $timeout );
		}

		/**
		 * Wakes streams waiting on the room without writing to it.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room Room identifier.
		 * @return void
		 */
		private static function changed( string $room ): void {
			/** This action is documented in includes/storage/class-wp-sync-table-storage.php */
			do_action( 'gutenberg_sync_engines_room_changed', $room );
		}
	}
}
