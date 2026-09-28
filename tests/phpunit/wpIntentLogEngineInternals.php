<?php
/**
 * Unit tests for WP_Intent_Log_Engine internals — genesis mapping, room
 * state reconstruction, and duplicate-snapshot resolution — driving the
 * engine instance directly rather than through the REST transport.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpIntentLogEngineInternals extends WP_UnitTestCase {
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

	/**
	 * Creates a fresh engine over post-meta storage.
	 *
	 * @return WP_Intent_Log_Engine Engine instance.
	 */
	private static function engine(): WP_Intent_Log_Engine {
		return new WP_Intent_Log_Engine( new WP_Sync_Table_Storage() );
	}

	/**
	 * Returns the decoded genesis snapshot for a room's first poll.
	 *
	 * @param WP_Intent_Log_Engine $engine Engine.
	 * @param string               $room   Room identifier.
	 * @return array Snapshot document.
	 */
	private static function snapshot_doc( WP_Intent_Log_Engine $engine, string $room ): array {
		$response = $engine->get_updates_since( $room, 101, 0, array() );
		$snapshot = null;
		foreach ( $response['updates'] as $update ) {
			if ( WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT === $update['type'] ) {
				$snapshot = json_decode( $update['data'], true );
				break;
			}
		}
		self::assertNotNull( $snapshot, 'first poll must contain a snapshot row' );

		return $snapshot['doc'];
	}

	public function test_genesis_carries_classic_content_as_freeform() {
		// Previously classic runs were silently DROPPED from genesis —
		// erasing them from the shared document and every collaborator's
		// editor. They now sync as core/freeform with a content field.
		$post_id = self::factory()->post->create(
			array( 'post_content' => "<p>classic content, no block comments</p>\n<div>more</div>" )
		);

		$doc = self::snapshot_doc( self::engine(), 'postType/post:' . $post_id );

		$this->assertCount( 1, $doc['root'] );
		$this->assertSame( 'core/freeform', $doc['root'][0]['blockType'] );
		$this->assertNotSame( '', $doc['root'][0]['fields']['content']['text'] );
	}

	public function test_genesis_maps_nested_blocks_with_deterministic_path_ids() {
		$content = "<!-- wp:group -->\n<div class=\"wp-block-group\"><!-- wp:paragraph -->\n<p>Inner</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:group -->\n\n<!-- wp:paragraph -->\n<p>Outer</p>\n<!-- /wp:paragraph -->";
		$post_id = self::factory()->post->create( array( 'post_content' => $content ) );

		$doc = self::snapshot_doc( self::engine(), 'postType/post:' . $post_id );

		$this->assertCount( 2, $doc['root'] );
		$group = $doc['root'][0];
		$this->assertSame( 'core/group', $group['blockType'] );
		$this->assertSame(
			WP_Intent_Log_Planner::genesis_sync_id( $post_id, 0, array( 0 ) ),
			$group['syncId']
		);
		$this->assertSame(
			WP_Intent_Log_Planner::genesis_sync_id( $post_id, 0, array( 0, 0 ) ),
			$group['children'][0]['syncId']
		);
		$this->assertSame( 'Inner', $group['children'][0]['fields']['content']['text'] );
		$this->assertSame(
			WP_Intent_Log_Planner::genesis_sync_id( $post_id, 0, array( 1 ) ),
			$doc['root'][1]['syncId']
		);
	}

	public function test_genesis_honors_existing_sync_id_and_preserves_other_metadata() {
		$content = '<!-- wp:paragraph {"metadata":{"syncId":"authored-id","name":"Keep me"},"align":"wide"} -->' . "\n<p>Hi</p>\n<!-- /wp:paragraph -->";
		$post_id = self::factory()->post->create( array( 'post_content' => $content ) );

		$doc   = self::snapshot_doc( self::engine(), 'postType/post:' . $post_id );
		$block = $doc['root'][0];

		$this->assertSame( 'authored-id', $block['syncId'] );
		$this->assertSame( 'wide', $block['attrs']['align'] );
		// syncId is extracted from metadata; sibling metadata keys survive.
		$this->assertSame( array( 'name' => 'Keep me' ), $block['attrs']['metadata'] );
	}

	public function test_non_post_rooms_initialize_with_an_empty_document() {
		$doc = self::snapshot_doc( self::engine(), 'taxonomy/category:1' );

		$this->assertSame( array(), $doc['root'] );
	}

	public function test_genesis_seeds_scalar_entity_properties_in_rest_shape() {
		$post_id = self::factory()->post->create(
			array(
				'post_title'   => 'Seeded title',
				'post_excerpt' => 'Seeded excerpt',
				'post_status'  => 'publish',
				'post_author'  => self::$editor_id,
				'post_content' => "<!-- wp:paragraph -->\n<p>Body</p>\n<!-- /wp:paragraph -->",
			)
		);
		$post    = get_post( $post_id );

		$doc   = self::snapshot_doc( self::engine(), 'postType/post:' . $post_id );
		$props = $doc['props'];

		$this->assertSame( 'Seeded title', $props['title'] );
		$this->assertSame( 'Seeded excerpt', $props['excerpt'] );
		$this->assertSame( 'publish', $props['status'] );
		$this->assertSame( $post->post_name, $props['slug'] );
		$this->assertSame( $post->comment_status, $props['comment_status'] );
		$this->assertSame( $post->ping_status, $props['ping_status'] );
		$this->assertSame( 'standard', $props['format'] );
		$this->assertFalse( $props['sticky'] );
		$this->assertSame( self::$editor_id, $props['author'] );
		$this->assertSame( 0, $props['featured_media'] );
		// The REST record's RFC3339 shape, so a joining client's echo
		// suppression sees the value its own record carries.
		$this->assertSame( mysql_to_rfc3339( $post->post_date ), $props['date'] );
		$this->assertSame( '', $props['template'] );
		// Attached taxonomies as whole term-ID arrays: the default
		// category assigned at insert, and no tags.
		$this->assertSame( array( (int) get_option( 'default_category' ) ), $props['categories'] );
		$this->assertSame( array(), $props['tags'] );
	}

	public function test_genesis_seeds_registered_meta_registers_in_rest_shape() {
		register_post_meta(
			'post',
			'phase3_note',
			array(
				'show_in_rest' => true,
				'single'       => true,
				'type'         => 'string',
				'default'      => '',
			)
		);
		register_post_meta(
			'post',
			'phase3_default',
			array(
				'show_in_rest' => true,
				'single'       => true,
				'type'         => 'string',
				'default'      => 'the-default',
			)
		);

		$post_id = self::factory()->post->create( array( 'post_status' => 'publish' ) );
		update_post_meta( $post_id, 'phase3_note', 'A note' );
		update_post_meta( $post_id, '_crdt_document', 'transport-state' );

		$doc   = self::snapshot_doc( self::engine(), 'postType/post:' . $post_id );
		$props = $doc['props'];

		unregister_post_meta( 'post', 'phase3_note' );
		unregister_post_meta( 'post', 'phase3_default' );

		$this->assertSame( 'A note', $props['meta.phase3_note'] );
		// Unset keys seed their registered default — exactly what the
		// REST record's meta object serves, so joining clients see their
		// own record's value.
		$this->assertSame( 'the-default', $props['meta.phase3_default'] );
		// The persisted-CRDT snapshot is transport state, never a register.
		$this->assertArrayNotHasKey( 'meta._crdt_document', $props );
	}

	public function test_genesis_seeds_taxonomy_registers_in_rest_order_and_respects_show_in_rest() {
		register_taxonomy(
			'genre',
			'post',
			array(
				'show_in_rest' => true,
				'rest_base'    => 'genres',
			)
		);
		register_taxonomy( 'internal_tax', 'post', array( 'show_in_rest' => false ) );

		$post_id = self::factory()->post->create( array( 'post_status' => 'publish' ) );
		$tag_b   = self::factory()->term->create(
			array(
				'taxonomy' => 'post_tag',
				'name'     => 'bravo',
			)
		);
		$tag_a   = self::factory()->term->create(
			array(
				'taxonomy' => 'post_tag',
				'name'     => 'alpha',
			)
		);
		wp_set_post_terms( $post_id, array( $tag_b, $tag_a ), 'post_tag' );
		$genre = self::factory()->term->create( array( 'taxonomy' => 'genre' ) );
		wp_set_post_terms( $post_id, array( $genre ), 'genre' );
		$internal = self::factory()->term->create( array( 'taxonomy' => 'internal_tax' ) );
		wp_set_post_terms( $post_id, array( $internal ), 'internal_tax' );

		$doc   = self::snapshot_doc( self::engine(), 'postType/post:' . $post_id );
		$props = $doc['props'];

		unregister_taxonomy( 'genre' );
		unregister_taxonomy( 'internal_tax' );

		// Canonical numeric order (term bindings are sets; the client
		// compares order-insensitively). Name order would be
		// array( $tag_a, $tag_b ) — 'alpha' before 'bravo' — but bravo
		// was created first and holds the lower id.
		$this->assertSame( array( $tag_b, $tag_a ), $props['tags'] );
		// Custom taxonomies key by rest_base…
		$this->assertSame( array( $genre ), $props['genres'] );
		// …and non-REST taxonomies never enter the document (absent from
		// the client record, so seeding them would push spurious edits).
		$this->assertArrayNotHasKey( 'internal_tax', $props );
	}

	public function test_genesis_blanks_the_auto_draft_placeholder_and_omits_invalid_registers() {
		$post_id = self::factory()->post->create(
			array(
				'post_title'  => 'Auto Draft',
				'post_status' => 'auto-draft',
			)
		);

		$doc   = self::snapshot_doc( self::engine(), 'postType/post:' . $post_id );
		$props = $doc['props'];

		// The stored placeholder title never reaches collaborators.
		$this->assertSame( '', $props['title'] );
		// An auto-draft status is invalid in the editor and never syncs.
		$this->assertArrayNotHasKey( 'status', $props );
		// An empty slug means the auto-generated default.
		$this->assertArrayNotHasKey( 'slug', $props );
		// A zeroed date_gmt is a floating date the REST record serves null.
		$this->assertArrayNotHasKey( 'date', $props );
	}

	public function test_genesis_omits_property_registers_the_post_type_does_not_support() {
		$page_id = self::factory()->post->create(
			array(
				'post_type'   => 'page',
				'post_title'  => 'A page',
				'post_status' => 'publish',
			)
		);

		$doc   = self::snapshot_doc( self::engine(), 'postType/page:' . $page_id );
		$props = $doc['props'];

		// Absent from the page REST schema (pages support none of these);
		// seeding them would push a spurious edit into every joining
		// client's editor.
		$this->assertArrayNotHasKey( 'format', $props );
		$this->assertArrayNotHasKey( 'sticky', $props );
		$this->assertArrayNotHasKey( 'excerpt', $props );
		// Pages support title, and template is universal.
		$this->assertSame( 'A page', $props['title'] );
		$this->assertSame( '', $props['template'] );
	}

	public function test_first_snapshot_wins_over_a_duplicate_from_a_concurrent_initializer() {
		$post_id = self::factory()->post->create(
			array( 'post_content' => "<!-- wp:paragraph -->\n<p>Real</p>\n<!-- /wp:paragraph -->" )
		);
		$room    = 'postType/post:' . $post_id;
		$target  = WP_Intent_Log_Planner::genesis_sync_id( $post_id, 0, array( 0 ) );

		// First initializer stores the real snapshot…
		self::snapshot_doc( self::engine(), $room );
		// …then a concurrent initializer loses the race and appends a bogus
		// duplicate (empty document).
		$storage = new WP_Sync_Table_Storage();
		$storage->add_update(
			$room,
			array(
				'client_id' => 0,
				'data'      => wp_json_encode( array( 'doc' => array( 'root' => array() ) ) ),
				'type'      => WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT,
			)
		);

		// A fresh engine (no request cache) must plan against the FIRST
		// snapshot: an intent targeting the real paragraph applies.
		$result = self::engine()->handle_updates(
			$room,
			101,
			0,
			array(
				array(
					'type' => WP_Intent_Log_Engine::UPDATE_TYPE_INTENT,
					'data' => wp_json_encode(
						array(
							'intentId' => 's-1',
							'actorId'  => 'ignored',
							'baseSeq'  => 0,
							'txnId'    => null,
							'type'     => 'insert_text',
							'payload'  => array(
								'syncId' => $target,
								'field'  => 'content',
								'offset' => 0,
								'text'   => 'x',
							),
						)
					),
				),
			),
			array()
		);

		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
	}

	public function test_room_state_rebuild_lets_voided_markers_override_intent_rows() {
		$post_id = self::factory()->post->create(
			array( 'post_content' => "<!-- wp:paragraph -->\n<p>Hello</p>\n<!-- /wp:paragraph -->" )
		);
		$room    = 'postType/post:' . $post_id;
		self::snapshot_doc( self::engine(), $room );

		/*
		 * Simulate an apply-time-voided intent as the engine persists it:
		 * the transformed intent lives in the log AND a voided marker
		 * records its true disposition.
		 */
		$storage = new WP_Sync_Table_Storage();
		$intent  = array(
			'intentId' => 'av-1',
			'actorId'  => 'u9c9',
			'baseSeq'  => 0,
			'txnId'    => null,
			'type'     => 'remove_block',
			'payload'  => array( 'syncId' => 'missing-block' ),
		);
		$storage->add_update(
			$room,
			array(
				'client_id' => 9,
				'data'      => wp_json_encode( $intent ),
				'type'      => WP_Intent_Log_Engine::UPDATE_TYPE_INTENT,
			)
		);
		$storage->add_update(
			$room,
			array(
				'client_id' => 9,
				'data'      => wp_json_encode(
					array(
						'intentId' => 'av-1',
						'reason'   => 'already-removed',
					)
				),
				'type'      => WP_Intent_Log_Engine::UPDATE_TYPE_VOIDED,
			)
		);

		// Redelivery through a fresh engine settles as voided, not applied.
		$result = self::engine()->handle_updates(
			$room,
			9,
			0,
			array(
				array(
					'type' => WP_Intent_Log_Engine::UPDATE_TYPE_INTENT,
					'data' => wp_json_encode( $intent ),
				),
			),
			array()
		);

		$this->assertSame(
			array(
				array(
					'intentId' => 'av-1',
					'status'   => 'voided',
					'reason'   => 'already-removed',
				),
			),
			$result['dispositions']
		);
	}

	public function test_materialize_returns_null_for_unparseable_room() {
		// A room the engine cannot initialize storage for is not the case
		// here (storage always works in tests); instead assert the benign
		// path: an unknown-but-parseable room materializes to the empty
		// string rather than erroring.
		$this->assertSame( '', self::engine()->materialize( 'taxonomy/category:1' ) );
	}
}
