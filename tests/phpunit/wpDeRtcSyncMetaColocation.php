<?php
/**
 * Tests for DE-RTC sync-meta co-location with post_content:
 * the save path embeds the room's sync metadata, revisions carry it,
 * and genesis adopts it back — version lineage included.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpDeRtcSyncMetaColocation extends WP_UnitTestCase {
	/**
	 * Editor user ID.
	 *
	 * @var int
	 */
	protected static $editor_id;

	const GENESIS_CONTENT = "<!-- wp:paragraph -->\n<p>Alpha block original text.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Beta block original text.</p>\n<!-- /wp:paragraph -->";

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id = $factory->user->create( array( 'role' => 'editor' ) );
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::$editor_id );
		WP_De_RTC_Sync_Meta_Colocation::register();
	}

	private function engine(): WP_De_RTC_Engine {
		return new WP_De_RTC_Engine( new WP_Sync_Table_Storage() );
	}

	private function make_post(): int {
		return self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_title'   => 'Co-location test post',
				'post_content' => self::GENESIS_CONTENT,
			)
		);
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

	/**
	 * Bootstraps a de-rtc room for a post and advances it one version.
	 *
	 * @param int $post_id Post ID.
	 * @return string The room identifier.
	 */
	private function bootstrap_room( int $post_id ): string {
		$room   = 'postType/post:' . $post_id;
		$engine = $this->engine();
		$this->assertSame( $this->genesis( $post_id ), $engine->materialize( $room ) );

		$proposed = str_replace( 'Alpha block original text.', 'Alpha block collaborated text.', $this->genesis( $post_id ) );
		$result   = $engine->handle_updates( $room, 201, 0, array( $this->proposal( 'p-1', 'v1', $proposed ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertSame( 'v2', $result['dispositions'][0]['version'] );

		return $room;
	}

	public function test_save_embeds_sync_meta_for_de_rtc_rooms() {
		$post_id = $this->make_post();
		$this->bootstrap_room( $post_id );

		wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => str_replace( 'Alpha block original text.', 'Alpha block collaborated text.', $this->genesis( $post_id ) ),
			)
		);

		$saved = get_post( $post_id )->post_content;
		$this->assertStringContainsString( 'data-wp-sync-meta="distributed-editing"', $saved );

		$parsed = wp_de_rtc_parse_post_content_sync_meta( $saved );
		$this->assertIsArray( $parsed );
		$this->assertSame( 'trailer', $parsed['sync_meta_position'] );
		$this->assertSame( 'v2', $parsed['sync_meta']['room_version'] );
		$this->assertSame( 2, $parsed['sync_meta']['room_version_seq'] );
		$this->assertArrayHasKey( 'version_snapshots', $parsed['sync_meta'] );
		$this->assertStringContainsString( 'Alpha block collaborated text.', $parsed['content'] );
	}

	public function test_save_without_room_is_untouched() {
		$post_id = $this->make_post();

		wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);

		$this->assertStringNotContainsString( 'data-wp-sync-meta', get_post( $post_id )->post_content );
	}

	public function test_repeated_saves_do_not_accumulate_embeds() {
		$post_id = $this->make_post();
		$this->bootstrap_room( $post_id );

		wp_update_post( array( 'ID' => $post_id ) );
		$content_once = get_post( $post_id )->post_content;
		wp_update_post( array( 'ID' => $post_id ) );
		$content_twice = get_post( $post_id )->post_content;

		$this->assertSame( 1, wp_de_rtc_count_post_content_sync_meta_scripts( $content_once ) );
		$this->assertSame( 1, wp_de_rtc_count_post_content_sync_meta_scripts( $content_twice ) );
	}

	public function test_revisions_carry_the_embedded_sync_meta() {
		$post_id = $this->make_post();
		$this->bootstrap_room( $post_id );

		wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => str_replace( 'Beta block original text.', 'Beta revised for the revision.', $this->genesis( $post_id ) ),
			)
		);

		$revisions = wp_get_post_revisions( $post_id );
		$this->assertNotEmpty( $revisions, 'The save must have produced a revision.' );
		$latest = array_shift( $revisions );
		$this->assertStringContainsString(
			'data-wp-sync-meta="distributed-editing"',
			$latest->post_content,
			'Revisions are the backup mechanism: they must carry the lineage.'
		);
	}

	public function test_genesis_resumes_lineage_from_embedded_meta() {
		$post_id = $this->make_post();
		$room    = $this->bootstrap_room( $post_id );

		// Save so post_content carries v2 lineage.
		wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => str_replace( 'Alpha block original text.', 'Alpha block collaborated text.', $this->genesis( $post_id ) ),
			)
		);

		// Simulate a room reset (engine flip / stale-room cleanup): the
		// room's rows disappear, the saved post is all that remains.
		$storage = new WP_Sync_Table_Storage();
		$this->assertTrue( $storage->get_room_size( $room )['found'] );
		$this->assertTrue( $storage->reset_room( $room ) );
		$this->assertFalse( $storage->get_room_size( $room )['found'] );

		// A fresh engine re-runs genesis from the saved post: lineage must
		// RESUME at v2 (adopted), not restart at v1.
		$engine       = $this->engine();
		$materialized = $engine->materialize( $room );
		$this->assertStringContainsString( 'Alpha block collaborated text.', $materialized );
		$this->assertStringNotContainsString( 'data-wp-sync-meta', $materialized, 'Genesis must strip the pseudo-block from canonical content.' );

		$proposed = str_replace( 'Alpha block collaborated text.', 'Alpha block after the reset.', $materialized );
		$result   = $engine->handle_updates( $room, 202, 0, array( $this->proposal( 'p-2', 'v2', $proposed ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertSame( 'v3', $result['dispositions'][0]['version'], 'The resumed lineage must continue past the adopted version.' );
	}

	/**
	 * The room's genesis content: the saved post with every block stamped
	 * with its deterministic identity (what the room actually serves).
	 *
	 * @param int $post_id Post ID.
	 * @return string Stamped genesis content.
	 */
	private function genesis( int $post_id ): string {
		return WP_De_RTC_Block_Identity::stamp_genesis( self::GENESIS_CONTENT, $post_id );
	}

	/**
	 * A client that parsed a SAVED post carries the co-located sync-meta
	 * script as a stray block (the editor renders it as a freeform block
	 * and proposes it back). The proposal lane strips it exactly as the
	 * save preflight does: bookkeeping never becomes content.
	 */
	public function test_a_proposal_carrying_the_sync_meta_pseudo_block_lands_stripped() {
		$post_id = $this->make_post();
		$room    = 'postType/post:' . $post_id;
		$engine  = $this->engine();
		$genesis = $engine->materialize( $room );
		$this->assertSame( $this->genesis( $post_id ), $genesis );

		$stray    = "\n\n<p><script data-sync-meta-format=\"automerge\" data-wp-sync-meta=\"distributed-editing\" type=\"application/json\">{\"version_snapshots\":{}}</script></p>";
		$proposed = str_replace( 'Alpha block original text.', 'Alpha block edited after a reload.', $genesis ) . $stray;
		$result   = $engine->handle_updates( $room, 201, 0, array( $this->proposal( 'p-stray', 'v1', $proposed ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$canonical = $engine->materialize( $room );
		$this->assertStringContainsString( 'edited after a reload', $canonical );
		$this->assertStringNotContainsString( 'data-wp-sync-meta', $canonical );
		$this->assertStringNotContainsString( '<script', $canonical );
	}

	/**
	 * The editor loads `content.raw` over REST; the co-located script must
	 * not be in it, or the editor parses it as a block and proposes it back.
	 */
	public function test_rest_raw_content_is_served_without_the_sync_meta_script() {
		$post_id = $this->make_post();
		$this->bootstrap_room( $post_id );
		wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
		$this->assertStringContainsString( 'data-wp-sync-meta', get_post( $post_id )->post_content );

		WP_De_RTC_Sync_Meta_Colocation::register_rest_filters();
		$request = new WP_REST_Request( 'GET', '/wp/v2/posts/' . $post_id );
		$request->set_param( 'context', 'edit' );
		$response = rest_get_server()->dispatch( $request );
		$this->assertSame( 200, $response->get_status() );
		$raw = $response->get_data()['content']['raw'];
		$this->assertStringNotContainsString( 'data-wp-sync-meta', $raw );
		$this->assertStringContainsString( 'Alpha block', $raw );
	}
}
