<?php
/**
 * Tests for DE-RTC self-healing from unaware writers: the
 * engine detects out-of-band post_content writes, merges them in as
 * ordinary collaborative updates, refuses to roll back stale copies,
 * and parks genuine conflicts for review.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpDeRtcSelfHealing extends WP_UnitTestCase {
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
				'post_title'   => 'Self-healing test post',
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
	 * Writes post_content the way a truly unaware system does: straight
	 * to the database, no filters, no hooks.
	 *
	 * @param int    $post_id Post ID.
	 * @param string $content New content.
	 */
	private function unaware_write( int $post_id, string $content ): void {
		global $wpdb;
		$wpdb->update( $wpdb->posts, array( 'post_content' => $content ), array( 'ID' => $post_id ) );
		clean_post_cache( $post_id );
	}

	public function test_external_replacement_converges_the_room() {
		$post_id = $this->make_post();
		$room    = 'postType/post:' . $post_id;
		$this->assertSame( $this->genesis( $post_id ), $this->engine()->materialize( $room ) );

		// An unaware integration replaces the whole post (no sync-meta).
		$external = "<!-- wp:paragraph -->\n<p>Entirely new external content.</p>\n<!-- /wp:paragraph -->";
		$this->unaware_write( $post_id, $external );

		$healed = $this->engine()->materialize( $room );
		$this->assertStringContainsString( 'Entirely new external content.', $healed, 'The room must converge to the accepted post state.' );

		// The prior canonical survives in row history (nothing wiped).
		$response = $this->engine()->get_updates_since( $room, 999, 0, array() );
		$all_data = implode( ' ', array_column( $response['updates'], 'data' ) );
		$this->assertStringContainsString( 'Alpha block original text.', $all_data, 'Pre-heal content must remain in the row history.' );
	}

	public function test_stale_copy_never_rolls_the_room_back() {
		$post_id = $this->make_post();
		$room    = 'postType/post:' . $post_id;
		$engine  = $this->engine();
		$this->assertSame( $this->genesis( $post_id ), $engine->materialize( $room ) );

		// The session advances past genesis.
		$proposed = str_replace( 'Alpha block original text.', 'Alpha advanced by the session.', $this->genesis( $post_id ) );
		$result   = $engine->handle_updates( $room, 301, 0, array( $this->proposal( 'p-1', 'v1', $proposed ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// An unaware writer re-saves a stale copy (the genesis content).
		$this->unaware_write( $post_id, $this->genesis( $post_id ) );

		$after = $this->engine()->materialize( $room );
		$this->assertStringContainsString( 'Alpha advanced by the session.', $after, 'A stale copy must not roll the room back.' );
	}

	public function test_unchanged_genesis_post_content_never_reads_as_external_work() {
		$post_id = $this->make_post();
		$room    = 'postType/post:' . $post_id;
		$engine  = $this->engine();
		$this->assertSame( $this->genesis( $post_id ), $engine->materialize( $room ) );

		/*
		 * Advance the session far enough that the genesis content ages out
		 * of the bounded version-snapshot window — all on ONE warm engine
		 * instance, so no intermediate room load re-marks the unchanged
		 * post_content as seen. That is the websocket daemon's long-lived
		 * shape, and the engine benchmark's warm session: before the
		 * genesis healed-hash stamp, the FIRST cold load after this point
		 * (a save request) misread the post's own unchanged content as new
		 * out-of-band work and converged the room back to genesis,
		 * discarding every accepted proposal (issue #70).
		 */
		$rounds  = wp_de_rtc_get_automerge_version_snapshot_limit() + 5;
		$alpha   = 'Alpha block original text.';
		$current = $this->genesis( $post_id );
		for ( $i = 1; $i <= $rounds; $i++ ) {
			$next_alpha = $alpha . " s{$i};";
			$next       = str_replace( $alpha, $next_alpha, $current );
			$result     = $engine->handle_updates( $room, 400 + $i, 0, array( $this->proposal( 'p-' . $i, 'v' . $i, $next ) ), array() );
			$this->assertSame( 'applied', $result['dispositions'][0]['status'], "Proposal {$i} must apply." );
			$alpha   = $next_alpha;
			$current = $next;
		}

		// A cold load (a save request's engine instance) must serve the
		// session head, not heal the room back to its own genesis.
		$cold = (string) $this->engine()->materialize( $room );
		$this->assertStringContainsString( ' s1;', $cold, 'The earliest accepted edit must survive a cold load.' );
		$this->assertSame( $current, $cold, 'An unchanged genesis post_content must never be merged back over the session.' );
	}

	public function test_meta_carrying_external_edit_merges_with_concurrent_session_work() {
		$post_id = $this->make_post();
		$room    = 'postType/post:' . $post_id;
		$engine  = $this->engine();
		$this->assertSame( $this->genesis( $post_id ), $engine->materialize( $room ) );

		// An aware save stamps v1 lineage into post_content.
		wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
		$saved = get_post( $post_id )->post_content;
		$this->assertStringContainsString( 'data-wp-sync-meta', $saved );

		// The session advances Alpha AFTER that save.
		$proposed = str_replace( 'Alpha block original text.', 'Alpha advanced by the session.', $this->genesis( $post_id ) );
		$result   = $engine->handle_updates( $room, 302, 0, array( $this->proposal( 'p-1', 'v1', $proposed ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// An unaware writer round-trips the saved copy (meta intact) and
		// edits Beta — a different block, based on v1.
		$external = str_replace( 'Beta block original text.', 'Beta edited externally.', $saved );
		$this->unaware_write( $post_id, $external );

		$healed = $this->engine()->materialize( $room );
		$this->assertStringContainsString( 'Alpha advanced by the session.', $healed, 'Concurrent session work must survive the heal.' );
		$this->assertStringContainsString( 'Beta edited externally.', $healed, 'The external edit must merge in.' );
	}

	public function test_conflicting_external_edit_parks_for_review() {
		$post_id = $this->make_post();
		$room    = 'postType/post:' . $post_id;
		$engine  = $this->engine();
		$this->assertSame( $this->genesis( $post_id ), $engine->materialize( $room ) );

		wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
		$saved = get_post( $post_id )->post_content;

		// Session and external writer both rewrite the SAME text from v1.
		$proposed = str_replace( 'Alpha block original text.', 'Alpha rewritten by the session.', $this->genesis( $post_id ) );
		$result   = $engine->handle_updates( $room, 303, 0, array( $this->proposal( 'p-1', 'v1', $proposed ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$external = str_replace( 'Alpha block original text.', 'Alpha rewritten externally.', $saved );
		$this->unaware_write( $post_id, $external );

		$healed = $this->engine()->materialize( $room );
		$this->assertStringContainsString( 'Alpha rewritten by the session.', $healed, 'Canonical wins locally on conflict.' );
		$this->assertStringNotContainsString( 'Alpha rewritten externally.', $healed );

		// The external edit is parked, not lost.
		$response = $engine->get_updates_since( $room, 999, 0, array() );
		$parked   = array_filter(
			$response['updates'],
			static function ( $update ) {
				return WP_De_RTC_Engine::UPDATE_TYPE_PARKED === $update['type'];
			}
		);
		$this->assertNotEmpty( $parked, 'A conflicting external edit must park for review.' );
	}

	public function test_healing_is_idempotent_across_loads() {
		$post_id = $this->make_post();
		$room    = 'postType/post:' . $post_id;
		$this->assertSame( $this->genesis( $post_id ), $this->engine()->materialize( $room ) );

		$external = "<!-- wp:paragraph -->\n<p>External once.</p>\n<!-- /wp:paragraph -->";
		$this->unaware_write( $post_id, $external );

		$this->engine()->materialize( $room );
		$first = $this->engine()->get_updates_since( $room, 999, 0, array() );
		$this->engine()->materialize( $room );
		$second = $this->engine()->get_updates_since( $room, 999, 0, array() );

		$this->assertSame(
			count( $first['updates'] ),
			count( $second['updates'] ),
			'Repeated loads must not re-heal the same external content.'
		);
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
