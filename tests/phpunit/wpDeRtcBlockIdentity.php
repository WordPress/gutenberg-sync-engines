<?php
/**
 * Durable block identity (syncId) under the DE-RTC engine: deterministic
 * genesis stamping, creation stamping for engine-unaware writers, and
 * identity adoption at ingest.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpDeRtcBlockIdentity extends WP_UnitTestCase {
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

	const NESTED_CONTENT = "<!-- wp:group {\"layout\":{\"type\":\"constrained\"}} -->\n<div class=\"wp-block-group\"><!-- wp:paragraph -->\n<p>Inner one.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:image {\"id\":7,\"sizeSlug\":\"large\",\"url\":\"https://example.com/a.png\"} -->\n<figure class=\"wp-block-image size-large\"><img src=\"https://example.com/a.png\" alt=\"\"/></figure>\n<!-- /wp:image --></div>\n<!-- /wp:group -->\n\n<!-- wp:separator /-->\n\n<!-- wp:paragraph {\"metadata\":{\"name\":\"Hero\"}} -->\n<p>Named.</p>\n<!-- /wp:paragraph -->";

	const GENESIS_CONTENT = "<!-- wp:paragraph -->\n<p>Alpha block original text.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Beta block original text.</p>\n<!-- /wp:paragraph -->";

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id = $factory->user->create( array( 'role' => 'editor' ) );
		self::$post_id   = $factory->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_title'   => 'DE-RTC identity post',
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
	 * Strips every stamped id, so a stamped document can be compared
	 * byte-for-byte against its unstamped source.
	 *
	 * @param string $content Stamped content.
	 * @return string Unstamped content.
	 */
	private static function unstamp( string $content ): string {
		$content = preg_replace( '/ \{"metadata":\{"syncId":"[^"]*"\}\}/', '', $content );
		$content = preg_replace( '/,"metadata":\{"syncId":"[^"]*"\}/', '', $content );
		return preg_replace( '/,"syncId":"[^"]*"/', '', $content );
	}

	/**
	 * Syncs ids of a content string, by path key.
	 *
	 * @param string $content Content.
	 * @return array<string, string|null> path => syncId.
	 */
	private static function ids_by_path( string $content ): array {
		$ids = array();
		foreach ( WP_De_RTC_Block_Identity::collect( $content ) as $block ) {
			$ids[ implode( '.', $block['path'] ) ] = $block['syncId'];
		}
		return $ids;
	}

	public function test_genesis_stamps_every_block_at_every_depth_deterministically() {
		$stamped = WP_De_RTC_Block_Identity::stamp_genesis( self::NESTED_CONTENT, 42 );

		$ids = self::ids_by_path( $stamped );
		$this->assertSame( array( '0', '0.0', '0.1', '1', '2' ), array_map( 'strval', array_keys( $ids ) ), 'Every named block, at every depth, is listed in pre-order.' );
		foreach ( $ids as $path => $sync_id ) {
			$expected = WP_Intent_Log_Planner::genesis_sync_id( 42, 0, array_map( 'intval', explode( '.', $path ) ) );
			$this->assertSame( $expected, $sync_id, "Block at path {$path} carries the intent-log genesis id (the editor stamper's function)." );
		}

		// A textual splice: nothing but the ids changed (slashes in the
		// image URL, whitespace, attribute order all survive).
		$this->assertSame( self::NESTED_CONTENT, self::unstamp( $stamped ) );
		$this->assertStringContainsString( '"url":"https://example.com/a.png","metadata":{"syncId":"', $stamped, 'metadata is appended LAST, where the editor serializes it.' );
		$this->assertStringContainsString( '<!-- wp:separator {"metadata":{"syncId":"', $stamped, 'A void block with no attributes gains an attribute object.' );

		// Stamping is idempotent and never re-mints an existing id.
		$this->assertSame( $stamped, WP_De_RTC_Block_Identity::stamp_genesis( $stamped, 42 ) );
		$this->assertSame( $stamped, WP_De_RTC_Block_Identity::stamp_creations( $stamped ) );
		$this->assertFalse( WP_De_RTC_Block_Identity::needs_stamping( $stamped ) );
	}

	public function test_stamped_content_still_satisfies_the_merge_core_round_trip() {
		$stamped = WP_De_RTC_Block_Identity::stamp_genesis( self::GENESIS_CONTENT, 42 );
		$records = wp_de_rtc_get_top_level_serialized_block_records( $stamped );
		$this->assertIsArray( $records, 'The merge core re-serializes the stamped delimiter to the same bytes.' );
		$this->assertCount( 2, $records );

		$parsed = parse_blocks( $stamped );
		$this->assertSame( WP_Intent_Log_Planner::genesis_sync_id( 42, 0, array( 1 ) ), $parsed[2]['attrs']['metadata']['syncId'] );
	}

	public function test_existing_metadata_gains_an_id_without_losing_its_keys() {
		$stamped = WP_De_RTC_Block_Identity::stamp_genesis( self::NESTED_CONTENT, 42 );
		$named   = WP_De_RTC_Block_Identity::collect( $stamped )[4];
		$this->assertSame( 'Hero', $named['attrs']['metadata']['name'] );
		$this->assertSame( WP_Intent_Log_Planner::genesis_sync_id( 42, 0, array( 2 ) ), $named['attrs']['metadata']['syncId'] );
	}

	public function test_duplicate_ids_are_reminted_keeping_the_first_holder() {
		$stamped   = WP_De_RTC_Block_Identity::stamp_genesis( self::GENESIS_CONTENT, 42 );
		$alpha_id  = self::ids_by_path( $stamped )['0'];
		$duplicate = str_replace( self::ids_by_path( $stamped )['1'], $alpha_id, $stamped );
		$this->assertTrue( WP_De_RTC_Block_Identity::needs_stamping( $duplicate ) );

		$reminted = WP_De_RTC_Block_Identity::stamp_creations( $duplicate );
		$ids      = self::ids_by_path( $reminted );
		$this->assertSame( $alpha_id, $ids['0'], 'The first holder keeps the identity.' );
		$this->assertNotSame( $alpha_id, $ids['1'] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f-]{36}$/', $ids['1'], 'The copy is a creation: a random id.' );
	}

	public function test_delimiter_unsafe_ids_are_escaped_like_the_serializer_does() {
		$stamped = WP_De_RTC_Block_Identity::stamp(
			self::GENESIS_CONTENT,
			static function ( array $path ): string {
				return 'ab--cd' . $path[0];
			}
		);
		$this->assertStringNotContainsString( 'ab--cd', $stamped, 'A double dash would end the HTML comment.' );
		$this->assertStringContainsString( 'ab\\u002d\\u002dcd0', $stamped, 'Escaped the way serialize_block_attributes() escapes.' );
		$this->assertSame(
			array(
				'0' => 'ab--cd0',
				'1' => 'ab--cd1',
			),
			self::ids_by_path( $stamped )
		);
		$this->assertIsArray( wp_de_rtc_get_top_level_serialized_block_records( $stamped ) );
	}

	public function test_classic_content_occupies_a_path_index_like_the_editor() {
		$content = "Classic text before any block.\n\n" . self::GENESIS_CONTENT;
		$stamped = WP_De_RTC_Block_Identity::stamp_genesis( $content, 42 );
		$this->assertSame(
			array(
				'1' => WP_Intent_Log_Planner::genesis_sync_id( 42, 0, array( 1 ) ),
				'2' => WP_Intent_Log_Planner::genesis_sync_id( 42, 0, array( 2 ) ),
			),
			self::ids_by_path( $stamped )
		);
		$this->assertStringStartsWith( 'Classic text before any block.', $stamped );
	}

	public function test_adopt_carries_base_identity_onto_an_unaware_copy_by_path() {
		$base = WP_De_RTC_Block_Identity::stamp_genesis( self::NESTED_CONTENT, 42 );
		$edit = str_replace( 'Inner one.', 'Inner one, edited by a script.', self::NESTED_CONTENT ) . "\n\n<!-- wp:paragraph -->\n<p>Appended by the script.</p>\n<!-- /wp:paragraph -->";

		$adopted = WP_De_RTC_Block_Identity::adopt( $edit, $base );
		$ids     = self::ids_by_path( $adopted );
		$base_id = self::ids_by_path( $base );
		foreach ( array( '0', '0.0', '0.1', '1', '2' ) as $path ) {
			$this->assertSame( $base_id[ $path ], $ids[ $path ], "Path {$path} adopts the base identity." );
		}
		$this->assertNull( $ids['3'], 'A block the base never had stays for creation stamping.' );
		$this->assertStringContainsString( 'Inner one, edited by a script.', $adopted );

		// Adoption never duplicates: an id the copy already carries
		// elsewhere is not handed out a second time, and a name mismatch
		// at a path is not an adoption.
		$moved = '<!-- wp:paragraph {"metadata":{"syncId":"' . $base_id['1'] . "\"}} -->\n<p>Moved.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:heading -->\n<h2>Was a separator</h2>\n<!-- /wp:heading -->";
		$ids   = self::ids_by_path( WP_De_RTC_Block_Identity::adopt( $moved, $base ) );
		$this->assertSame( $base_id['1'], $ids['0'] );
		$this->assertNull( $ids['1'] );

		// A copy that already carries identity is returned unchanged.
		$this->assertSame( $base, WP_De_RTC_Block_Identity::adopt( $base, $base ) );
	}

	public function test_room_genesis_carries_deterministic_identity_and_is_not_mistaken_for_external_work() {
		$response = $this->engine()->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = json_decode( $response['updates'][0]['data'], true );

		$expected = WP_De_RTC_Block_Identity::stamp_genesis( self::GENESIS_CONTENT, self::$post_id );
		$this->assertNotSame( self::GENESIS_CONTENT, $expected );
		$this->assertSame( $expected, $genesis['content'], 'The genesis snapshot stamps every block.' );
		$this->assertSame( $expected, $this->engine()->materialize( $this->room() ) );

		// A fresh room load (a save request's cold engine) must not read
		// the still-unstamped post_content as an outside change and heal
		// it in as a new version.
		$again = $this->engine()->get_updates_since( $this->room(), 2, 0, array() );
		$types = array_column( $again['updates'], 'type' );
		$this->assertNotContains( WP_De_RTC_Engine::UPDATE_TYPE_ANNOUNCE, $types, 'No healed version was announced.' );
		$this->assertSame( $expected, $this->engine()->materialize( $this->room() ) );
	}

	public function test_an_unaware_writer_keeps_identity_and_its_new_block_is_stamped() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = json_decode( $response['updates'][0]['data'], true );
		$base_ids = self::ids_by_path( $genesis['content'] );

		// A script read post_content (no ids), edited Beta, appended a block,
		// and saved with base_version v1 (descriptor-less, like the
		// preflight lane).
		$proposed = str_replace( 'Beta block original text.', 'Beta rewritten by a script.', self::GENESIS_CONTENT )
			. "\n\n<!-- wp:paragraph -->\n<p>Appended by a script.</p>\n<!-- /wp:paragraph -->";
		$result   = $engine->handle_updates(
			$this->room(),
			WP_De_RTC_Base_Version_Preflight::WRITER_CLIENT_ID,
			0,
			array(
				array(
					'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
					'data' => wp_json_encode(
						array(
							'proposalId'      => 'p-script',
							'baseVersion'     => 'v1',
							'proposedContent' => $proposed,
							'clientUpdate'    => null,
						)
					),
				),
			),
			array()
		);
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$canonical = $this->engine()->materialize( $this->room() );
		$ids       = self::ids_by_path( $canonical );
		$this->assertSame( $base_ids['0'], $ids['0'], 'The untouched block keeps its identity.' );
		$this->assertSame( $base_ids['1'], $ids['1'], 'The edited block keeps its identity.' );
		$this->assertMatchesRegularExpression( '/^[0-9a-f-]{36}$/', (string) $ids['2'], 'The new block is stamped as it becomes canonical.' );
		$this->assertStringContainsString( 'Beta rewritten by a script.', $canonical );
	}

	public function test_a_session_proposal_is_never_second_guessed() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = json_decode( $response['updates'][0]['data'], true );

		// A session stamps in the editor. Should a proposal ever beat the
		// stamper, the id-less block lands as sent: the editor's id will
		// follow on the next commit, and a server id here would collide
		// with it.
		$proposed = $genesis['content'] . "\n\n<!-- wp:paragraph -->\n<p>Beat the stamper.</p>\n<!-- /wp:paragraph -->";
		$result   = $engine->handle_updates(
			$this->room(),
			1,
			0,
			array(
				array(
					'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
					'data' => wp_json_encode(
						array(
							'proposalId'      => 'p-session',
							'baseVersion'     => $genesis['version'],
							'proposedContent' => $proposed,
							'clientUpdate'    => wp_de_rtc_create_automerge_update_for_content_change( $genesis['content'], $proposed, 'session' ),
						)
					),
				),
			),
			array()
		);
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$ids = self::ids_by_path( $this->engine()->materialize( $this->room() ) );
		$this->assertNotNull( $ids['0'] );
		$this->assertNull( $ids['2'], 'The session keeps authority over its own identities.' );
	}
}
