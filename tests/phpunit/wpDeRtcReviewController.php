<?php
/**
 * Unit tests covering WP_De_RTC_Review_Controller (the B5 REST review
 * lane): review resolutions POST to an authenticated route — the only
 * way clients send them; the stamped `resolved` row the engine appends
 * still broadcasts to peers through ordinary room reads.
 *
 * @package GutenbergSyncEngines
 */

class Tests_Collaboration_WpDeRtcReviewController extends WP_UnitTestCase {
	/**
	 * Editor user ID (can edit_posts).
	 *
	 * @var int
	 */
	protected static $editor_id;

	/**
	 * Subscriber user ID (cannot edit_posts).
	 *
	 * @var int
	 */
	protected static $subscriber_id;

	/**
	 * Contributor user ID (can edit_posts, but only their own posts).
	 *
	 * @var int
	 */
	protected static $contributor_id;

	/**
	 * Post ID used for room targets.
	 *
	 * @var int
	 */
	protected static $post_id;

	const GENESIS_CONTENT = "<!-- wp:paragraph -->\n<p>Alpha block original text.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Beta block original text.</p>\n<!-- /wp:paragraph -->";

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id      = $factory->user->create( array( 'role' => 'editor' ) );
		self::$subscriber_id  = $factory->user->create( array( 'role' => 'subscriber' ) );
		self::$contributor_id = $factory->user->create( array( 'role' => 'contributor' ) );
		self::$post_id        = $factory->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_status'  => 'draft',
				'post_title'   => 'DE-RTC review controller test post',
				'post_content' => self::GENESIS_CONTENT,
			)
		);
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
		self::delete_user( self::$subscriber_id );
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
	 * A fresh engine over a fresh storage instance — the per-request
	 * state boundary, as in the engine suite.
	 *
	 * @return WP_De_RTC_Engine Engine.
	 */
	private function engine(): WP_De_RTC_Engine {
		return new WP_De_RTC_Engine( new WP_Sync_Table_Storage() );
	}

	/**
	 * Builds a proposal update the way the client adapter does.
	 *
	 * @param string $proposal_id  Correlation id.
	 * @param string $base_version Base version label.
	 * @param string $base         Base content.
	 * @param string $proposed     Proposed content.
	 * @return array Typed update row.
	 */
	private function proposal( string $proposal_id, string $base_version, string $base, string $proposed ): array {
		return array(
			'data' => wp_json_encode(
				array(
					'proposalId'      => $proposal_id,
					'baseVersion'     => $base_version,
					'proposedContent' => $proposed,
					'clientUpdate'    => wp_de_rtc_create_automerge_update_for_content_change( $base, $proposed, 'test-actor' ),
				)
			),
			'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
		);
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
	 * Drives the standard two-client same-block conflict so client 2's
	 * `p-b` parks (per-block salvage), mirroring the engine suite.
	 *
	 * @return void
	 */
	private function escalate_conflict(): void {
		$engine   = $this->engine();
		$response = $engine->get_updates_since( $this->room(), 1, 0, array() );
		$genesis  = json_decode( $response['updates'][0]['data'], true );

		$a_proposed = str_replace( 'Alpha block original text', 'Alpha block A-REWRITE text', $genesis['content'] );
		$engine->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->proposal( 'p-a', $genesis['version'], $genesis['content'], $a_proposed ) ),
			array()
		);

		$b_proposed = str_replace( 'Alpha block original text', 'Alpha block B-REWRITE text', $genesis['content'] );
		$b_result   = $this->engine()->handle_updates(
			$this->room(),
			2,
			0,
			array( $this->proposal( 'p-b', $genesis['version'], $genesis['content'], $b_proposed ) ),
			array()
		);
		$this->assertSame( 1, $b_result['dispositions'][0]['parkedBlocks'] ?? null, 'the conflict fixture must park a block' );
	}

	/**
	 * Dispatches a resolve POST as the client's REST review lane does.
	 *
	 * @param array $params Request body params.
	 * @return WP_REST_Response Response.
	 */
	private function dispatch_resolve( array $params ): WP_REST_Response {
		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/de-rtc/resolve' );
		$request->set_body_params( $params );
		return rest_get_server()->dispatch( $request );
	}

	public function test_accepts_a_parked_proposal_with_replacement_content() {
		$this->escalate_conflict();
		$response = $this->dispatch_resolve(
			array(
				'room'       => $this->room(),
				'proposalId' => 'p-b',
				'resolution' => 'accepted',
				'client_id'  => 2,
				'content'    => "<!-- wp:paragraph -->\n<p>Alpha block REVIEWED text.</p>\n<!-- /wp:paragraph -->",
			)
		);
		$this->assertSame( 200, $response->get_status() );
		$disposition = $response->get_data()['disposition'];
		$this->assertSame( 'resolved', $disposition['status'] );
		$this->assertSame( 'applied', $disposition['applied']['status'] );
		$this->assertStringContainsString( 'Alpha block REVIEWED text.', $this->engine()->materialize( $this->room() ) );

		$room_read = $this->engine()->get_updates_since( $this->room(), 3, 0, array() );
		$resolved  = $this->rows_of_type( $room_read, WP_De_RTC_Engine::UPDATE_TYPE_RESOLVED );
		$this->assertCount( 1, $resolved );
		$this->assertSame( 'accepted', $resolved[0]['resolution'] );
	}

	public function test_accepted_against_a_version_whose_block_changed_since_is_a_conflict() {
		$this->escalate_conflict();
		// The reviewer saw this version: the newest one the room announces.
		$seen = array(
			'version' => 'v0',
			'content' => (string) $this->engine()->materialize( $this->room() ),
		);
		foreach ( $this->engine()->get_updates_since( $this->room(), 3, 0, array() )['updates'] as $update ) {
			$version = json_decode( $update['data'], true )['version'] ?? null;
			if ( is_string( $version ) && (int) ltrim( $version, 'v' ) > (int) ltrim( $seen['version'], 'v' ) ) {
				$seen['version'] = $version;
			}
		}

		// A peer edits the block under review.
		$proposed = str_replace( 'Alpha block A-REWRITE text', 'Alpha block A-REWRITE text, and a later thought', $seen['content'] );
		$this->assertNotSame( $seen['content'], $proposed );
		$peer = $this->engine()->handle_updates(
			$this->room(),
			1,
			0,
			array( $this->proposal( 'p-a2', $seen['version'], $seen['content'], $proposed ) ),
			array()
		);
		$this->assertSame( 'applied', $peer['dispositions'][0]['status'] );
		$before = $this->engine()->materialize( $this->room() );
		$this->assertStringContainsString( 'and a later thought', $before );

		$response = $this->dispatch_resolve(
			array(
				'room'        => $this->room(),
				'proposalId'  => 'p-b',
				'resolution'  => 'accepted',
				'client_id'   => 2,
				'content'     => "<!-- wp:paragraph -->\n<p>Alpha block REVIEWED text.</p>\n<!-- /wp:paragraph -->",
				'seenVersion' => $seen['version'],
			)
		);

		$this->assertSame( 409, $response->get_status() );
		$this->assertSame( 'review_stale', $response->get_data()['code'] );
		$this->assertSame( $before, $this->engine()->materialize( $this->room() ) );
		$room_read = $this->engine()->get_updates_since( $this->room(), 3, 0, array() );
		$this->assertCount( 0, $this->rows_of_type( $room_read, WP_De_RTC_Engine::UPDATE_TYPE_RESOLVED ) );
	}

	public function test_accepted_without_content_is_a_bad_request() {
		$this->escalate_conflict();
		$response = $this->dispatch_resolve(
			array(
				'room'       => $this->room(),
				'proposalId' => 'p-b',
				'resolution' => 'accepted',
			)
		);
		$this->assertSame( 400, $response->get_status() );
	}

	public function test_route_is_registered() {
		$routes = rest_get_server()->get_routes();
		$this->assertArrayHasKey( '/wp-sync/v1/de-rtc/resolve', $routes );
	}

	public function test_resolves_a_parked_proposal_and_appends_the_broadcast_row() {
		$this->escalate_conflict();

		$response = $this->dispatch_resolve(
			array(
				'room'       => $this->room(),
				'proposalId' => 'p-b',
				'resolution' => 'dismissed',
				'client_id'  => 2,
			)
		);

		$this->assertSame( 200, $response->get_status() );
		$this->assertSame(
			array(
				'intentId' => 'p-b',
				'status'   => 'resolved',
			),
			$response->get_data()['disposition']
		);

		// The stamped resolved row broadcasts through ordinary room reads,
		// so peers and late joiners close the review item.
		$room_read = $this->engine()->get_updates_since( $this->room(), 3, 0, array() );
		$resolved  = $this->rows_of_type( $room_read, WP_De_RTC_Engine::UPDATE_TYPE_RESOLVED );
		$this->assertCount( 1, $resolved );
		$this->assertSame( 'p-b', $resolved[0]['proposalId'] );
		$this->assertSame( 'dismissed', $resolved[0]['resolution'] );
		$this->assertSame( self::$editor_id, $resolved[0]['resolvedBy'] );
	}

	public function test_unknown_proposal_acks_idempotently_without_a_row() {
		$this->engine()->get_updates_since( $this->room(), 1, 0, array() );

		$response = $this->dispatch_resolve(
			array(
				'room'       => $this->room(),
				'proposalId' => 'p-never-parked',
				'resolution' => 'restored',
			)
		);

		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( 'resolved', $response->get_data()['disposition']['status'] );

		$room_read = $this->engine()->get_updates_since( $this->room(), 3, 0, array() );
		$this->assertCount( 0, $this->rows_of_type( $room_read, WP_De_RTC_Engine::UPDATE_TYPE_RESOLVED ) );
	}

	public function test_resolving_twice_appends_only_one_row() {
		$this->escalate_conflict();

		$params = array(
			'room'       => $this->room(),
			'proposalId' => 'p-b',
			'resolution' => 'dismissed',
		);
		$this->assertSame( 200, $this->dispatch_resolve( $params )->get_status() );
		$this->assertSame( 200, $this->dispatch_resolve( $params )->get_status() );

		$room_read = $this->engine()->get_updates_since( $this->room(), 3, 0, array() );
		$this->assertCount( 1, $this->rows_of_type( $room_read, WP_De_RTC_Engine::UPDATE_TYPE_RESOLVED ) );
	}

	public function test_requires_edit_posts() {
		wp_set_current_user( self::$subscriber_id );
		$response = $this->dispatch_resolve(
			array(
				'room'       => $this->room(),
				'proposalId' => 'p-b',
				'resolution' => 'dismissed',
			)
		);
		$this->assertSame( 403, $response->get_status() );
	}

	public function test_a_contributor_cannot_decide_a_record_on_a_post_they_cannot_edit() {
		$this->escalate_conflict();
		$before = $this->engine()->materialize( $this->room() );

		// A Contributor has edit_posts, but not edit_post on the Editor's draft.
		wp_set_current_user( self::$contributor_id );
		$dismissed = $this->dispatch_resolve(
			array(
				'room'       => $this->room(),
				'proposalId' => 'p-b',
				'resolution' => 'dismissed',
				'client_id'  => 2,
			)
		);
		$this->assertSame( 403, $dismissed->get_status() );
		$this->assertSame( 'rest_cannot_edit', $dismissed->get_data()['code'] );

		$accepted = $this->dispatch_resolve(
			array(
				'room'       => $this->room(),
				'proposalId' => 'p-b',
				'resolution' => 'accepted',
				'client_id'  => 2,
				'content'    => "<!-- wp:paragraph -->\n<p>Alpha block WRITTEN BY A CONTRIBUTOR.</p>\n<!-- /wp:paragraph -->",
			)
		);
		$this->assertSame( 403, $accepted->get_status() );
		$this->assertSame( 'rest_cannot_edit', $accepted->get_data()['code'] );

		// Nothing was written and the record is still open.
		wp_set_current_user( self::$editor_id );
		$this->assertSame( $before, $this->engine()->materialize( $this->room() ) );
		$room_read = $this->engine()->get_updates_since( $this->room(), 3, 0, array() );
		$this->assertCount( 0, $this->rows_of_type( $room_read, WP_De_RTC_Engine::UPDATE_TYPE_RESOLVED ) );
	}

	public function test_a_contributor_can_decide_a_record_on_their_own_draft() {
		$draft_id = self::factory()->post->create(
			array(
				'post_author'  => self::$contributor_id,
				'post_status'  => 'draft',
				'post_content' => self::GENESIS_CONTENT,
			)
		);
		$room     = 'postType/post:' . $draft_id;
		$this->engine()->get_updates_since( $room, 1, 0, array() );

		wp_set_current_user( self::$contributor_id );
		$response = $this->dispatch_resolve(
			array(
				'room'       => $room,
				'proposalId' => 'p-never-parked',
				'resolution' => 'dismissed',
			)
		);
		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( 'resolved', $response->get_data()['disposition']['status'] );
	}

	public function test_rejects_a_room_name_that_does_not_parse() {
		$response = $this->dispatch_resolve(
			array(
				'room'       => 'not-a-room',
				'proposalId' => 'p-b',
				'resolution' => 'dismissed',
			)
		);
		$this->assertSame( 400, $response->get_status() );
		$this->assertSame( 'rest_invalid_param', $response->get_data()['code'] );
	}

	public function test_rejects_a_room_that_names_the_post_under_another_type() {
		$response = $this->dispatch_resolve(
			array(
				'room'       => 'postType/page:' . self::$post_id,
				'proposalId' => 'p-b',
				'resolution' => 'dismissed',
			)
		);
		$this->assertSame( 403, $response->get_status() );
	}

	public function test_rejects_an_unknown_resolution_value() {
		$response = $this->dispatch_resolve(
			array(
				'room'       => $this->room(),
				'proposalId' => 'p-b',
				'resolution' => 'obliterated',
			)
		);
		$this->assertSame( 400, $response->get_status() );
	}

	public function test_fences_rooms_with_another_engine_lineage() {
		// A second post: the route only serves rooms of posts the user can edit.
		$room    = 'postType/post:' . self::factory()->post->create( array( 'post_author' => self::$editor_id ) );
		$storage = new WP_Sync_Table_Storage();
		$this->assertTrue( $storage->set_room_engine( $room, 'intent-log' ) );

		$response = $this->dispatch_resolve(
			array(
				'room'       => $room,
				'proposalId' => 'p-b',
				'resolution' => 'dismissed',
			)
		);
		$this->assertSame( 409, $response->get_status() );
		$this->assertSame( 'rest_sync_engine_mismatch', $response->get_data()['code'] );
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
