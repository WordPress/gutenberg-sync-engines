<?php
/**
 * Tests for revision-backed base resolution: a proposal whose
 * base aged out of the room's snapshot window resolves from a revision's
 * embedded sync-meta instead of voiding.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpDeRtcRevisionBases extends WP_UnitTestCase {
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
	 * Drives the room far enough that v1 ages out of the 20-version
	 * snapshot window.
	 *
	 * @param string $room    Room identifier.
	 * @param string $content Starting content (v1 canonical).
	 * @return string The final canonical content.
	 */
	private function advance_past_window( string $room, string $content ): string {
		$engine = $this->engine();
		for ( $i = 2; $i <= 25; $i++ ) {
			$marker = 2 === $i ? 'Alpha block' : 'Alpha v' . ( $i - 1 ) . ' block';
			$next   = str_replace( $marker, "Alpha v{$i} block", $content );
			$this->assertNotSame( $content, $next, "Each advance must actually change the content (v{$i})." );
			$result = $engine->handle_updates( $room, 400 + $i, 0, array( $this->proposal( "p-{$i}", 'v' . ( $i - 1 ), $next ) ), array() );
			$this->assertSame( 'applied', $result['dispositions'][0]['status'], "Advance to v{$i} must apply." );
			$content = $next;
		}
		return $content;
	}

	public function test_aged_out_base_resolves_from_a_revision() {
		$post_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
		$room    = 'postType/post:' . $post_id;
		$this->assertSame( $this->genesis( $post_id ), $this->engine()->materialize( $room ) );

		// An aware save at v1 writes the lineage (and thus a revision
		// carrying v1's snapshot) — then the room advances far past the
		// window.
		wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
		$this->assertNotEmpty( wp_get_post_revisions( $post_id ) );
		$this->advance_past_window( $room, $this->genesis( $post_id ) );

		// A deep-lagged client proposes from v1, editing the untouched
		// Beta block. The room no longer holds v1 — the revision does.
		$engine   = $this->engine();
		$proposed = str_replace( 'Beta block original text.', 'Beta from the deep past.', $this->genesis( $post_id ) );
		$result   = $engine->handle_updates( $room, 500, 0, array( $this->proposal( 'p-lagged', 'v1', $proposed ) ), array() );

		$this->assertSame( 'applied', $result['dispositions'][0]['status'], 'An aged-out base carried by a revision must merge, not void.' );
		$final = $this->engine()->materialize( $room );
		$this->assertStringContainsString( 'Beta from the deep past.', $final );
		$this->assertStringContainsString( 'Alpha v25 block', $final, 'The intervening session work must survive.' );
	}

	public function test_aged_out_base_without_any_revision_still_voids() {
		$post_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
		$room    = 'postType/post:' . $post_id;
		$this->assertSame( $this->genesis( $post_id ), $this->engine()->materialize( $room ) );

		// No aware save ever happened: no revision carries v1.
		$this->advance_past_window( $room, $this->genesis( $post_id ) );

		$engine   = $this->engine();
		$proposed = str_replace( 'Beta block original text.', 'Beta from the deep past.', $this->genesis( $post_id ) );
		$result   = $engine->handle_updates( $room, 501, 0, array( $this->proposal( 'p-lagged', 'v1', $proposed ) ), array() );

		$this->assertSame( 'voided', $result['dispositions'][0]['status'] );
		$this->assertSame( 'unknown-base-version', $result['dispositions'][0]['reason'], 'With no lineage anywhere, the deep-lag contract stands.' );
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
}
