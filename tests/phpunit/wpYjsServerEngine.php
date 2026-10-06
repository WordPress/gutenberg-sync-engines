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

	/**
	 * Contributor user ID (can edit_posts, but only their own posts).
	 *
	 * @var int
	 */
	protected static $contributor_id;

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id      = $factory->user->create( array( 'role' => 'editor' ) );
		self::$author_id      = $factory->user->create( array( 'role' => 'author' ) );
		self::$contributor_id = $factory->user->create( array( 'role' => 'contributor' ) );
		self::$post_id        = $factory->post->create(
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
		self::delete_user( self::$contributor_id );
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
			} elseif ( WP_Yjs_Server_Engine::UPDATE_TYPE_UPDATE === $update['type'] ) {
				\Yjs\applyUpdateV2( $doc, \Yjs\Lib0\Buffer::fromBase64( $update['data'] ) );
			}
			// Review rows (held, held-resolved) carry no document content.
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
		$this->assertSame( array( 'update', 'snapshot', 'held', 'held-resolved' ), $engine->get_update_types() );
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

	/**
	 * Decoded rows of a type from a room response.
	 *
	 * @param array  $response Room response.
	 * @param string $type     Update type.
	 * @return array Decoded row payloads.
	 */
	private function rows_of_type( array $response, string $type ): array {
		$rows = array();
		foreach ( $response['updates'] as $update ) {
			if ( $type === $update['type'] ) {
				$rows[] = json_decode( $update['data'], true );
			}
		}
		return $rows;
	}

	/**
	 * A filtered author writes a script into the first block: the kses
	 * lane sanitizes it and holds what it stripped.
	 *
	 * @param string $markup The markup the author types.
	 * @return array The open hold.
	 */
	private function raise_hold( string $markup = ' <script>alert(1)</script>' ): array {
		$response = $this->engine()->get_updates_since( $this->room(), 101, 0, array() );
		$doc      = $this->client_doc_from_response( $response );

		wp_set_current_user( self::$author_id );
		$update = $this->encode_edit(
			$doc,
			function ( $doc ) use ( $markup ) {
				$this->first_block_content( $doc )->insert( 11, $markup );
			}
		);
		$this->engine()->handle_updates(
			$this->room(),
			101,
			(int) $response['end_cursor'],
			array(
				array(
					'type' => 'update',
					'data' => $update,
				),
			),
			array()
		);

		$holds = $this->engine()->get_open_holds( $this->room() );
		$this->assertCount( 1, $holds, 'the sanitized block must be held' );
		return array_values( $holds )[0];
	}

	public function test_kses_lane_holds_the_markup_it_strips() {
		$hold = $this->raise_hold();

		$this->assertStringContainsString( '<script>alert(1)</script>', $hold['held'] );
		$this->assertStringNotContainsString( '<script>', $hold['sanitized'] );
		$this->assertStringContainsString( 'Hello world', $hold['base'] );
		$this->assertStringNotContainsString( 'alert', $hold['base'], 'the base is the block before the batch' );
		$this->assertSame( 0, $hold['index'] );
		$this->assertSame( self::$author_id, $hold['author'] );
		$this->assertSame( 101, $hold['authorClientId'] );
		$this->assertIsString( $hold['blockId'] );

		// The hold is announced to every client, the author included, and
		// names the sanitized block in the canonical document.
		$read = $this->engine()->get_updates_since( $this->room(), 202, 0, array() );
		$held = $this->rows_of_type( $read, WP_Yjs_Server_Engine::UPDATE_TYPE_HELD );
		$this->assertCount( 1, $held );
		$this->assertSame( $hold['holdId'], $held[0]['holdId'] );
		$doc = $this->client_doc_from_response( $read );
		$this->assertSame(
			$hold['blockId'],
			$doc->getMap( 'document' )->get( 'blocks' )->get( 0 )->get( 'clientId' )
		);
		$this->assertNotEmpty(
			$this->rows_of_type(
				$this->engine()->get_updates_since( $this->room(), 101, 0, array() ),
				WP_Yjs_Server_Engine::UPDATE_TYPE_HELD
			)
		);
	}

	public function test_accepting_a_hold_lands_the_held_markup_for_every_client() {
		$hold = $this->raise_hold();

		wp_set_current_user( self::$editor_id );
		$disposition = $this->engine()->resolve_hold( $this->room(), $hold['holdId'], 'accepted' );
		$this->assertSame( 'resolved', $disposition['status'] );
		$this->assertTrue( $disposition['applied'] );

		$this->assertStringContainsString( '<script>alert(1)</script>', (string) $this->engine()->materialize( $this->room() ) );
		$this->assertSame( array(), $this->engine()->get_open_holds( $this->room() ) );

		// A fresh peer converges on the approved markup and sees the hold closed.
		$read     = $this->engine()->get_updates_since( $this->room(), 303, 0, array() );
		$doc      = $this->client_doc_from_response( $read );
		$resolved = $this->rows_of_type( $read, WP_Yjs_Server_Engine::UPDATE_TYPE_HELD_RESOLVED );
		$this->assertStringContainsString( '<script>', $this->first_block_content( $doc )->toString() );
		$this->assertCount( 1, $resolved );
		$this->assertSame( $hold['holdId'], $resolved[0]['holdId'] );
		$this->assertSame( 'accepted', $resolved[0]['resolution'] );
		$this->assertSame( self::$editor_id, $resolved[0]['resolvedBy'] );
	}

	public function test_accepting_a_hold_with_edited_content_lands_that_content() {
		$hold = $this->raise_hold();

		wp_set_current_user( self::$editor_id );
		$edited = "<!-- wp:paragraph -->\n<p>Hello world, <em>reviewed</em></p>\n<!-- /wp:paragraph -->";
		$this->engine()->resolve_hold( $this->room(), $hold['holdId'], 'accepted', $edited );

		$materialized = (string) $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( '<em>reviewed</em>', $materialized );
		$this->assertStringNotContainsString( 'alert', $materialized, 'the content replaces the sanitized block' );
	}

	/**
	 * A peer who may publish unfiltered HTML edits the first block, which
	 * is the sanitized block of the open hold.
	 *
	 * @param string $text The text the peer puts at the start of the block.
	 * @return void
	 */
	private function peer_edits_the_held_block( string $text ): void {
		wp_set_current_user( self::$editor_id );
		$response = $this->engine()->get_updates_since( $this->room(), 202, 0, array() );
		$doc      = $this->client_doc_from_response( $response );
		$update   = $this->encode_edit(
			$doc,
			function ( $doc ) use ( $text ) {
				$this->first_block_content( $doc )->insert( 0, $text );
			}
		);
		$this->engine()->handle_updates(
			$this->room(),
			202,
			(int) $response['end_cursor'],
			array(
				array(
					'type' => 'update',
					'data' => $update,
				),
			),
			array()
		);
	}

	public function test_accepting_a_hold_is_refused_when_the_block_changed_after_the_reviewer_saw_it() {
		$hold = $this->raise_hold();

		// The reviewer has the dialog open. A peer edits the sanitized block.
		$this->peer_edits_the_held_block( 'PEER EDIT ' );
		$before = (string) $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'PEER EDIT', $before );

		// The reviewer approves what they saw: the block before the peer's edit.
		$refused = $this->engine()->resolve_hold( $this->room(), $hold['holdId'], 'accepted', null, $hold['sanitized'] );
		$this->assertWPError( $refused );
		$this->assertSame( 'review_stale', $refused->get_error_code() );
		$this->assertSame( 409, $refused->get_error_data()['status'] );

		// Nothing was written: the peer's edit is still there, the held
		// markup is not, and the hold is still open.
		$this->assertSame( $before, (string) $this->engine()->materialize( $this->room() ) );
		$holds = $this->engine()->get_open_holds( $this->room() );
		$this->assertCount( 1, $holds );

		// The hold now records the block as it reads, the refusal carries
		// it, and every client hears about it.
		$fresh = $holds[ $hold['holdId'] ];
		$this->assertStringContainsString( 'PEER EDIT', $fresh['sanitized'] );
		$this->assertSame( $fresh['sanitized'], $refused->get_error_data()['hold']['sanitized'] );
		$read = $this->engine()->get_updates_since( $this->room(), 303, 0, array() );
		$held = $this->rows_of_type( $read, WP_Yjs_Server_Engine::UPDATE_TYPE_HELD );
		$this->assertCount( 2, $held, 'the hold is announced again' );
		$this->assertSame( $hold['holdId'], $held[1]['holdId'] );
		$this->assertSame( $fresh['sanitized'], $held[1]['sanitized'] );
		$this->assertCount( 0, $this->rows_of_type( $read, WP_Yjs_Server_Engine::UPDATE_TYPE_HELD_RESOLVED ) );

		// The reviewer looks again and approves against the block as it reads now.
		$edited      = "<!-- wp:paragraph -->\n<p>PEER EDIT Hello world, <em>reviewed</em></p>\n<!-- /wp:paragraph -->";
		$disposition = $this->engine()->resolve_hold( $this->room(), $hold['holdId'], 'accepted', $edited, $fresh['sanitized'] );
		$this->assertIsArray( $disposition );
		$this->assertTrue( $disposition['applied'] );
		$this->assertStringContainsString( '<em>reviewed</em>', (string) $this->engine()->materialize( $this->room() ) );
		$this->assertSame( array(), $this->engine()->get_open_holds( $this->room() ) );
	}

	public function test_accepting_a_hold_without_naming_the_block_checks_it_against_the_hold() {
		$hold = $this->raise_hold();
		$this->peer_edits_the_held_block( 'PEER EDIT ' );
		$before = (string) $this->engine()->materialize( $this->room() );

		// A caller that does not say what it saw is held to the hold as recorded.
		$refused = $this->engine()->resolve_hold( $this->room(), $hold['holdId'], 'accepted' );
		$this->assertWPError( $refused );
		$this->assertSame( 'review_stale', $refused->get_error_code() );
		$this->assertSame( $before, (string) $this->engine()->materialize( $this->room() ) );
	}

	public function test_a_hold_records_the_block_the_way_an_approval_reads_it_back() {
		$hold = $this->raise_hold();

		// Nobody touched the block: approving against the hold goes through.
		wp_set_current_user( self::$editor_id );
		$disposition = $this->engine()->resolve_hold( $this->room(), $hold['holdId'], 'accepted', null, $hold['sanitized'] );
		$this->assertIsArray( $disposition );
		$this->assertTrue( $disposition['applied'] );
	}

	public function test_dismissing_a_hold_is_never_stale() {
		$hold = $this->raise_hold();
		$this->peer_edits_the_held_block( 'PEER EDIT ' );
		$before = (string) $this->engine()->materialize( $this->room() );

		// Dismissing keeps the document as it is, whatever it is now.
		$disposition = $this->engine()->resolve_hold( $this->room(), $hold['holdId'], 'dismissed', null, $hold['sanitized'] );
		$this->assertIsArray( $disposition );
		$this->assertSame( array(), $this->engine()->get_open_holds( $this->room() ) );
		$this->assertSame( $before, (string) $this->engine()->materialize( $this->room() ) );
	}

	/**
	 * An engine whose storage cannot store a `held-resolved` row, and
	 * stores everything else.
	 *
	 * @return WP_Yjs_Server_Engine Engine.
	 */
	private function engine_that_cannot_store_a_closing_row(): WP_Yjs_Server_Engine {
		$storage = new class() extends WP_Sync_Table_Storage {
			public function add_update( string $room, $update ): bool {
				if ( WP_Yjs_Server_Engine::UPDATE_TYPE_HELD_RESOLVED === ( $update['type'] ?? null ) ) {
					return false;
				}
				return parent::add_update( $room, $update );
			}
		};

		return new WP_Yjs_Server_Engine( $storage );
	}

	public function test_a_decision_whose_closing_row_was_not_stored_leaves_the_hold_open() {
		$hold = $this->raise_hold();

		wp_set_current_user( self::$editor_id );
		$result = $this->engine_that_cannot_store_a_closing_row()->resolve_hold( $this->room(), $hold['holdId'], 'dismissed' );
		$this->assertWPError( $result );
		$this->assertSame( 'rest_sync_storage_error', $result->get_error_code() );

		// The caller shows the hold again, so the server must still know
		// it: the next decision has to count.
		$this->assertArrayHasKey( $hold['holdId'], $this->engine()->get_open_holds( $this->room() ) );
		$this->assertSame( array(), $this->closed_holds() );

		$disposition = $this->engine()->resolve_hold( $this->room(), $hold['holdId'], 'dismissed' );
		$this->assertSame( 'resolved', $disposition['status'] );
		$this->assertSame( array(), $this->engine()->get_open_holds( $this->room() ) );
		$this->assertSame( array( $hold['holdId'] => 'dismissed' ), $this->closed_holds() );
	}

	public function test_accepting_a_hold_needs_unfiltered_html() {
		$hold = $this->raise_hold();

		// Still the filtered author.
		$rejected = $this->engine()->resolve_hold( $this->room(), $hold['holdId'], 'accepted' );
		$this->assertWPError( $rejected );
		$this->assertSame( 'rest_sync_forbidden', $rejected->get_error_code() );
		$this->assertCount( 1, $this->engine()->get_open_holds( $this->room() ), 'the hold stays open' );
		$this->assertStringNotContainsString( '<script>', (string) $this->engine()->materialize( $this->room() ) );
	}

	public function test_dismissing_a_hold_keeps_the_sanitized_block() {
		$hold   = $this->raise_hold();
		$before = (string) $this->engine()->materialize( $this->room() );

		// Anyone who can edit may discard, the author included.
		$disposition = $this->engine()->resolve_hold( $this->room(), $hold['holdId'], 'dismissed' );
		$this->assertSame( 'resolved', $disposition['status'] );
		$this->assertArrayNotHasKey( 'applied', $disposition );
		$this->assertSame( $before, (string) $this->engine()->materialize( $this->room() ) );
		$this->assertSame( array(), $this->engine()->get_open_holds( $this->room() ) );

		// Deciding it again acks without changing anything.
		wp_set_current_user( self::$editor_id );
		$again = $this->engine()->resolve_hold( $this->room(), $hold['holdId'], 'accepted' );
		$this->assertSame( 'resolved', $again['status'] );
		$this->assertSame( $before, (string) $this->engine()->materialize( $this->room() ) );
	}

	public function test_a_newer_hold_by_the_same_author_over_the_same_block_supersedes_the_open_one() {
		$first = $this->raise_hold();

		// The author catches up on the sanitized block and tries again.
		$response = $this->engine()->get_updates_since( $this->room(), 101, 0, array() );
		$doc      = $this->client_doc_from_response( $response );
		$update   = $this->encode_edit(
			$doc,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, '<script>alert(2)</script>' );
			}
		);
		$this->engine()->handle_updates(
			$this->room(),
			101,
			(int) $response['end_cursor'],
			array(
				array(
					'type' => 'update',
					'data' => $update,
				),
			),
			array()
		);

		$holds = array_values( $this->engine()->get_open_holds( $this->room() ) );
		$this->assertCount( 1, $holds, 'one review task per author and block' );
		$this->assertNotSame( $first['holdId'], $holds[0]['holdId'] );
		$this->assertStringContainsString( 'alert(2)', $holds[0]['held'] );
		// The reviewer still compares against the block before the author's first attempt.
		$this->assertSame( $first['base'], $holds[0]['base'] );

		$resolved = $this->rows_of_type(
			$this->engine()->get_updates_since( $this->room(), 202, 0, array() ),
			WP_Yjs_Server_Engine::UPDATE_TYPE_HELD_RESOLVED
		);
		$this->assertCount( 1, $resolved );
		$this->assertSame( $first['holdId'], $resolved[0]['holdId'] );
		$this->assertSame( 'superseded', $resolved[0]['resolution'] );
	}

	/**
	 * A paragraph block as an editor adds it to the document.
	 *
	 * @param string $client_id The block's id.
	 * @param string $content   The paragraph's content.
	 * @return \Yjs\Types\YMap The block.
	 */
	private function paragraph_block( string $client_id, string $content ): \Yjs\Types\YMap {
		$attributes = new \Yjs\Types\YMap();
		$attributes->set( 'content', new \Yjs\Types\YText( $content ) );

		$block = new \Yjs\Types\YMap();
		$block->set( 'name', 'core/paragraph' );
		$block->set( 'clientId', $client_id );
		$block->set( 'isValid', true );
		$block->set( 'attributes', $attributes );
		$block->set( 'innerBlocks', new \Yjs\Types\YArray() );

		return $block;
	}

	/**
	 * The filtered author catches up on the room and makes one more edit.
	 *
	 * @param callable $edit The edit, given the author's document.
	 * @return void
	 */
	private function author_edits( callable $edit ): void {
		wp_set_current_user( self::$author_id );
		// Read as a client that has sent nothing, so the document holds
		// every row. A client's own rows are left out of its reads.
		$response = $this->engine()->get_updates_since( $this->room(), 909, 0, array() );
		$doc      = $this->client_doc_from_response( $response );
		$update   = $this->encode_edit( $doc, $edit );
		$result   = $this->engine()->handle_updates(
			$this->room(),
			101,
			(int) $response['end_cursor'],
			array(
				array(
					'type' => 'update',
					'data' => $update,
				),
			),
			array()
		);
		$this->assertSame( array( array( 'status' => 'applied' ) ), $result['dispositions'] );
	}

	/**
	 * The `held-resolved` rows a fresh client reads, by hold id.
	 *
	 * @return array<string, string> Hold id => resolution.
	 */
	private function closed_holds(): array {
		$closed = array();
		$rows   = $this->rows_of_type(
			$this->engine()->get_updates_since( $this->room(), 202, 0, array() ),
			WP_Yjs_Server_Engine::UPDATE_TYPE_HELD_RESOLVED
		);
		foreach ( $rows as $row ) {
			$closed[ $row['holdId'] ] = $row['resolution'];
		}
		return $closed;
	}

	public function test_a_hold_on_another_block_at_the_same_position_leaves_the_open_hold_alone() {
		$first = $this->raise_hold();
		$this->assertSame( 0, $first['index'] );

		// The author puts a new block with a script ABOVE the held block.
		// The held block moves to the second position, and the new hold
		// is on the first position, where the open hold was raised.
		$this->author_edits(
			function ( $doc ) {
				$doc->getMap( 'document' )->get( 'blocks' )->insert(
					0,
					array( $this->paragraph_block( 'inserted-above', 'Above <script>alert(2)</script>' ) )
				);
			}
		);

		$holds = $this->engine()->get_open_holds( $this->room() );
		$this->assertCount( 2, $holds, 'a hold on another block must not close the open one' );
		$this->assertArrayHasKey( $first['holdId'], $holds );
		$this->assertSame( array(), $this->closed_holds() );
		unset( $holds[ $first['holdId'] ] );
		$second = array_values( $holds )[0];
		$this->assertSame( 0, $second['index'] );
		$this->assertStringContainsString( 'alert(2)', $second['held'] );
		$this->assertSame( '', $second['base'], 'a new block has no earlier form' );

		// The author writes into the block of the first hold again. It is
		// on the second position now.
		$this->author_edits(
			function ( $doc ) use ( $first ) {
				$block = $doc->getMap( 'document' )->get( 'blocks' )->get( 1 );
				$this->assertSame( $first['blockId'], $block->get( 'clientId' ) );
				$block->get( 'attributes' )->get( 'content' )->insert( 0, '<script>alert(3)</script>' );
			}
		);

		$holds = $this->engine()->get_open_holds( $this->room() );
		$this->assertCount( 2, $holds, 'one review task per author and block' );
		$this->assertArrayNotHasKey( $first['holdId'], $holds, 'the newer hold over the same block replaces the open one' );
		$this->assertArrayHasKey( $second['holdId'], $holds, 'the hold on the other block stays open' );
		unset( $holds[ $second['holdId'] ] );
		$third = array_values( $holds )[0];
		$this->assertSame( 1, $third['index'] );
		$this->assertStringContainsString( 'alert(3)', $third['held'] );
		$this->assertSame( $first['base'], $third['base'] );
		$this->assertSame( array( $first['holdId'] => 'superseded' ), $this->closed_holds() );
	}

	/**
	 * The id of a top-level block, as a fresh client reads it.
	 *
	 * @param int $index The block's position.
	 * @return string|null The id, or null when no block is there.
	 */
	private function block_id_at( int $index ): ?string {
		$doc    = $this->client_doc_from_response( $this->engine()->get_updates_since( $this->room(), 808, 0, array() ) );
		$blocks = $doc->getMap( 'document' )->get( 'blocks' );
		if ( $index >= $blocks->length ) {
			return null;
		}

		return $blocks->get( $index )->get( 'clientId' );
	}

	/**
	 * A second filtered user writes a script into the first block.
	 *
	 * @param string $markup The markup they put at the start of the block.
	 * @return void
	 */
	private function second_filtered_author_edits_the_first_block( string $markup ): void {
		wp_set_current_user( self::$contributor_id );
		$response = $this->engine()->get_updates_since( $this->room(), 303, 0, array() );
		$doc      = $this->client_doc_from_response( $response );
		$update   = $this->encode_edit(
			$doc,
			function ( $doc ) use ( $markup ) {
				$this->first_block_content( $doc )->insert( 0, $markup );
			}
		);
		$result   = $this->engine()->handle_updates(
			$this->room(),
			303,
			(int) $response['end_cursor'],
			array(
				array(
					'type' => 'update',
					'data' => $update,
				),
			),
			array()
		);
		$this->assertSame( array( array( 'status' => 'applied' ) ), $result['dispositions'] );
	}

	/**
	 * An editor approves a hold with the given content, the way the
	 * review dialog does after a peer changed the block: the first try
	 * is refused and answers with the block as it reads now, and the
	 * second try names that block.
	 *
	 * @param string $hold_id The hold.
	 * @param string $content The approved content.
	 * @return array The disposition of the second try.
	 */
	private function approve_after_a_refusal( string $hold_id, string $content ): array {
		wp_set_current_user( self::$editor_id );
		$holds   = $this->engine()->get_open_holds( $this->room() );
		$refused = $this->engine()->resolve_hold( $this->room(), $hold_id, 'accepted', $content, $holds[ $hold_id ]['sanitized'] );
		$this->assertWPError( $refused );
		$this->assertSame( 'review_stale', $refused->get_error_code() );

		$seen        = $refused->get_error_data()['hold']['sanitized'];
		$disposition = $this->engine()->resolve_hold( $this->room(), $hold_id, 'accepted', $content, $seen );
		$this->assertIsArray( $disposition );

		return $disposition;
	}

	public function test_a_sanitized_block_keeps_its_id() {
		$id_before = $this->block_id_at( 0 );
		$hold      = $this->raise_hold();

		$this->assertSame( $id_before, $hold['blockId'], 'the hold names the block by the id it had' );
		$this->assertSame( $id_before, $this->block_id_at( 0 ), 'the sanitized form is the same block to every editor' );
	}

	public function test_a_second_authors_hold_on_a_block_leaves_the_first_authors_hold_on_it() {
		$first = $this->raise_hold();

		$this->second_filtered_author_edits_the_first_block( '<script>alert(2)</script>' );

		$holds = $this->engine()->get_open_holds( $this->room() );
		$this->assertCount( 2, $holds, 'one hold per author' );
		$this->assertArrayHasKey( $first['holdId'], $holds );
		unset( $holds[ $first['holdId'] ] );
		$second = array_values( $holds )[0];
		$this->assertSame( self::$contributor_id, $second['author'] );
		$this->assertSame( $first['blockId'], $second['blockId'], 'both holds name one block' );
		$this->assertSame( $first['blockId'], $this->block_id_at( 0 ), 'sanitizing the block again keeps its id' );

		// Approving the first author's hold still changes the block.
		$approved    = "<!-- wp:paragraph -->\n<p>Approved for the first author</p>\n<!-- /wp:paragraph -->";
		$disposition = $this->approve_after_a_refusal( $first['holdId'], $approved );
		$this->assertTrue( $disposition['applied'], 'the approval must find the block' );
		$this->assertStringContainsString( 'Approved for the first author', (string) $this->engine()->materialize( $this->room() ) );

		// The approved block keeps the id too, so the second author's
		// hold is still open, still names the block, and can be approved.
		$this->assertSame( $first['blockId'], $this->block_id_at( 0 ) );
		$this->assertSame( array( $second['holdId'] ), array_keys( $this->engine()->get_open_holds( $this->room() ) ) );

		$approved    = "<!-- wp:paragraph -->\n<p>Approved for the second author</p>\n<!-- /wp:paragraph -->";
		$disposition = $this->approve_after_a_refusal( $second['holdId'], $approved );
		$this->assertTrue( $disposition['applied'] );
		$this->assertStringContainsString( 'Approved for the second author', (string) $this->engine()->materialize( $this->room() ) );
		$this->assertSame( array(), $this->engine()->get_open_holds( $this->room() ) );
	}

	public function test_the_first_author_writing_again_replaces_their_own_hold_after_a_second_authors_hold() {
		$first = $this->raise_hold();
		$this->second_filtered_author_edits_the_first_block( '<script>alert(2)</script>' );

		// The first author writes into the block once more.
		$this->author_edits(
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 0, '<script>alert(3)</script>' );
			}
		);

		$holds = $this->engine()->get_open_holds( $this->room() );
		$this->assertCount( 2, $holds, 'still one hold per author' );
		$this->assertArrayNotHasKey( $first['holdId'], $holds, "the first author's newer hold replaces their open one" );
		$this->assertSame( array( $first['holdId'] => 'superseded' ), $this->closed_holds() );
		foreach ( $holds as $hold ) {
			$this->assertSame( $first['blockId'], $hold['blockId'] );
		}
	}

	/**
	 * The author adds a block that holds nothing but a script, so the
	 * filter leaves nothing of it and the hold has no block to name.
	 *
	 * Only classic content, which has no block comment, can be removed
	 * entirely. The engine reads its text only while the classic block
	 * is not registered on the server, so it is unregistered for the edit.
	 *
	 * @param int $index Where the author puts the block.
	 * @return array The open hold.
	 */
	private function raise_hold_for_a_removed_block( int $index ): array {
		$registry = WP_Block_Type_Registry::get_instance();
		$classic  = $registry->get_registered( 'core/freeform' );
		if ( null !== $classic ) {
			$registry->unregister( 'core/freeform' );
		}

		try {
			$this->author_edits(
				function ( $doc ) use ( $index ) {
					$block = $this->paragraph_block( 'removed', '<script></script>' );
					$block->set( 'name', 'core/freeform' );
					$doc->getMap( 'document' )->get( 'blocks' )->insert( $index, array( $block ) );
				}
			);
		} finally {
			if ( null !== $classic ) {
				$registry->register( $classic );
			}
		}

		$holds = array_values( $this->engine()->get_open_holds( $this->room() ) );
		$this->assertCount( 1, $holds, 'the removed block must be held' );
		$this->assertNull( $holds[0]['blockId'] );
		$this->assertSame( $index, $holds[0]['index'] );

		return $holds[0];
	}

	public function test_a_second_try_at_a_block_the_filter_removed_replaces_its_hold() {
		$first = $this->raise_hold_for_a_removed_block( 1 );

		// The author tries again in the same place.
		$this->author_edits(
			function ( $doc ) {
				$doc->getMap( 'document' )->get( 'blocks' )->insert(
					1,
					array( $this->paragraph_block( 'second-try', 'Again <script>alert(2)</script>' ) )
				);
			}
		);

		$holds = array_values( $this->engine()->get_open_holds( $this->room() ) );
		$this->assertCount( 1, $holds, 'one review task for the two tries' );
		$this->assertStringContainsString( 'alert(2)', $holds[0]['held'] );
		$this->assertSame( array( $first['holdId'] => 'superseded' ), $this->closed_holds() );
	}

	public function test_a_hold_for_a_removed_block_is_not_replaced_by_a_hold_on_a_block_that_was_already_there() {
		// The filter removes the author's new first block entirely.
		$first = $this->raise_hold_for_a_removed_block( 0 );

		// The author then writes a script into the paragraph that was in
		// the post all along. It sits on the same position.
		$this->author_edits(
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 11, ' <script>alert(2)</script>' );
			}
		);

		$holds = $this->engine()->get_open_holds( $this->room() );
		$this->assertCount( 2, $holds, 'the two holds are about different blocks' );
		$this->assertArrayHasKey( $first['holdId'], $holds );
		$this->assertSame( array(), $this->closed_holds() );
		unset( $holds[ $first['holdId'] ] );
		$second = array_values( $holds )[0];
		$this->assertSame( 0, $second['index'] );
		$this->assertStringContainsString( 'Hello world', $second['base'], 'the newer hold keeps its own base' );
	}

	/**
	 * A peer who may publish unfiltered HTML catches up on the room and
	 * makes one edit.
	 *
	 * @param callable $edit The edit, given the peer's document.
	 * @return void
	 */
	private function editor_edits( callable $edit ): void {
		wp_set_current_user( self::$editor_id );
		$response = $this->engine()->get_updates_since( $this->room(), 707, 0, array() );
		$doc      = $this->client_doc_from_response( $response );
		$update   = $this->encode_edit( $doc, $edit );
		$result   = $this->engine()->handle_updates(
			$this->room(),
			202,
			(int) $response['end_cursor'],
			array(
				array(
					'type' => 'update',
					'data' => $update,
				),
			),
			array()
		);
		$this->assertSame( array( array( 'status' => 'applied' ) ), $result['dispositions'] );
	}

	/**
	 * An editor approves a hold with the given content, against the
	 * block as it reads at that moment.
	 *
	 * @param string $hold_id The hold.
	 * @param string $content The approved content.
	 * @return array The disposition.
	 */
	private function approve( string $hold_id, string $content ): array {
		wp_set_current_user( self::$editor_id );
		$disposition = $this->engine()->resolve_hold( $this->room(), $hold_id, 'accepted', $content );
		if ( is_wp_error( $disposition ) && 'review_stale' === $disposition->get_error_code() ) {
			$seen        = $disposition->get_error_data()['hold']['sanitized'];
			$disposition = $this->engine()->resolve_hold( $this->room(), $hold_id, 'accepted', $content, $seen );
		}
		$this->assertIsArray( $disposition );

		return $disposition;
	}

	/**
	 * The text of each top-level block, as a fresh client reads the
	 * document.
	 *
	 * @return string[] One text per block, in order.
	 */
	private function block_texts(): array {
		$doc   = $this->client_doc_from_response( $this->engine()->get_updates_since( $this->room(), 808, 0, array() ) );
		$texts = array();
		foreach ( $doc->getMap( 'document' )->get( 'blocks' )->toArray() as $block ) {
			$content = $block->get( 'attributes' )->get( 'content' );
			$texts[] = null === $content ? '' : $content->toString();
		}

		return $texts;
	}

	public function test_removing_a_held_block_closes_its_hold() {
		$hold = $this->raise_hold();

		// A peer adds a block. Nothing was removed, so the hold stays.
		$this->editor_edits(
			function ( $doc ) {
				$doc->getMap( 'document' )->get( 'blocks' )->insert( 1, array( $this->paragraph_block( 'other', 'Another block' ) ) );
			}
		);
		$this->editor_edits(
			function ( $doc ) {
				$doc->getMap( 'document' )->get( 'blocks' )->delete( 1, 1 );
			}
		);
		$this->assertArrayHasKey( $hold['holdId'], $this->engine()->get_open_holds( $this->room() ), 'removing another block leaves the hold alone' );
		$this->assertSame( array(), $this->closed_holds() );

		// The peer removes the held block.
		$this->editor_edits(
			function ( $doc ) {
				$doc->getMap( 'document' )->get( 'blocks' )->delete( 0, 1 );
			}
		);

		$this->assertSame( array(), $this->engine()->get_open_holds( $this->room() ), 'a hold with no block left to approve must close' );
		$this->assertSame( array( $hold['holdId'] => 'block-removed' ), $this->closed_holds() );

		// A client reads the removal before the closed hold.
		$types = array_column( $this->engine()->get_updates_since( $this->room(), 606, 0, array() )['updates'], 'type' );
		$this->assertSame( WP_Yjs_Server_Engine::UPDATE_TYPE_HELD_RESOLVED, end( $types ) );
	}

	public function test_a_held_block_moved_into_a_group_keeps_its_hold_and_can_be_approved_there() {
		$hold = $this->raise_hold();

		// A peer wraps the held block in a group: the block leaves the
		// top level and comes back, under the same id, inside the group.
		$this->editor_edits(
			function ( $doc ) {
				$blocks = $doc->getMap( 'document' )->get( 'blocks' );
				$group  = new \Yjs\Types\YMap();
				$inner  = new \Yjs\Types\YArray();
				$inner->push( array( $blocks->get( 0 )->clone() ) );
				$group->set( 'name', 'core/group' );
				$group->set( 'clientId', 'the-group' );
				$group->set( 'isValid', true );
				$group->set( 'attributes', new \Yjs\Types\YMap() );
				$group->set( 'innerBlocks', $inner );
				$blocks->delete( 0, 1 );
				$blocks->insert( 0, array( $group ) );
			}
		);

		$this->assertArrayHasKey( $hold['holdId'], $this->engine()->get_open_holds( $this->room() ), 'the block is still in the document' );
		$this->assertSame( array(), $this->closed_holds() );

		$disposition = $this->approve( $hold['holdId'], "<!-- wp:paragraph -->\n<p>Approved inside</p>\n<!-- /wp:paragraph -->" );
		$this->assertTrue( $disposition['applied'], 'the approval must find the block inside the group' );

		$materialized = (string) $this->engine()->materialize( $this->room() );
		$this->assertMatchesRegularExpression( '#<!-- wp:group.*Approved inside.*<!-- /wp:group -->#s', $materialized );
		$this->assertSame( 'the-group', $this->block_id_at( 0 ) );
		$this->assertNull( $this->block_id_at( 1 ), 'nothing lands at the top level' );
	}

	public function test_an_approval_that_removes_the_block_closes_another_authors_hold_on_it() {
		$first = $this->raise_hold();
		$this->second_filtered_author_edits_the_first_block( '<script>alert(2)</script>' );
		$holds = $this->engine()->get_open_holds( $this->room() );
		unset( $holds[ $first['holdId'] ] );
		$second = array_values( $holds )[0];

		// The reviewer decides the first hold with "remove the block".
		$disposition = $this->approve( $first['holdId'], '' );
		$this->assertTrue( $disposition['applied'] );

		$this->assertSame( array(), $this->engine()->get_open_holds( $this->room() ) );
		$this->assertSame(
			array(
				$second['holdId'] => 'block-removed',
				$first['holdId']  => 'accepted',
			),
			$this->closed_holds()
		);
	}

	public function test_a_hold_with_no_block_is_approved_after_the_block_that_was_before_it() {
		// The filter removes the author's new block, which came right
		// after the paragraph the post starts with.
		$first_id = $this->block_id_at( 0 );
		$hold     = $this->raise_hold_for_a_removed_block( 1 );
		$this->assertSame( $first_id, $hold['afterId'] );

		// A peer adds two blocks at the top. The recorded position (1)
		// now points between them.
		$this->editor_edits(
			function ( $doc ) {
				$doc->getMap( 'document' )->get( 'blocks' )->insert(
					0,
					array(
						$this->paragraph_block( 'top-1', 'Top one' ),
						$this->paragraph_block( 'top-2', 'Top two' ),
					)
				);
			}
		);

		$disposition = $this->approve( $hold['holdId'], "<!-- wp:paragraph -->\n<p>Approved</p>\n<!-- /wp:paragraph -->" );
		$this->assertTrue( $disposition['applied'] );
		$this->assertSame( array( 'Top one', 'Top two', 'Hello world', 'Approved' ), $this->block_texts() );
	}

	public function test_a_hold_with_no_block_at_the_start_is_approved_at_the_start() {
		$hold = $this->raise_hold_for_a_removed_block( 0 );
		$this->assertSame( '', $hold['afterId'] );

		$this->editor_edits(
			function ( $doc ) {
				$doc->getMap( 'document' )->get( 'blocks' )->push( array( $this->paragraph_block( 'last', 'Last' ) ) );
			}
		);

		$this->approve( $hold['holdId'], "<!-- wp:paragraph -->\n<p>Approved</p>\n<!-- /wp:paragraph -->" );
		$this->assertSame( array( 'Approved', 'Hello world', 'Last' ), $this->block_texts() );
	}

	public function test_a_hold_with_no_block_is_approved_at_the_end_when_its_neighbour_is_gone() {
		$hold = $this->raise_hold_for_a_removed_block( 1 );

		// A peer adds a block at the end, then removes the paragraph the
		// hold came after.
		$this->editor_edits(
			function ( $doc ) {
				$blocks = $doc->getMap( 'document' )->get( 'blocks' );
				$blocks->push( array( $this->paragraph_block( 'last', 'Last' ) ) );
				$blocks->delete( 0, 1 );
			}
		);
		$this->assertArrayHasKey( $hold['holdId'], $this->engine()->get_open_holds( $this->room() ), 'the hold names no block, so no removal closes it' );

		$this->approve( $hold['holdId'], "<!-- wp:paragraph -->\n<p>Approved</p>\n<!-- /wp:paragraph -->" );
		$this->assertSame( array( 'Last', 'Approved' ), $this->block_texts() );
	}

	public function test_a_hold_from_before_the_neighbour_was_recorded_is_approved_at_its_recorded_position() {
		$hold = $this->raise_hold_for_a_removed_block( 1 );

		// The hold as an earlier version of the plugin stored it.
		$storage = new WP_Sync_Table_Storage();
		$ledger  = $storage->get_room_meta( $this->room(), WP_Yjs_Server_Engine::META_HELD );
		unset( $ledger[ $hold['holdId'] ]['afterId'] );
		$storage->set_room_meta( $this->room(), WP_Yjs_Server_Engine::META_HELD, $ledger );

		$this->editor_edits(
			function ( $doc ) {
				$doc->getMap( 'document' )->get( 'blocks' )->insert( 0, array( $this->paragraph_block( 'top', 'Top' ) ) );
			}
		);

		$this->approve( $hold['holdId'], "<!-- wp:paragraph -->\n<p>Approved</p>\n<!-- /wp:paragraph -->" );
		$this->assertSame( array( 'Top', 'Approved', 'Hello world' ), $this->block_texts() );
	}

	public function test_privileged_markup_raises_no_hold() {
		$response = $this->engine()->get_updates_since( $this->room(), 101, 0, array() );
		$doc      = $this->client_doc_from_response( $response );
		$update   = $this->encode_edit(
			$doc,
			function ( $doc ) {
				$this->first_block_content( $doc )->insert( 11, ' <script>alert(1)</script>' );
			}
		);
		$this->engine()->handle_updates(
			$this->room(),
			101,
			(int) $response['end_cursor'],
			array(
				array(
					'type' => 'update',
					'data' => $update,
				),
			),
			array()
		);
		$this->assertSame( array(), $this->engine()->get_open_holds( $this->room() ) );
	}

	/**
	 * Dispatches a resolve POST as the client's REST review lane does.
	 *
	 * @param array $params Request body params.
	 * @return WP_REST_Response Response.
	 */
	private function dispatch_resolve( array $params ): WP_REST_Response {
		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/yjs-server/resolve' );
		$request->set_body_params( $params );
		return rest_get_server()->dispatch( $request );
	}

	/**
	 * Makes the filtered author the owner of the test post, so they may
	 * edit it (an Author can only edit their own posts). The test's
	 * transaction rolls the change back.
	 *
	 * @return void
	 */
	private function give_the_post_to_the_author(): void {
		global $wpdb;
		$wpdb->update( $wpdb->posts, array( 'post_author' => self::$author_id ), array( 'ID' => self::$post_id ) );
		clean_post_cache( self::$post_id );
	}

	public function test_hold_decisions_travel_over_the_rest_review_lane() {
		$this->give_the_post_to_the_author();
		$hold = $this->raise_hold();
		$this->assertArrayHasKey( '/wp-sync/v1/yjs-server/resolve', rest_get_server()->get_routes() );

		// The filtered author may edit the post, but cannot approve.
		$forbidden = $this->dispatch_resolve(
			array(
				'room'       => $this->room(),
				'holdId'     => $hold['holdId'],
				'resolution' => 'accepted',
			)
		);
		$this->assertSame( 403, $forbidden->get_status() );
		$this->assertSame( 'rest_sync_forbidden', $forbidden->get_data()['code'] );

		wp_set_current_user( self::$editor_id );
		$accepted = $this->dispatch_resolve(
			array(
				'room'       => $this->room(),
				'holdId'     => $hold['holdId'],
				'resolution' => 'accepted',
				'content'    => $hold['held'],
			)
		);
		$this->assertSame( 200, $accepted->get_status() );
		$this->assertSame( 'resolved', $accepted->get_data()['disposition']['status'] );
		$this->assertStringContainsString( '<script>alert(1)</script>', (string) $this->engine()->materialize( $this->room() ) );
	}

	public function test_the_review_lane_answers_a_stale_approval_with_a_conflict() {
		$hold = $this->raise_hold();
		$this->peer_edits_the_held_block( 'PEER EDIT ' );

		$response = $this->dispatch_resolve(
			array(
				'room'       => $this->room(),
				'holdId'     => $hold['holdId'],
				'resolution' => 'accepted',
				'content'    => $hold['held'],
				// The sanitized block the reviewer saw.
				'current'    => $hold['sanitized'],
			)
		);

		$this->assertSame( 409, $response->get_status() );
		$data = $response->get_data();
		$this->assertSame( 'review_stale', $data['code'] );
		// The answer carries the hold with the block as it reads now.
		$this->assertSame( $hold['holdId'], $data['data']['hold']['holdId'] );
		$this->assertStringContainsString( 'PEER EDIT', $data['data']['hold']['sanitized'] );
		$this->assertStringNotContainsString( '<script>', (string) $this->engine()->materialize( $this->room() ) );
	}

	public function test_the_review_lane_refuses_a_user_who_cannot_edit_the_rooms_post() {
		$hold   = $this->raise_hold();
		$before = (string) $this->engine()->materialize( $this->room() );

		// A Contributor has edit_posts, but not edit_post on the Editor's post.
		wp_set_current_user( self::$contributor_id );
		foreach ( array( 'dismissed', 'accepted' ) as $resolution ) {
			$response = $this->dispatch_resolve(
				array(
					'room'       => $this->room(),
					'holdId'     => $hold['holdId'],
					'resolution' => $resolution,
					'content'    => $hold['held'],
				)
			);
			$this->assertSame( 403, $response->get_status(), $resolution );
			$this->assertSame( 'rest_cannot_edit', $response->get_data()['code'], $resolution );
		}

		// The hold is still open and the block is unchanged.
		$this->assertCount( 1, $this->engine()->get_open_holds( $this->room() ) );
		$this->assertSame( $before, (string) $this->engine()->materialize( $this->room() ) );

		// A room name that does not parse is a bad request.
		wp_set_current_user( self::$editor_id );
		$unparseable = $this->dispatch_resolve(
			array(
				'room'       => 'not-a-room',
				'holdId'     => $hold['holdId'],
				'resolution' => 'dismissed',
			)
		);
		$this->assertSame( 400, $unparseable->get_status() );
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
