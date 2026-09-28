<?php
/**
 * Tests for the intent-log base-seq machine-writer lane: a
 * wp_update_post() caller declares the seq it read, its save diffs into
 * typed intents through the engine, concurrent session work merges by
 * transform, collisions park for review, and the saved content becomes
 * the merged canonical.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpIntentLogBaseSeqPreflight extends WP_UnitTestCase {
	/**
	 * Editor user ID.
	 *
	 * @var int
	 */
	protected static $editor_id;

	const GENESIS_CONTENT = "<!-- wp:paragraph -->\n<p>Hello world</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Second graf</p>\n<!-- /wp:paragraph -->";

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id = $factory->user->create( array( 'role' => 'editor' ) );
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::$editor_id );
		WP_Intent_Log_Base_Seq_Preflight::register();
	}

	private static function engine(): WP_Intent_Log_Engine {
		return new WP_Intent_Log_Engine( new WP_Sync_Table_Storage() );
	}

	/**
	 * Creates a post + room; returns [post_id, room, [syncId0, syncId1]].
	 *
	 * @return array{int, string, array{string, string}} Fixture.
	 */
	private function make_room(): array {
		$post_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
		$room    = 'postType/post:' . $post_id;
		self::engine()->get_updates_since( $room, 101, 0, array() );
		return array(
			$post_id,
			$room,
			array(
				WP_Intent_Log_Planner::genesis_sync_id( $post_id, 0, array( 0 ) ),
				WP_Intent_Log_Planner::genesis_sync_id( $post_id, 0, array( 1 ) ),
			),
		);
	}

	private function session_intent( string $room, string $intent_id, string $type, array $payload ): void {
		$result = self::engine()->handle_updates(
			$room,
			301,
			0,
			array(
				array(
					'type' => WP_Intent_Log_Engine::UPDATE_TYPE_INTENT,
					'data' => wp_json_encode(
						array(
							'intentId' => $intent_id,
							'baseSeq'  => 0,
							'type'     => $type,
							'payload'  => $payload,
						)
					),
				),
			),
			array()
		);
		$this->assertNotWPError( $result );
	}

	/**
	 * Content the machine writer produces: a round-trip of genesis with
	 * syncId metadata carried, with substitutions applied.
	 *
	 * @param array  $ids  Genesis syncIds.
	 * @param string $from Text to replace.
	 * @param string $to   Replacement.
	 * @return string Writer content.
	 */
	private function writer_content( array $ids, string $from, string $to ): string {
		$content = sprintf(
			"<!-- wp:paragraph {\"metadata\":{\"syncId\":\"%s\"}} -->\n<p>Hello world</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph {\"metadata\":{\"syncId\":\"%s\"}} -->\n<p>Second graf</p>\n<!-- /wp:paragraph -->",
			$ids[0],
			$ids[1]
		);
		return str_replace( $from, $to, $content );
	}

	public function test_cooperating_writer_merges_with_concurrent_session_work() {
		list( $post_id, $room, $ids ) = $this->make_room();

		// The session edits paragraph 1 after the writer's read (seq 0).
		$this->session_intent(
			$room,
			'i-session',
			'insert_text',
			array(
				'syncId' => $ids[0],
				'field'  => 'content',
				'offset' => 11,
				'text'   => ' from the session',
			)
		);

		// The writer edits paragraph 2 against seq 0.
		$updated = wp_update_post(
			array(
				'ID'                  => $post_id,
				'post_content'        => $this->writer_content( $ids, 'Second graf', 'Second graf, updated by the integration' ),
				'intent_log_base_seq' => 0,
			),
			true
		);
		$this->assertNotWPError( $updated );

		$saved = get_post( $post_id )->post_content;
		$this->assertStringContainsString( 'Hello world from the session', $saved, 'The session edit must survive the machine save.' );
		$this->assertStringContainsString( 'updated by the integration', $saved, 'The writer edit must land.' );
		// Serialized attrs unicode-escape `--` (serialize_block_attributes),
		// and base64url syncIds occasionally contain `--` — compare the
		// escaped form so the assertion is not id-dependent.
		$this->assertStringContainsString( str_replace( '--', '\\u002d\\u002d', $ids[0] ), $saved, 'The merged save carries block identity.' );

		// The room converged to the same state (the writer merged THROUGH it).
		$canonical = self::engine()->materialize( $room );
		$this->assertStringContainsString( 'Hello world from the session', $canonical );
		$this->assertStringContainsString( 'updated by the integration', $canonical );
	}

	public function test_register_collision_parks_for_review_and_save_succeeds() {
		list( $post_id, $room, $ids ) = $this->make_room();

		// The session restyles paragraph 1 (register version advances).
		$this->session_intent(
			$room,
			'i-align',
			'set_attr',
			array(
				'syncId'          => $ids[0],
				'key'             => 'align',
				'value'           => 'wide',
				'observedVersion' => 0,
			)
		);

		// The writer restyles the SAME register from the old base.
		$writer  = str_replace(
			sprintf( '{"metadata":{"syncId":"%s"}}', $ids[0] ),
			sprintf( '{"align":"left","metadata":{"syncId":"%s"}}', $ids[0] ),
			$this->writer_content( $ids, 'unused', 'unused' )
		);
		$updated = wp_update_post(
			array(
				'ID'                  => $post_id,
				'post_content'        => $writer,
				'intent_log_base_seq' => 0,
			),
			true
		);
		$this->assertNotWPError( $updated, 'Intent-log never rejects on conflict: clean intents land, contested ones park.' );

		$dispositions = WP_Intent_Log_Base_Seq_Preflight::last_dispositions();
		$escalated    = array_filter(
			(array) $dispositions,
			static function ( $disposition ) {
				return 'escalated' === ( $disposition['status'] ?? null );
			}
		);
		$this->assertNotEmpty( $escalated, 'The register collision must surface, not overwrite.' );

		// Canonical (and the saved post) keep the session's value.
		$this->assertStringContainsString( '"align":"wide"', get_post( $post_id )->post_content );
	}

	public function test_writer_can_append_a_new_block() {
		list( $post_id, $room, $ids ) = $this->make_room();
		$this->assertNotEmpty( $room );

		$appended = $this->writer_content( $ids, 'unused', 'unused' )
			. "\n\n<!-- wp:paragraph -->\n<p>Appended by the integration</p>\n<!-- /wp:paragraph -->";
		$updated  = wp_update_post(
			array(
				'ID'                  => $post_id,
				'post_content'        => $appended,
				'intent_log_base_seq' => 0,
			),
			true
		);
		$this->assertNotWPError( $updated );
		$this->assertStringContainsString( 'Appended by the integration', get_post( $post_id )->post_content );
	}

	public function test_stale_base_seq_rejects_the_save() {
		list( $post_id, $room, $ids ) = $this->make_room();
		$this->assertNotEmpty( $room );

		$before  = get_post( $post_id )->post_content;
		$updated = wp_update_post(
			array(
				'ID'                  => $post_id,
				'post_content'        => $this->writer_content( $ids, 'Second graf', 'Never lands' ),
				'intent_log_base_seq' => 99,
			),
			true
		);

		$this->assertWPError( $updated );
		$this->assertSame( 'intent_log_base_seq_stale', WP_Intent_Log_Base_Seq_Preflight::last_error()->get_error_code() );
		$this->assertSame( $before, get_post( $post_id )->post_content, 'A rejected save must not touch the post.' );
	}

	public function test_roomless_post_rejects_base_seq_saves() {
		$post_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);

		$updated = wp_update_post(
			array(
				'ID'                  => $post_id,
				'post_content'        => self::GENESIS_CONTENT,
				'intent_log_base_seq' => 0,
			),
			true
		);

		$this->assertWPError( $updated );
		$this->assertSame( 'intent_log_base_seq_no_room', WP_Intent_Log_Base_Seq_Preflight::last_error()->get_error_code() );
	}
}
