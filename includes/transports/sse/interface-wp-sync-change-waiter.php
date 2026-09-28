<?php
/**
 * What an open SSE stream sleeps on between reads.
 *
 * @package GutenbergSyncEngines
 * @since 0.0.2
 */

/**
 * A wait that ends early when a room may have changed.
 *
 * @since 0.0.2
 */
interface WP_Sync_Change_Waiter {
	/**
	 * Sleep for at most the given time.
	 *
	 * @param float $seconds Maximum wait.
	 * @return bool Whether a change was noticed (true) or the time ran out (false).
	 * @throws RuntimeException When the wait cannot continue; the stream ends and the browser reconnects.
	 */
	public function wait( float $seconds ): bool;

	/** Release whatever the wait holds. */
	public function close(): void;
}
