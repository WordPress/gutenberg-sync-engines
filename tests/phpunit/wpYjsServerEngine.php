<?php
/**
 * Engine-level tests for the server-authoritative Yjs sync engine
 * (WP_Yjs_Server_Engine), driving the production WP_Sync_Engine seam
 * against the table storage with real y-php documents on both sides.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpYjsServerEngine extends WP_UnitTestCase {
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

	/**
	 * Author user ID (lacks unfiltered_html).
	 *
	 * @var int
	 */
	protected static $author_id;

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id = $factory->user->create( array( 'role' => 'editor' ) );
		self::$author_id = $factory->user->create( array( 'role' => 'author' ) );
		self::$post_id   = $factory->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_title'   => 'Yjs server test post',
				'post_content' => "<!-- wp:paragraph {\"align\":\"wide\"} -->\n<p>Hello world</p>\n<!-- /wp:paragraph -->",
			)
		);
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
		self::delete_user( self::$author_id );
		wp_delete_post( self::$post_id, true );
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::$editor_id );
	}

	private function room(): string {
		return 'postType/post:' . self::$post_id;
	}

	/**
	 * A fresh engine over a fresh storage instance — the per-request state
	 * boundary. Sharing the DB while resetting in-memory caches mimics
	 * separate HTTP requests.
	 *
	 * @return WP_Yjs_Server_Engine Engine.
	 */
	private function engine(): WP_Yjs_Server_Engine {
		return new WP_Yjs_Server_Engine( new WP_Sync_Table_Storage() );
	}

	/**
	 * Builds a client-side y-php doc from a room response (applies snapshot
	 * and update rows in order).
	 *
	 * @param array $response Room response from get_updates_since().
	 * @return \Yjs\Utils\Doc Client document.
	 */
	private function client_doc_from_response( array $response ): \Yjs\Utils\Doc {
		$doc = new \Yjs\Utils\Doc();
		$this->apply_response( $doc, $response );
		return $doc;
	}

	/**
	 * Applies a room response's rows to a client doc.
	 *
	 * @param \Yjs\Utils\Doc $doc      Client document.
	 * @param array          $response Room response.
	 */
	private function apply_response( \Yjs\Utils\Doc $doc, array $response ): void {
		foreach ( $response['updates'] as $update ) {
			if ( WP_Yjs_Server_Engine::UPDATE_TYPE_SNAPSHOT === $update['type'] ) {
				$decoded = json_decode( $update['data'], true );
				\Yjs\applyUpdateV2( $doc, \Yjs\Lib0\Buffer::fromBase64( $decoded['doc'] ) );
			} else {
				\Yjs\applyUpdateV2( $doc, \Yjs\Lib0\Buffer::fromBase64( $update['data'] ) );
			}
		}
	}

	/**
	 * The content Y.Text of the first block in a client doc.
	 *
	 * @param \Yjs\Utils\Doc $doc Client document.
	 * @return \Yjs\Types\YText Content text.
	 */
	private function first_block_content( \Yjs\Utils\Doc $doc ): \Yjs\Types\YText {
		return $doc->getMap( 'document' )->get( 'blocks' )->get( 0 )->get( 'attributes' )->get( 'content' );
	}

	/**
	 * Encodes a client edit as the incremental V2 update a real client
	 * sends: everything past the pre-edit state vector.
	 *
	 * @param \Yjs\Utils\Doc $doc  Client document.
	 * @param callable       $edit Edit to perform on the doc.
	 * @return string Base64 V2 update.
	 */
	private function encode_edit( \Yjs\Utils\Doc $doc, callable $edit ): string {
		$sv_before = \Yjs\encodeStateVector( $doc );
		$edit( $doc );
		return \Yjs\encodeStateAsUpdateV2( $doc, $sv_before )->toBase64();
	}

	public function test_identity() {
		$engine = $this->engine();
		$this->assertSame( 'yjs-server', $engine->get_slug() );
		$this->assertSame( 1, $engine->get_protocol_version() );
		$this->assertSame( array( 'update', 'snapshot' ), $engine->get_update_types() );
	}

	public function test_room_size_ceiling_rejects_writes_but_not_reads() {
		// Bootstrap the room, author a valid client update.
		$response = $this->engine()->get_updates_since( $this->room(), 101, 0, array() );
		$doc      = $this->client_doc_from_response( $response );
		$update   = $this->encode_edit(
			$doc,
			function ( $client_doc ) {
				$this->first_block_content( $client_doc )->insert( 11, ' grown' );
			}
		);
		$row      = array(
			'type' => WP_Yjs_Server_Engine::UPDATE_TYPE_UPDATE,
			'data' => $update,
		);

		// Growth-policing tier 2: past the ceiling, writes 413 and reads continue.
		$ceiling = static function () {
			return 10;
		};
		add_filter( 'wp_sync_yjs_server_max_room_bytes', $ceiling );
		$result = $this->engine()->handle_updates( $this->room(), 101, 0, array( $row ), array() );
		$this->assertWPError( $result );
		$this->assertSame( 'rest_sync_room_full', $result->get_error_code() );
		$this->assertSame( 413, $result->get_error_data()['status'] );
		$read = $this->engine()->get_updates_since( $this->room(), 102, 0, array() );
		$this->assertNotEmpty( $read['updates'], 'Reads must survive a full room.' );
		remove_filter( 'wp_sync_yjs_server_max_room_bytes', $ceiling );

		// Below the ceiling the same update applies normally.
		$result = $this->engine()->handle_updates( $this->room(), 101, 0, array( $row ), array() );
		$this->assertNotWPError( $result );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
	}

	public function test_genesis_snapshot_on_first_read() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 101, 0, array() );

		$this->assertCount( 1, $response['updates'] );
		$this->assertSame( WP_Yjs_Server_Engine::UPDATE_TYPE_SNAPSHOT, $response['updates'][0]['type'] );
		$this->assertGreaterThan( 0, $response['end_cursor'] );

		$doc    = $this->client_doc_from_response( $response );
		$record = $doc->getMap( 'document' );

		$this->assertSame( 'Yjs server test post', $record->get( 'title' )->toString() );
		$this->assertSame( 1, $record->get( 'blocks' )->length );

		$block = $record->get( 'blocks' )->get( 0 );
		$this->assertSame( 'core/paragraph', $block->get( 'name' ) );
		$this->assertSame( 'wide', $block->get( 'attributes' )->get( 'align' ) );
		$this->assertSame( 'Hello world', $block->get( 'attributes' )->get( 'content' )->toString() );

		// The genesis row stamps the engine lineage.
		$storage = new WP_Sync_Table_Storage();
		$this->assertSame( 'yjs-server', $storage->get_room_engine( $this->room() ) );
	}

	/**
	 * The shape post-new.php creates: an auto-draft stored with the
	 * placeholder title while the editor shows an empty title.
	 */
	public function test_genesis_blanks_the_auto_draft_placeholder_title() {
		$auto_draft_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_title'   => __( 'Auto Draft', 'default' ),
				'post_status'  => 'auto-draft',
				'post_content' => '',
			)
		);

		$engine   = $this->engine();
		$response = $engine->get_updates_since( 'postType/post:' . $auto_draft_id, 101, 0, array() );
		$doc      = $this->client_doc_from_response( $response );

		$this->assertSame( '', $doc->getMap( 'document' )->get( 'title' )->toString() );

		wp_delete_post( $auto_draft_id, true );
	}

	/**
	 * The guard is gated on auto-draft status: a published post a user
	 * genuinely titled "Auto Draft" seeds verbatim.
	 */
	public function test_genesis_keeps_a_real_title_that_matches_the_placeholder() {
		$published_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_title'   => 'Auto Draft',
				'post_status'  => 'publish',
				'post_content' => '',
			)
		);

		$engine   = $this->engine();
		$response = $engine->get_updates_since( 'postType/post:' . $published_id, 101, 0, array() );
		$doc      = $this->client_doc_from_response( $response );

		$this->assertSame( 'Auto Draft', $doc->getMap( 'document' )->get( 'title' )->toString() );

		wp_delete_post( $published_id, true );
	}

	public function test_update_merges_into_canonical_and_relays_to_peers() {
		$engine = $this->engine();

		// Client A bootstraps.
		$response_a = $engine->get_updates_since( $this->room(), 101, 0, array() );
		$doc_a      = $this->client_doc_from_response( $response_a );
		$cursor_a   = (int) $response_a['end_cursor'];

		// Client A types.
		$update = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 11, ', friends' );
			}
		);

		$result = $this->engine()->handle_updates(
			$this->room(),
			101,
			$cursor_a,
			array(
				array(
					'type' => 'update',
					'data' => $update,
				),
			),
			array()
		);

		$this->assertIsArray( $result );
		$this->assertSame( array( array( 'status' => 'applied' ) ), $result['dispositions'] );

		// Client B (fresh) sees genesis + the update and converges.
		$engine_b   = $this->engine();
		$response_b = $engine_b->get_updates_since( $this->room(), 202, 0, array() );
		$doc_b      = $this->client_doc_from_response( $response_b );
		$this->assertSame( 'Hello world, friends', $this->first_block_content( $doc_b )->toString() );

		// The canonical document materializes with the merged edit.
		$materialized = $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( '<p>Hello world, friends</p>', $materialized );
		$this->assertStringContainsString( '"align":"wide"', $materialized );
	}

	public function test_materialize_roundtrips_genesis_content() {
		$engine = $this->engine();
		$engine->get_updates_since( $this->room(), 101, 0, array() );

		$this->assertSame(
			get_post( self::$post_id )->post_content,
			$engine->materialize( $this->room() )
		);
	}

	public function test_materialize_roundtrips_nested_group_genesis() {
		/*
		 * REGRESSION (fuzzer: nested group + save + reload rendered invalid
		 * recovery blocks): a container's wrapper must split into open and
		 * close innerContent fragments around the child slots; a single
		 * concatenated fragment serialized children OUTSIDE the wrapper
		 * element, breaking the byte roundtrip and block validation.
		 */
		$nested_content = implode(
			"\n",
			array(
				'<!-- wp:group -->',
				'<div class="wp-block-group"><!-- wp:paragraph -->',
				'<p>Inside the group</p>',
				'<!-- /wp:paragraph --></div>',
				'<!-- /wp:group -->',
			)
		);
		$nested_post_id = self::factory()->post->create(
			array( 'post_content' => $nested_content )
		);
		$room           = 'postType/post:' . $nested_post_id;

		$engine = $this->engine();
		$engine->get_updates_since( $room, 101, 0, array() );

		$this->assertSame(
			get_post( $nested_post_id )->post_content,
			$engine->materialize( $room ),
			'nested genesis content must roundtrip byte-identically'
		);

		wp_delete_post( $nested_post_id, true );
	}

	/**
	 * REGRESSION (issue #38, fuzzer seed 8): genesis blocks seeded only the
	 * comment-delimiter attributes, so registered defaults were missing from
	 * the doc. Clients adopt doc blocks verbatim (no parse, no createBlock —
	 * nothing re-fills defaults), and core/group's save() renders its wrapper
	 * from the `tagName` attribute: with it missing, the group serialized to
	 * an EMPTY string, landed in post_content as a void `<!-- wp:group /-->`
	 * with every child dropped, and the next reload showed the invalid-content
	 * recovery screen with an empty recovery copy. Genesis must fill unsourced
	 * attribute defaults; materialize strips them again (the roundtrip test
	 * above certifies that half).
	 */
	public function test_genesis_fills_unsourced_attribute_defaults() {
		$nested_content = implode(
			"\n",
			array(
				'<!-- wp:group {"layout":{"type":"constrained"}} -->',
				'<div class="wp-block-group"><!-- wp:paragraph -->',
				'<p>Inside the group</p>',
				'<!-- /wp:paragraph --></div>',
				'<!-- /wp:group -->',
			)
		);
		$nested_post_id = self::factory()->post->create(
			array( 'post_content' => $nested_content )
		);
		$room           = 'postType/post:' . $nested_post_id;

		$engine   = $this->engine();
		$response = $engine->get_updates_since( $room, 101, 0, array() );
		$doc      = $this->client_doc_from_response( $response );

		$group = $doc->getMap( 'document' )->get( 'blocks' )->get( 0 );
		$this->assertSame( 'core/group', $group->get( 'name' ) );
		$attributes = $group->get( 'attributes' );
		$this->assertSame(
			'div',
			$attributes->get( 'tagName' ),
			'genesis must fill the registered tagName default the comment delimiters omit'
		);
		$this->assertSame(
			array( 'type' => 'constrained' ),
			(array) $attributes->get( 'layout' ),
			'comment-delimiter attributes must survive alongside the filled defaults'
		);

		/*
		 * ORDER is part of the contract: the editor's convergence checks
		 * compare block state as serialized JSON, and parse/createBlock emit
		 * attributes in schema registration order — registered keys first
		 * (rich-text content at its own schema slot), extras appended.
		 * A doc-adopted `{dropCap, content}` against a peer's parsed
		 * `{content, dropCap}` never compares equal (e2e late-joiner-paste
		 * failure on the first version of this fix).
		 */
		$this->assertSame(
			array( 'tagName', 'layout' ),
			array_keys( (array) $attributes->toJSON() ),
			'group attributes must sit in schema order with extras appended'
		);
		$paragraph = $group->get( 'innerBlocks' )->get( 0 );
		$this->assertSame( 'core/paragraph', $paragraph->get( 'name' ) );
		$this->assertSame(
			array( 'content', 'dropCap' ),
			array_keys( (array) $paragraph->get( 'attributes' )->toJSON() ),
			'the rich-text content attribute must occupy its schema position, not be appended last'
		);

		// The materialized content must NOT carry the filled defaults back
		// into the comment delimiters.
		$this->assertSame(
			get_post( $nested_post_id )->post_content,
			$engine->materialize( $room ),
			'filled defaults must strip back out of materialized content'
		);

		wp_delete_post( $nested_post_id, true );
	}

	/**
	 * REGRESSION (V1.md A4): genesis put a block's whole stripped inner
	 * markup into its FIRST rich-text-source attribute — for core/image
	 * the `<img …>` markup landed in `caption`. Self-consistent for byte
	 * round-trips but semantically wrong the moment anyone edits the
	 * caption. Selector-sourced attributes now seed only the named
	 * sub-element's inner text.
	 */
	public function test_genesis_image_caption_seeds_the_caption_not_the_markup() {
		$no_caption   = implode(
			"\n",
			array(
				'<!-- wp:image {"id":42,"sizeSlug":"large","linkDestination":"none"} -->',
				'<figure class="wp-block-image size-large"><img src="https://example.com/a.png" alt=""/></figure>',
				'<!-- /wp:image -->',
			)
		);
		$with_caption = implode(
			"\n",
			array(
				'<!-- wp:image {"id":43,"sizeSlug":"large","linkDestination":"none"} -->',
				'<figure class="wp-block-image size-large"><img src="https://example.com/b.png" alt=""/><figcaption class="wp-element-caption">A café view</figcaption></figure>',
				'<!-- /wp:image -->',
			)
		);

		foreach ( array(
			array( $no_caption, '' ),
			array( $with_caption, 'A café view' ),
		) as list( $content, $expected_caption ) ) {
			$post_id = self::factory()->post->create( array( 'post_content' => $content ) );
			$room    = 'postType/post:' . $post_id;

			$engine   = $this->engine();
			$response = $engine->get_updates_since( $room, 101, 0, array() );
			$doc      = $this->client_doc_from_response( $response );
			$caption  = $doc->getMap( 'document' )->get( 'blocks' )->get( 0 )
				->get( 'attributes' )->get( 'caption' )->toString();

			$this->assertSame( $expected_caption, $caption );
			$this->assertStringNotContainsString( '<img', $caption );

			// The fix must not regress the byte round-trip.
			$this->assertSame(
				get_post( $post_id )->post_content,
				$engine->materialize( $room ),
				'image genesis content must roundtrip byte-identically'
			);

			wp_delete_post( $post_id, true );
		}
	}

	public function test_editing_an_image_caption_keeps_the_image_markup() {
		$content = implode(
			"\n",
			array(
				'<!-- wp:image {"id":44,"sizeSlug":"large","linkDestination":"none"} -->',
				'<figure class="wp-block-image size-large"><img src="https://example.com/c.png" alt=""/><figcaption class="wp-element-caption">Old caption</figcaption></figure>',
				'<!-- /wp:image -->',
			)
		);
		$post_id = self::factory()->post->create( array( 'post_content' => $content ) );
		$room    = 'postType/post:' . $post_id;

		$engine   = $this->engine();
		$response = $engine->get_updates_since( $room, 101, 0, array() );
		$doc      = $this->client_doc_from_response( $response );

		// The client edits ONLY the caption. Before the fix this edit
		// operated on the whole `<img …>` markup living in `caption`.
		$update = $this->encode_edit(
			$doc,
			static function ( $client_doc ) {
				$caption = $client_doc->getMap( 'document' )->get( 'blocks' )->get( 0 )
					->get( 'attributes' )->get( 'caption' );
				$caption->delete( 0, 3 );
				$caption->insert( 0, 'New' );
			}
		);
		$result = $engine->handle_updates(
			$room,
			101,
			(int) $response['end_cursor'],
			array(
				array(
					'type' => WP_Yjs_Server_Engine::UPDATE_TYPE_UPDATE,
					'data' => $update,
				),
			),
			array()
		);
		$this->assertNotWPError( $result );

		$materialized = $engine->materialize( $room );
		$this->assertStringContainsString( '<img src="https://example.com/c.png"', $materialized );
		$this->assertStringContainsString( '<figcaption class="wp-element-caption">New caption</figcaption>', $materialized );

		wp_delete_post( $post_id, true );
	}

	public function test_caption_added_in_session_materializes_with_conventional_tags() {
		$content = implode(
			"\n",
			array(
				'<!-- wp:image {"id":45,"sizeSlug":"large","linkDestination":"none"} -->',
				'<figure class="wp-block-image size-large"><img src="https://example.com/d.png" alt=""/></figure>',
				'<!-- /wp:image -->',
			)
		);
		$post_id = self::factory()->post->create( array( 'post_content' => $content ) );
		$room    = 'postType/post:' . $post_id;

		$engine   = $this->engine();
		$response = $engine->get_updates_since( $room, 101, 0, array() );
		$doc      = $this->client_doc_from_response( $response );

		$update = $this->encode_edit(
			$doc,
			static function ( $client_doc ) {
				$client_doc->getMap( 'document' )->get( 'blocks' )->get( 0 )
					->get( 'attributes' )->get( 'caption' )->insert( 0, 'Added later' );
			}
		);
		$result = $engine->handle_updates(
			$room,
			101,
			(int) $response['end_cursor'],
			array(
				array(
					'type' => WP_Yjs_Server_Engine::UPDATE_TYPE_UPDATE,
					'data' => $update,
				),
			),
			array()
		);
		$this->assertNotWPError( $result );

		$materialized = $engine->materialize( $room );
		$this->assertStringContainsString( '<img src="https://example.com/d.png"', $materialized );
		$this->assertStringContainsString( '<figcaption class="wp-element-caption">Added later</figcaption>', $materialized );

		wp_delete_post( $post_id, true );
	}

	/**
	 * B1 materialization fidelity: a client-maintained `_save` mirror (the
	 * block's registered save() output for its CURRENT attributes)
	 * outranks the genesis wrapper — attribute-driven wrapper changes
	 * (alignment classes, heading levels) materialize instead of being
	 * frozen at the genesis markup.
	 */
	public function test_client_save_markup_outranks_the_genesis_wrapper() {
		$engine     = $this->engine();
		$response_a = $engine->get_updates_since( $this->room(), 101, 0, array() );
		$doc_a      = $this->client_doc_from_response( $response_a );

		// The client re-renders the paragraph's save output after an
		// alignment change and mirrors it into the block's `_save`.
		$update = $this->encode_edit(
			$doc_a,
			static function ( $doc ) {
				$block = $doc->getMap( 'document' )->get( 'blocks' )->get( 0 );
				$block->set( '_save', '<p class="has-text-align-right">STALE TEXT</p>' );
				$block->get( 'attributes' )->set( 'align', 'right' );
			}
		);
		$result = $engine->handle_updates(
			$this->room(),
			101,
			(int) $response_a['end_cursor'],
			array(
				array(
					'type' => WP_Yjs_Server_Engine::UPDATE_TYPE_UPDATE,
					'data' => $update,
				),
			),
			array()
		);
		$this->assertNotWPError( $result );

		$materialized = $engine->materialize( $this->room() );
		// The _save wrapper wins; the live shared text (NOT the stale text
		// embedded in the mirror) fills it.
		$this->assertStringContainsString( '<p class="has-text-align-right">Hello world</p>', $materialized );
		$this->assertStringNotContainsString( 'STALE TEXT', $materialized );
	}

	public function test_redelivered_update_settles_as_already_merged() {
		$engine     = $this->engine();
		$response_a = $engine->get_updates_since( $this->room(), 101, 0, array() );
		$doc_a      = $this->client_doc_from_response( $response_a );

		$update = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, 'A' );
			}
		);
		$row    = array(
			'type' => 'update',
			'data' => $update,
		);

		$first = $this->engine()->handle_updates( $this->room(), 101, 0, array( $row ), array() );
		$this->assertSame( 'applied', $first['dispositions'][0]['status'] );

		$storage    = new WP_Sync_Table_Storage();
		$row_count  = $storage->get_update_count( $this->room() );
		$redelivery = $this->engine()->handle_updates( $this->room(), 101, 0, array( $row ), array() );

		$this->assertSame(
			array(
				array(
					'status' => 'voided',
					'reason' => 'already-merged',
				),
			),
			$redelivery['dispositions']
		);
		// Nothing new was stored.
		$this->assertSame( $row_count, ( new WP_Sync_Table_Storage() )->get_update_count( $this->room() ) );
	}

	public function test_malformed_update_voids_per_update_without_starving_the_batch() {
		$engine     = $this->engine();
		$response_a = $engine->get_updates_since( $this->room(), 101, 0, array() );
		$doc_a      = $this->client_doc_from_response( $response_a );

		$valid = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, 'B' );
			}
		);

		$result = $this->engine()->handle_updates(
			$this->room(),
			101,
			0,
			array(
				array(
					'type' => 'update',
					'data' => 'not!!valid@@base64',
				),
				array(
					'type' => 'update',
					'data' => base64_encode( 'valid base64, junk yjs bytes' ),
				),
				array(
					'type' => 'update',
					'data' => $valid,
				),
			),
			array()
		);

		$this->assertSame( 'voided', $result['dispositions'][0]['status'] );
		$this->assertSame( 'invalid-payload', $result['dispositions'][0]['reason'] );
		$this->assertSame( 'voided', $result['dispositions'][1]['status'] );
		$this->assertSame( 'invalid-payload', $result['dispositions'][1]['reason'] );
		$this->assertSame( 'applied', $result['dispositions'][2]['status'] );

		// The valid edit survived the malformed neighbors.
		$this->assertStringContainsString( 'BHello world', (string) $this->engine()->materialize( $this->room() ) );
	}

	public function test_rejects_non_update_types_from_clients() {
		$engine = $this->engine();
		$engine->get_updates_since( $this->room(), 101, 0, array() );

		$result = $engine->handle_updates(
			$this->room(),
			101,
			0,
			array(
				array(
					'type' => 'sync_step1',
					'data' => base64_encode( 'x' ),
				),
			),
			array()
		);

		$this->assertWPError( $result );
		$this->assertSame( 'rest_invalid_update_type', $result->get_error_code() );
	}

	public function test_own_update_rows_are_filtered_on_read() {
		$engine     = $this->engine();
		$response_a = $engine->get_updates_since( $this->room(), 101, 0, array() );
		$doc_a      = $this->client_doc_from_response( $response_a );
		$cursor_a   = (int) $response_a['end_cursor'];

		$update = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, 'C' );
			}
		);
		$this->engine()->handle_updates(
			$this->room(),
			101,
			$cursor_a,
			array(
				array(
					'type' => 'update',
					'data' => $update,
				),
			),
			array()
		);

		$own = $this->engine()->get_updates_since( $this->room(), 101, $cursor_a, array() );
		$this->assertSame( array(), $own['updates'] );

		$peer = $this->engine()->get_updates_since( $this->room(), 202, $cursor_a, array() );
		$this->assertCount( 1, $peer['updates'] );
		$this->assertSame( 'update', $peer['updates'][0]['type'] );
	}

	public function test_server_checkpoints_trims_and_serves_stale_cursors_from_the_floor() {
		$interval = static function () {
			return 5;
		};
		add_filter( 'wp_sync_yjs_server_checkpoint_interval', $interval );

		try {
			$engine     = $this->engine();
			$response_a = $engine->get_updates_since( $this->room(), 101, 0, array() );
			$doc_a      = $this->client_doc_from_response( $response_a );
			$cursor_a   = (int) $response_a['end_cursor'];

			// Never nominated: the server compacts by itself.
			for ( $i = 0; $i < 12; $i++ ) {
				$update = $this->encode_edit(
					$doc_a,
					function ( $doc ) use ( $i ) {
						$this->first_block_content( $doc )->insert( 0, 'x' . $i . ';' );
					}
				);
				$result = $this->engine()->handle_updates(
					$this->room(),
					101,
					$cursor_a,
					array(
						array(
							'type' => 'update',
							'data' => $update,
						),
					),
					array()
				);
				$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
				$read     = $this->engine()->get_updates_since( $this->room(), 101, $cursor_a, array() );
				$cursor_a = (int) $read['end_cursor'];
				$this->assertFalse( $read['should_compact'] );
			}

			$storage = new WP_Sync_Table_Storage();
			$rows    = $storage->get_updates_after_cursor( $this->room(), 0 );

			// Checkpoint snapshots were appended by the server.
			$checkpoints = array_values(
				array_filter(
					$rows,
					static function ( $row ) {
						if ( WP_Yjs_Server_Engine::UPDATE_TYPE_SNAPSHOT !== $row['type'] ) {
							return false;
						}
						$decoded = json_decode( $row['data'], true );
						return is_array( $decoded ) && ! empty( $decoded['checkpoint'] );
					}
				)
			);
			$this->assertNotEmpty( $checkpoints );

			// History below the previous checkpoint was trimmed: the genesis
			// row is gone, and total row count stays bounded near the
			// interval instead of growing one row per edit.
			$this->assertLessThan( 12, count( $rows ) );
			$floor = $storage->get_room_meta( $this->room(), WP_Yjs_Server_Engine::META_FLOOR );
			$this->assertIsNumeric( $floor );

			// A cursor below the floor is served from the retained
			// checkpoint snapshot and still converges.
			$stale = $this->engine()->get_updates_since( $this->room(), 999, 1, array() );
			$this->assertSame( WP_Yjs_Server_Engine::UPDATE_TYPE_SNAPSHOT, $stale['updates'][0]['type'] );

			$doc_stale = $this->client_doc_from_response( $stale );
			$this->assertSame(
				$this->first_block_content( $doc_a )->toString(),
				$this->first_block_content( $doc_stale )->toString()
			);
		} finally {
			remove_filter( 'wp_sync_yjs_server_checkpoint_interval', $interval );
		}
	}

	/**
	 * The canonical snapshot's stamped cursor is the ingest's load-time
	 * watermark, never the ingest's own insert id: an insert-id stamp
	 * over-claims a concurrent ingest's rows interleaved below it, and the
	 * load-path repair would then skip them forever.
	 */
	public function test_canonical_stamp_under_claims_so_the_log_repair_can_run() {
		$response_a = $this->engine()->get_updates_since( $this->room(), 101, 0, array() );
		$doc_a      = $this->client_doc_from_response( $response_a );
		$cursor_a   = (int) $response_a['end_cursor'];

		// Genesis stamps cursor 0: a racing initializer's client can append
		// a row below this genesis row's id, so even the genesis row id
		// would over-claim.
		$storage = new WP_Sync_Table_Storage();
		$meta    = $storage->get_room_meta( $this->room(), WP_Yjs_Server_Engine::META_DOC );
		$this->assertSame( 0, (int) $meta['cursor'] );

		$update = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, 'A' );
			}
		);
		$this->engine()->handle_updates(
			$this->room(),
			101,
			$cursor_a,
			array(
				array(
					'type' => 'update',
					'data' => $update,
				),
			),
			array()
		);

		$storage = new WP_Sync_Table_Storage();
		$meta    = $storage->get_room_meta( $this->room(), WP_Yjs_Server_Engine::META_DOC );
		$storage->get_updates_after_cursor( $this->room(), 0 );
		$head = $storage->get_cursor( $this->room() );

		// The stamp is the ingest's load-time watermark, strictly below the
		// row it appended. A concurrent ingest's row interleaved below the
		// head therefore stays above the stamp and re-applies on the next
		// load; a stamp at the appended row's id would hide it forever.
		$this->assertSame( $cursor_a, (int) $meta['cursor'] );
		$this->assertLessThan( $head, (int) $meta['cursor'] );
	}

	/**
	 * The lock-free design's canonical save race, re-enacted through the
	 * real storage: the losing writer's merged content is gone from the
	 * canonical document but its row is in the log, and the under-claiming
	 * stamp lets the next load repair it. Before the fix this scenario
	 * wedged the losing client permanently (every subsequent update voided
	 * as invalid-payload).
	 */
	public function test_lost_canonical_save_race_is_repaired_from_the_log() {
		// Clients A and B bootstrap from genesis.
		$response_a = $this->engine()->get_updates_since( $this->room(), 101, 0, array() );
		$doc_a      = $this->client_doc_from_response( $response_a );
		$cursor_a   = (int) $response_a['end_cursor'];

		$response_b = $this->engine()->get_updates_since( $this->room(), 202, 0, array() );
		$doc_b      = $this->client_doc_from_response( $response_b );

		// A's ingest lands: row appended, canonical saved.
		$update_a = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, 'alpha ' );
			}
		);
		$first    = $this->engine()->handle_updates(
			$this->room(),
			101,
			$cursor_a,
			array(
				array(
					'type' => 'update',
					'data' => $update_a,
				),
			),
			array()
		);
		$this->assertSame( 'applied', $first['dispositions'][0]['status'] );

		// B's concurrent ingest loaded the canonical BEFORE A's row was
		// visible, merged only its own edit, appended its row, and won the
		// canonical save race. Replay that outcome through the storage: B's
		// row lands after A's, and the canonical becomes genesis + B's edit
		// (A's merged content is gone from it), stamped with B's load-time
		// watermark per the under-claim invariant.
		$update_b = $this->encode_edit(
			$doc_b,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, 'bravo ' );
			}
		);
		$storage  = new WP_Sync_Table_Storage();
		$storage->add_update(
			$this->room(),
			array(
				'client_id' => 202,
				'data'      => $update_b,
				'type'      => 'update',
			)
		);
		$storage->set_room_meta(
			$this->room(),
			WP_Yjs_Server_Engine::META_DOC,
			array(
				'doc'    => \Yjs\encodeStateAsUpdateV2( $doc_b )->toBase64(),
				'cursor' => $cursor_a,
			)
		);

		// A's next edit causally depends on its first. Before the
		// under-claim fix the canonical had lost A's items, y-php rejected
		// the update, and every subsequent update from A voided; now the
		// load repairs A's row from the log first and the edit applies.
		$update_a2 = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, 'delta ' );
			}
		);
		$second    = $this->engine()->handle_updates(
			$this->room(),
			101,
			$cursor_a,
			array(
				array(
					'type' => 'update',
					'data' => $update_a2,
				),
			),
			array()
		);
		$this->assertSame( 'applied', $second['dispositions'][0]['status'] );

		// Nothing lost, nothing duplicated: the repair re-applied B's row
		// idempotently, and all three edits survive in the canonical.
		$materialized = (string) $this->engine()->materialize( $this->room() );
		foreach ( array( 'alpha ', 'bravo ', 'delta ' ) as $token ) {
			$this->assertSame( 1, substr_count( $materialized, $token ), "token '{$token}' in: {$materialized}" );
		}

		// A fresh peer converges to the same text from the log alone.
		$doc_c  = $this->client_doc_from_response( $this->engine()->get_updates_since( $this->room(), 303, 0, array() ) );
		$text_c = $this->first_block_content( $doc_c )->toString();
		foreach ( array( 'alpha ', 'bravo ', 'delta ' ) as $token ) {
			$this->assertSame( 1, substr_count( $text_c, $token ), "token '{$token}' in: {$text_c}" );
		}
	}

	/**
	 * The ingest-side replay lane: a canonical snapshot that both LOST a
	 * row's content and over-claims it in its stamp (the read-visibility
	 * race the under-claiming stamp cannot rule out) is repaired from the
	 * update log within the ingest request itself, instead of voiding the
	 * dependent update.
	 */
	public function test_lossy_over_claimed_canonical_is_repaired_by_ingest_replay() {
		$response_a = $this->engine()->get_updates_since( $this->room(), 101, 0, array() );
		$doc_a      = $this->client_doc_from_response( $response_a );
		$cursor_a   = (int) $response_a['end_cursor'];
		$genesis    = json_decode( $response_a['updates'][0]['data'], true );

		$update_a = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, 'alpha ' );
			}
		);
		$first    = $this->engine()->handle_updates(
			$this->room(),
			101,
			$cursor_a,
			array(
				array(
					'type' => 'update',
					'data' => $update_a,
				),
			),
			array()
		);
		$this->assertSame( 'applied', $first['dispositions'][0]['status'] );

		// Corrupt the canonical the way the visibility race would: content
		// reverted to genesis, stamp claiming the head, nothing left above
		// the stamp for the load-path repair to apply.
		$storage = new WP_Sync_Table_Storage();
		$storage->get_updates_after_cursor( $this->room(), 0 );
		$head = $storage->get_cursor( $this->room() );
		$storage->set_room_meta(
			$this->room(),
			WP_Yjs_Server_Engine::META_DOC,
			array(
				'doc'    => $genesis['doc'],
				'cursor' => $head,
			)
		);

		// A's next edit depends on its first, which the canonical no longer
		// has: ingest must fall back to the log replay and apply it.
		$update_a2 = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, 'delta ' );
			}
		);
		$second    = $this->engine()->handle_updates(
			$this->room(),
			101,
			$cursor_a,
			array(
				array(
					'type' => 'update',
					'data' => $update_a2,
				),
			),
			array()
		);
		$this->assertSame( 'applied', $second['dispositions'][0]['status'] );

		// The repair persisted: materialization (canonical + tail) carries
		// both edits exactly once, and a fresh peer converges from the log.
		$materialized = (string) $this->engine()->materialize( $this->room() );
		foreach ( array( 'alpha ', 'delta ' ) as $token ) {
			$this->assertSame( 1, substr_count( $materialized, $token ), "token '{$token}' in: {$materialized}" );
		}

		$doc_b  = $this->client_doc_from_response( $this->engine()->get_updates_since( $this->room(), 202, 0, array() ) );
		$text_b = $this->first_block_content( $doc_b )->toString();
		foreach ( array( 'alpha ', 'delta ' ) as $token ) {
			$this->assertSame( 1, substr_count( $text_b, $token ), "token '{$token}' in: {$text_b}" );
		}
	}

	/**
	 * A client genuinely ahead of the room (an earlier send never landed)
	 * settles as a `resync-required` void, NOT `invalid-payload`, stores
	 * nothing, and the documented recovery (the client uploads its full
	 * state as an ordinary update) heals the room.
	 */
	public function test_update_ahead_of_the_log_voids_resync_required_and_full_state_heals() {
		$response_a = $this->engine()->get_updates_since( $this->room(), 101, 0, array() );
		$doc_a      = $this->client_doc_from_response( $response_a );
		$cursor_a   = (int) $response_a['end_cursor'];

		// Edit 1 happens locally but its update is never submitted.
		$this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, 'lost ' );
			}
		);

		// Edit 2's incremental update causally depends on edit 1.
		$update_2 = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, 'found ' );
			}
		);

		$storage = new WP_Sync_Table_Storage();
		$storage->get_updates_after_cursor( $this->room(), 0 );
		$rows_before = $storage->get_update_count( $this->room() );

		$result = $this->engine()->handle_updates(
			$this->room(),
			101,
			$cursor_a,
			array(
				array(
					'type' => 'update',
					'data' => $update_2,
				),
			),
			array()
		);
		$this->assertSame(
			array(
				array(
					'status' => 'voided',
					'reason' => 'resync-required',
				),
			),
			$result['dispositions']
		);

		// Nothing was stored for the unresolvable update.
		$storage = new WP_Sync_Table_Storage();
		$storage->get_updates_after_cursor( $this->room(), 0 );
		$this->assertSame( $rows_before, $storage->get_update_count( $this->room() ) );

		// The recovery lane: the client uploads its full state; the server
		// diffs out what it already has and applies the rest.
		$recovery = $this->engine()->handle_updates(
			$this->room(),
			101,
			$cursor_a,
			array(
				array(
					'type' => 'update',
					'data' => \Yjs\encodeStateAsUpdateV2( $doc_a )->toBase64(),
				),
			),
			array()
		);
		$this->assertSame( 'applied', $recovery['dispositions'][0]['status'] );

		$materialized = (string) $this->engine()->materialize( $this->room() );
		foreach ( array( 'lost ', 'found ' ) as $token ) {
			$this->assertSame( 1, substr_count( $materialized, $token ), "token '{$token}' in: {$materialized}" );
		}
	}

	public function test_concurrent_genesis_writers_merge_idempotently() {
		// Two engines race the same empty room: both build genesis. The
		// deterministic build (fixed per-room clientID, fixed op order) must
		// make the duplicate rows byte-identical so applying both cannot
		// duplicate content.
		$engine_a = $this->engine();
		$engine_b = $this->engine();

		$initialize = new ReflectionMethod( WP_Yjs_Server_Engine::class, 'initialize_room' );
		$initialize->setAccessible( true );

		$doc_a = new \Yjs\Utils\Doc();
		$doc_b = new \Yjs\Utils\Doc();
		$initialize->invoke( $engine_a, $this->room(), $doc_a );
		$initialize->invoke( $engine_b, $this->room(), $doc_b );

		$storage = new WP_Sync_Table_Storage();
		$rows    = $storage->get_updates_after_cursor( $this->room(), 0 );
		$this->assertCount( 2, $rows );
		$this->assertSame( $rows[0]['data'], $rows[1]['data'] );

		// A client applying BOTH genesis rows converges to one paragraph.
		$doc = new \Yjs\Utils\Doc();
		foreach ( $rows as $row ) {
			$decoded = json_decode( $row['data'], true );
			\Yjs\applyUpdateV2( $doc, \Yjs\Lib0\Buffer::fromBase64( $decoded['doc'] ) );
		}
		$this->assertSame( 1, $doc->getMap( 'document' )->get( 'blocks' )->length );
	}

	public function test_genesis_seeds_the_full_shared_property_set() {
		register_post_meta(
			'post',
			'yjs_note',
			array(
				'show_in_rest' => true,
				'single'       => true,
				'type'         => 'string',
				'default'      => '',
			)
		);
		$post_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_title'   => 'Full seed post',
				'post_excerpt' => 'Seeded excerpt',
				'post_status'  => 'publish',
				'post_content' => "<!-- wp:paragraph -->\n<p>Body</p>\n<!-- /wp:paragraph -->",
			)
		);
		update_post_meta( $post_id, 'yjs_note', 'noted' );

		$engine   = $this->engine();
		$response = $engine->get_updates_since( 'postType/post:' . $post_id, 101, 0, array() );
		$doc      = $this->client_doc_from_response( $response );
		$record   = $doc->getMap( 'document' );
		$expected = WP_Sync_Post_Genesis_Props::for_post( get_post( $post_id ) );

		unregister_post_meta( 'post', 'yjs_note' );

		// Rich-text properties seed as Y.Text in the client schema…
		$this->assertSame( $expected['title'], $record->get( 'title' )->toString() );
		$this->assertSame( $expected['excerpt'], $record->get( 'excerpt' )->toString() );
		// …scalars and taxonomy term-ID arrays as plain values…
		$this->assertSame( 'publish', $record->get( 'status' ) );
		$this->assertSame( $expected['date'], $record->get( 'date' ) );
		$this->assertSame( $expected['author'], $record->get( 'author' ) );
		$this->assertSame( $expected['categories'], $record->get( 'categories' ) );
		$this->assertSame( array(), $record->get( 'tags' ) );
		// …and registered meta nested under ONE meta map, matching the
		// crdt.ts schema (per-key merge on the client).
		$this->assertSame( 'noted', $record->get( 'meta' )->get( 'yjs_note' ) );

		wp_delete_post( $post_id, true );
	}

	public function test_genesis_size_gate_refuses_oversized_posts_and_respects_the_filter() {
		$big_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => "<!-- wp:paragraph -->\n<p>" . str_repeat( 'x', 2048 ) . "</p>\n<!-- /wp:paragraph -->",
			)
		);
		$room   = 'postType/post:' . $big_id;

		add_filter( 'wp_sync_yjs_server_max_genesis_bytes', $gate_filter = static fn() => 1024 );
		try {
			// A read never bootstraps the room: no snapshot row is built or
			// stored, so RTC simply never activates for the oversized post.
			$response = $this->engine()->get_updates_since( $room, 101, 0, array() );
			$this->assertSame( array(), $response['updates'] );

			// A write states the refusal explicitly through the transport.
			$result = $this->engine()->handle_updates(
				$room,
				101,
				0,
				array(
					array(
						'type' => 'update',
						'data' => 'AAA=',
					),
				),
				array()
			);
			$this->assertWPError( $result );
			$this->assertSame( 'rest_sync_document_too_large', $result->get_error_code() );
		} finally {
			remove_filter( 'wp_sync_yjs_server_max_genesis_bytes', $gate_filter );
		}

		// With the default gate the same post initializes normally.
		$response = $this->engine()->get_updates_since( $room, 101, 0, array() );
		$this->assertNotEmpty( $response['updates'] );
		$this->assertSame( WP_Yjs_Server_Engine::UPDATE_TYPE_SNAPSHOT, $response['updates'][0]['type'] );

		wp_delete_post( $big_id, true );
	}

	public function test_kses_lane_sanitizes_a_filtered_authors_markup_and_every_client_converges() {
		$engine     = $this->engine();
		$response_a = $engine->get_updates_since( $this->room(), 101, 0, array() );
		$doc_a      = $this->client_doc_from_response( $response_a );
		$cursor_a   = (int) $response_a['end_cursor'];

		wp_set_current_user( self::$author_id );
		$update = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 11, ' <script>alert(1)</script>' );
			}
		);
		$result = $this->engine()->handle_updates(
			$this->room(),
			101,
			$cursor_a,
			array(
				array(
					'type' => 'update',
					'data' => $update,
				),
			),
			array()
		);
		// Filter-on-save semantics: the update APPLIES; the markup goes.
		$this->assertSame( array( array( 'status' => 'applied' ) ), $result['dispositions'] );

		$materialized = $this->engine()->materialize( $this->room() );
		$this->assertStringNotContainsString( '<script>', $materialized );
		$this->assertStringContainsString( 'alert(1)', $materialized, 'kses strips tags, not their text content' );

		// A fresh peer converges on the sanitized content.
		$doc_b = $this->client_doc_from_response(
			$this->engine()->get_updates_since( $this->room(), 202, 0, array() )
		);
		$this->assertStringNotContainsString(
			'<script>',
			$this->first_block_content( $doc_b )->toString()
		);

		// The AUTHOR converges too: the compensating row is server-authored,
		// so their own-row read filter does not hide it.
		$catch_up = $this->engine()->get_updates_since( $this->room(), 101, $cursor_a, array() );
		$this->assertNotEmpty( $catch_up['updates'], 'the author must receive the compensation row' );
		$this->apply_response( $doc_a, $catch_up );
		$this->assertStringNotContainsString(
			'<script>',
			$this->first_block_content( $doc_a )->toString()
		);

		// The author's replica is NOT diverged: their next edit still applies.
		$next   = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, 'Onward: ' );
			}
		);
		$result = $this->engine()->handle_updates(
			$this->room(),
			101,
			(int) $catch_up['end_cursor'],
			array(
				array(
					'type' => 'update',
					'data' => $next,
				),
			),
			array()
		);
		$this->assertSame( array( array( 'status' => 'applied' ) ), $result['dispositions'] );
		$this->assertStringContainsString( 'Onward: ', (string) $this->engine()->materialize( $this->room() ) );
	}

	public function test_kses_lane_leaves_untouched_privileged_blocks_alone() {
		$two_block_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_status'  => 'publish',
				'post_content' => "<!-- wp:paragraph -->\n<p>First</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Second</p>\n<!-- /wp:paragraph -->",
			)
		);
		$room         = 'postType/post:' . $two_block_id;

		// A privileged EDITOR lands protected markup in the FIRST block.
		$engine     = $this->engine();
		$response_e = $engine->get_updates_since( $room, 101, 0, array() );
		$doc_e      = $this->client_doc_from_response( $response_e );
		$editor_up  = $this->encode_edit(
			$doc_e,
			function ( $doc ) {
				$doc->getMap( 'document' )->get( 'blocks' )->get( 0 )
					->get( 'attributes' )->get( 'content' )
					->insert( 5, ' <script>privileged()</script>' );
			}
		);
		$result     = $this->engine()->handle_updates(
			$room,
			101,
			(int) $response_e['end_cursor'],
			array(
				array(
					'type' => 'update',
					'data' => $editor_up,
				),
			),
			array()
		);
		$this->assertSame( array( array( 'status' => 'applied' ) ), $result['dispositions'] );
		$this->assertStringContainsString( '<script>privileged()</script>', (string) $this->engine()->materialize( $room ) );

		// A FILTERED author edits only the SECOND block: the privileged
		// first block is untouched by the batch and never judged.
		wp_set_current_user( self::$author_id );
		$response_a = $this->engine()->get_updates_since( $room, 202, 0, array() );
		$doc_a      = $this->client_doc_from_response( $response_a );
		$author_up  = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$doc->getMap( 'document' )->get( 'blocks' )->get( 1 )
					->get( 'attributes' )->get( 'content' )
					->insert( 6, ' plus author text' );
			}
		);
		$result     = $this->engine()->handle_updates(
			$room,
			202,
			(int) $response_a['end_cursor'],
			array(
				array(
					'type' => 'update',
					'data' => $author_up,
				),
			),
			array()
		);
		$this->assertSame( array( array( 'status' => 'applied' ) ), $result['dispositions'] );

		$materialized = (string) $this->engine()->materialize( $room );
		$this->assertStringContainsString( '<script>privileged()</script>', $materialized, 'a privileged block untouched by the batch survives' );
		$this->assertStringContainsString( 'plus author text', $materialized );

		wp_delete_post( $two_block_id, true );
	}

	public function test_privileged_author_markup_is_never_sanitized() {
		$engine     = $this->engine();
		$response_a = $engine->get_updates_since( $this->room(), 101, 0, array() );
		$doc_a      = $this->client_doc_from_response( $response_a );

		// The editor keeps unfiltered_html on single site.
		$update = $this->encode_edit(
			$doc_a,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 11, ' <script>ok()</script>' );
			}
		);
		$result = $this->engine()->handle_updates(
			$this->room(),
			101,
			(int) $response_a['end_cursor'],
			array(
				array(
					'type' => 'update',
					'data' => $update,
				),
			),
			array()
		);
		$this->assertSame( array( array( 'status' => 'applied' ) ), $result['dispositions'] );
		$this->assertStringContainsString( '<script>ok()</script>', (string) $this->engine()->materialize( $this->room() ) );
	}
}
