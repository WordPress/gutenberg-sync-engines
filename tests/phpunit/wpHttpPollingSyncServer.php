<?php
/**
 * Tests for the WP_HTTP_Polling_Sync_Server REST endpoint.
 *
 * @package gutenberg
 * @subpackage Collaboration
 *
 * @group collaboration
 * @group restapi
 */
class Tests_Collaboration_WpHttpPollingSyncServer extends WP_Test_REST_Controller_Testcase {

	protected static int $editor_id;
	protected static int $subscriber_id;
	protected static int $post_id;
	protected static int $category_id;
	protected static int $tag_id;
	protected static int $comment_id;

	/**
	 * Registers the opaque-relay TEST FIXTURE engine on the registry filter.
	 *
	 * These tests exercise the transport's engine-agnostic store-and-forward
	 * mechanics with arbitrary opaque payloads, which a real engine
	 * (yjs-server, intent-log) would validate and reject. Re-added at the
	 * top of every set_up — see the comment there for the hook-snapshot
	 * timing this dances around.
	 *
	 * @param WP_Sync_Engine[] $engines Engines to register.
	 * @param WP_Sync_Storage  $storage Storage backend.
	 * @return WP_Sync_Engine[] Engines including the fixture.
	 */
	public static function register_fixture_engine( array $engines, WP_Sync_Storage $storage ): array {
		$engines[] = new Test_Opaque_Relay_Engine( $storage );
		return $engines;
	}

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id     = $factory->user->create( array( 'role' => 'editor' ) );
		self::$subscriber_id = $factory->user->create( array( 'role' => 'subscriber' ) );
		self::$post_id       = $factory->post->create( array( 'post_author' => self::$editor_id ) );
		self::$category_id   = $factory->category->create();
		self::$tag_id        = $factory->tag->create();
		self::$comment_id    = $factory->comment->create( array( 'comment_post_ID' => self::$post_id ) );

