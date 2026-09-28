<?php
/**
 * Tests for the wp_update_post base-version preflight: a
 * cooperating writer passes base_version and gets a genuine three-way
 * merge instead of an overwrite; unresolvable conflicts reject the save
 * with a rich error.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpDeRtcBaseVersionPreflight extends WP_UnitTestCase {
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
		WP_De_RTC_Base_Version_Preflight::register();
	}

	private function engine(): WP_De_RTC_Engine {
		return new WP_De_RTC_Engine( new WP_Sync_Table_Storage() );
	}

	private function make_post_with_room(): array {
		$post_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
		$room    = 'postType/post:' . $post_id;
		$this->assertSame( $this->genesis( $post_id ), $this->engine()->materialize( $room ) );
		return array( $post_id, $room );
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

	public function test_cooperating_writer_merges_instead_of_overwriting() {
		list( $post_id, $room ) = $this->make_post_with_room();

		// The session advances Alpha past the writer's read.
		$session = str_replace( 'Alpha block original text.', 'Alpha advanced by the session.', $this->genesis( $post_id ) );
		$result  = $this->engine()->handle_updates( $room, 701, 0, array( $this->proposal( 'p-1', 'v1', $session ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// A cooperating writer edits Beta against the v1 copy it read.
		$writer_copy = str_replace( 'Beta block original text.', 'Beta updated by the integration.', $this->genesis( $post_id ) );
		$updated     = wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => $writer_copy,
				'base_version' => 'v1',
			),
			true
		);
		$this->assertNotWPError( $updated );

		// The save landed MERGED: both edits present, plus fresh lineage.
		$saved = get_post( $post_id )->post_content;
		$this->assertStringContainsString( 'Alpha advanced by the session.', $saved, 'The session edit must survive the integration save.' );
		$this->assertStringContainsString( 'Beta updated by the integration.', $saved, 'The integration edit must land.' );
		$this->assertStringContainsString( 'data-wp-sync-meta', $saved, 'The merged save carries fresh lineage.' );

		// The room converged to the same merged content (it merged THROUGH
		// the room), and the writer's edit is in collaborative history.
		$canonical = $this->engine()->materialize( $room );
		$this->assertStringContainsString( 'Beta updated by the integration.', $canonical );
		$this->assertStringContainsString( 'Alpha advanced by the session.', $canonical );
	}

	public function test_structural_conflict_rejects_the_save_and_parks() {
		list( $post_id, $room ) = $this->make_post_with_room();

		// The session removes Beta (structural change).
		$session = "<!-- wp:paragraph -->\n<p>Alpha advanced by the session.</p>\n<!-- /wp:paragraph -->";
		$result  = $this->engine()->handle_updates( $room, 702, 0, array( $this->proposal( 'p-1', 'v1', $session ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		$before = get_post( $post_id )->post_content;

		// The writer rewrites Alpha differently against the old structure,
		// with classic content between the blocks so identity cannot
		// model the copy and the positional policy decides.
		$writer_copy = "Classic text between blocks.\n\n" . str_replace( 'Alpha block original text.', 'Alpha rewritten by the integration.', $this->genesis( $post_id ) );
		$updated     = wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => $writer_copy,
				'base_version' => 'v1',
			),
			true
		);

		$this->assertWPError( $updated, 'A structural conflict must reject the save.' );
		$error = WP_De_RTC_Base_Version_Preflight::last_error();
		$this->assertInstanceOf( WP_Error::class, $error );
		$this->assertSame( 'de_rtc_base_version_conflict', $error->get_error_code() );
		$this->assertSame( $before, get_post( $post_id )->post_content, 'A rejected save must not touch the post.' );

		// The conflicting save is parked for review, not lost.
		$response = $this->engine()->get_updates_since( $room, 999, 0, array() );
		$parked   = array_filter(
			$response['updates'],
			static function ( $update ) {
				return WP_De_RTC_Engine::UPDATE_TYPE_PARKED === $update['type'];
			}
		);
		$this->assertNotEmpty( $parked );
	}

	public function test_a_conflicting_rewrite_beside_a_structural_change_parks_just_that_block() {
		list( $post_id, $room ) = $this->make_post_with_room();

		// The session removes Beta and advances Alpha.
		$session = "<!-- wp:paragraph -->\n<p>Alpha advanced by the session.</p>\n<!-- /wp:paragraph -->";
		$result  = $this->engine()->handle_updates( $room, 703, 0, array( $this->proposal( 'p-1', 'v1', $session ) ), array() );
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );

		// The writer rewrites Alpha differently against v1. Identity
		// merges block-for-block: Beta's deletion stands, the writer's
		// Alpha loses to canonical and parks, and the save lands as the
		// canonical content.
		$writer_copy = str_replace( 'Alpha block original text.', 'Alpha rewritten by the integration.', $this->genesis( $post_id ) );
		$updated     = wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => $writer_copy,
				'base_version' => 'v1',
			),
			true
		);
		$this->assertSame( $post_id, $updated );
		$saved = get_post( $post_id )->post_content;
		$this->assertStringContainsString( 'Alpha advanced by the session.', $saved );
		$this->assertStringNotContainsString( 'Alpha rewritten by the integration.', $saved );
		$this->assertStringNotContainsString( 'Beta', $saved );

		$response = $this->engine()->get_updates_since( $room, 999, 0, array() );
		$parked   = array_filter(
			$response['updates'],
			static function ( $update ) {
				return WP_De_RTC_Engine::UPDATE_TYPE_PARKED === $update['type'];
			}
		);
		$this->assertCount( 1, $parked );
		$row = json_decode( array_values( $parked )[0]['data'], true );
		$this->assertStringContainsString( 'Alpha rewritten by the integration.', $row['changedBlocks'][0]['html'] );
	}

	public function test_unknown_base_version_rejects_with_stale_error() {
		list( $post_id, $room ) = $this->make_post_with_room();
		$this->assertNotEmpty( $room );

		$updated = wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => self::GENESIS_CONTENT,
				'base_version' => 'v99',
			),
			true
		);

		$this->assertWPError( $updated );
		$this->assertSame( 'de_rtc_base_version_stale', WP_De_RTC_Base_Version_Preflight::last_error()->get_error_code() );
	}

	public function test_save_without_base_version_is_untouched_by_the_preflight() {
		list( $post_id, $room ) = $this->make_post_with_room();
		$this->assertNotEmpty( $room );

		$updated = wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => str_replace( 'Beta block original text.', 'Beta plain save.', $this->genesis( $post_id ) ),
			),
			true
		);
		$this->assertNotWPError( $updated );
		$this->assertStringContainsString( 'Beta plain save.', get_post( $post_id )->post_content );
	}

	public function test_roomless_post_rejects_base_version_saves() {
		$post_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);

		$updated = wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => self::GENESIS_CONTENT,
				'base_version' => 'v1',
			),
			true
		);

		$this->assertWPError( $updated );
		$this->assertSame( 'de_rtc_base_version_no_room', WP_De_RTC_Base_Version_Preflight::last_error()->get_error_code() );
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
