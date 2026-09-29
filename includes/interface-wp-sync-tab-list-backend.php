<?php
/**
 * WP_Sync_Tab_List_Backend interface
 *
 * @package gutenberg-sync-engines
 */

if ( ! interface_exists( 'WP_Sync_Tab_List_Backend' ) ) {
	/**
	 * A per-tab store for the editor tabs open on a room, plugged in via
	 * the `wp_sync_tab_list_backend` filter. The default rewrites one
	 * transient per room, so two tabs refreshing at once can drop each
	 * other.
	 *
	 * A backend expires tabs itself, writes every `put`, and leaves other
	 * tabs alone. Callers have already authorized the room.
	 *
	 * @since n.e.x.t
	 */
	interface WP_Sync_Tab_List_Backend {
		/**
		 * Every tab written within `$timeout` seconds.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room    Room identifier.
		 * @param int    $timeout Seconds before a tab is gone.
		 * @return array<string, array<string, mixed>> token => { state, updated_at, user_id }.
		 */
		public function tabs( string $room, int $timeout ): array;

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
		public function put( string $room, string $token, array $state, int $user_id, int $timeout ): void;

		/**
		 * Removes one tab.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room  Room identifier.
		 * @param string $token The tab's token.
		 * @return void
		 */
		public function forget( string $room, string $token ): void;
	}
}
