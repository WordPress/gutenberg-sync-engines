<?php
/**
 * The wait an SSE stream uses when no Redis is available.
 *
 * @package GutenbergSyncEngines
 * @since 0.0.2
 */

/**
 * Sleeps in half-second steps and asks storage whether anything changed.
 *
 * This is what the retired long-polling transport did inside its held
 * request. It costs a storage read per step per open stream, so a host
 * with more than a few editors should configure Redis instead; the
 * stream itself is the same either way.
 *
 * @since 0.0.2
 */
class WP_Sync_Storage_Change_Waiter implements WP_Sync_Change_Waiter {
	/**
	 * Seconds between storage checks.
	 *
	 * @var float Seconds between storage checks.
	 */
	const CHECK_INTERVAL = 0.5;

	/**
	 * Answers whether a watched room changed since the last read.
	 *
	 * @var callable Answers whether a watched room changed since the last read.
	 */
	private $has_changes;

	/**
	 * Sleeps for a number of seconds. Replaceable in tests.
	 *
	 * @var callable Sleeps for a number of seconds.
	 */
	private $sleep;

	/**
	 * Constructor.
	 *
	 * @param callable      $has_changes Returns true when a watched room changed.
	 * @param callable|null $sleep       Sleeps for the given seconds (default: usleep).
	 */
	public function __construct( callable $has_changes, ?callable $sleep = null ) {
		$this->has_changes = $has_changes;
		$this->sleep       = $sleep ?? static function ( float $seconds ): void {
			usleep( (int) ( $seconds * 1000000 ) );
		};
	}

	/**
	 * Sleep in half-second steps, checking storage after each.
	 *
	 * @param float $seconds Maximum wait.
	 * @return bool Whether a change was noticed.
	 */
	public function wait( float $seconds ): bool {
		$remaining = max( 0.0, $seconds );
		do {
			$step = min( self::CHECK_INTERVAL, $remaining );
			( $this->sleep )( $step );
			$remaining -= $step;
			if ( ( $this->has_changes )() ) {
				return true;
			}
		} while ( $remaining > 0 );
		return false;
	}

	/** Nothing is held. */
	public function close(): void {}
}
