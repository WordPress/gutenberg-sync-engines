<?php
/**
 * Atomic compare-and-swap over a single options row.
 *
 * @package gutenberg-sync-engines
 */

if ( ! class_exists( 'WP_Sync_Atomic_Option' ) ) {
	/**
	 * A tiny compare-and-swap primitive backed by one options-table row.
	 *
	 * This is the optimistic-concurrency counterpart to WP_Sync_Room_Lock:
	 * instead of excluding writers, a writer CLAIMS a state transition
	 * (`swap( name, expected, next )`) and loses gracefully when someone
	 * else got there first. The de-rtc engine uses it to claim canonical
	 * version advancement — restoring upstream DE-RTC's lock-free,
	 * validate-and-retry model.
	 *
	 * Same topology rationale as the lock: options-row UPDATEs are writes
	 * (always routed to the primary), the pattern works on SQLite, and all
	 * access is direct $wpdb so object caches never see (or serve) it.
	 */
	class WP_Sync_Atomic_Option {

		/**
		 * A resolved substitute backend, null for the built-in options
		 * implementation, or false while unresolved.
		 *
		 * @var WP_Sync_CAS_Backend|null|false
		 */
		private static $backend = false;

		/**
		 * Resolves the CAS backend once per request.
		 *
		 * @return WP_Sync_CAS_Backend|null Substitute backend, or null for
		 *                                  the built-in implementation.
		 */
		private static function backend(): ?WP_Sync_CAS_Backend {
			if ( false === self::$backend ) {
				/**
				 * Filters the compare-and-swap backend, so a drop-in plugin
				 * can hold these rows somewhere other than the options
				 * table. Return a WP_Sync_CAS_Backend; its contract —
				 * including why memcached is unsuitable — is documented on
				 * the interface.
				 *
				 * @since 0.4.0
				 *
				 * @param WP_Sync_CAS_Backend|null $backend Substitute
				 *        backend, or null for the options-table default.
				 */
				$backend       = apply_filters( 'wp_sync_cas_backend', null );
				self::$backend = $backend instanceof WP_Sync_CAS_Backend ? $backend : null;
			}
			return self::$backend;
		}

		/**
		 * Clears the resolved backend. Test use only.
		 *
		 * @return void
		 */
		public static function reset_backend_for_testing(): void {
			self::$backend = false;
		}

		/**
		 * Atomically swaps the row from an expected value to the next one.
		 *
		 * A missing row is seeded with the expected value first (INSERT
		 * IGNORE — atomic under races), so pre-existing state that never
		 * had a claim row starts claimable at its current value.
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $name     Option name.
		 * @param string $expected Value the caller believes is current.
		 * @param string $next     Replacement value.
		 * @return bool Whether this caller performed the swap.
		 */
		public static function swap( string $name, string $expected, string $next ): bool {
			global $wpdb;

			$backend = self::backend();
			if ( null !== $backend ) {
				return $backend->swap( $name, $expected, $next );
			}

			for ( $attempt = 0; $attempt < 2; $attempt++ ) {
				// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotSimple -- Atomic CAS; deliberately bypasses the options cache.
				$swapped = $wpdb->query(
					$wpdb->prepare( "UPDATE `{$wpdb->options}` SET option_value = %s WHERE option_name = %s AND option_value = %s", $next, $name, $expected ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotSimple
				);
				if ( $swapped ) {
					return true;
				}
				if ( null !== self::read( $name ) ) {
					return false; // Row exists with a different value: lost the race.
				}
				// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotSimple -- Atomic seed for a missing row.
				$wpdb->query(
					$wpdb->prepare( "INSERT IGNORE INTO `{$wpdb->options}` ( `option_name`, `option_value`, `autoload` ) VALUES ( %s, %s, 'no' )", $name, $expected ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotSimple
				);
			}

			return false;
		}

		/**
		 * Atomically swaps the row when its current value has the expected
		 * PREFIX. The large-value CAS variant: chained writers whose values
		 * embed a sequence prefix (`"<seq>|<payload>"`) order themselves by
		 * expecting their predecessor's prefix, without comparing the whole
		 * (potentially large) payload. A missing row is seeded with `$next`
		 * directly (INSERT IGNORE — the first chained write of state that
		 * predates the chain).
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $name            Option name.
		 * @param string $expected_prefix Prefix the current value must have.
		 * @param string $next            Replacement value.
		 * @return bool Whether this caller performed the swap (or seed).
		 */
		public static function swap_prefixed( string $name, string $expected_prefix, string $next ): bool {
			global $wpdb;

			$backend = self::backend();
			if ( null !== $backend ) {
				return $backend->swap_prefixed( $name, $expected_prefix, $next );
			}

			for ( $attempt = 0; $attempt < 2; $attempt++ ) {
				// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotSimple -- Atomic CAS; deliberately bypasses the options cache.
				$swapped = $wpdb->query(
					$wpdb->prepare( "UPDATE `{$wpdb->options}` SET option_value = %s WHERE option_name = %s AND option_value LIKE %s", $next, $name, $wpdb->esc_like( $expected_prefix ) . '%' ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotSimple
				);
				if ( $swapped ) {
					return true;
				}
				if ( null !== self::read( $name ) ) {
					return false; // Row exists with another prefix: lost the race.
				}
				// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotSimple -- Atomic seed for a missing row.
				$seeded = $wpdb->query(
					$wpdb->prepare( "INSERT IGNORE INTO `{$wpdb->options}` ( `option_name`, `option_value`, `autoload` ) VALUES ( %s, %s, 'no' )", $name, $next ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotSimple
				);
				if ( $seeded ) {
					return true;
				}
			}

			return false;
		}

		/**
		 * Deletes a row. A substitute backend without a delete of its own
		 * has the row reset to the empty string instead.
		 *
		 * @since 0.0.1
		 *
		 * @param string $name Option name.
		 * @return void
		 */
		public static function delete( string $name ): void {
			global $wpdb;

			$backend = self::backend();
			if ( null !== $backend ) {
				if ( method_exists( $backend, 'delete' ) ) {
					$backend->delete( $name );
				} else {
					$backend->reset( $name, '' );
				}
				return;
			}

			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Deliberately bypasses the options cache, like the rest of this class.
			$wpdb->delete( $wpdb->options, array( 'option_name' => $name ) );
		}

		/**
		 * Reads the current raw value, uncached.
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $name Option name.
		 * @return string|null Current value, or null when the row is absent.
		 */
		public static function read( string $name ): ?string {
			global $wpdb;

			$backend = self::backend();
			if ( null !== $backend ) {
				return $backend->read( $name );
			}

			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotSimple -- Deliberately bypasses the options cache.
			$value = $wpdb->get_var(
				$wpdb->prepare( "SELECT option_value FROM `{$wpdb->options}` WHERE option_name = %s", $name ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotSimple
			);

			return is_string( $value ) ? $value : null;
		}

		/**
		 * Unconditionally re-seeds the row (delete + insert). Used when the
		 * guarded state itself is rebuilt from nothing (room genesis after a
		 * reset), where a stale claim row must not outlive the state it
		 * described. Racing re-seeders writing the same value are idempotent.
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $name  Option name.
		 * @param string $value Fresh value.
		 * @return void
		 */
		public static function reset( string $name, string $value ): void {
			global $wpdb;

			$backend = self::backend();
			if ( null !== $backend ) {
				$backend->reset( $name, $value );
				return;
			}

			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotSimple -- Deliberately bypasses the options cache.
			$wpdb->query(
				$wpdb->prepare( "DELETE FROM `{$wpdb->options}` WHERE option_name = %s", $name ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotSimple
			);
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotSimple -- Atomic seed.
			$wpdb->query(
				$wpdb->prepare( "INSERT IGNORE INTO `{$wpdb->options}` ( `option_name`, `option_value`, `autoload` ) VALUES ( %s, %s, 'no' )", $name, $value ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotSimple
			);
		}
	}
}
