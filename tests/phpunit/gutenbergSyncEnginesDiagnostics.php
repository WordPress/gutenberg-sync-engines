<?php
/**
 * Tests for the diagnostics request log and session capture (the
 * community-harness-convention benchmark observability:
 * capture→sanitize→replay fixtures and per-request server metrics).
 *
 * The diagnostics files are environment-gated in the plugin bootstrap; the
 * test bootstrap defines GUTENBERG_SYNC_ENGINES_DIAGNOSTICS so they load
 * (and register their dispatch hooks) regardless of the test environment's
 * reported type. These tests drive the REST dispatch filters by hand.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_GutenbergSyncEnginesDiagnostics extends WP_UnitTestCase {
	/**
	 * Post ID used for capture room targets.
	 *
	 * @var int
	 */
	protected static $post_id;

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$post_id = $factory->post->create(
			array(
				'post_title'   => 'Capture base title',
				'post_content' => '<!-- wp:paragraph --><p>Base paragraph</p><!-- /wp:paragraph -->',
			)
		);

		// DDL causes an implicit commit, so create the tables once outside
		// the per-test transactions.
		Gutenberg_Sync_Engines_Request_Log::ensure_table();
		Gutenberg_Sync_Engines_Session_Capture::ensure_table();
	}

	public static function wpTearDownAfterClass() {
		wp_delete_post( self::$post_id, true );
		Gutenberg_Sync_Engines_Request_Log::drop_table();
		Gutenberg_Sync_Engines_Session_Capture::drop( null );
	}

	public function set_up() {
		global $wpdb;
		parent::set_up();
		Gutenberg_Sync_Engines_Request_Log::reset_whole_request();
		unset( $_SERVER['HTTP_X_RTC_TEST'], $_SERVER['HTTP_X_RTC_SCENARIO'], $_SERVER['HTTP_X_RTC_APPROACH'] );
		// The plugin bootstrap registered the diagnostics hooks (the test
		// bootstrap defines GUTENBERG_SYNC_ENGINES_DIAGNOSTICS); these tests
		// only need clean tables.
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.NotPrepared -- Test isolation on diagnostics-only tables.
		$wpdb->query( 'DELETE FROM `' . Gutenberg_Sync_Engines_Request_Log::table() . '`' );
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.NotPrepared -- Test isolation on diagnostics-only tables.
		$wpdb->query( 'DELETE FROM `' . Gutenberg_Sync_Engines_Session_Capture::table() . '`' );
	}

	/**
	 * Builds a wp-sync updates request carrying one room payload.
	 *
	 * @param string $room    Room identifier.
	 * @param array  $updates Updates array.
	 * @return WP_REST_Request Request.
	 */
	private function build_sync_request( string $room, array $updates = array() ): WP_REST_Request {
		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/updates' );
		$request->set_param(
			'rooms',
			array(
				array(
					'room'      => $room,
					'client_id' => 10001,
					'awareness' => array(
						'name'  => 'Test Client',
						'color' => '#cc0000',
					),
					'after'     => 0,
					'updates'   => $updates,
				),
			)
		);
		return $request;
	}

	/**
	 * Runs a request/response pair through the dispatch filters like the
	 * REST server would.
	 *
	 * @param WP_REST_Request $request  Request.
	 * @param array           $data     Response payload.
	 * @return WP_REST_Response The filtered response.
	 */
	private function simulate_dispatch( WP_REST_Request $request, array $data ) {
		$server = rest_get_server();
		apply_filters( 'rest_pre_dispatch', null, $server, $request );
		$response = new WP_REST_Response( $data, 200 );
		return apply_filters( 'rest_post_dispatch', $response, $server, $request );
	}

	/**
	 * A room-shaped response payload.
	 *
	 * @param array $updates Outgoing updates.
	 * @return array Response data.
	 */
	private function room_response( array $updates = array() ): array {
		return array(
			'rooms' => array(
				array(
					'room'           => 'postType/post:' . self::$post_id,
					'updates'        => $updates,
					'end_cursor'     => 7,
					'should_compact' => false,
					'total_updates'  => 7,
					'awareness'      => array( '10001' => array( 'name' => 'Test Client' ) ),
				),
			),
		);
	}

	// -----------------------------------------------------------------
	// Request log
	// -----------------------------------------------------------------

	public function test_untagged_requests_are_not_logged() {
		$this->simulate_dispatch(
			$this->build_sync_request( 'postType/post:' . self::$post_id ),
			$this->room_response()
		);

		$this->assertSame( array(), Gutenberg_Sync_Engines_Request_Log::fetch_rows() );
	}

	public function test_tagged_request_records_community_convention_row() {
		update_option( 'wp_sync_engine', 'intent-log' );

		$request = $this->build_sync_request(
			'postType/post:' . self::$post_id,
			array(
				array(
					'type' => 'intent',
					'data' => '{}',
				),
				array(
					'type' => 'intent',
					'data' => '{}',
				),
			)
		);
		$request->set_header( 'X-RTC-Test', '1' );
		$request->set_header( 'X-RTC-Scenario', 'editing' );
		$request->set_header( 'X-RTC-Poll-Delay', '1' );
		$request->set_header( 'X-RTC-Update-Size', 'small' );

		$response = $this->simulate_dispatch(
			$request,
			$this->room_response( array( array( 'type' => 'intent' ) ) )
		);

		$rows = Gutenberg_Sync_Engines_Request_Log::fetch_rows();
		$this->assertCount( 1, $rows );
		$row = $rows[0];

		$this->assertSame( 'editing', $row['scenario'] );
		// No approach label sent: rows auto-label <engine>/<transport>.
		$this->assertSame( 'intent-log/http-polling', $row['approach'] );
		$this->assertSame( 1, $row['poll_delay'] );
		$this->assertSame( 'small', $row['update_size'] );
		$this->assertSame( 2, $row['updates_in'] );
		$this->assertSame( 1, $row['updates_out'] );
		$this->assertSame( 1, $row['rooms'] );
		$this->assertSame( 1, $row['awareness_count'] );
		$this->assertSame( 7, $row['total_updates'] );
		$this->assertSame( 200, $row['status'] );
		$this->assertFalse( $row['should_compact'] );
		$this->assertGreaterThanOrEqual( 0, $row['ms'] );
		$this->assertGreaterThanOrEqual( 1, $row['concurrent'] );
		$this->assertGreaterThan( 0, $row['peak_memory'] );
		$this->assertGreaterThan( 0, $row['response_bytes'] );

		// The community harness's diagnostic response headers.
		$headers = $response->get_headers();
		$this->assertSame( '1', $headers['X-RTC-Test-Active'] );
		$this->assertSame( '1', $headers['X-RTC-DB-Insert'] );

		delete_option( 'wp_sync_engine' );
	}

	public function test_query_parameter_tags_work_without_headers() {
		$request = $this->build_sync_request( 'postType/post:' . self::$post_id );
		$request->set_param( '_rtctest', '1' );
		$request->set_param( '_rtcscenario', 'sustain' );
		$request->set_param( '_rtcapproach', 'custom-label' );

		$this->simulate_dispatch( $request, $this->room_response() );

		$rows = Gutenberg_Sync_Engines_Request_Log::fetch_rows();
		$this->assertCount( 1, $rows );
		$this->assertSame( 'sustain', $rows[0]['scenario'] );
		// An explicit approach label wins over the auto-label.
		$this->assertSame( 'custom-label', $rows[0]['approach'] );
	}

	public function test_non_sync_routes_are_not_logged() {
		$request = new WP_REST_Request( 'GET', '/wp/v2/posts' );
		$request->set_header( 'X-RTC-Test', '1' );

		$this->simulate_dispatch( $request, array() );

		$this->assertSame( array(), Gutenberg_Sync_Engines_Request_Log::fetch_rows() );
	}

	public function test_option_writes_are_counted_per_request() {
		$request = $this->build_sync_request( 'postType/post:' . self::$post_id );
		$request->set_header( 'X-RTC-Test', '1' );
		$request->set_header( 'X-RTC-Scenario', 'editing' );

		$server = rest_get_server();
		apply_filters( 'rest_pre_dispatch', null, $server, $request );
		// Two options-API writes inside the measured window; the direct-SQL
		// primitives (room lock, CAS) deliberately bypass the API and must
		// not count.
		update_option( 'gutenberg_sync_engines_test_option', 'a' );
		delete_option( 'gutenberg_sync_engines_test_option' );
		apply_filters(
			'rest_post_dispatch',
			new WP_REST_Response( $this->room_response(), 200 ),
			$server,
			$request
		);

		$rows = Gutenberg_Sync_Engines_Request_Log::fetch_rows();
		$this->assertCount( 1, $rows );
		$this->assertGreaterThanOrEqual( 2, $rows[0]['option_writes'] );
		// The PHP-process block-I/O columns exist and are sane (zero on
		// platforms whose getrusage does not fill the fields).
		$this->assertGreaterThanOrEqual( 0, $rows[0]['php_io_reads'] );
		$this->assertGreaterThanOrEqual( 0, $rows[0]['php_io_writes'] );
	}

	public function test_db_io_counters_are_cumulative_and_route_matches() {
		$first = Gutenberg_Sync_Engines_Request_Log::db_io_counters();
		$this->assertArrayHasKey( 'available', $first );
		$this->assertArrayHasKey( 'data_reads', $first );
		$this->assertArrayHasKey( 'data_writes', $first );
		$this->assertArrayHasKey( 'fsyncs', $first );
		$this->assertArrayHasKey( 'buffer_pool_reads', $first );

		if ( $first['available'] ) {
			// Force at least one write transaction, then resample: the
			// counters are cumulative and must never go backward.
			update_option( 'gutenberg_sync_engines_dbio_probe', wp_rand() );
			delete_option( 'gutenberg_sync_engines_dbio_probe' );
			$second = Gutenberg_Sync_Engines_Request_Log::db_io_counters();
			$this->assertGreaterThanOrEqual( $first['data_writes'], $second['data_writes'] );
			$this->assertGreaterThanOrEqual( $first['fsyncs'], $second['fsyncs'] );
		}

		$log  = new Gutenberg_Sync_Engines_Request_Log();
		$data = $log->rest_db_io()->get_data();
		$this->assertSame( $first['available'], $data['available'] );
	}

	public function test_room_size_route_reports_storage_without_creating() {
		$log = new Gutenberg_Sync_Engines_Request_Log();

		$missing = new WP_REST_Request( 'GET', '/rtc-test/v1/room-size' );
		$missing->set_param( 'room', 'postType/post:999999' );
		$data = $log->rest_room_size( $missing )->get_data();
		$this->assertFalse( $data['found'] );
		$this->assertSame( 0, $data['rows'] );

		// The probe must not have created the room by looking.
		$this->assertFalse( ( new WP_Sync_Table_Storage() )->get_room_size( 'postType/post:999999' )['found'] );

		// A room with two update rows.
		$room    = 'postType/post:' . self::$post_id;
		$storage = new WP_Sync_Table_Storage();
		$storage->add_update( $room, 'payload-one' );
		$storage->add_update( $room, 'payload-two-longer' );

		$request = new WP_REST_Request( 'GET', '/rtc-test/v1/room-size' );
		$request->set_param( 'room', $room );
		$data = $log->rest_room_size( $request )->get_data();
		$this->assertTrue( $data['found'] );
		$this->assertSame( 2, $data['rows'] );
		$this->assertGreaterThan( 0, $data['bytes'] );
	}

	public function test_whole_request_capture_logs_any_tagged_request() {
		// The mu-plugin lane: an untagged request arms nothing…
		$log = new Gutenberg_Sync_Engines_Request_Log();
		$log->capture_whole_request();
		Gutenberg_Sync_Engines_Request_Log::flush_whole_request();
		$this->assertSame( array(), Gutenberg_Sync_Engines_Request_Log::fetch_rows() );

		// …and a tagged one (any route — there is no REST request at all
		// here, as on a page load or admin-ajax) logs a whole-request row.
		$_SERVER['HTTP_X_RTC_TEST']     = '1';
		$_SERVER['HTTP_X_RTC_SCENARIO'] = 'host-editing';
		$_SERVER['HTTP_X_RTC_APPROACH'] = 'baseline';
		$log->capture_whole_request();
		Gutenberg_Sync_Engines_Request_Log::flush_whole_request();

		$rows = Gutenberg_Sync_Engines_Request_Log::fetch_rows();
		$this->assertCount( 1, $rows );
		$this->assertSame( 'host-editing', $rows[0]['scenario'] );
		$this->assertSame( 'baseline', $rows[0]['approach'] );
		$this->assertSame( 0.0, $rows[0]['ms'] );
		$this->assertGreaterThan( 0, $rows[0]['total_ms'] );
		$this->assertGreaterThan( 0, $rows[0]['peak_memory'] );
		$this->assertGreaterThanOrEqual( 1, $rows[0]['concurrent'] );

		// A second flush must not insert a second row.
		Gutenberg_Sync_Engines_Request_Log::flush_whole_request();
		$this->assertCount( 1, Gutenberg_Sync_Engines_Request_Log::fetch_rows() );
	}

	public function test_whole_request_capture_merges_with_rest_dispatch() {
		// Armed whole-request lane + a tagged REST dispatch in the same
		// request (the mu-plugin scenario with the plugin active): ONE
		// row, carrying the dispatch detail AND whole-request totals.
		$_SERVER['HTTP_X_RTC_TEST']     = '1';
		$_SERVER['HTTP_X_RTC_SCENARIO'] = 'host-editing';
		$_SERVER['HTTP_X_RTC_APPROACH'] = 'intent-log';
		$log                            = new Gutenberg_Sync_Engines_Request_Log();
		$log->capture_whole_request();

		$request = $this->build_sync_request( 'postType/post:' . self::$post_id );
		$request->set_header( 'X-RTC-Test', '1' );
		$request->set_header( 'X-RTC-Scenario', 'host-editing' );
		$request->set_header( 'X-RTC-Approach', 'intent-log' );
		$response = $this->simulate_dispatch( $request, $this->room_response() );

		// The dispatch deferred its insert to the shutdown flush.
		$this->assertSame( array(), Gutenberg_Sync_Engines_Request_Log::fetch_rows() );
		$this->assertSame( 'deferred', $response->get_headers()['X-RTC-DB-Insert'] );

		Gutenberg_Sync_Engines_Request_Log::flush_whole_request();
		$rows = Gutenberg_Sync_Engines_Request_Log::fetch_rows();
		$this->assertCount( 1, $rows );
		$this->assertSame( 'host-editing', $rows[0]['scenario'] );
		$this->assertSame( 'intent-log', $rows[0]['approach'] );
		// Dispatch detail survived the merge…
		$this->assertSame( 1, $rows[0]['rooms'] );
		$this->assertGreaterThan( 0, $rows[0]['response_bytes'] );
		// …and the totals are whole-request measurements.
		$this->assertGreaterThan( 0, $rows[0]['total_ms'] );
	}

	public function test_tagged_autosave_route_is_logged() {
		// De-rtc commits travel through the ordinary autosave endpoint, so
		// a client that tags one (the host benchmark tags commit-shaped
		// autosaves) opts it into the log; untagged autosaves stay out.
		$untagged = new WP_REST_Request( 'POST', '/wp/v2/posts/' . self::$post_id . '/autosaves' );
		$this->simulate_dispatch( $untagged, array() );
		$this->assertSame( array(), Gutenberg_Sync_Engines_Request_Log::fetch_rows() );

		$tagged = new WP_REST_Request( 'POST', '/wp/v2/posts/' . self::$post_id . '/autosaves' );
		$tagged->set_header( 'X-RTC-Test', '1' );
		$tagged->set_header( 'X-RTC-Scenario', 'host-editing' );
		$this->simulate_dispatch( $tagged, array( 'id' => self::$post_id ) );

		$rows = Gutenberg_Sync_Engines_Request_Log::fetch_rows();
		$this->assertCount( 1, $rows );
		$this->assertSame( 'host-editing', $rows[0]['scenario'] );
		$this->assertSame( 0, $rows[0]['rooms'] );
		$this->assertSame( 0, $rows[0]['updates_in'] );
	}

	public function test_report_text_includes_baseline_ratio() {
		foreach ( array( 'baseline', 'baseline', 'editing' ) as $scenario ) {
			$request = $this->build_sync_request( 'postType/post:' . self::$post_id );
			$request->set_header( 'X-RTC-Test', '1' );
			$request->set_header( 'X-RTC-Scenario', $scenario );
			$this->simulate_dispatch( $request, $this->room_response() );
		}

		$text = Gutenberg_Sync_Engines_Request_Log::report_text( null, false );
		$this->assertStringContainsString( 'Scenario', $text );
		$this->assertStringContainsString( 'disp_ms', $text );
		$this->assertStringContainsString( 'baseline', $text );
		$this->assertStringContainsString( 'editing', $text );
		$this->assertStringContainsString( 'Ratio to baseline', $text );

		$per_approach = Gutenberg_Sync_Engines_Request_Log::report_text( null, true );
		$this->assertStringContainsString( '--- Approach:', $per_approach );
	}

	// -----------------------------------------------------------------
	// Session capture
	// -----------------------------------------------------------------

	public function test_capture_lifecycle_exports_community_fixture_format() {
		update_option( 'wp_sync_engine', 'intent-log' );
		$room = 'postType/post:' . self::$post_id;

		$started = Gutenberg_Sync_Engines_Session_Capture::start( 'test-session', $room );
		$this->assertIsArray( $started );
		$this->assertSame( 'intent-log', $started['engine'] );

		$this->simulate_dispatch(
			$this->build_sync_request(
				$room,
				array(
					array(
						'type' => 'intent',
						'data' => '{"op":"x"}',
					),
				)
			),
			$this->room_response()
		);
		// A frame for a different room must not be captured under a filter.
		$this->simulate_dispatch(
			$this->build_sync_request( 'postType/post:999999' ),
			$this->room_response()
		);

		$stopped = Gutenberg_Sync_Engines_Session_Capture::stop();
		$this->assertIsArray( $stopped );
		$this->assertSame( 1, $stopped['frames'] );

		$fixture = Gutenberg_Sync_Engines_Session_Capture::export( 'test-session' );
		$this->assertIsArray( $fixture );

		// The community capture-export shape.
		$this->assertSame( 'test-session', $fixture['session_id'] );
		$this->assertSame( 1, $fixture['frame_count'] );
		$frame = $fixture['frames'][0];
		$this->assertSame( 1, $frame['n'] );
		$this->assertSame( 10001, $frame['client_id'] );
		$this->assertSame( $room, $frame['room'] );
		$this->assertArrayHasKey( 'elapsed_ms', $frame );
		$this->assertSame( $room, $frame['request']['rooms'][0]['room'] );
		$this->assertCount( 1, $frame['request']['rooms'][0]['updates'] );
		$this->assertSame( 7, $frame['response']['rooms'][0]['end_cursor'] );

		// The additive replay metadata this plugin's exports carry.
		$this->assertSame( 'intent-log', $fixture['engine'] );
		$this->assertSame( 'Capture base title', $fixture['base_title'] );
		$this->assertStringContainsString( 'Base paragraph', $fixture['base_content'] );

		$this->assertSame( 1, Gutenberg_Sync_Engines_Session_Capture::drop( 'test-session' ) );
		$this->assertNull( Gutenberg_Sync_Engines_Session_Capture::export( 'test-session' ) );

		delete_option( 'wp_sync_engine' );
	}

	public function test_capture_requires_stop_before_restart() {
		$this->assertIsArray( Gutenberg_Sync_Engines_Session_Capture::start( 'first' ) );
		$second = Gutenberg_Sync_Engines_Session_Capture::start( 'second' );
		$this->assertWPError( $second );
		$this->assertSame( 'capture_active', $second->get_error_code() );
		Gutenberg_Sync_Engines_Session_Capture::stop();
	}

	public function test_capture_rejects_invalid_session_ids() {
		$result = Gutenberg_Sync_Engines_Session_Capture::start( 'bad id!' );
		$this->assertWPError( $result );
		$this->assertSame( 'invalid_session_id', $result->get_error_code() );
	}

	public function test_capture_without_filter_records_all_rooms_and_lists_sessions() {
		Gutenberg_Sync_Engines_Session_Capture::start( 'unfiltered' );

		$this->simulate_dispatch(
			$this->build_sync_request( 'postType/post:' . self::$post_id ),
			$this->room_response()
		);
		$this->simulate_dispatch(
			$this->build_sync_request( 'taxonomy/category' ),
			$this->room_response()
		);

		$stopped = Gutenberg_Sync_Engines_Session_Capture::stop();
		$this->assertSame( 2, $stopped['frames'] );

		$sessions = Gutenberg_Sync_Engines_Session_Capture::sessions();
		$this->assertCount( 1, $sessions );
		$this->assertSame( 'unfiltered', $sessions[0]['session_id'] );
		$this->assertSame( 2, $sessions[0]['frames'] );
		$this->assertFalse( $sessions[0]['active'] );

		Gutenberg_Sync_Engines_Session_Capture::drop( null );
	}
}
