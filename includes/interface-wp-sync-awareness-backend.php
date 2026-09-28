<?php
/**
 * WP_Sync_Awareness_Backend interface
 *
 * @package gutenberg-sync-engines
 */

if ( ! interface_exists( 'WP_Sync_Awareness_Backend' ) ) {
	/**
	 * A substitute store for who is in a room and what they are doing,
	 * plugged in via the `wp_sync_awareness_backend` filter.
	 *
	 * The built-in store rewrites a room's whole array whenever one client
	 * moves, so two clients polling in the same instant can drop each
	 * other's entry. This interface is per client instead.
	 *
	 * The contract:
	 *
	 * - `put` and `forget` address ONE client and must leave every other
	 *   client's entry alone.
	 * - `entries` returns only entries younger than `$timeout` seconds;
	 *   expiry is the backend's job, as no caller sweeps.
	 * - An idle client re-`put`s the same state every poll, so a backend
	 *   should skip a write it can prove is redundant.
	 * - Entries carry `client_id` (int), `state` (array), `updated_at`
	 *   (Unix seconds) and `wp_user_id` (int).
	 * - `put` and `forget` return the room as it stands afterwards, and
	 *   neither is required to re-read to do it.
	 * - Callers have already authorized the room, so a backend must not add
	 *   a capability check: the WebSocket daemon sweeps out of band, with no
	 *   current user to check.
	 *
	 * @since 0.0.2
	 */
	interface WP_Sync_Awareness_Backend {
		/**
		 * Every live entry in a room.
		 *
		 * @param string $room    Room identifier.
		 * @param int    $timeout Age in seconds past which an entry is gone.
		 * @return array<int, array<string, mixed>> Entries, each with
		 *         client_id, state, updated_at and wp_user_id.
		 */
		public function entries( string $room, int $timeout ): array;

		/**
		 * Records one client's awareness state.
		 *
		 * @param string               $room      Room identifier.
		 * @param int                  $client_id The client's sync id.
		 * @param array<string, mixed> $state     The state to store.
		 * @param int                  $user_id   The WordPress user behind it.
		 * @param int                  $timeout   Age in seconds past which an
		 *                                        entry is gone.
		 * @return array<int, array<string, mixed>> The room's live entries.
		 */
		public function put( string $room, int $client_id, array $state, int $user_id, int $timeout ): array;

		/**
		 * Removes one client's entry.
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id The client's sync id.
		 * @param int    $timeout   Age in seconds past which an entry is gone.
		 * @return array<int, array<string, mixed>> The room's live entries.
		 */
		public function forget( string $room, int $client_id, int $timeout ): array;
	}
}
