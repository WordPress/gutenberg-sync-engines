<?php
/**
 * WP_Sync_CAS_Backend interface
 *
 * @package gutenberg-sync-engines
 */

if ( ! interface_exists( 'WP_Sync_CAS_Backend' ) ) {
	/**
	 * A substitute compare-and-swap implementation (e.g. Redis), plugged
	 * in via the `wp_sync_cas_backend` filter. The contract — each clause
	 * is load-bearing:
	 *
	 * - `swap` must atomically compare and replace the whole value.
	 *   Reads must not use a stale cache.
	 * - A missing row is seeded with the expected value before comparison.
	 * - The backend must preserve the complete mailbox value.
	 * - `reset` (delete + seed) must be idempotent under racing
	 *   re-seeders writing the same value.
	 */
	interface WP_Sync_CAS_Backend {
		/**
		 * Atomically swaps from an expected value to the next one.
		 *
		 * @param string $name     Row name.
		 * @param string $expected Value the caller believes is current.
		 * @param string $next     Replacement value.
		 * @return bool Whether this caller performed the swap.
		 */
		public function swap( string $name, string $expected, string $next ): bool;

		/**
		 * Reads the current raw value, uncached.
		 *
		 * @param string $name Row name.
		 * @return string|null Current value, or null when absent.
		 */
		public function read( string $name ): ?string;

		/**
		 * Unconditionally re-seeds the row (delete + insert).
		 *
		 * @param string $name  Row name.
		 * @param string $value Fresh value.
		 * @return void
		 */
		public function reset( string $name, string $value ): void;
	}
}
