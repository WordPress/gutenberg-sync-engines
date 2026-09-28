<?php
/**
 * Tests for the Core-style concurrency primitives (WP_Sync_Room_Lock,
 * WP_Sync_Atomic_Option) and the de-rtc engine's optimistic
 * version-claim concurrency built on them.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpSyncConcurrencyPrimitives extends WP_UnitTestCase {
	/**
	 * Editor user ID.
	 *
	 * @var int
	 */
	protected static $editor_id;

	/**
	 * Post ID used for room targets.
	 *
	 * @var int
	 */
	protected static $post_id;

	const GENESIS_CONTENT = "<!-- wp:paragraph -->\n<p>Alpha block original text.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Beta block original text.</p>\n<!-- /wp:paragraph -->";

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id = $factory->user->create( array( 'role' => 'editor' ) );
		self::$post_id   = $factory->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_title'   => 'Concurrency test post',
				'post_content' => self::GENESIS_CONTENT,
			)
		);
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
		wp_delete_post( self::$post_id, true );
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::$editor_id );
	}

	private function room(): string {
		return 'postType/post:' . self::$post_id;
	}

	private function engine(): WP_De_RTC_Engine {
		return new WP_De_RTC_Engine( new WP_Sync_Table_Storage() );
	}

	/**
	 * The de-rtc claim option name (mirrors the engine's private helper).
	 */
	private function claim_name(): string {
		global $wpdb;
		return $wpdb->prefix . 'sync_de_rtc_claim_' . md5( $this->room() );
	}

	private function proposal( string $proposal_id, string $base_version, string $proposed ): array {
		return array(
			'data' => wp_json_encode(
				array(
					'proposalId'      => $proposal_id,
					'baseVersion'     => $base_version,
					'proposedContent' => $proposed,
					'clientUpdate'    => null,
				)
			),
			'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
		);
	}

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

	// ---------------------------------------------------------------
	// de-rtc optimistic concurrency
	// ---------------------------------------------------------------

	/**
	 * The heart of the lock-free model: a request whose in-memory state
	 * went stale (another request committed first) loses its claim,
	 * reloads, re-merges, and lands cleanly on the advanced lineage.
	 */
	public function test_lost_claim_reloads_and_remerges() {
		$stale = $this->engine();
		// Load canonical (v1) into the stale engine's per-request cache.
		$this->assertSame( $this->genesis(), $stale->materialize( $this->room() ) );

		// A concurrent request (fresh engine, same DB) commits first: v2.
		$winner   = $this->engine();
		$proposed = str_replace( 'Beta block original text.', 'Beta block edited by winner.', $this->genesis() );
		$result   = $winner->handle_updates( $this->room(), 101, 0, array( $this->proposal( 'p-winner', 'v1', $proposed ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertSame( 'v2', $result['dispositions'][0]['version'] );

		// The stale engine now ingests a proposal merged against its cached
		// v1 state. Its first claim must lose, then reload and re-merge.
		$proposed2 = str_replace( 'Alpha block original text.', 'Alpha block edited by loser.', $this->genesis() );
		$result2   = $stale->handle_updates( $this->room(), 102, 0, array( $this->proposal( 'p-loser', 'v1', $proposed2 ) ), array( 'debug' => true ) );

		$this->assertNotWPError( $result2 );
		$this->assertSame( 'applied', $result2['dispositions'][0]['status'] );
		$this->assertSame( 'v3', $result2['dispositions'][0]['version'], 'The re-merge must land on the advanced lineage.' );

		// Both edits survive in canonical: nothing lost, no fork.
		$final = $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Beta block edited by winner.', $final );
		$this->assertStringContainsString( 'Alpha block edited by loser.', $final );
	}

	/**
	 * A claimer that died between claim and commit must not wedge the
	 * room: an expired orphan claim is taken over.
	 */
	public function test_orphaned_claim_is_taken_over() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		// Simulate: someone claimed v2 and crashed before add_row, 20s ago.
		WP_Sync_Atomic_Option::reset( $this->claim_name(), '2:' . sprintf( '%.6F', microtime( true ) - 20 ) );

		$proposed = str_replace( 'Alpha block original text.', 'Alpha healed after orphan.', $this->genesis() );
		$result   = $engine->handle_updates( $this->room(), 103, 0, array( $this->proposal( 'p-heal', 'v1', $proposed ) ), array() );

		$this->assertNotWPError( $result );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
	}

	/**
	 * A FRESH foreign claim (its writer may still be about to commit)
	 * must not be stolen: the request exhausts its attempts and returns
	 * the retryable 503 — the old lock-timeout contract.
	 */
	public function test_fresh_foreign_claim_returns_retryable_busy() {
		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ) );

		WP_Sync_Atomic_Option::reset( $this->claim_name(), '2:' . sprintf( '%.6F', microtime( true ) ) );

		$proposed = str_replace( 'Alpha block original text.', 'Alpha never lands.', $this->genesis() );
		$result   = $engine->handle_updates( $this->room(), 104, 0, array( $this->proposal( 'p-busy', 'v1', $proposed ) ), array() );

		$this->assertWPError( $result );
		$this->assertSame( 'rest_sync_room_busy', $result->get_error_code() );
		$this->assertSame( 503, $result->get_error_data()['status'] );
	}

	/**
	 * Genesis re-seeds the claim row, so a stale claim from a previous
	 * room lifetime (reset / engine flip) cannot wedge the new room.
	 */
	public function test_genesis_reseeds_stale_claim_row() {
		// A leftover claim from a prior room lifetime, far ahead.
		WP_Sync_Atomic_Option::reset( $this->claim_name(), '47:' . sprintf( '%.6F', microtime( true ) ) );

		$engine = $this->engine();
		$this->assertSame( $this->genesis(), $engine->materialize( $this->room() ), 'Genesis must run normally.' );
		$this->assertStringStartsWith( '1:', (string) WP_Sync_Atomic_Option::read( $this->claim_name() ), 'Genesis must re-seed the claim to its own seq.' );

		$proposed = str_replace( 'Alpha block original text.', 'Alpha after reseed.', $this->genesis() );
		$result   = $engine->handle_updates( $this->room(), 105, 0, array( $this->proposal( 'p-reseed', 'v1', $proposed ) ), array() );
		$this->assertNotWPError( $result );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertSame( 'v2', $result['dispositions'][0]['version'] );
	}

	/**
	 * The room's genesis content: the saved post with every block stamped
	 * with its deterministic identity (what the room actually serves).
	 *
	 * @return string Stamped genesis content.
	 */
	private function genesis(): string {
		return WP_De_RTC_Block_Identity::stamp_genesis( self::GENESIS_CONTENT, self::$post_id );
	}
}
