<?php
/**
 * Tests for the sync engine registry and the engine mismatch protection in
 * the polling transport.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpSyncEngineRegistry extends WP_Test_REST_TestCase {
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

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id = $factory->user->create( array( 'role' => 'editor' ) );
		self::$post_id   = $factory->post->create( array( 'post_author' => self::$editor_id ) );
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
		wp_delete_post( self::$post_id, true );
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::$editor_id );

		// Register the opaque-relay TEST FIXTURE engine and make it the
		// site's active engine: the lineage/fencing machinery under test is
		// engine-agnostic and needs an engine that accepts arbitrary opaque
		// bytes. The filter and option are rolled back per-test by the WP
		// test framework.
		add_filter(
			'wp_sync_engines',
			static function ( array $engines, WP_Sync_Storage $storage ): array {
				$engines[] = new Test_Opaque_Relay_Engine( $storage );
				return $engines;
			},
			10,
			2
		);
		update_option( 'wp_sync_engine', Test_Opaque_Relay_Engine::SLUG );

		global $wp_rest_server;
		$wp_rest_server = new Spy_REST_Server();
		do_action( 'rest_api_init', $wp_rest_server );
	}

	public function tear_down() {
		global $wp_rest_server;
		$wp_rest_server = null;
		parent::tear_down();
	}

	/**
	 * Builds a minimal /wp-sync/v1/updates request for a single room.
	 *
	 * @param array $room_overrides Fields to override in the room payload.
	 * @return WP_REST_Request Request object.
	 */
	private function build_request( array $room_overrides = array() ): WP_REST_Request {
		$room    = array_merge(
			array(
				'after'     => 0,
				'awareness' => array( 'user' => 'test' ),
				'client_id' => 123,
				'room'      => 'postType/post:' . self::$post_id,
				'updates'   => array(
					array(
						'data' => base64_encode( 'update-bytes' ),
						'type' => Test_Opaque_Relay_Engine::UPDATE_TYPE_UPDATE,
					),
				),
			),
			$room_overrides
		);
		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/updates' );
		$request->set_body_params( array( 'rooms' => array( $room ) ) );

		return $request;
	}

	public function test_registry_defaults_to_intent_log_when_option_unset() {
		delete_option( 'wp_sync_engine' );
		$registry = new WP_Sync_Engine_Registry( new WP_Sync_Table_Storage() );

		$engine = $registry->get_engine( WP_Intent_Log_Engine::SLUG );
		$this->assertInstanceOf( 'WP_Intent_Log_Engine', $engine );
		// The framework's conventional default slug (intent-log) is
		// registered by this plugin, so it wins with no option set.
		$this->assertSame( WP_Intent_Log_Engine::SLUG, $registry->get_engine_slug_for_room( 'postType/post:1' ) );
	}

	public function test_registry_falls_back_to_first_registered_for_unknown_configured_engine() {
		update_option( 'wp_sync_engine', 'engine-that-does-not-exist' );
		$registry = new WP_Sync_Engine_Registry( new WP_Sync_Table_Storage() );

		// A configured-but-unregistered slug degrades to the FIRST
		// registered engine (yjs-server), not the conventional default.
		$this->assertSame( WP_Yjs_Server_Engine::SLUG, $registry->get_engine_slug_for_room( 'postType/post:1' ) );
		delete_option( 'wp_sync_engine' );
	}

	public function test_registry_accepts_engines_from_filter_and_room_override() {
		$stub = $this->createStub( 'WP_Sync_Engine' );
		$stub->method( 'get_slug' )->willReturn( 'stub-engine' );
		$stub->method( 'get_protocol_version' )->willReturn( 7 );
		$stub->method( 'get_update_types' )->willReturn( array( 'stub_update' ) );

		$register = static function ( $engines ) use ( $stub ) {
			$engines[] = $stub;
			return $engines;
		};
		add_filter( 'wp_sync_engines', $register );
		$select = static function ( $slug, $room ) {
			return 'stub/room' === $room ? 'stub-engine' : $slug;
		};
		add_filter( 'wp_sync_engine_for_room', $select, 10, 2 );

		$registry = new WP_Sync_Engine_Registry( new WP_Sync_Table_Storage() );

		$this->assertSame( 'stub-engine', $registry->get_engine_slug_for_room( 'stub/room' ) );
		$this->assertSame( Test_Opaque_Relay_Engine::SLUG, $registry->get_engine_slug_for_room( 'postType/post:1' ) );
		$this->assertContains( 'stub_update', $registry->get_all_update_types() );
		$this->assertContains( Test_Opaque_Relay_Engine::UPDATE_TYPE_UPDATE, $registry->get_all_update_types() );

		remove_filter( 'wp_sync_engines', $register );
		remove_filter( 'wp_sync_engine_for_room', $select );
	}

	public function test_matching_engine_stamp_is_accepted() {
		$request  = $this->build_request(
			array(
				'engine'          => Test_Opaque_Relay_Engine::SLUG,
				'engine_protocol' => Test_Opaque_Relay_Engine::PROTOCOL_VERSION,
			)
		);
		$response = rest_get_server()->dispatch( $request );

		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertArrayHasKey( 'rooms', $data );
		// The relay engine produces no dispositions; the key must be absent.
		$this->assertArrayNotHasKey( 'dispositions', $data['rooms'][0] );
	}

	public function test_wrong_engine_stamp_is_rejected_with_409() {
		$request  = $this->build_request( array( 'engine' => 'intent-log' ) );
		$response = rest_get_server()->dispatch( $request );

		$this->assertErrorResponse( 'rest_sync_engine_mismatch', $response, 409 );
	}

	public function test_wrong_engine_protocol_is_rejected_with_409() {
		$request  = $this->build_request(
			array(
				'engine'          => Test_Opaque_Relay_Engine::SLUG,
				'engine_protocol' => Test_Opaque_Relay_Engine::PROTOCOL_VERSION + 1,
			)
		);
		$response = rest_get_server()->dispatch( $request );

		$this->assertErrorResponse( 'rest_sync_engine_mismatch', $response, 409 );
	}

	public function test_first_write_stamps_room_lineage() {
		$room    = 'postType/post:' . self::$post_id;
		$storage = new WP_Sync_Table_Storage();
		$this->assertNull( $storage->get_room_engine( $room ) );

		$response = rest_get_server()->dispatch( $this->build_request() );
		$this->assertSame( 200, $response->get_status() );

		$this->assertSame( Test_Opaque_Relay_Engine::SLUG, $storage->get_room_engine( $room ) );
	}

	public function test_read_only_request_does_not_stamp_lineage() {
		$response = rest_get_server()->dispatch(
			$this->build_request( array( 'updates' => array() ) )
		);
		$this->assertSame( 200, $response->get_status() );

		$storage = new WP_Sync_Table_Storage();
		$this->assertNull( $storage->get_room_engine( 'postType/post:' . self::$post_id ) );
	}

	public function test_lineage_from_another_engine_is_rejected_with_409() {
		$room    = 'postType/post:' . self::$post_id;
		$storage = new WP_Sync_Table_Storage();
		$storage->set_room_engine( $room, 'intent-log' );

		$response = rest_get_server()->dispatch( $this->build_request() );

		$this->assertErrorResponse( 'rest_sync_engine_mismatch', $response, 409 );
	}

	public function test_engine_switch_resets_collection_room_for_new_engine_clients() {
		$room = 'taxonomy/wp_pattern_category';

		// Stamp the room under the relay: a relay client writes to it.
		$write = rest_get_server()->dispatch(
			$this->build_request(
				array(
					'room'   => $room,
					'engine' => Test_Opaque_Relay_Engine::SLUG,
				)
			)
		);
		$this->assertSame( 200, $write->get_status() );
		$storage = new WP_Sync_Table_Storage();
		$this->assertSame( Test_Opaque_Relay_Engine::SLUG, $storage->get_room_engine( $room ) );

		// The site switches engines. A client speaking the NEW engine must
		// not be fenced forever on this global, rebuildable room: it resets
		// and re-derives under yjs-server instead.
		update_option( 'wp_sync_engine', WP_Yjs_Server_Engine::SLUG );
		try {
			$response = rest_get_server()->dispatch(
				$this->build_request(
					array(
						'room'            => $room,
						'engine'          => WP_Yjs_Server_Engine::SLUG,
						'engine_protocol' => WP_Yjs_Server_Engine::PROTOCOL_VERSION,
						'updates'         => array(),
					)
				)
			);
			$this->assertSame( 200, $response->get_status() );

			// The room was reset and re-genesised under the new engine: the
			// relay rows are gone and lineage moved on.
			$this->assertSame( WP_Yjs_Server_Engine::SLUG, $storage->get_room_engine( $room ) );
			$rows = $response->get_data()['rooms'][0]['updates'];
			$this->assertNotEmpty( $rows );
			$this->assertSame( WP_Yjs_Server_Engine::UPDATE_TYPE_SNAPSHOT, $rows[0]['type'] );
			foreach ( $rows as $row ) {
				$this->assertNotSame( Test_Opaque_Relay_Engine::UPDATE_TYPE_SYNC_STEP1, $row['type'] );
			}
		} finally {
			delete_option( 'wp_sync_engine' );
		}
	}

	public function test_engine_switch_keeps_post_entity_rooms_fenced() {
		$room = 'postType/post:' . self::$post_id;

		// A relay client writes real content to the post's room.
		$write = rest_get_server()->dispatch(
			$this->build_request( array( 'engine' => Test_Opaque_Relay_Engine::SLUG ) )
		);
		$this->assertSame( 200, $write->get_status() );

		// After the switch, even a client speaking the new engine is fenced:
		// per-post rooms can hold unsaved collaborative content and degrade
		// to the post lock by design.
		update_option( 'wp_sync_engine', WP_Yjs_Server_Engine::SLUG );
		try {
			$response = rest_get_server()->dispatch(
				$this->build_request(
					array(
						'room'            => $room,
						'engine'          => WP_Yjs_Server_Engine::SLUG,
						'engine_protocol' => WP_Yjs_Server_Engine::PROTOCOL_VERSION,
						'updates'         => array(),
					)
				)
			);
			$this->assertErrorResponse( 'rest_sync_engine_mismatch', $response, 409 );
			$this->assertSame(
				Test_Opaque_Relay_Engine::SLUG,
				( new WP_Sync_Table_Storage() )->get_room_engine( $room )
			);
		} finally {
			delete_option( 'wp_sync_engine' );
		}
	}

	public function test_stale_tab_never_triggers_a_room_reset() {
		$room = 'taxonomy/wp_pattern_category';

		$write = rest_get_server()->dispatch(
			$this->build_request(
				array(
					'room'   => $room,
					'engine' => Test_Opaque_Relay_Engine::SLUG,
				)
			)
		);
		$this->assertSame( 200, $write->get_status() );

		// The site switched, but this tab still speaks the OLD engine: it is
		// fenced by the client-stamp check and must not reset anything.
		update_option( 'wp_sync_engine', WP_Yjs_Server_Engine::SLUG );
		try {
			$response = rest_get_server()->dispatch(
				$this->build_request(
					array(
						'room'   => $room,
						'engine' => Test_Opaque_Relay_Engine::SLUG,
					)
				)
			);
			$this->assertErrorResponse( 'rest_sync_engine_mismatch', $response, 409 );
			$this->assertSame(
				Test_Opaque_Relay_Engine::SLUG,
				( new WP_Sync_Table_Storage() )->get_room_engine( $room )
			);
		} finally {
			delete_option( 'wp_sync_engine' );
		}
	}

	public function test_lineage_stamp_does_not_overwrite() {
		$room    = 'postType/post:' . self::$post_id . ':lineage';
		$storage = new WP_Sync_Table_Storage();

		$this->assertTrue( $storage->set_room_engine( $room, 'first-engine' ) );
		$this->assertTrue( $storage->set_room_engine( $room, 'second-engine' ) );
		$this->assertSame( 'first-engine', $storage->get_room_engine( $room ) );
	}

	public function test_mismatch_error_carries_expected_engine_details() {
		$response = rest_get_server()->dispatch(
			$this->build_request( array( 'engine' => 'intent-log' ) )
		);
		$this->assertWPError( $response->as_error() );
		$data = $response->as_error()->get_error_data();

		$this->assertSame( Test_Opaque_Relay_Engine::SLUG, $data['engine'] );
		$this->assertSame( Test_Opaque_Relay_Engine::PROTOCOL_VERSION, $data['engine_protocol'] );
		$this->assertSame( 'postType/post:' . self::$post_id, $data['room'] );
	}
}
