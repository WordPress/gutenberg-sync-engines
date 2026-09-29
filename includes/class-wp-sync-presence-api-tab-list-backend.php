<?php
/**
 * WP_Sync_Presence_API_Tab_List_Backend class
 *
 * @package gutenberg-sync-engines
 */

if ( ! class_exists( 'WP_Sync_Presence_API_Tab_List_Backend' ) ) {

	/**
	 * Keeps each tab as its own `gsetab-` row in the Presence API table.
	 *
	 * @since n.e.x.t
	 */
	final class WP_Sync_Presence_API_Tab_List_Backend implements WP_Sync_Tab_List_Backend {
		/**
		 * Client id prefix, distinct from awareness's `gse-`.
		 *
		 * @since n.e.x.t
		 * @var string
		 */
		const CLIENT_PREFIX = 'gsetab-';

		/**
		 * Whether the Presence API can hold the list.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool Whether this backend can serve.
		 */
		public static function is_available(): bool {
			return WP_Sync_Presence_API_Awareness_Backend::is_available();
		}

		/**
		 * Every live tab in a room.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room    Room identifier.
		 * @param int    $timeout Seconds before a tab is gone.
		 * @return array<string, array<string, mixed>> token => tab.
		 */
		public function tabs( string $room, int $timeout ): array {
			$tabs = array();

			foreach ( wp_get_presence( $room, $timeout, self::CLIENT_PREFIX ) as $row ) {
				$client_id = (string) $row->client_id;
				// Presence API versions before 0.7.0 ignore the prefix argument.
				if ( ! str_starts_with( $client_id, self::CLIENT_PREFIX ) ) {
					continue;
				}

				$tabs[ substr( $client_id, strlen( self::CLIENT_PREFIX ) ) ] = array(
					'state'      => is_array( $row->data ) ? $row->data : array(),
					'updated_at' => (int) strtotime( $row->date_gmt . ' UTC' ),
					'user_id'    => (int) $row->user_id,
				);
			}

			return $tabs;
		}

		/**
		 * Records one tab, stamped now.
		 *
		 * @since n.e.x.t
		 *
		 * @param string               $room    Room identifier.
		 * @param string               $token   The tab's token.
		 * @param array<string, mixed> $state   What the caller keeps for the tab.
		 * @param int                  $user_id The tab's user.
		 * @param int                  $timeout Seconds before the tab is gone.
		 * @return void
		 */
		public function put( string $room, string $token, array $state, int $user_id, int $timeout ): void {
			// An explicit date is never skipped as too recent; the lifetime
			// outlasts the site's default, which can be shorter than $timeout.
			wp_set_presence( $room, self::CLIENT_PREFIX . $token, $state, $user_id, gmdate( 'Y-m-d H:i:s' ), $timeout );
		}

		/**
		 * Removes one tab.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room  Room identifier.
		 * @param string $token The tab's token.
		 * @return void
		 */
		public function forget( string $room, string $token ): void {
			wp_remove_presence( $room, self::CLIENT_PREFIX . $token );
		}
	}
}