		// Make the fixture the active engine. Committed here (outside the
		// per-test transaction) so it holds for every test in the class.
		update_option( 'wp_sync_engine', Test_Opaque_Relay_Engine::SLUG );
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
		self::delete_user( self::$subscriber_id );
		delete_option( 'wp_sync_engine' );
		wp_delete_post( self::$post_id, true );
		wp_delete_term( self::$category_id, 'category' );
		wp_delete_term( self::$tag_id, 'post_tag' );
		wp_delete_comment( self::$comment_id, true );
	}

	public function set_up() {
		// The fixture filter must be (re-)added BEFORE parent::set_up():
		// the controller testcase's set_up creates the REST server and fires
		// `rest_api_init`, which constructs the engine registry — and the WP
		// test framework's tear_down restores hooks to a run-global snapshot
		// that predates this class, wiping any class-level filter after
		// every test.
		add_filter( 'wp_sync_engines', array( self::class, 'register_fixture_engine' ), 10, 2 );

		parent::set_up();
	}

	/**
	 * Builds a room request array for the sync endpoint.
	 *
	 * @param string $room      Room identifier.
	 * @param int    $client_id Client ID.
	 * @param int    $cursor    Cursor value for the 'after' parameter.
	 * @param array  $awareness Awareness state.
	 * @param array  $updates   Array of updates.
	 * @return array Room request data.
	 */
	private function build_room( $room, $client_id = 1, $cursor = 0, $awareness = array(), $updates = array() ) {
		if ( empty( $awareness ) ) {
			$awareness = array( 'user' => 'test' );
		}

		return array(
			'after'     => $cursor,
			'awareness' => $awareness,
			'client_id' => $client_id,
			'room'      => $room,
			'updates'   => $updates,
		);
	}

	/**
	 * Dispatches a sync request with the given rooms.
	 *
	 * @param array $rooms Array of room request data.
	 * @return WP_REST_Response Response object.
	 */
	private function dispatch_sync( $rooms ) {
		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/updates' );
		$request->set_body_params( array( 'rooms' => $rooms ) );
		return rest_get_server()->dispatch( $request );
	}

	/**
	 * Returns the default room identifier for the test post.
	 *
	 * @return string Room identifier.
	 */
	private function get_post_room() {
		return 'postType/post:' . self::$post_id;
	}

	/*
	 * Required abstract method implementations.
	 *
	 * The sync endpoint is a single POST endpoint, not a standard CRUD controller.
	 * Methods that don't apply are stubbed with @doesNotPerformAssertions.
	 */

	public function test_register_routes() {
		$routes = rest_get_server()->get_routes();
		$this->assertArrayHasKey( '/wp-sync/v1/updates', $routes );
	}

	/**
	 * @doesNotPerformAssertions
	 */
	public function test_context_param() {
		// Not applicable for sync endpoint.
	}

	/**
	 * @doesNotPerformAssertions
	 */
	public function test_get_items() {
		// Not applicable for sync endpoint.
	}

	/**
	 * @doesNotPerformAssertions
	 */
	public function test_get_item() {
		// Not applicable for sync endpoint.
	}

	public function test_create_item() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( $this->get_post_room() ) ) );

		$this->assertSame( 200, $response->get_status() );
	}

	/**
	 * @doesNotPerformAssertions
	 */
	public function test_update_item() {
		// Not applicable for sync endpoint.
	}

	/**
	 * @doesNotPerformAssertions
	 */
	public function test_delete_item() {
		// Not applicable for sync endpoint.
	}

	/**
	 * @doesNotPerformAssertions
	 */
	public function test_prepare_item() {
		// Not applicable for sync endpoint.
	}

	/**
	 * @doesNotPerformAssertions
	 */
	public function test_get_item_schema() {
		// Not applicable for sync endpoint.
	}

	/*
	 * `rows_received_separately: true` (a send made beside an open stream).
	 */

	public function test_receive_false_stores_the_update_but_returns_no_stored_rows_and_the_head_cursor() {
		wp_set_current_user( self::$editor_id );
		$room = $this->get_post_room();

		// A peer's row is already in the room; the sender has not read it.
		$peer_head = $this->dispatch_sync(
			array(
				$this->build_room(
					$room,
					2,
					0,
					array(),
					array(
						array(
							'data' => 'peer',
							'type' => 'update',
						),
					)
				),
			)
		)->get_data()['rooms'][0]['end_cursor'];

		$response = $this->dispatch_sync(
			array(
				array_merge(
					$this->build_room(
						$room,
						1,
						0,
						array(),
						array(
							array(
								'data' => 'mine',
								'type' => 'update',
							),
						)
					),
					array( 'rows_received_separately' => true )
				),
			)
		);
		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data()['rooms'][0];
		$this->assertSame( array(), $data['updates'], 'Neither the peer row nor the own row: the stream delivers stored rows.' );
		$this->assertGreaterThan( $peer_head, $data['end_cursor'], 'The head, including the row this request stored.' );
		$this->assertArrayHasKey( 'awareness', $data );
		$this->assertCount( 2, $data['awareness'] );

		// An ordinary read from where the sender was sees both rows.
		$catch_up = $this->dispatch_sync( array( $this->build_room( $room, 3, 0 ) ) )->get_data()['rooms'][0];
		$this->assertSame( array( 'peer', 'mine' ), array_column( $catch_up['updates'], 'data' ) );
		$this->assertSame( $data['end_cursor'], $catch_up['end_cursor'], 'The ordinary read reaches the head the send reported.' );
	}

	public function test_receive_false_without_updates_reports_the_head_and_merges_awareness() {
		wp_set_current_user( self::$editor_id );
		$room      = $this->get_post_room();
		$peer_head = $this->dispatch_sync(
			array(
				$this->build_room(
					$room,
					2,
					0,
					array(),
					array(
						array(
							'data' => 'peer',
							'type' => 'update',
						),
					)
				),
			)
		)->get_data()['rooms'][0]['end_cursor'];

		// An awareness-only send (a cursor move on a streaming tab).
		$response = $this->dispatch_sync( array( array_merge( $this->build_room( $room, 1, 0, array( 'cursor' => 7 ) ), array( 'rows_received_separately' => true ) ) ) );
		$data     = $response->get_data()['rooms'][0];
		$this->assertSame( array(), $data['updates'] );
		$this->assertSame( $peer_head, $data['end_cursor'] );
		$this->assertSame( array( 'cursor' => 7 ), $data['awareness'][1] );
	}

	/*
	 * Permission tests.
	 */

	public function test_sync_requires_authentication() {
		wp_set_current_user( 0 );

		$response = $this->dispatch_sync( array( $this->build_room( $this->get_post_room() ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 401 );
	}

	public function test_sync_post_requires_edit_capability() {
		wp_set_current_user( self::$subscriber_id );

		$response = $this->dispatch_sync( array( $this->build_room( $this->get_post_room() ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	public function test_sync_post_allowed_with_edit_capability() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( $this->get_post_room() ) ) );

		$this->assertSame( 200, $response->get_status() );
	}

	public function test_sync_post_type_collection_requires_edit_posts_capability() {
		wp_set_current_user( self::$subscriber_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'postType/post' ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	public function test_sync_post_type_collection_allowed_with_edit_posts_capability() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'postType/post' ) ) );

		$this->assertSame( 200, $response->get_status() );
	}

	public function test_sync_root_collection_allowed() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'root/site' ) ) );

		$this->assertSame( 200, $response->get_status() );
	}

	public function test_sync_taxonomy_collection_allowed() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'taxonomy/category' ) ) );

		$this->assertSame( 200, $response->get_status() );
	}

	public function test_sync_unknown_collection_kind_rejected() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'unknown/entity' ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	public function test_sync_non_posttype_entity_with_object_id_rejected() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'root/site:123' ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	public function test_sync_nonexistent_post_rejected() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'postType/post:999999' ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	/**
	 * @ticket 77243
	 */
	public function test_sync_permission_checked_per_room() {
		wp_set_current_user( self::$editor_id );

		$forbidden_rooms = array(
			'unknown/entity',
			'postType/post:999999',
		);

		// First room is allowed, remaining rooms are forbidden.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $this->get_post_room() ),
				$this->build_room( $forbidden_rooms[0] ),
				$this->build_room( $forbidden_rooms[1] ),
			)
		);

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
		$data = $response->get_data();
		$this->assertSame( $forbidden_rooms, $data['data']['rooms'] );
		$this->assertStringContainsString( $forbidden_rooms[0], $data['message'] );
		$this->assertStringContainsString( $forbidden_rooms[1], $data['message'] );
	}

	/**
	 * @ticket 64890
	 */
	public function test_sync_malformed_object_id_rejected() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'postType/post:1abc' ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	/**
	 * @ticket 64890
	 */
	public function test_sync_zero_object_id_rejected(): void {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'postType/post:0' ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	/**
	 * @ticket 64890
	 */
	public function test_sync_post_type_mismatch_rejected(): void {
		wp_set_current_user( self::$editor_id );

		// The test post is of type 'post', not 'page'.
		$response = $this->dispatch_sync( array( $this->build_room( 'postType/page:' . self::$post_id ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	/**
	 * @ticket 64890
	 */
	public function test_sync_taxonomy_term_allowed(): void {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'taxonomy/category:' . self::$category_id ) ) );

		$this->assertSame( 200, $response->get_status() );
	}

	/**
	 * @ticket 64890
	 */
	public function test_sync_nonexistent_taxonomy_term_rejected(): void {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'taxonomy/category:999999' ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	/**
	 * @ticket 64890
	 */
	public function test_sync_taxonomy_term_wrong_taxonomy_rejected(): void {
		wp_set_current_user( self::$editor_id );

		// The tag term exists in 'post_tag', not 'category'.
		$response = $this->dispatch_sync( array( $this->build_room( 'taxonomy/category:' . self::$tag_id ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	/**
	 * @ticket 64890
	 */
	public function test_sync_comment_allowed(): void {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'root/comment:' . self::$comment_id ) ) );

		$this->assertSame( 200, $response->get_status() );
	}

	/**
	 * @ticket 64890
	 */
	public function test_sync_nonexistent_comment_rejected(): void {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'root/comment:999999' ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	/**
	 * @ticket 64890
	 */
	public function test_sync_nonexistent_post_type_collection_rejected(): void {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( 'postType/nonexistent_type' ) ) );

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	/*
	 * Validation tests.
	 */

	public function test_sync_invalid_room_format_rejected() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync(
			array(
				$this->build_room( 'invalid-room-format' ),
			)
		);

		$this->assertSame( 400, $response->get_status() );
	}

	/**
	 * Verifies that schema type validation rejects a non-string value for the
	 * update 'data' field, confirming that per-arg schema validation still runs
	 * with a route-level validate_callback registered.
	 *
	 * @ticket 64890
	 */
	public function test_sync_rejects_non_string_update_data(): void {
		wp_set_current_user( self::$editor_id );

		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/updates' );
		$request->set_body_params(
			array(
				'rooms' => array(
					array(
						'after'     => 0,
						'awareness' => array( 'user' => 'test' ),
						'client_id' => 1,
						'room'      => $this->get_post_room(),
						'updates'   => array(
							array(
								'data' => 12345,
								'type' => 'update',
							),
						),
					),
				),
			)
		);

		$response = rest_get_server()->dispatch( $request );
		$this->assertErrorResponse( 'rest_invalid_param', $response, 400 );
	}

	/**
	 * Verifies that schema enum validation rejects an invalid update type,
	 * confirming that per-arg schema validation still runs with a route-level
	 * validate_callback registered.
	 *
	 * @ticket 64890
	 */
	public function test_sync_rejects_invalid_update_type_enum(): void {
		wp_set_current_user( self::$editor_id );

		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/updates' );
		$request->set_body_params(
			array(
				'rooms' => array(
					array(
						'after'     => 0,
						'awareness' => array( 'user' => 'test' ),
						'client_id' => 1,
						'room'      => $this->get_post_room(),
						'updates'   => array(
							array(
								'data' => 'dGVzdA==',
								'type' => 'invalid_type',
							),
						),
					),
				),
			)
		);

		$response = rest_get_server()->dispatch( $request );
		$this->assertErrorResponse( 'rest_invalid_param', $response, 400 );
	}

	/**
	 * Verifies that schema required-field validation rejects a room missing
	 * the 'client_id' field, confirming that per-arg schema validation still
	 * runs with a route-level validate_callback registered.
	 *
	 * @ticket 64890
	 */
	public function test_sync_rejects_missing_required_room_field(): void {
		wp_set_current_user( self::$editor_id );

		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/updates' );
		$request->set_body_params(
			array(
				'rooms' => array(
					array(
						'after'     => 0,
						'awareness' => array( 'user' => 'test' ),
						// 'client_id' deliberately omitted.
						'room'      => $this->get_post_room(),
						'updates'   => array(),
					),
				),
			)
		);

		$response = rest_get_server()->dispatch( $request );
		$this->assertErrorResponse( 'rest_invalid_param', $response, 400 );
	}

	/**
	 * Verifies that the maxItems constraint rejects a request with more rooms
	 * than MAX_ROOMS_PER_REQUEST.
	 *
	 * @ticket 64890
	 */
	public function test_sync_rejects_rooms_exceeding_max_items(): void {
		wp_set_current_user( self::$editor_id );

		$rooms = array();
		for ( $i = 0; $i < WP_HTTP_Polling_Sync_Server::MAX_ROOMS_PER_REQUEST + 1; $i++ ) {
			$rooms[] = $this->build_room( 'root/site', $i + 1 );
		}

		$response = $this->dispatch_sync( $rooms );
		$this->assertErrorResponse( 'rest_invalid_param', $response, 400 );
	}

	/**
	 * Verifies that the maxLength constraint rejects update data exceeding
	 * MAX_UPDATE_DATA_SIZE.
	 *
	 * @ticket 64890
	 */
	public function test_sync_rejects_update_data_exceeding_max_length(): void {
		wp_set_current_user( self::$editor_id );

		$oversized_data = str_repeat( 'a', WP_HTTP_Polling_Sync_Server::MAX_UPDATE_DATA_SIZE + 1 );

		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/updates' );
		$request->set_body_params(
			array(
				'rooms' => array(
					array(
						'after'     => 0,
						'awareness' => array( 'user' => 'test' ),
						'client_id' => 1,
						'room'      => $this->get_post_room(),
						'updates'   => array(
							array(
								'data' => $oversized_data,
								'type' => 'update',
							),
						),
					),
				),
			)
		);

		$response = rest_get_server()->dispatch( $request );
		$this->assertErrorResponse( 'rest_invalid_param', $response, 400 );
	}

	/**
	 * Verifies that the route-level validate_callback rejects a request body
	 * exceeding MAX_BODY_SIZE.
	 *
	 * @ticket 64890
	 */
	public function test_sync_rejects_oversized_request_body(): void {
		wp_set_current_user( self::$editor_id );

		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/updates' );

		// Set valid parsed params so per-arg schema validation passes first.
		$request->set_body_params(
			array(
				'rooms' => array(
					$this->build_room( $this->get_post_room() ),
				),
			)
		);

		// Set an oversized raw body to trigger the route-level validate_callback.
		$request->set_body( str_repeat( 'x', WP_HTTP_Polling_Sync_Server::MAX_BODY_SIZE + 1 ) );

		$response = rest_get_server()->dispatch( $request );
		$this->assertErrorResponse( 'rest_sync_body_too_large', $response, 413 );
	}

	/*
	 * Response format tests.
	 */

	public function test_sync_response_structure() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( $this->get_post_room() ) ) );

		$this->assertSame( 200, $response->get_status() );

		$data = $response->get_data();
		$this->assertArrayHasKey( 'rooms', $data );
		$this->assertCount( 1, $data['rooms'] );

		$room_data = $data['rooms'][0];
		$this->assertArrayHasKey( 'room', $room_data );
		$this->assertArrayHasKey( 'awareness', $room_data );
		$this->assertArrayHasKey( 'updates', $room_data );
		$this->assertArrayHasKey( 'end_cursor', $room_data );
		$this->assertArrayHasKey( 'total_updates', $room_data );
		$this->assertArrayHasKey( 'should_compact', $room_data );
	}

	public function test_sync_response_room_matches_request() {
		wp_set_current_user( self::$editor_id );

		$room     = $this->get_post_room();
		$response = $this->dispatch_sync( array( $this->build_room( $room ) ) );

		$data = $response->get_data();
		$this->assertSame( $room, $data['rooms'][0]['room'] );
	}

	public function test_sync_end_cursor_is_positive_integer() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( $this->get_post_room() ) ) );

		$data = $response->get_data();
		$this->assertIsInt( $data['rooms'][0]['end_cursor'] );
		$this->assertGreaterThanOrEqual( 0, $data['rooms'][0]['end_cursor'] );
	}

	public function test_sync_empty_updates_returns_zero_total() {
		wp_set_current_user( self::$editor_id );

		$response = $this->dispatch_sync( array( $this->build_room( $this->get_post_room() ) ) );

		$data = $response->get_data();
		$this->assertSame( 0, $data['rooms'][0]['total_updates'] );
		$this->assertEmpty( $data['rooms'][0]['updates'] );
	}

	/*
	 * Update tests.
	 */

	public function test_sync_update_delivered_to_other_client() {
		wp_set_current_user( self::$editor_id );

		$room   = $this->get_post_room();
		$update = array(
			'type' => 'update',
			'data' => 'dGVzdCBkYXRh',
		);

		// Client 1 sends an update.
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'user' => 'client1' ), array( $update ) ),
			)
		);

		// Client 2 requests updates from the beginning.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 2, 0 ),
			)
		);

		$data    = $response->get_data();
		$updates = $data['rooms'][0]['updates'];

		$this->assertNotEmpty( $updates );

		$types = wp_list_pluck( $updates, 'type' );
		$this->assertContains( 'update', $types );
	}

	/**
	 * Runs a callback and returns every SQL statement it issued.
	 *
	 * @param callable $callback What to run.
	 * @return string[] The statements, in order.
	 */
	private function record_queries( callable $callback ): array {
		$seen     = array();
		$recorder = static function ( $query ) use ( &$seen ) {
			$seen[] = (string) $query;
			return $query;
		};
		add_filter( 'query', $recorder );
		try {
			$callback();
		} finally {
			remove_filter( 'query', $recorder );
		}
		return $seen;
	}

	private function queries_touching( array $queries, string $table ): array {
		return array_values(
			array_filter(
				$queries,
				static function ( string $query ) use ( $table ) {
					return false !== stripos( $query, $table );
				}
			)
		);
	}

	private function write_queries( array $queries ): array {
		return array_values(
			array_filter(
				$queries,
				static function ( string $query ) {
					return (bool) preg_match( '/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i', $query );
				}
			)
		);
	}

	public function test_a_poll_carrying_unchanged_awareness_writes_nothing() {
		global $wpdb;
		wp_set_current_user( self::$editor_id );

		// One wide bucket so the two polls cannot straddle a boundary.
		$wide = static fn() => HOUR_IN_SECONDS;
		add_filter( 'wp_sync_awareness_timestamp_granularity', $wide );

		$room  = $this->get_post_room();
		$first = $this->record_queries( fn() => $this->dispatch_sync( array( $this->build_room( $room, 1, 0, array( 'user' => 'one' ) ) ) ) );
		$this->assertNotEmpty( $this->write_queries( $this->queries_touching( $first, $wpdb->sync_room_meta ) ), 'The first poll records the client.' );

		$second = $this->record_queries( fn() => $this->dispatch_sync( array( $this->build_room( $room, 1, 0, array( 'user' => 'one' ) ) ) ) );
		$this->assertSame( array(), $this->write_queries( $second ), 'A poll that changes nothing is read-only.' );

		$changed = $this->record_queries(
			fn() => $this->dispatch_sync(
				array(
					$this->build_room(
						$room,
						1,
						0,
						array(
							'user'   => 'one',
							'cursor' => 4,
						)
					),
				)
			)
		);
		$this->assertNotEmpty( $this->write_queries( $this->queries_touching( $changed, $wpdb->sync_room_meta ) ), 'A changed state is written.' );

		remove_filter( 'wp_sync_awareness_timestamp_granularity', $wide );
	}

	public function test_awareness_timestamps_round_up_to_the_bucket() {
		$this->assertSame( 100, WP_HTTP_Polling_Sync_Server::awareness_timestamp( 100 ) );
		$this->assertSame( 110, WP_HTTP_Polling_Sync_Server::awareness_timestamp( 101 ) );
		$this->assertSame( 110, WP_HTTP_Polling_Sync_Server::awareness_timestamp( 110 ) );

		$exact = static fn() => 1;
		add_filter( 'wp_sync_awareness_timestamp_granularity', $exact );
		$this->assertSame( 101, WP_HTTP_Polling_Sync_Server::awareness_timestamp( 101 ) );
		remove_filter( 'wp_sync_awareness_timestamp_granularity', $exact );
	}

	public function test_an_idle_poll_with_a_persistent_object_cache_reads_one_table_once() {
		global $wpdb;
		wp_set_current_user( self::$editor_id );

		$wide     = static fn() => HOUR_IN_SECONDS;
		add_filter( 'wp_sync_awareness_timestamp_granularity', $wide );
		$previous = wp_using_ext_object_cache( true );
		try {
			$room = $this->get_post_room();

			// A room with history: one update stamps the lineage, and the
			// first read mints the generation token.
			$this->dispatch_sync(
				array(
					$this->build_room(
						$room,
						1,
						0,
						array( 'user' => 'one' ),
						array(
							array(
								'type' => 'update',
								'data' => 'dGVzdA==',
							),
						)
					),
				)
			);
			$response = $this->dispatch_sync( array( $this->build_room( $room, 2, 0, array( 'user' => 'two' ) ) ) );
			$cursor   = (int) $response->get_data()['rooms'][0]['end_cursor'];

			// Now the idle poll: same awareness, nothing new to fetch.
			$idle = $this->record_queries( fn() => $this->dispatch_sync( array( $this->build_room( $room, 2, $cursor, array( 'user' => 'two' ) ) ) ) );

			$this->assertSame( array(), $this->write_queries( $idle ), 'Nothing is written.' );
			$this->assertSame( array(), $this->queries_touching( $idle, $wpdb->sync_room_meta ), 'Presence, lineage, and the generation token come from the cache.' );
			$this->assertCount( 1, $this->queries_touching( $idle, $wpdb->sync_updates ), 'Only the cursor snapshot reads the update log.' );
		} finally {
			wp_using_ext_object_cache( (bool) $previous );
			remove_filter( 'wp_sync_awareness_timestamp_granularity', $wide );
		}
	}

	public function test_sync_own_updates_not_returned() {
		wp_set_current_user( self::$editor_id );

		$room   = $this->get_post_room();
		$update = array(
			'type' => 'update',
			'data' => 'b3duIGRhdGE=',
		);

		// Client 1 sends an update.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'user' => 'client1' ), array( $update ) ),
			)
		);

		$data    = $response->get_data();
		$updates = $data['rooms'][0]['updates'];

		// Client 1 should not see its own non-compaction update.
		$this->assertEmpty( $updates );
	}

	public function test_sync_step1_update_stored_and_returned() {
		wp_set_current_user( self::$editor_id );

		$room   = $this->get_post_room();
		$update = array(
			'type' => 'sync_step1',
			'data' => 'c3RlcDE=',
		);

		// Client 1 sends sync_step1.
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'user' => 'client1' ), array( $update ) ),
			)
		);

		// Client 2 should see the sync_step1 update.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 2, 0 ),
			)
		);

		$data  = $response->get_data();
		$types = wp_list_pluck( $data['rooms'][0]['updates'], 'type' );
		$this->assertContains( 'sync_step1', $types );
	}

	public function test_sync_step2_update_stored_and_returned() {
		wp_set_current_user( self::$editor_id );

		$room   = $this->get_post_room();
		$update = array(
			'type' => 'sync_step2',
			'data' => 'c3RlcDI=',
		);

		// Client 1 sends sync_step2.
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'user' => 'client1' ), array( $update ) ),
			)
		);

		// Client 2 should see the sync_step2 update.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 2, 0 ),
			)
		);

		$data  = $response->get_data();
		$types = wp_list_pluck( $data['rooms'][0]['updates'], 'type' );
		$this->assertContains( 'sync_step2', $types );
	}

	public function test_sync_multiple_updates_in_single_request() {
		wp_set_current_user( self::$editor_id );

		$room    = $this->get_post_room();
		$updates = array(
			array(
				'type' => 'sync_step1',
				'data' => 'c3RlcDE=',
			),
			array(
				'type' => 'update',
				'data' => 'dXBkYXRl',
			),
		);

		// Client 1 sends multiple updates.
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'user' => 'client1' ), $updates ),
			)
		);

		// Client 2 should see both updates.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 2, 0 ),
			)
		);

		$data         = $response->get_data();
		$room_updates = $data['rooms'][0]['updates'];

		$this->assertCount( 2, $room_updates );
		$this->assertSame( 2, $data['rooms'][0]['total_updates'] );
	}

	public function test_sync_update_data_preserved() {
		wp_set_current_user( self::$editor_id );

		$room   = $this->get_post_room();
		$update = array(
			'type' => 'update',
			'data' => 'cHJlc2VydmVkIGRhdGE=',
		);

		// Client 1 sends an update.
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'user' => 'client1' ), array( $update ) ),
			)
		);

		// Client 2 should receive the exact same data.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 2, 0 ),
			)
		);

		$data         = $response->get_data();
		$room_updates = $data['rooms'][0]['updates'];

		$this->assertSame( 'cHJlc2VydmVkIGRhdGE=', $room_updates[0]['data'] );
		$this->assertSame( 'update', $room_updates[0]['type'] );
	}

	public function test_sync_total_updates_increments() {
		wp_set_current_user( self::$editor_id );

		$room   = $this->get_post_room();
		$update = array(
			'type' => 'update',
			'data' => 'dGVzdA==',
		);

		// Send three updates from different clients.
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'user' => 'c1' ), array( $update ) ),
			)
		);
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 2, 0, array( 'user' => 'c2' ), array( $update ) ),
			)
		);
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 3, 0, array( 'user' => 'c3' ), array( $update ) ),
			)
		);

		// Any client should see total_updates = 3.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 4, 0 ),
			)
		);

		$data = $response->get_data();
		$this->assertSame( 3, $data['rooms'][0]['total_updates'] );
	}

	/*
	 * Compaction tests.
	 */

	public function test_sync_should_compact_is_false_below_threshold() {
		wp_set_current_user( self::$editor_id );

		$room   = $this->get_post_room();
		$update = array(
			'type' => 'update',
			'data' => 'dGVzdA==',
		);

		// Client 1 sends a single update.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'user' => 'c1' ), array( $update ) ),
			)
		);

		$data = $response->get_data();
		$this->assertFalse( $data['rooms'][0]['should_compact'] );
	}

	public function test_sync_should_compact_is_true_above_threshold_for_compactor() {
		wp_set_current_user( self::$editor_id );

		$room    = $this->get_post_room();
		$updates = array();
		for ( $i = 0; $i < 51; $i++ ) {
			$updates[] = array(
				'type' => 'update',
				'data' => base64_encode( "update-$i" ),
			);
		}

		// Client 1 sends enough updates to exceed the compaction threshold.
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'user' => 'c1' ), $updates ),
			)
		);

		// Client 1 polls again. It is the lowest (only) client, so it is the compactor.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'user' => 'c1' ) ),
			)
		);

		$data = $response->get_data();
		$this->assertTrue( $data['rooms'][0]['should_compact'] );
	}

	public function test_sync_should_compact_is_false_for_non_compactor() {
		wp_set_current_user( self::$editor_id );

		$room    = $this->get_post_room();
		$updates = array();
		for ( $i = 0; $i < 51; $i++ ) {
			$updates[] = array(
				'type' => 'update',
				'data' => base64_encode( "update-$i" ),
			);
		}

		// Client 1 sends enough updates to exceed the compaction threshold.
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'user' => 'c1' ), $updates ),
			)
		);

		// Client 2 (higher ID than client 1) should not be the compactor.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 2, 0, array( 'user' => 'c2' ) ),
			)
		);

		$data = $response->get_data();
		$this->assertFalse( $data['rooms'][0]['should_compact'] );
	}

	public function test_sync_stale_compaction_is_stored_as_update_when_newer_compaction_exists() {
		wp_set_current_user( self::$editor_id );

		$room   = $this->get_post_room();
		$update = array(
			'type' => 'update',
			'data' => 'dGVzdA==',
		);

		// Client 1 sends an update to seed the room.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'user' => 'c1' ), array( $update ) ),
			)
		);

		$end_cursor = $response->get_data()['rooms'][0]['end_cursor'];

		// Client 2 sends a compaction at the current cursor.
		$compaction = array(
			'type' => 'compaction',
			'data' => 'Y29tcGFjdGVk',
		);

		$this->dispatch_sync(
			array(
				$this->build_room( $room, 2, $end_cursor, array( 'user' => 'c2' ), array( $compaction ) ),
			)
		);

		// Client 3 sends a stale compaction at cursor 0 (mirroring two offline
		// clients that reconnect from the same baseline cursor). The server
		// cannot run remove_updates_before_cursor because client 2 has already
		// advanced the frontier, but the bytes must still be stored as a
		// regular update so client 3's operations can propagate to other
		// clients via Yjs state-as-update merging.
		$stale_compaction = array(
			'type' => 'compaction',
			'data' => 'c3RhbGU=',
		);
		$response         = $this->dispatch_sync(
			array(
				$this->build_room( $room, 3, 0, array( 'user' => 'c3' ), array( $stale_compaction ) ),
			)
		);

		$this->assertSame( 200, $response->get_status() );

		// Verify the newer compaction is preserved AND the stale compaction's
		// bytes were persisted (now as type=update so subsequent compactions
		// don't trip the has_newer_compaction check).
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 4, 0, array( 'user' => 'c4' ) ),
			)
		);
		$updates  = $response->get_data()['rooms'][0]['updates'];

		$update_data = wp_list_pluck( $updates, 'data' );
		$this->assertContains( 'Y29tcGFjdGVk', $update_data, 'The newer compaction should be preserved.' );
		$this->assertContains( 'c3RhbGU=', $update_data, 'The stale compaction bytes should be stored so client 3\'s operations propagate.' );

		$stale_entry = null;
		foreach ( $updates as $entry ) {
			if ( 'c3RhbGU=' === $entry['data'] ) {
				$stale_entry = $entry;
				break;
			}
		}
		$this->assertNotNull( $stale_entry, 'The stale compaction entry should be present in the room.' );
		$this->assertSame( 'update', $stale_entry['type'], 'The stale compaction should be stored as type=update, not type=compaction.' );
	}

	/*
	 * Awareness tests.
	 */

	public function test_sync_awareness_returned() {
		wp_set_current_user( self::$editor_id );

		$awareness = array( 'name' => 'Editor' );
		$response  = $this->dispatch_sync(
			array(
				$this->build_room( $this->get_post_room(), 1, 0, $awareness ),
			)
		);

		$data = $response->get_data();
		$this->assertArrayHasKey( 1, $data['rooms'][0]['awareness'] );
		$this->assertSame( $awareness, $data['rooms'][0]['awareness'][1] );
	}

	public function test_sync_awareness_shows_multiple_clients() {
		wp_set_current_user( self::$editor_id );

		$room = $this->get_post_room();

		// Client 1 connects.
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'name' => 'Client 1' ) ),
			)
		);

		// Client 2 connects.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 2, 0, array( 'name' => 'Client 2' ) ),
			)
		);

		$data      = $response->get_data();
		$awareness = $data['rooms'][0]['awareness'];

		$this->assertArrayHasKey( 1, $awareness );
		$this->assertArrayHasKey( 2, $awareness );
		$this->assertSame( array( 'name' => 'Client 1' ), $awareness[1] );
		$this->assertSame( array( 'name' => 'Client 2' ), $awareness[2] );
	}

	public function test_sync_awareness_updates_existing_client() {
		wp_set_current_user( self::$editor_id );

		$room = $this->get_post_room();

		// Client 1 connects with initial awareness.
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'cursor' => 'start' ) ),
			)
		);

		// Client 1 updates its awareness.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'cursor' => 'updated' ) ),
			)
		);

		$data      = $response->get_data();
		$awareness = $data['rooms'][0]['awareness'];

		// Should have exactly one entry for client 1 with updated state.
		$this->assertCount( 1, $awareness );
		$this->assertSame( array( 'cursor' => 'updated' ), $awareness[1] );
	}

	public function test_sync_awareness_client_id_cannot_be_used_by_another_user() {
		wp_set_current_user( self::$editor_id );

		$room = $this->get_post_room();

		// Editor establishes awareness with client_id 1.
		$this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'name' => 'Editor' ) ),
			)
		);

		// A different user tries to use the same client_id.
		$editor_id_2 = self::factory()->user->create( array( 'role' => 'editor' ) );
		wp_set_current_user( $editor_id_2 );

		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room, 1, 0, array( 'name' => 'Impostor' ) ),
			)
		);

		$this->assertErrorResponse( 'rest_cannot_edit', $response, 403 );
	}

	/*
	 * Multiple rooms tests.
	 */

	public function test_sync_multiple_rooms_in_single_request() {
		wp_set_current_user( self::$editor_id );

		$room1 = $this->get_post_room();
		$room2 = 'taxonomy/category';

		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room1 ),
				$this->build_room( $room2 ),
			)
		);

		$this->assertSame( 200, $response->get_status() );

		$data = $response->get_data();
		$this->assertCount( 2, $data['rooms'] );
		$this->assertSame( $room1, $data['rooms'][0]['room'] );
		$this->assertSame( $room2, $data['rooms'][1]['room'] );
	}

	public function test_sync_rooms_are_isolated() {
		wp_set_current_user( self::$editor_id );

		$post_id_2 = self::factory()->post->create( array( 'post_author' => self::$editor_id ) );
		$room1     = $this->get_post_room();
		$room2     = 'postType/post:' . $post_id_2;

		$update = array(
			'type' => 'update',
			'data' => 'cm9vbTEgb25seQ==',
		);

		// Client 1 sends an update to room 1 only.
		$this->dispatch_sync(
			array(
				$this->build_room( $room1, 1, 0, array( 'user' => 'client1' ), array( $update ) ),
			)
		);

		// Client 2 queries both rooms.
		$response = $this->dispatch_sync(
			array(
				$this->build_room( $room1, 2, 0 ),
				$this->build_room( $room2, 2, 0 ),
			)
		);

		$data = $response->get_data();

		// Room 1 should have the update.
		$this->assertNotEmpty( $data['rooms'][0]['updates'] );

		// Room 2 should have no updates.
		$this->assertEmpty( $data['rooms'][1]['updates'] );
	}

	/**
	 * The advisory channel's signaling probe rides the poll and is answered
	 * alongside the rooms (see Gutenberg_Sync_Engines_Advisory_Presence).
	 */
	public function test_poll_answers_the_advisory_probe_alongside_the_rooms() {
		wp_set_current_user( self::$editor_id );
		$room    = 'postType/post:' . self::$post_id;
		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/updates' );
		$request->set_body_params(
			array(
				'rooms'    => array(
					array(
						'room'      => $room,
						'client_id' => 1,
						'after'     => 0,
						'awareness' => array( 'user' => 'a' ),
						'updates'   => array(),
					),
				),
				'advisory' => array(
					'room'      => $room,
					'token'     => 'tok-poll',
					'client_id' => 1,
				),
			)
		);
		$response = rest_get_server()->dispatch( $request );
		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertArrayHasKey( 'advisory', $data );
		$this->assertFalse( $data['advisory']['others'] );
		$this->assertSame( array(), $data['advisory']['peers'] );

		// A request without a probe carries no answer.
		$request->set_body_params(
			array(
				'rooms' => array(
					array(
						'room'      => $room,
						'client_id' => 1,
						'after'     => 0,
						'awareness' => array( 'user' => 'a' ),
						'updates'   => array(),
					),
				),
			)
		);
		$this->assertArrayNotHasKey( 'advisory', rest_get_server()->dispatch( $request )->get_data() );
	}

	/**
	 * The room generation token: absent until the room has rows, stable
	 * across requests, and different after the room is reset — the signal a
	 * client uses to notice that its rows and cursor are gone.
	 */
	public function test_room_generation_is_stable_until_the_room_is_reset(): void {
		wp_set_current_user( self::$editor_id );
		$room   = $this->get_post_room();
		$update = array(
			array(
				'data' => base64_encode( 'first' ),
				'type' => Test_Opaque_Relay_Engine::UPDATE_TYPE_UPDATE,
			),
		);

		$first = $this->dispatch_sync( array( $this->build_room( $room, 1, 0, array(), $update ) ) )->get_data()['rooms'][0];
		$this->assertArrayHasKey( 'generation', $first );
		$this->assertIsString( $first['generation'] );
		$this->assertNotSame( '', $first['generation'] );

		// A second client reading the room sees the same token.
		$second = $this->dispatch_sync( array( $this->build_room( $room, 2, 0 ) ) )->get_data()['rooms'][0];
		$this->assertSame( $first['generation'], $second['generation'] );

		// Reset the room (rows, lineage, room meta): the next write mints a
		// new token, so a client holding the old one learns of the restart.
		$storage = wp_get_sync_storage();
		$this->assertTrue( $storage->reset_room( $room ) );
		$after = $this->dispatch_sync( array( $this->build_room( $room, 1, (int) $first['end_cursor'], array(), $update ) ) )->get_data()['rooms'][0];
		$this->assertArrayHasKey( 'generation', $after );
		$this->assertNotSame( $first['generation'], $after['generation'] );
	}

	/**
	 * A room with no rows has nothing to restart, so it carries no token.
	 */
	public function test_room_generation_is_absent_for_an_empty_room(): void {
		wp_set_current_user( self::$editor_id );
		$room     = 'taxonomy/category';
		$response = $this->dispatch_sync( array( $this->build_room( $room ) ) )->get_data()['rooms'][0];
		$this->assertSame( 0, $response['end_cursor'] );
		$this->assertArrayNotHasKey( 'generation', $response );
	}

	/**
	 * A new tab's first request, carrying its presence token, finds nobody
	 * else in the room: the room's leftovers are reset before it is served,
	 * and the generation token changes so any stale client notices.
	 */
	public function test_a_new_tabs_join_resets_an_abandoned_room_and_changes_the_generation(): void {
		wp_set_current_user( self::$editor_id );
		$room   = $this->get_post_room();
		$update = array(
			array(
				'data' => base64_encode( 'stale' ),
				'type' => Test_Opaque_Relay_Engine::UPDATE_TYPE_UPDATE,
			),
		);

		// An earlier session (no presence token: a tab from before the lane,
		// or an expired one) left a row behind, and its awareness has since
		// gone stale.
		$first = $this->dispatch_sync( array( $this->build_room( $room, 1, 0, array(), $update ) ) )->get_data()['rooms'][0];
		$this->assertNotEmpty( $first['generation'] );
		$storage = gutenberg_sync_engines_storage();
		$storage->set_awareness_state(
			$room,
			array_map(
				static function ( $entry ) {
					$entry['updated_at'] = time() - 31;
					return $entry;
				},
				$storage->get_awareness_state( $room )
			)
		);

		// A new tab joins with its token and writes: the old row is gone.
		$join_room                   = $this->build_room( $room, 2, 0, array(), $update );
		$join_room['presence_token'] = 'tab-new';
		$joined                      = $this->dispatch_sync( array( $join_room ) )->get_data()['rooms'][0];
		// The relay fixture never echoes a client's own rows, so the stale
		// row's absence is what shows here; the storage holds the joiner's
		// row alone.
		$this->assertCount( 0, $joined['updates'], 'The earlier session\'s stale row is gone after the reset.' );
		$this->assertSame( array( 2 ), array_column( $storage->get_updates_after_cursor( $room, 0 ), 'client_id' ) );
		$this->assertNotSame( $first['generation'], $joined['generation'] );

		// The same tab again (re-bootstrap from cursor 0): nothing resets.
		$again = $this->dispatch_sync( array( $join_room ) )->get_data()['rooms'][0];
		$this->assertSame( $joined['generation'], $again['generation'] );
	}
}
