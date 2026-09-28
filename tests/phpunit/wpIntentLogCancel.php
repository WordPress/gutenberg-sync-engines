<?php
/**
 * Tests for the intent-log cancel lane: a cancel row dropping
 * still-queued intents in the same batch, the too-late contract, and
 * idempotence under redelivery.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpIntentLogCancel extends WP_UnitTestCase {
	/**
	 * Editor user ID.
	 *
	 * @var int
	 */
	protected static $editor_id;

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id = $factory->user->create( array( 'role' => 'editor' ) );
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::$editor_id );
	}

	private static function engine(): WP_Intent_Log_Engine {
		return new WP_Intent_Log_Engine( new WP_Sync_Table_Storage() );
	}

	/**
	 * Creates a post + room and returns [room, syncId of paragraph 0].
	 *
	 * @return array{string, string} Room and syncId.
	 */
	private function make_room(): array {
		$post_id = self::factory()->post->create(
			array( 'post_content' => "<!-- wp:paragraph -->\n<p>Hello world</p>\n<!-- /wp:paragraph -->" )
		);
		$room    = 'postType/post:' . $post_id;
		// First read initializes genesis.
		self::engine()->get_updates_since( $room, 101, 0, array() );
		return array( $room, WP_Intent_Log_Planner::genesis_sync_id( $post_id, 0, array( 0 ) ) );
	}

	private function intent_update( string $intent_id, string $sync_id ): array {
		return array(
			'type' => WP_Intent_Log_Engine::UPDATE_TYPE_INTENT,
			'data' => wp_json_encode(
				array(
					'intentId' => $intent_id,
					'baseSeq'  => 0,
					'type'     => 'insert_text',
					'payload'  => array(
						'syncId' => $sync_id,
						'field'  => 'content',
						'offset' => 11,
						'text'   => ' EDIT',
					),
				)
			),
		);
	}

	private function cancel_update( string $cancel_id, array $intent_ids ): array {
		return array(
			'type' => WP_Intent_Log_Engine::UPDATE_TYPE_CANCEL,
			'data' => wp_json_encode(
				array(
					'cancelId'  => $cancel_id,
					'intentIds' => $intent_ids,
				)
			),
		);
	}

	private function disposition_for( array $result, string $id ): ?array {
		foreach ( $result['dispositions'] as $disposition ) {
			if ( ( $disposition['intentId'] ?? null ) === $id ) {
				return $disposition;
			}
		}
		return null;
	}

	public function test_same_batch_cancel_drops_the_intent() {
		list( $room, $sync_id ) = $this->make_room();
		$engine                 = self::engine();

		$result = $engine->handle_updates(
			$room,
			201,
			0,
			array(
				$this->intent_update( 'i-1', $sync_id ),
				$this->cancel_update( 'cancel-i-1', array( 'i-1' ) ),
			),
			array()
		);

		$this->assertNotWPError( $result );
		$this->assertSame(
			array(
				'status' => 'voided',
				'reason' => 'canceled',
			),
			array_diff_key( $this->disposition_for( $result, 'i-1' ), array( 'intentId' => 1 ) )
		);
		$this->assertSame( 'applied', $this->disposition_for( $result, 'cancel-i-1' )['status'] );
		$this->assertStringNotContainsString( 'EDIT', (string) $engine->materialize( $room ), 'The canceled edit must never land.' );
	}

	public function test_cancel_after_ingestion_is_too_late() {
		list( $room, $sync_id ) = $this->make_room();
		$engine                 = self::engine();

		$result = $engine->handle_updates( $room, 202, 0, array( $this->intent_update( 'i-2', $sync_id ) ), array() );
		$this->assertSame( 'applied', $this->disposition_for( $result, 'i-2' )['status'] );

		$result      = $engine->handle_updates( $room, 202, 0, array( $this->cancel_update( 'cancel-i-2', array( 'i-2' ) ) ), array() );
		$disposition = $this->disposition_for( $result, 'cancel-i-2' );
		$this->assertSame( 'voided', $disposition['status'] );
		$this->assertSame( 'cancel-too-late', $disposition['reason'] );
		$this->assertStringContainsString( 'EDIT', (string) $engine->materialize( $room ), 'A too-late cancel must not disturb the applied edit.' );
	}

	public function test_redelivered_cancel_batch_is_idempotent() {
		list( $room, $sync_id ) = $this->make_room();
		$engine                 = self::engine();

		$batch = array(
			$this->intent_update( 'i-3', $sync_id ),
			$this->cancel_update( 'cancel-i-3', array( 'i-3' ) ),
		);
		$engine->handle_updates( $room, 203, 0, $batch, array() );

		// Redelivery (a 503-retry resend): same outcome, no double rows.
		$fresh  = self::engine();
		$result = $fresh->handle_updates( $room, 203, 0, $batch, array() );
		$this->assertSame( 'applied', $this->disposition_for( $result, 'cancel-i-3' )['status'], 'A redelivered confirmed cancel stays confirmed.' );
		$this->assertSame( 'voided', $this->disposition_for( $result, 'i-3' )['status'] );
		$this->assertStringNotContainsString( 'EDIT', (string) $fresh->materialize( $room ) );
	}

	public function test_late_arriving_copy_of_a_canceled_intent_is_dead() {
		list( $room, $sync_id ) = $this->make_room();
		$engine                 = self::engine();

		$engine->handle_updates( $room, 204, 0, array( $this->cancel_update( 'cancel-i-4', array( 'i-4' ) ) ), array() );

		// The canceled intent arrives on its own later (reordered relay):
		// its cancellation marker must keep it dead.
		$fresh  = self::engine();
		$result = $fresh->handle_updates( $room, 204, 0, array( $this->intent_update( 'i-4', $sync_id ) ), array() );
		$this->assertSame( 'voided', $this->disposition_for( $result, 'i-4' )['status'] );
		$this->assertStringNotContainsString( 'EDIT', (string) $fresh->materialize( $room ) );
	}
}
