<?php
/**
 * WP_Sync_Awareness class
 *
 * @package gutenberg-sync-engines
 */

if ( ! class_exists( 'WP_Sync_Awareness' ) ) {

	/**
	 * Who is in a room and what they are doing.
	 *
	 * Every awareness read and write in the plugin goes through here, so a
	 * backend returned from `wp_sync_awareness_backend` serves all of them.
	 * The built-in store keeps the room's whole array under one storage key,
	 * which two clients polling in the same instant can lose, and which
	 * never reaches the database on a host with a persistent object cache
	 * (P5).
	 *
	 * @since 0.0.2
	 */
	final class WP_Sync_Awareness {
		/**
		 * The resolved substitute backend, null for the built-in store, false
		 * before the filter has run.
		 *
		 * @since 0.0.2
		 * @var WP_Sync_Awareness_Backend|null|false
		 */
		private static $backend = false;

		/**
		 * The storage holding the built-in store's array.
		 *
		 * @since 0.0.2
		 * @var WP_Sync_Storage
		 */
		private $storage;

		/**
		 * Constructor.
		 *
		 * @since 0.0.2
		 *
		 * @param WP_Sync_Storage $storage Storage backing the built-in store.
		 */
		public function __construct( WP_Sync_Storage $storage ) {
			$this->storage = $storage;
		}

		/**
		 * Resolves the awareness backend once per request.
		 *
		 * @since 0.0.2
		 *
		 * @return WP_Sync_Awareness_Backend|null Substitute backend, or null
		 *                                        for the built-in store.
		 */
		private static function backend(): ?WP_Sync_Awareness_Backend {
			if ( false === self::$backend ) {
				/**
				 * Filters the store holding who is in a room.
				 *
				 * Return a WP_Sync_Awareness_Backend to hold awareness
				 * somewhere other than this plugin's room array, or null to
				 * keep the built-in store; the contract is on the interface.
				 * This plugin registers the Presence API backend here at the
				 * default priority, so
				 * `remove_all_filters( 'wp_sync_awareness_backend' )` forces
				 * the built-in store back.
				 *
				 * @since 0.0.2
				 *
				 * @param WP_Sync_Awareness_Backend|null $backend Substitute
				 *        backend, or null for the built-in store.
				 */
				$backend       = apply_filters( 'wp_sync_awareness_backend', null );
				self::$backend = $backend instanceof WP_Sync_Awareness_Backend ? $backend : null;
			}
			return self::$backend;
		}

		/**
		 * Clears the resolved backend. Test use only.
		 *
		 * @since 0.0.2
		 *
		 * @return void
		 */
		public static function reset_backend_for_testing(): void {
			self::$backend = false;
		}

		/**
		 * Whether a substitute backend is serving this request.
		 *
		 * @since 0.0.2
		 *
		 * @return bool Whether awareness is held somewhere other than the
		 *              built-in store.
		 */
		public static function has_substitute_backend(): bool {
			return null !== self::backend();
		}

		/**
		 * Every live entry in a room.
		 *
		 * @since 0.0.2
		 *
		 * @param string $room    Room identifier.
		 * @param int    $timeout Age in seconds past which an entry is gone.
		 * @return array<int, array<string, mixed>> Entries, oldest client id first.
		 */
		public function entries( string $room, int $timeout ): array {
			$backend = self::backend();
			if ( null !== $backend ) {
				return $backend->entries( $room, $timeout );
			}

			return self::live( $this->storage->get_awareness_state( $room ), $timeout, 0 );
		}

		/**
		 * Records one client's awareness state and returns the room.
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
			$backend = self::backend();
			if ( null !== $backend ) {
				return $backend->put( $room, $client_id, $state, $user_id, $timeout );
			}

			$stored = $this->storage->get_awareness_state( $room );
			$live   = self::live( $stored, $timeout, $client_id );
			$live[] = array(
				'client_id'  => $client_id,
				'state'      => $state,
				'updated_at' => WP_HTTP_Polling_Sync_Server::awareness_timestamp( time() ),
				'wp_user_id' => $user_id,
			);

			return $this->store( $room, $stored, $live );
		}

		/**
		 * Removes one client's entry and returns the room.
		 *
		 * @since 0.0.2
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id The client's sync id.
		 * @param int    $timeout   Age in seconds past which an entry is gone.
		 * @return array<int, array<string, mixed>> The room's live entries.
		 */
		public function forget( string $room, int $client_id, int $timeout ): array {
			$backend = self::backend();
			if ( null !== $backend ) {
				return $backend->forget( $room, $client_id, $timeout );
			}

			$stored = $this->storage->get_awareness_state( $room );

			return $this->store( $room, $stored, self::live( $stored, $timeout, $client_id ) );
		}

		/**
		 * Writes the room's array back, unless it is already what is stored.
		 *
		 * An idle poll carries the same state in the same timestamp bucket,
		 * so the comparison skips the write and the poll stays read-only.
		 *
		 * @since 0.0.2
		 *
		 * @param string                           $room    Room identifier.
		 * @param array<int, array<string, mixed>> $stored  What the store holds.
		 * @param array<int, array<string, mixed>> $entries What it should hold.
		 * @return array<int, array<string, mixed>> The entries, as written.
		 */
		private function store( string $room, array $stored, array $entries ): array {
			// A stable order makes "nothing changed" a plain comparison.
			usort(
				$entries,
				static function ( array $a, array $b ): int {
					return $a['client_id'] <=> $b['client_id'];
				}
			);

			if ( $entries !== $stored ) {
				$this->storage->set_awareness_state( $room, $entries );
			}

			return $entries;
		}

		/**
		 * The still-live entries of a stored array, without the client the
		 * caller is about to replace or remove.
		 *
		 * @since 0.0.2
		 *
		 * @param array<int, mixed> $stored  What the store holds.
		 * @param int               $timeout Age in seconds past which an entry is gone.
		 * @param int               $exclude Client id to leave out, or 0 for none.
		 * @return array<int, array<string, mixed>> Live entries.
		 */
		private static function live( array $stored, int $timeout, int $exclude ): array {
			$now  = time();
			$live = array();

			foreach ( $stored as $entry ) {
				if ( ! is_array( $entry ) || ! isset( $entry['client_id'], $entry['updated_at'] ) ) {
					continue;
				}
				if ( 0 !== $exclude && $exclude === (int) $entry['client_id'] ) {
					continue;
				}
				if ( $now - (int) $entry['updated_at'] >= $timeout ) {
					continue;
				}
				$live[] = $entry;
			}

			return $live;
		}
	}
}
