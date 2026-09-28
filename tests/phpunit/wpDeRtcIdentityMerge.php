<?php
/**
 * The DE-RTC identity-keyed three-way merge: nested blocks merge
 * block-for-block by `metadata.syncId`, and only true conflicts park.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpDeRtcIdentityMerge extends WP_UnitTestCase {
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

	const NESTED = "<!-- wp:group {\"layout\":{\"type\":\"constrained\"}} -->\n<div class=\"wp-block-group\"><!-- wp:paragraph -->\n<p>Inner one.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Inner two.</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:group -->\n\n<!-- wp:paragraph -->\n<p>Outer.</p>\n<!-- /wp:paragraph -->";

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id = $factory->user->create( array( 'role' => 'editor' ) );
		self::$post_id   = $factory->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_title'   => 'DE-RTC nested post',
				'post_content' => self::NESTED,
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
	 * The stamped nested document (post id 42 for the pure-merge tests).
	 *
	 * @return string Stamped content.
	 */
	private static function base(): string {
		return WP_De_RTC_Block_Identity::stamp_genesis( self::NESTED, 42 );
	}

	/**
	 * The ids of the stamped nested document, by path.
	 *
	 * @return array<string, string> path => syncId.
	 */
	private static function ids(): array {
		$ids = array();
		foreach ( WP_De_RTC_Block_Identity::collect( self::base() ) as $block ) {
			$ids[ implode( '.', $block['path'] ) ] = $block['syncId'];
		}
		return $ids;
	}

	/**
	 * A serialized paragraph carrying an identity.
	 *
	 * @param string $text    Paragraph text.
	 * @param string $sync_id Identity.
	 * @return string Serialized block.
	 */
	private static function paragraph( string $text, string $sync_id ): string {
		return "<!-- wp:paragraph {\"metadata\":{\"syncId\":\"{$sync_id}\"}} -->\n<p>{$text}</p>\n<!-- /wp:paragraph -->";
	}

	public function test_edits_to_different_blocks_inside_one_container_both_land() {
		$base     = self::base();
		$current  = str_replace( 'Inner one.', 'Inner one, by the peer.', $base );
		$proposed = str_replace( 'Inner two.', 'Inner two, by me.', $base );

		$result = WP_De_RTC_Identity_Merge::merge( $base, $current, $proposed );
		$this->assertIsArray( $result );
		$this->assertSame( array(), $result['conflicts'] );
		$this->assertStringContainsString( 'Inner one, by the peer.', $result['merged_content'] );
		$this->assertStringContainsString( 'Inner two, by me.', $result['merged_content'] );
		$this->assertSame( str_replace( 'Inner two.', 'Inner two, by me.', $current ), $result['merged_content'], 'Untouched bytes survive exactly.' );

		// The positional core parks this very case (one opaque Group record
		// changed on both sides) — the reason identity exists.
		$core = wp_de_rtc_get_automerge_retry_save_result( $base, $current, $proposed, null );
		$this->assertWPError( $core );
	}

	public function test_a_nested_insert_lands_next_to_the_sibling_it_followed() {
		$base    = self::base();
		$ids     = self::ids();
		$current = str_replace( 'Outer.', 'Outer, by the peer.', $base );
		// Insert a new paragraph between the two inner ones.
		$proposed = str_replace(
			self::paragraph( 'Inner one.', $ids['0.0'] ),
			self::paragraph( 'Inner one.', $ids['0.0'] ) . "\n\n" . self::paragraph( 'Inserted.', 'new-1' ),
			$base
		);
		$this->assertNotSame( $base, $proposed );

		$result = WP_De_RTC_Identity_Merge::merge( $base, $current, $proposed );
		$this->assertIsArray( $result );
		$this->assertSame( array(), $result['conflicts'] );
		$merged = $result['merged_content'];
		$this->assertStringContainsString( 'Outer, by the peer.', $merged );
		$order = array_map(
			static function ( array $block ): string {
				return implode( '.', $block['path'] ) . ':' . $block['syncId'];
			},
			WP_De_RTC_Block_Identity::collect( $merged )
		);
		$this->assertSame( array( '0:' . $ids['0'], '0.0:' . $ids['0.0'], '0.1:new-1', '0.2:' . $ids['0.1'], '1:' . $ids['1'] ), $order );
		$this->assertIsArray( wp_de_rtc_get_top_level_serialized_block_records( $merged ), 'The rebuilt container round-trips.' );
	}

	public function test_the_same_nested_block_changed_on_both_sides_parks_only_that_block() {
		$base     = self::base();
		$ids      = self::ids();
		$current  = str_replace( 'Inner two.', 'Inner two, rewritten by the peer.', $base );
		$proposed = str_replace( array( 'Inner two.', 'Outer.' ), array( 'Inner two, rewritten by me.', 'Outer, by me.' ), $base );

		$result = WP_De_RTC_Identity_Merge::merge( $base, $current, $proposed );
		$this->assertIsArray( $result );
		$this->assertCount( 1, $result['conflicts'] );
		$conflict = $result['conflicts'][0];
		$this->assertSame( $ids['0.1'], $conflict['syncId'] );
		$this->assertSame( array( 0, 1 ), $conflict['path'] );
		$this->assertSame( 0, $conflict['index'], 'The parked block sits under top-level block 0.' );
		$this->assertStringContainsString( 'Inner two, rewritten by me.', $conflict['html'] );
		$this->assertStringNotContainsString( 'Outer', $conflict['html'], 'Only the conflicting leaf parks.' );

		$merged = $result['merged_content'];
		$this->assertStringContainsString( 'Inner two, rewritten by the peer.', $merged, 'Canonical wins the conflicted block.' );
		$this->assertStringContainsString( 'Outer, by me.', $merged, 'The rest of the proposal lands.' );
	}

	public function test_compatible_edits_to_one_nested_paragraph_merge_through_the_rich_text_lane() {
		$base     = self::base();
		$current  = str_replace( 'Inner one.', 'Peer prefix. Inner one.', $base );
		$proposed = str_replace( 'Inner one.', 'Inner one. My suffix.', $base );

		$result = WP_De_RTC_Identity_Merge::merge( $base, $current, $proposed );
		$this->assertIsArray( $result );
		$this->assertSame( array(), $result['conflicts'] );
		$this->assertStringContainsString( 'Peer prefix. Inner one. My suffix.', $result['merged_content'] );
	}

	public function test_a_move_follows_the_block_and_carries_the_peers_edit() {
		$base = self::base();
		$ids  = self::ids();
		// The peer edits the outer paragraph; I move it into the group.
		$current  = str_replace( 'Outer.', 'Outer, edited by the peer.', $base );
		$proposed = str_replace( "\n\n" . self::paragraph( 'Outer.', $ids['1'] ), '', $base );
		$proposed = str_replace(
			self::paragraph( 'Inner two.', $ids['0.1'] ),
			self::paragraph( 'Inner two.', $ids['0.1'] ) . "\n\n" . self::paragraph( 'Outer.', $ids['1'] ),
			$proposed
		);

		$result = WP_De_RTC_Identity_Merge::merge( $base, $current, $proposed );
		$this->assertIsArray( $result );
		$this->assertSame( array(), $result['conflicts'] );
		$paths = array();
		foreach ( WP_De_RTC_Block_Identity::collect( $result['merged_content'] ) as $block ) {
			$paths[ $block['syncId'] ] = implode( '.', $block['path'] );
		}
		$this->assertSame( '0.2', $paths[ $ids['1'] ], 'The block moved into the group.' );
		$this->assertStringContainsString( 'Outer, edited by the peer.', $result['merged_content'], 'The edit travelled with it.' );
	}

	public function test_a_deletion_beats_a_concurrent_edit_and_the_edit_parks() {
		$base     = self::base();
		$ids      = self::ids();
		$current  = str_replace( 'Inner one.', 'Inner one, edited by the peer.', $base );
		$proposed = str_replace( self::paragraph( 'Inner one.', $ids['0.0'] ) . "\n\n", '', $base );
		$this->assertNotSame( $base, $proposed );

		// I deleted what the peer edited: the deletion applies (as the
		// disposition will say) and the peer's edited form parks.
		$result = WP_De_RTC_Identity_Merge::merge( $base, $current, $proposed );
		$this->assertIsArray( $result );
		$this->assertStringNotContainsString( 'Inner one', $result['merged_content'] );
		$this->assertCount( 1, $result['conflicts'] );
		$this->assertSame( $ids['0.0'], $result['conflicts'][0]['syncId'] );
		$this->assertStringContainsString( 'Inner one, edited by the peer.', $result['conflicts'][0]['html'] );

		// The mirror: the peer deleted what I edited — my edit parks.
		$result = WP_De_RTC_Identity_Merge::merge( $base, $proposed, $current );
		$this->assertIsArray( $result );
		$this->assertStringNotContainsString( 'Inner one', $result['merged_content'] );
		$this->assertCount( 1, $result['conflicts'] );
		$this->assertSame( $ids['0.0'], $result['conflicts'][0]['syncId'] );
		$this->assertStringContainsString( 'Inner one, edited by the peer.', $result['conflicts'][0]['html'] );
	}

	public function test_an_untouched_deletion_is_honoured() {
		$base     = self::base();
		$ids      = self::ids();
		$current  = str_replace( 'Outer.', 'Outer, by the peer.', $base );
		$proposed = str_replace( self::paragraph( 'Inner one.', $ids['0.0'] ) . "\n\n", '', $base );

		$result = WP_De_RTC_Identity_Merge::merge( $base, $current, $proposed );
		$this->assertIsArray( $result );
		$this->assertSame( array(), $result['conflicts'] );
		$this->assertStringNotContainsString( 'Inner one.', $result['merged_content'] );
		$this->assertStringContainsString( 'Outer, by the peer.', $result['merged_content'] );
	}

	public function test_clashing_reorders_inside_a_container_keep_canonical_and_park_the_container() {
		$base = self::base();
		$ids  = self::ids();
		$one  = self::paragraph( 'Inner one.', $ids['0.0'] );
		$two  = self::paragraph( 'Inner two.', $ids['0.1'] );
		// The peer swaps the inner paragraphs; I insert a third between the
		// ORIGINAL order — the common blocks disagree on order.
		$current  = str_replace( $one . "\n\n" . $two, $two . "\n\n" . $one, $base );
		$proposed = str_replace( $one . "\n\n" . $two, $one . "\n\n" . self::paragraph( 'Third.', 'new-3' ) . "\n\n" . $two, $base );

		$result = WP_De_RTC_Identity_Merge::merge( $base, $current, $proposed );
		$this->assertIsArray( $result );
		$this->assertCount( 1, $result['conflicts'] );
		$this->assertSame( $ids['0'], $result['conflicts'][0]['syncId'], 'The container parks.' );
		$this->assertStringContainsString( 'Third.', $result['conflicts'][0]['html'] );
		$this->assertStringContainsString( $two . "\n\n" . $one, $result['merged_content'], 'Canonical order wins.' );
	}

	public function test_identity_declines_without_ids_and_at_the_root_order_clash() {
		$this->assertNull( WP_De_RTC_Identity_Merge::merge( self::NESTED, str_replace( 'Inner one.', 'x', self::NESTED ), str_replace( 'Inner two.', 'y', self::NESTED ) ), 'Unidentified blocks: the positional core decides.' );

		$base    = self::base();
		$ids     = self::ids();
		$group   = substr( $base, 0, strpos( $base, "\n\n<!-- wp:paragraph" ) );
		$outer   = self::paragraph( 'Outer.', $ids['1'] );
		$swapped = $outer . "\n\n" . $group;
		$this->assertNull( WP_De_RTC_Identity_Merge::merge( $base, $swapped, $group . "\n\n" . self::paragraph( 'Appended.', 'new-4' ) . "\n\n" . $outer ) );
	}

	public function test_substitute_replaces_one_identified_block_anywhere() {
		$base   = self::base();
		$ids    = self::ids();
		$source = str_replace( 'Inner two.', 'Inner two, from an older version.', $base );

		$rewritten = WP_De_RTC_Identity_Merge::substitute( $base, $ids['0.1'], $source );
		$this->assertSame( $source, $rewritten );
		$this->assertNull( WP_De_RTC_Identity_Merge::substitute( $base, 'unknown', $source ) );
		$this->assertSame( $ids['1'], WP_De_RTC_Identity_Merge::top_level_id_at( $base, 1 ) );
	}

	public function test_two_sessions_editing_inside_one_group_both_land_through_the_engine() {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = json_decode( $response['updates'][0]['data'], true );
		$this->assertSame( WP_De_RTC_Block_Identity::stamp_genesis( self::NESTED, self::$post_id ), $genesis['content'] );

		$proposal = static function ( string $id, string $base, string $proposed ): array {
			return array(
				'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
				'data' => wp_json_encode(
					array(
						'proposalId'      => $id,
						'baseVersion'     => 'v1',
						'proposedContent' => $proposed,
						'clientUpdate'    => wp_de_rtc_create_automerge_update_for_content_change( $base, $proposed, 'session' ),
					)
				),
			);
		};

		$a = str_replace( 'Inner one.', 'Inner one, by A.', $genesis['content'] );
		$r = $engine->handle_updates( $this->room(), 1, 0, array( $proposal( 'p-a', $genesis['content'], $a ) ), array() );
		$this->assertSame( 'applied', $r['dispositions'][0]['status'] );

		// B still based on v1 edits the OTHER inner paragraph.
		$b = str_replace( 'Inner two.', 'Inner two, by B.', $genesis['content'] );
		$r = $this->engine()->handle_updates( $this->room(), 2, 0, array( $proposal( 'p-b', $genesis['content'], $b ) ), array() );
		$this->assertSame( 'applied', $r['dispositions'][0]['status'] );
		$this->assertArrayNotHasKey( 'parkedBlocks', $r['dispositions'][0] );

		$canonical = $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Inner one, by A.', $canonical );
		$this->assertStringContainsString( 'Inner two, by B.', $canonical );

		// C, also on v1, rewrites the paragraph A rewrote: only that block
		// parks, C's other edit lands.
		$c = str_replace( array( 'Inner one.', 'Outer.' ), array( 'Inner one, by C.', 'Outer, by C.' ), $genesis['content'] );
		$r = $this->engine()->handle_updates( $this->room(), 3, 0, array( $proposal( 'p-c', $genesis['content'], $c ) ), array() );
		$this->assertSame( 'applied', $r['dispositions'][0]['status'] );
		$this->assertSame( 1, $r['dispositions'][0]['parkedBlocks'] );
		$canonical = $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Inner one, by A.', $canonical );
		$this->assertStringContainsString( 'Outer, by C.', $canonical );

		$parked = array_filter(
			$this->engine()->get_updates_since( $this->room(), 4, 0, array() )['updates'],
			static function ( array $row ): bool {
				return WP_De_RTC_Engine::UPDATE_TYPE_PARKED === $row['type'];
			}
		);
		$this->assertCount( 1, $parked );
		$row = json_decode( array_values( $parked )[0]['data'], true );
		$this->assertSame( 'p-c', $row['proposalId'] );
		$this->assertCount( 1, $row['changedBlocks'] );
		$this->assertStringContainsString( 'Inner one, by C.', $row['changedBlocks'][0]['html'] );
		$this->assertSame( array( 0, 0 ), $row['changedBlocks'][0]['path'] );
		$this->assertNotEmpty( $row['changedBlocks'][0]['syncId'] );
	}

	public function test_sequester_by_identity_reverts_only_the_risky_nested_block() {
		$base = self::base();
		$ids  = self::ids();
		// An author without unfiltered_html rewrites Inner one with a
		// script (risky), edits Inner two harmlessly, and appends a risky
		// new Custom HTML block.
		$proposed = str_replace( '<p>Inner one.</p>', '<p>Inner one.<script>alert(1)</script></p>', $base );
		$proposed = str_replace( 'Inner two.', 'Inner two, safely edited.', $proposed );
		$proposed = $proposed . "\n\n<!-- wp:html {\"metadata\":{\"syncId\":\"risky-new\"}} -->\n<script>alert(2)</script>\n<!-- /wp:html -->";

		$result = WP_De_RTC_Identity_Merge::sequester( $base, $proposed );
		$this->assertIsArray( $result );
		$this->assertCount( 2, $result['risky'] );
		$this->assertSame( array( $ids['0.0'], 'risky-new' ), array_column( $result['risky'], 'syncId' ) );
		$this->assertSame( array( 0, 0 ), $result['risky'][0]['path'] );
		$this->assertSame( 0, $result['risky'][0]['index'] );

		$laundered = $result['laundered'];
		$this->assertStringNotContainsString( '<script>', $laundered );
		$this->assertStringContainsString( '<p>Inner one.</p>', $laundered, 'The risky nested block reverts to its base form.' );
		$this->assertStringContainsString( 'Inner two, safely edited.', $laundered, 'The safe sibling inside the same Group lands.' );
		$this->assertStringNotContainsString( 'wp:html', $laundered, 'The risky new block drops.' );
		$this->assertIsArray( wp_de_rtc_get_top_level_serialized_block_records( $laundered ) );

		// Nothing risky: the proposal passes through verbatim.
		$safe = str_replace( 'Inner two.', 'Inner two, safely edited.', $base );
		$this->assertSame(
			array(
				'laundered' => $safe,
				'risky'     => array(),
			),
			WP_De_RTC_Identity_Merge::sequester( $base, $safe )
		);

		// Without identity the lane declines.
		$this->assertNull( WP_De_RTC_Identity_Merge::sequester( self::NESTED, self::NESTED ) );
	}

	public function test_a_filtered_author_keeps_the_safe_half_of_a_group_through_the_engine() {
		$author_id = self::factory()->user->create( array( 'role' => 'author' ) );
		$engine    = $this->engine();
		$response  = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis   = json_decode( $response['updates'][0]['data'], true );

		wp_set_current_user( $author_id );
		$proposed = str_replace( '<p>Inner one.</p>', '<p>Inner one.<script>alert(1)</script></p>', $genesis['content'] );
		$proposed = str_replace( 'Inner two.', 'Inner two, by the author.', $proposed );
		$result   = $engine->handle_updates(
			$this->room(),
			5,
			0,
			array(
				array(
					'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
					'data' => wp_json_encode(
						array(
							'proposalId'      => 'p-filtered',
							'baseVersion'     => 'v1',
							'proposedContent' => $proposed,
							'clientUpdate'    => wp_de_rtc_create_automerge_update_for_content_change( $genesis['content'], $proposed, 'author' ),
						)
					),
				),
			),
			array()
		);
		wp_set_current_user( self::$editor_id );

		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$canonical = $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'Inner two, by the author.', $canonical );
		$this->assertStringContainsString( '<p>Inner one.</p>', $canonical );
		$this->assertStringNotContainsString( '<script>', $canonical );

		$parked = array_values(
			array_filter(
				$this->engine()->get_updates_since( $this->room(), 6, 0, array() )['updates'],
				static function ( array $row ): bool {
					return WP_De_RTC_Engine::UPDATE_TYPE_PARKED === $row['type'];
				}
			)
		);
		$this->assertCount( 1, $parked );
		$row = json_decode( $parked[0]['data'], true );
		$this->assertSame( 'requires-unfiltered-html', $row['reason'] );
		$this->assertCount( 1, $row['changedBlocks'] );
		$this->assertSame( array( 0, 0 ), $row['changedBlocks'][0]['path'] );
		$this->assertStringContainsString( '<script>alert(1)</script>', $row['changedBlocks'][0]['html'] );
		wp_delete_user( $author_id );
	}
}
