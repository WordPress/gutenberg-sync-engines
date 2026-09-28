<?php
/**
 * Tests for the de-rtc autosave commit lane: commits
 * ride the ordinary autosave endpoint; the transport stays advisory.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpDeRtcAutosaveCommits extends WP_UnitTestCase {
	/**
	 * Editor user ID.
	 *
	 * @var int
	 */
	protected static $editor_id;

	/**
	 * Subscriber user ID (cannot edit the post).
	 *
	 * @var int
	 */
	protected static $subscriber_id;

	/**
	 * Post ID used for room targets.
	 *
	 * @var int
	 */
	protected static $post_id;

	const GENESIS_CONTENT = "<!-- wp:paragraph -->\n<p>Alpha block original text.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Beta block original text.</p>\n<!-- /wp:paragraph -->";

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id     = $factory->user->create( array( 'role' => 'editor' ) );
		self::$subscriber_id = $factory->user->create( array( 'role' => 'subscriber' ) );
		self::$post_id       = $factory->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
		self::delete_user( self::$subscriber_id );
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
	 * Dispatches a commit-shaped autosave request.
	 *
	 * @param array $params Body params.
	 * @return WP_REST_Response|WP_Error Response.
	 */
	private function commit_request( array $params ) {
		$request = new WP_REST_Request( 'POST', '/wp/v2/posts/' . self::$post_id . '/autosaves' );
		$request->set_header( 'content-type', 'application/json' );
		$request->set_body( wp_json_encode( $params ) );
		return rest_get_server()->dispatch( $request );
	}

	public function test_commit_merges_through_the_room_and_returns_rows() {
		// Initialize the room (the session bootstraps via the transport in
		// production; the engine read does it here).
		$this->assertSame( $this->genesis(), $this->engine()->materialize( $this->room() ) );

		$proposed = str_replace( 'Alpha block original text.', 'Alpha via autosave commit.', $this->genesis() );
		$response = $this->commit_request(
			array(
				'proposal_id'      => 'p-777-1',
				'base_version'     => 'v1',
				'proposed_content' => $proposed,
				'client_id'        => 777,
			)
		);

		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertSame( 'applied', $data['dispositions'][0]['status'] );
		$this->assertSame( 'v2', $data['dispositions'][0]['version'] );

		// The rows this commit appended come back for the session to
		// settle from (rows first, dispositions after).
		$announces = array_values(
			array_filter(
				$data['updates'],
				static function ( $update ) {
					return WP_De_RTC_Engine::UPDATE_TYPE_ANNOUNCE === $update['type'];
				}
			)
		);
		$this->assertCount( 1, $announces );
		$announce = json_decode( $announces[0]['data'], true );
		$this->assertSame( 'v2', $announce['version'] );
		$this->assertSame( 'p-777-1', $announce['proposalId'] );
		$this->assertSame( 777, $announce['authorClientId'] );
		$this->assertSame( self::$editor_id, $announce['author'] );

		// And the room really advanced.
		$this->assertStringContainsString( 'Alpha via autosave commit.', (string) $this->engine()->materialize( $this->room() ) );
	}

	public function test_commit_requires_edit_capability() {
		$this->engine()->materialize( $this->room() ); // Room exists.
		wp_set_current_user( self::$subscriber_id );

		$response = $this->commit_request(
			array(
				'proposal_id'      => 'p-778-1',
				'base_version'     => 'v1',
				'proposed_content' => $this->genesis(),
				'client_id'        => 778,
			)
		);
		$this->assertSame( 403, $response->get_status() );
	}

	public function test_commit_against_a_roomless_post_is_a_conflict() {
		$orphan  = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
		$request = new WP_REST_Request( 'POST', '/wp/v2/posts/' . $orphan . '/autosaves' );
		$request->set_header( 'content-type', 'application/json' );
		$request->set_body(
			wp_json_encode(
				array(
					'proposal_id'      => 'p-779-1',
					'base_version'     => 'v1',
					'proposed_content' => $this->genesis(),
					'client_id'        => 779,
				)
			)
		);
		$response = rest_get_server()->dispatch( $request );
		$this->assertSame( 409, $response->get_status() );
		wp_delete_post( $orphan, true );
	}

	public function test_editor_native_autosaves_pass_through_untouched() {
		$this->engine()->materialize( $this->room() ); // Room exists.

		/*
		 * No commit shape: the interceptor must decline (null) so core's
		 * autosave controller handles the request. Asserted against the
		 * filter DIRECTLY — dispatching into core's controller would
		 * define DOING_AUTOSAVE, a process-wide constant that suppresses
		 * revision creation for every later test in the run.
		 */
		$request = new WP_REST_Request( 'POST', '/wp/v2/posts/' . self::$post_id . '/autosaves' );
		$request->set_header( 'content-type', 'application/json' );
		$request->set_body(
			wp_json_encode(
				array(
					'content' => str_replace( 'Beta block original text.', 'Beta native autosave.', $this->genesis() ),
				)
			)
		);
		$this->assertNull( WP_De_RTC_Autosave_Commits::maybe_commit( null, rest_get_server(), $request ) );
		// And the ROOM did not advance (native autosaves are not commits).
		$this->assertStringNotContainsString( 'Beta native autosave.', (string) $this->engine()->materialize( $this->room() ) );
	}

	/**
	 * The room's genesis content: the saved post with every block stamped
	 * with its deterministic identity (what the room actually serves).
	 *
	 * @return string Stamped genesis content.
	 */
	private function genesis(): string {
		return WP_De_RTC_Block_Identity::stamp_genesis( self::GENESIS_CONTENT, self::$post_id );
	}
}
