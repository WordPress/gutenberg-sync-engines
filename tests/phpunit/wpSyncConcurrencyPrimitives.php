<?php
/**
 * Tests for the shared room lock and atomic option storage.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpSyncConcurrencyPrimitives extends WP_UnitTestCase {
	// ---------------------------------------------------------------
	// WP_Sync_Room_Lock
	// ---------------------------------------------------------------

	public function test_lock_acquire_contend_release_reacquire() {
		$name = 'test_sync_lock_' . md5( __METHOD__ );

		$token = WP_Sync_Room_Lock::acquire( $name, 0.0 );
		$this->assertIsString( $token, 'First acquire should win immediately.' );

		$contender = WP_Sync_Room_Lock::acquire( $name, 0.0 );
		$this->assertWPError( $contender, 'A held lock should refuse a zero-wait contender.' );
		$this->assertSame( 'rest_sync_room_busy', $contender->get_error_code() );
		$this->assertSame( 503, $contender->get_error_data()['status'] );

		WP_Sync_Room_Lock::release( $name, $token );
		$again = WP_Sync_Room_Lock::acquire( $name, 0.0 );
		$this->assertIsString( $again, 'A released lock should be acquirable again.' );
		WP_Sync_Room_Lock::release( $name, $again );
	}

	public function test_lock_ttl_takeover_of_abandoned_holder() {
		global $wpdb;
		$name = 'test_sync_lock_' . md5( __METHOD__ );

		// A holder that "crashed" longer than the TTL ago.
		$stale = sprintf( '%.6F:%s', microtime( true ) - WP_Sync_Room_Lock::TTL_SECONDS - 5, 'dead' );
		$wpdb->query(
			$wpdb->prepare( "INSERT IGNORE INTO `{$wpdb->options}` ( option_name, option_value, autoload ) VALUES ( %s, %s, 'no' )", $name, $stale )
		);

		$token = WP_Sync_Room_Lock::acquire( $name, 0.0 );
		$this->assertIsString( $token, 'An expired lock should be taken over.' );
		WP_Sync_Room_Lock::release( $name, $token );
	}

	public function test_lock_release_is_token_checked() {
		$name = 'test_sync_lock_' . md5( __METHOD__ );

		$token = WP_Sync_Room_Lock::acquire( $name, 0.0 );
		$this->assertIsString( $token );

		WP_Sync_Room_Lock::release( $name, 'not-the-token' );
		$contender = WP_Sync_Room_Lock::acquire( $name, 0.0 );
		$this->assertWPError( $contender, 'A wrong-token release must not free the lock.' );

		WP_Sync_Room_Lock::release( $name, $token );
	}

	// ---------------------------------------------------------------
	// WP_Sync_Atomic_Option
	// ---------------------------------------------------------------

	public function test_atomic_option_swap_seeds_missing_row() {
		$name = 'test_sync_cas_' . md5( __METHOD__ );

		$this->assertNull( WP_Sync_Atomic_Option::read( $name ) );
		$this->assertTrue( WP_Sync_Atomic_Option::swap( $name, '1', '2' ), 'A missing row seeds at the expected value, then swaps.' );
		$this->assertSame( '2', WP_Sync_Atomic_Option::read( $name ) );
	}

	public function test_atomic_option_swap_wins_once_and_loses_after() {
		$name = 'test_sync_cas_' . md5( __METHOD__ );

		WP_Sync_Atomic_Option::reset( $name, '5' );
		$this->assertTrue( WP_Sync_Atomic_Option::swap( $name, '5', '6' ) );
		$this->assertFalse( WP_Sync_Atomic_Option::swap( $name, '5', '6' ), 'A second swap from the same expected value must lose.' );
		$this->assertSame( '6', WP_Sync_Atomic_Option::read( $name ) );
	}

	public function test_atomic_option_reset_reseeds() {
		$name = 'test_sync_cas_' . md5( __METHOD__ );

		WP_Sync_Atomic_Option::reset( $name, '9' );
		WP_Sync_Atomic_Option::reset( $name, '1' );
		$this->assertSame( '1', WP_Sync_Atomic_Option::read( $name ) );
	}
}
