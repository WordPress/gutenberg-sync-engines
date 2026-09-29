<?php
/**
 * Tests for Gutenberg_Sync_Engines_Advisory_Presence: the per-tab presence
 * tokens, the heartbeat discovery answer, the handshake mailbox, and the
 * leave beacon behind the advisory channel.
 *
 * @package gutenberg-sync-engines
 *
 * @group collaboration
 */
class Tests_Collaboration_GutenbergSyncEnginesAdvisoryPresence extends WP_UnitTestCase {

	protected static int $editor_id;
	protected static int $other_editor_id;
	protected static int $subscriber_id;
	protected static int $post_id;

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id       = $factory->user->create(
			array(
				'role'         => 'editor',
				'display_name' => 'Riley',
			)
		);
		self::$other_editor_id = $factory->user->create( array( 'role' => 'editor' ) );
		self::$subscriber_id   = $factory->user->create( array( 'role' => 'subscriber' ) );
		self::$post_id         = $factory->post->create( array( 'post_author' => self::$editor_id ) );
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
		self::delete_user( self::$other_editor_id );
		self::delete_user( self::$subscriber_id );
		wp_delete_post( self::$post_id, true );
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::$editor_id );
		$this->presence = new Gutenberg_Sync_Engines_Advisory_Presence();

		// The storage caches room => storage post id across requests; the
		// per-test transaction rollback removes the post but not the cache.
		$reflection = new ReflectionProperty( 'WP_Sync_Post_Meta_Storage', 'storage_post_ids' );
		if ( PHP_VERSION_ID < 80100 ) {
			$reflection->setAccessible( true );
		}
		$reflection->setValue( null, array() );

		Fake_Presence_API::reset();
		WP_Sync_Awareness::reset_backend_for_testing();
	}

	public function tear_down() {
		Fake_Presence_API::reset();
		WP_Sync_Awareness::reset_backend_for_testing();
		parent::tear_down();
	}

	/**
	 * @var Gutenberg_Sync_Engines_Advisory_Presence
	 */
	private $presence;

	private function room(): string {
		return 'postType/post:' . self::$post_id;
	}

	private function beat( string $token, array $extra = array() ): array {
		$data     = array(
			Gutenberg_Sync_Engines_Advisory_Presence::HEARTBEAT_KEY => array_merge(
				array(
					'room'  => $this->room(),
					'token' => $token,
				),
				$extra
			),
		);
		$response = $this->presence->answer_heartbeat( array(), $data );
		return $response[ Gutenberg_Sync_Engines_Advisory_Presence::HEARTBEAT_KEY ] ?? array();
	}

	public function test_editor_settings_stamp_a_token_and_report_no_company_for_the_first_tab() {
		$settings = $this->presence->editor_settings( get_post( self::$post_id ) );

		$this->assertSame( $this->room(), $settings['room'] );
		$this->assertNotEmpty( $settings['token'] );
		$this->assertFalse( $settings['othersPresent'] );
		$this->assertSame( 8, $settings['maxPeers'] );
		$this->assertNotEmpty( $settings['iceServers'] );
		$this->assertStringContainsString( '/advisory/leave', $settings['leaveUrl'] );

		// The stamped token is visible to a second tab at once.
		$second = $this->presence->editor_settings( get_post( self::$post_id ) );
		$this->assertTrue( $second['othersPresent'] );
	}

	public function test_editor_settings_are_withheld_from_users_who_may_not_sync_and_when_disabled() {
		wp_set_current_user( self::$subscriber_id );
		$this->assertNull( $this->presence->editor_settings( get_post( self::$post_id ) ) );

		wp_set_current_user( self::$editor_id );
		add_filter( 'gutenberg_sync_engines_advisory_enabled', '__return_false' );
		$this->assertNull( $this->presence->editor_settings( get_post( self::$post_id ) ) );
		remove_filter( 'gutenberg_sync_engines_advisory_enabled', '__return_false' );
	}

	public function test_heartbeat_answers_company_and_peers_from_tokens() {
		$alone = $this->beat( 'tok-a', array( 'client_id' => 11 ) );
		$this->assertFalse( $alone['others'] );
		$this->assertSame( array(), $alone['peers'] );
		$this->assertSame( array(), $alone['signals'] );

		wp_set_current_user( self::$other_editor_id );
		$joined = $this->beat( 'tok-b', array( 'client_id' => 22 ) );
		$this->assertTrue( $joined['others'] );
		$this->assertSame(
			array(
				array(
					'token'     => 'tok-a',
					'client_id' => 11,
					'user_id'   => self::$editor_id,
				),
			),
			$joined['peers']
		);

		wp_set_current_user( self::$editor_id );
		$again = $this->beat( 'tok-a', array( 'client_id' => 11 ) );
		$this->assertTrue( $again['others'] );
		$this->assertSame( 'tok-b', $again['peers'][0]['token'] );
		$this->assertSame( 22, $again['peers'][0]['client_id'] );
	}

	public function test_a_probe_with_a_block_keeps_it_on_the_token_and_answers_peers_with_theirs() {
		$this->beat(
			'tok-a',
			array(
				'client_id' => 11,
				'block'     => 's-one',
			)
		);

		// A probe without a block key (a tab not running slow awareness
		// over Heartbeat) gets the plain discovery answer.
		wp_set_current_user( self::$other_editor_id );
		$plain = $this->beat( 'tok-b', array( 'client_id' => 22 ) );
		$this->assertSame( array( 'token', 'client_id', 'user_id' ), array_keys( $plain['peers'][0] ) );

		// A probe with one gets every other tab's block, name, and avatar.
		$peers = $this->beat(
			'tok-b',
			array(
				'client_id' => 22,
				'block'     => null,
			)
		)['peers'];
		$this->assertCount( 1, $peers );
		$this->assertSame( 'tok-a', $peers[0]['token'] );
		$this->assertSame( 's-one', $peers[0]['block'] );
		$this->assertSame( 'Riley', $peers[0]['name'] );
		$this->assertNotEmpty( $peers[0]['avatar'] );

		// The block stays on the token across a probe without one, and a
		// null block means present but in no block.
		wp_set_current_user( self::$editor_id );
		$this->beat( 'tok-a', array( 'client_id' => 11 ) );
		$peers = $this->beat(
			'tok-a',
			array(
				'client_id' => 11,
				'block'     => 's-two',
			)
		)['peers'];
		$this->assertNull( $peers[0]['block'], 'tok-b reported null' );
		wp_set_current_user( self::$other_editor_id );
		$peers = $this->beat(
			'tok-b',
			array(
				'client_id' => 22,
				'block'     => null,
			)
		)['peers'];
		$this->assertSame( 's-two', $peers[0]['block'] );

		// Unusable values are stored as null.
		$cases = array( str_repeat( 'a', Gutenberg_Sync_Engines_Advisory_Presence::MAX_BLOCK_BYTES + 1 ), array( 'nested' => true ), '', 42 );
		foreach ( $cases as $index => $bad ) {
			wp_set_current_user( self::$editor_id );
			$this->beat(
				'tok-a',
				array(
					'client_id' => 11,
					'block'     => $bad,
				)
			);
			wp_set_current_user( self::$other_editor_id );
			$peers = $this->beat(
				'tok-b',
				array(
					'client_id' => 22,
					'block'     => null,
				)
			)['peers'];
			$this->assertNull( $peers[0]['block'], "case $index" );
		}
	}

	public function test_the_heartbeat_interval_follows_the_awareness_setting_on_editor_screens_only() {
		$GLOBALS['pagenow'] = 'post.php';
		$this->assertSame( array( 'x' => 1 ), $this->presence->filter_heartbeat_settings( array( 'x' => 1 ) ), 'Off: untouched' );

		update_option( Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_OPTION, 15 );
		update_option( Gutenberg_Sync_Engines_Settings::AWARENESS_CHANNEL_OPTION, 'heartbeat' );
		$this->assertSame( 15, $this->presence->filter_heartbeat_settings( array() )['interval'] );

		$GLOBALS['pagenow'] = 'post-new.php';
		$this->assertSame( 15, $this->presence->filter_heartbeat_settings( array() )['interval'] );

		$GLOBALS['pagenow'] = 'index.php';
		$this->assertArrayNotHasKey( 'interval', $this->presence->filter_heartbeat_settings( array() ) );

		update_option( Gutenberg_Sync_Engines_Settings::AWARENESS_CHANNEL_OPTION, 'sync' );
		$GLOBALS['pagenow'] = 'post.php';
		$this->assertArrayNotHasKey( 'interval', $this->presence->filter_heartbeat_settings( array() ), 'Sync channel leaves Heartbeat alone' );

		delete_option( Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_OPTION );
		delete_option( Gutenberg_Sync_Engines_Settings::AWARENESS_CHANNEL_OPTION );
		unset( $GLOBALS['pagenow'] );
	}

	public function test_heartbeat_ignores_probes_without_permission_or_for_non_post_rooms() {
		wp_set_current_user( self::$subscriber_id );
		$response = $this->presence->answer_heartbeat(
			array( 'keep' => 1 ),
			array(
				Gutenberg_Sync_Engines_Advisory_Presence::HEARTBEAT_KEY => array(
					'room'  => $this->room(),
					'token' => 'tok-x',
				),
			)
		);
		$this->assertSame( array( 'keep' => 1 ), $response );

		wp_set_current_user( self::$editor_id );
		$response = $this->presence->answer_heartbeat(
			array(),
			array(
				Gutenberg_Sync_Engines_Advisory_Presence::HEARTBEAT_KEY => array(
					'room'  => 'taxonomy/category',
					'token' => 'tok-x',
				),
			)
		);
		$this->assertArrayNotHasKey( Gutenberg_Sync_Engines_Advisory_Presence::HEARTBEAT_KEY, $response );

		// The rejected probes left no trace: the first real tab is alone.
		$this->assertFalse( $this->beat( 'tok-a' )['others'] );
	}

	public function test_heartbeat_relays_signals_to_live_peers_only_and_drains_the_mailbox() {
		$this->beat( 'tok-a' );
		wp_set_current_user( self::$other_editor_id );
		$this->beat( 'tok-b' );

		// A sends B an offer, plus junk: to itself, to an unknown token, an
		// unknown kind, an oversized payload.
		wp_set_current_user( self::$editor_id );
		$this->beat(
			'tok-a',
			array(
				'signals' => array(
					array(
						'to'   => 'tok-b',
						'kind' => 'offer',
						'data' => 'sdp-offer',
					),
					array(
						'to'   => 'tok-a',
						'kind' => 'offer',
						'data' => 'self',
					),
					array(
						'to'   => 'tok-nobody',
						'kind' => 'offer',
						'data' => 'nobody',
					),
					array(
						'to'   => 'tok-b',
						'kind' => 'shout',
						'data' => 'x',
					),
					array(
						'to'   => 'tok-b',
						'kind' => 'ice',
						'data' => str_repeat( 'x', Gutenberg_Sync_Engines_Advisory_Presence::MAX_SIGNAL_DATA_BYTES + 1 ),
					),
				),
			)
		);

		wp_set_current_user( self::$other_editor_id );
		$answer = $this->beat( 'tok-b' );
		$this->assertSame(
			array(
				array(
					'id'   => '',
					'from' => 'tok-a',
					'kind' => 'offer',
					'data' => 'sdp-offer',
				),
			),
			$answer['signals']
		);

		// Delivered once.
		$this->assertSame( array(), $this->beat( 'tok-b' )['signals'] );
	}

	public function test_leave_forgets_the_token_and_its_mail() {
		$this->beat( 'tok-a' );
		wp_set_current_user( self::$other_editor_id );
		$this->beat(
			'tok-b',
			array(
				'signals' => array(
					array(
						'to'   => 'tok-a',
						'kind' => 'offer',
						'data' => 'o',
					),
				),
			)
		);

		wp_set_current_user( self::$editor_id );
		$request = new WP_REST_Request( 'POST', '/gutenberg-sync-engines/v1/advisory/leave' );
		$request->set_param( 'room', $this->room() );
		$request->set_param( 'token', 'tok-a' );
		$response = $this->presence->handle_leave( $request );
		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( array( 'reset' => false ), $response->get_data() );

		wp_set_current_user( self::$other_editor_id );
		$answer = $this->beat( 'tok-b' );
		$this->assertFalse( $answer['others'] );
		$this->assertSame( array(), $answer['peers'] );

		// A returning tab with the old token starts with an empty mailbox.
		wp_set_current_user( self::$editor_id );
		$this->assertSame( array(), $this->beat( 'tok-a' )['signals'] );
	}

	public function test_with_the_presence_api_each_tab_is_its_own_row_in_its_table() {
		Fake_Presence_API::$enabled = true;
		$room                       = $this->room();

		$this->beat( 'tok-a' );
		wp_set_current_user( self::$other_editor_id );
		$answer = $this->beat( 'tok-b' );

		$this->assertTrue( $answer['others'] );
		$this->assertSame( array( 'tok-a' ), array_column( $answer['peers'], 'token' ) );
		$this->assertSame( array( 'gsetab-tok-a', 'gsetab-tok-b' ), array_keys( Fake_Presence_API::$rows[ $room ] ) );
		$this->assertFalse( get_transient( Gutenberg_Sync_Engines_Advisory_Presence::TOKENS_TRANSIENT_PREFIX . md5( $room ) ) );

		// Awareness does not read the tab rows.
		$awareness = new WP_Sync_Awareness( new WP_Sync_Post_Meta_Storage() );
		$this->assertSame( array(), $awareness->entries( $room, 30 ) );

		$request = new WP_REST_Request( 'POST', '/gutenberg-sync-engines/v1/advisory/leave' );
		$request->set_param( 'room', $room );
		$request->set_param( 'token', 'tok-b' );
		$this->presence->handle_leave( $request );
		$this->assertSame( array( 'gsetab-tok-a' ), array_keys( Fake_Presence_API::$rows[ $room ] ) );
	}

	public function test_without_the_filter_the_tab_list_stays_in_the_transient() {
		Fake_Presence_API::$enabled = true;
		remove_all_filters( 'wp_sync_tab_list_backend' );
		$room = $this->room();

		$this->beat( 'tok-a' );

		$this->assertArrayNotHasKey( $room, Fake_Presence_API::$rows );
		$this->assertSame( array( 'tok-a' ), array_keys( get_transient( Gutenberg_Sync_Engines_Advisory_Presence::TOKENS_TRANSIENT_PREFIX . md5( $room ) ) ) );
	}

	public function test_company_is_also_seen_through_live_sync_awareness() {
		// A tab without the presence lane (an older bundle) that still
		// polls shows up in the room's awareness; that counts as company.
		$storage = gutenberg_sync_engines_storage();
		$storage->set_awareness_state(
			$this->room(),
			array(
				array(
					'client_id'  => 77,
					'state'      => array( 'user' => 'x' ),
					'updated_at' => time(),
					'wp_user_id' => self::$other_editor_id,
				),
			)
		);
		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$response = $presence->answer_heartbeat(
			array(),
			array(
				Gutenberg_Sync_Engines_Advisory_Presence::HEARTBEAT_KEY => array(
					'room'      => $this->room(),
					'token'     => 'tok-a',
					'client_id' => 11,
				),
			)
		);
		$answer   = $response[ Gutenberg_Sync_Engines_Advisory_Presence::HEARTBEAT_KEY ];
		$this->assertTrue( $answer['others'] );
		$this->assertSame( array(), $answer['peers'] );

		// The tab's own awareness entry is not company.
		$storage->set_awareness_state(
			$this->room(),
			array(
				array(
					'client_id'  => 11,
					'state'      => array( 'user' => 'me' ),
					'updated_at' => time(),
					'wp_user_id' => self::$editor_id,
				),
			)
		);
		$response = $presence->answer_heartbeat(
			array(),
			array(
				Gutenberg_Sync_Engines_Advisory_Presence::HEARTBEAT_KEY => array(
					'room'      => $this->room(),
					'token'     => 'tok-a',
					'client_id' => 11,
				),
			)
		);
		$this->assertFalse( $response[ Gutenberg_Sync_Engines_Advisory_Presence::HEARTBEAT_KEY ]['others'] );
	}

	public function test_answer_probe_is_shared_by_the_poll_route_and_gated_by_the_settings() {
		// The same answer, whichever request carried the probe.
		$answer = $this->presence->answer_probe(
			array(
				'room'      => $this->room(),
				'token'     => 'tok-a',
				'client_id' => 11,
			)
		);
		$this->assertSame( array( 'others', 'peers', 'signals', 'cursor', 'engine' ), array_keys( $answer ) );
		$this->assertFalse( $answer['others'] );
		$this->assertSame( 0, $answer['cursor'] );
		$this->assertSame( 'intent-log', $answer['engine'] );
		update_option( 'wp_sync_engine', 'yjs-server' );
		$this->assertSame(
			'yjs-server',
			$this->presence->answer_probe(
				array(
					'room'  => $this->room(),
					'token' => 'tok-a',
				)
			)['engine']
		);
		delete_option( 'wp_sync_engine' );

		// Off on the settings screen: no answer, no token recorded.
		update_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION, '' );
		$this->assertNull(
			$this->presence->answer_probe(
				array(
					'room'  => $this->room(),
					'token' => 'tok-b',
				)
			)
		);
		delete_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION );

		// The transport choice does not gate the channel: it serves
		// whenever short polling does (under websocket, while the socket
		// is down).
		update_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION, 'websocket' );
		$this->assertTrue( Gutenberg_Sync_Engines_Advisory_Presence::is_enabled() );
		delete_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION );

		// tok-b never made it in.
		$this->assertSame( array(), $this->beat( 'tok-a' )['peers'] );
	}

	public function test_mailbox_keeps_every_message_filed_between_a_read_and_a_take() {
		$this->beat( 'tok-a' );
		wp_set_current_user( self::$other_editor_id );
		$this->beat( 'tok-b' );

		// Two senders' messages, with ids, both survive; the take drains
		// them once; a message filed after the take is seen next time.
		wp_set_current_user( self::$editor_id );
		$this->beat(
			'tok-a',
			array(
				'signals' => array(
					array(
						'id'   => 'tok-a-1',
						'to'   => 'tok-b',
						'kind' => 'offer',
						'data' => 'o',
					),
					array(
						'id'   => 'tok-a-2',
						'to'   => 'tok-b',
						'kind' => 'ice',
						'data' => 'c1',
					),
				),
			)
		);
		wp_set_current_user( self::$other_editor_id );
		$first = $this->beat( 'tok-b' )['signals'];
		$this->assertSame( array( 'tok-a-1', 'tok-a-2' ), array_column( $first, 'id' ) );
		$this->assertSame( array(), $this->beat( 'tok-b' )['signals'] );

		wp_set_current_user( self::$editor_id );
		$this->beat(
			'tok-a',
			array(
				'signals' => array(
					array(
						'id'   => 'tok-a-3',
						'to'   => 'tok-b',
						'kind' => 'ice',
						'data' => 'c2',
					),
				),
			)
		);
		wp_set_current_user( self::$other_editor_id );
		$this->assertSame( array( 'tok-a-3' ), array_column( $this->beat( 'tok-b' )['signals'], 'id' ) );
	}

	public function test_expired_tokens_take_their_mailbox_rows_with_them() {
		$this->beat( 'tok-a' );
		wp_set_current_user( self::$other_editor_id );
		$this->beat(
			'tok-b',
			array(
				'signals' => array(
					array(
						'to'   => 'tok-a',
						'kind' => 'offer',
						'data' => 'o',
					),
				),
			)
		);
		$key = 'gse_adv_mail_' . md5( $this->room() ) . '_' . md5( 'tok-a' );
		$this->assertNotNull( WP_Sync_Atomic_Option::read( $key ) );

		// tok-a crashes: its token ages past the TTL without a leave beacon.
		$transient            = 'gse_adv_tokens_' . md5( $this->room() );
		$tokens               = get_transient( $transient );
		$tokens['tok-a']['t'] = time() - Gutenberg_Sync_Engines_Advisory_Presence::PRESENCE_TTL - 1;
		set_transient( $transient, $tokens, 600 );

		// The next refresh by anyone sweeps the dead tab's mailbox row.
		delete_transient( 'gse_adv_swept_' . md5( $this->room() ) );
		$this->beat( 'tok-b' );
		$this->assertNull( WP_Sync_Atomic_Option::read( $key ) );

		// Everyone leaves without a beacon and the room idles long enough
		// for the token record itself to expire: the next visitor's
		// refresh still finds the abandoned rows by their room prefix.
		$this->beat(
			'tok-b',
			array(
				'signals' => array(
					array(
						'to'   => 'tok-b',
						'kind' => 'ice',
						'data' => 'self',
					),
				),
			)
		);
		wp_set_current_user( self::$editor_id );
		$this->beat(
			'tok-c',
			array(
				'signals' => array(
					array(
						'to'   => 'tok-b',
						'kind' => 'offer',
						'data' => 'o2',
					),
				),
			)
		);
		$key_b = 'gse_adv_mail_' . md5( $this->room() ) . '_' . md5( 'tok-b' );
		$this->assertNotNull( WP_Sync_Atomic_Option::read( $key_b ) );
		delete_transient( $transient );
		delete_transient( 'gse_adv_swept_' . md5( $this->room() ) );
		$this->beat( 'tok-d' );
		$this->assertNull( WP_Sync_Atomic_Option::read( $key_b ) );
		// The newcomer's own row (none yet) and record are untouched.
		$this->assertSame( array(), $this->beat( 'tok-d' )['peers'] );
	}

	public function test_answer_reports_the_room_head_cursor_once_rows_exist() {
		$storage = gutenberg_sync_engines_storage();
		$storage->add_update( $this->room(), 'a' );
		$storage->add_update( $this->room(), 'b' );
		// The newest row's id, read the way the transports' cursor is
		// derived (the storage API caches the cursor per read).
		$rows = $storage->get_updates_after_cursor( $this->room(), 0 );
		$this->assertCount( 2, $rows );
		$expected = $storage->get_cursor( $this->room() );
		$this->assertGreaterThan( 0, $expected );
		$answer = ( new Gutenberg_Sync_Engines_Advisory_Presence( $storage ) )->answer_probe(
			array(
				'room'  => $this->room(),
				'token' => 'tok-a',
			)
		);
		$this->assertSame( $expected, $answer['cursor'] );
	}

	/**
	 * Seeds the room with one stored row so it has something to lose.
	 */
	private function seed_room_row( WP_Sync_Storage $storage ): void {
		$storage->add_update(
			$this->room(),
			array(
				'type' => 'update',
				'data' => 'AA==',
			)
		);
		$storage->set_room_engine( $this->room(), 'intent-log' );
		$this->assertNotEmpty( $storage->get_updates_after_cursor( $this->room(), 0 ) );
	}

	private function room_is_empty( WP_Sync_Storage $storage ): bool {
		return array() === $storage->get_updates_after_cursor( $this->room(), 0 )
			&& null === $storage->peek_room_engine( $this->room() );
	}

	public function test_leaving_as_the_last_tab_resets_the_room() {
		$storage  = new WP_Sync_Post_Meta_Storage();
		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$this->seed_room_row( $storage );
		$presence->answer_probe(
			array(
				'room'  => $this->room(),
				'token' => 'tab-a',
			)
		);

		$this->assertTrue( $presence->leave( $this->room(), 'tab-a', 0 ) );
		$this->assertTrue( $this->room_is_empty( $storage ) );
		// The token is gone too: a following opener is alone.
		$this->assertFalse(
			$presence->answer_probe(
				array(
					'room'  => $this->room(),
					'token' => 'tab-b',
				)
			)['others']
		);
	}

	public function test_leaving_while_another_tab_stays_keeps_the_room() {
		$storage  = new WP_Sync_Post_Meta_Storage();
		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$this->seed_room_row( $storage );
		$presence->answer_probe(
			array(
				'room'  => $this->room(),
				'token' => 'tab-a',
			)
		);
		$presence->answer_probe(
			array(
				'room'  => $this->room(),
				'token' => 'tab-b',
			)
		);

		$this->assertFalse( $presence->leave( $this->room(), 'tab-a', 0 ) );
		$this->assertFalse( $this->room_is_empty( $storage ) );
	}

	public function test_leaving_while_a_live_sync_session_remains_keeps_the_room() {
		$storage  = new WP_Sync_Post_Meta_Storage();
		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$this->seed_room_row( $storage );
		$storage->set_awareness_state(
			$this->room(),
			array(
				array(
					'client_id'  => 555,
					'state'      => array(),
					'updated_at' => time(),
					'wp_user_id' => self::$editor_id,
				),
				array(
					'client_id'  => 777,
					'state'      => array(),
					'updated_at' => time(),
					'wp_user_id' => self::$editor_id,
				),
			)
		);

		// Tab a (client 555) leaves; client 777 (a tab whose token is not
		// tracked, e.g. an older page) is still live.
		$this->assertFalse( $presence->leave( $this->room(), 'tab-a', 555 ) );
		$this->assertFalse( $this->room_is_empty( $storage ) );
		// Its own awareness entry was removed at once.
		$this->assertSame( array( 777 ), array_column( $storage->get_awareness_state( $this->room() ), 'client_id' ) );
	}

	public function test_a_new_tabs_first_sync_request_resets_an_abandoned_room() {
		$storage  = new WP_Sync_Post_Meta_Storage();
		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$this->seed_room_row( $storage );

		// Nobody present (a crashed tab's token has expired): the newcomer's
		// join wipes the leftovers.
		$this->assertTrue( $presence->note_sync_request( $this->room(), 'tab-new', 1 ) );
		$this->assertTrue( $this->room_is_empty( $storage ) );
	}

	public function test_the_same_tabs_later_requests_never_reset() {
		$storage  = new WP_Sync_Post_Meta_Storage();
		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );

		$presence->note_sync_request( $this->room(), 'tab-a', 1 );
		// The tab writes to the room, then re-requests from cursor 0 (a
		// re-bootstrap after a restart): it is the room's participant.
		$this->seed_room_row( $storage );
		$this->assertFalse( $presence->note_sync_request( $this->room(), 'tab-a', 1 ) );
		$this->assertFalse( $this->room_is_empty( $storage ) );

		// A heartbeat refresh keeps the joined mark.
		$presence->answer_probe(
			array(
				'room'  => $this->room(),
				'token' => 'tab-a',
			)
		);
		$this->assertFalse( $presence->note_sync_request( $this->room(), 'tab-a', 1 ) );
		$this->assertFalse( $this->room_is_empty( $storage ) );
	}

	public function test_a_join_with_someone_present_keeps_the_room() {
		$storage  = new WP_Sync_Post_Meta_Storage();
		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$this->seed_room_row( $storage );
		$presence->answer_probe(
			array(
				'room'  => $this->room(),
				'token' => 'tab-a',
			)
		);

		$this->assertFalse( $presence->note_sync_request( $this->room(), 'tab-b', 2 ) );
		$this->assertFalse( $this->room_is_empty( $storage ) );
	}

	public function test_collection_rooms_are_never_reset() {
		$storage  = new WP_Sync_Post_Meta_Storage();
		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$room     = 'taxonomy/category';
		$storage->add_update(
			$room,
			array(
				'type' => 'update',
				'data' => 'AA==',
			)
		);

		$this->assertFalse( $presence->note_sync_request( $room, 'tab-new', 1 ) );
		$this->assertFalse( $presence->leave( $room, 'tab-new', 1 ) );
		$this->assertNotEmpty( $storage->get_updates_after_cursor( $room, 0 ) );
	}

	public function test_the_keep_policy_and_the_filter_both_keep_empty_rooms() {
		$storage  = new WP_Sync_Post_Meta_Storage();
		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$this->seed_room_row( $storage );

		update_option( Gutenberg_Sync_Engines_Settings::UNSAVED_OPTION, Gutenberg_Sync_Engines_Settings::UNSAVED_KEEP );
		$this->assertFalse( $presence->note_sync_request( $this->room(), 'tab-new', 1 ) );
		$this->assertFalse( $presence->leave( $this->room(), 'tab-new', 1 ) );
		$this->assertFalse( $this->room_is_empty( $storage ) );
		delete_option( Gutenberg_Sync_Engines_Settings::UNSAVED_OPTION );

		add_filter( 'gutenberg_sync_engines_room_reset_when_empty', '__return_false' );
		try {
			$this->assertFalse( $presence->note_sync_request( $this->room(), 'tab-other', 2 ) );
			$this->assertFalse( $this->room_is_empty( $storage ) );
		} finally {
			remove_filter( 'gutenberg_sync_engines_room_reset_when_empty', '__return_false' );
		}

		// Back on the default policy: the two tabs that joined meanwhile
		// leave, and the last one out resets the room.
		$this->assertFalse( $presence->leave( $this->room(), 'tab-new', 1 ) );
		$this->assertFalse( $this->room_is_empty( $storage ) );
		$this->assertTrue( $presence->leave( $this->room(), 'tab-other', 2 ) );
		$this->assertTrue( $this->room_is_empty( $storage ) );
	}

	public function test_a_never_written_room_is_not_created_by_a_reset() {
		$storage  = new WP_Sync_Post_Meta_Storage();
		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$this->assertFalse( $presence->note_sync_request( $this->room(), 'tab-new', 1 ) );
		$this->assertSame(
			array(),
			get_posts(
				array(
					'post_type'   => 'wp_sync_storage',
					'post_status' => 'any',
					'numberposts' => -1,
					'fields'      => 'ids',
				)
			)
		);
	}

	public function test_leave_route_reports_the_reset() {
		$storage  = new WP_Sync_Post_Meta_Storage();
		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$this->seed_room_row( $storage );
		$presence->answer_probe(
			array(
				'room'  => $this->room(),
				'token' => 'tab-a',
			)
		);

		$request = new WP_REST_Request( 'POST', '/gutenberg-sync-engines/v1/advisory/leave' );
		$request->set_param( 'room', $this->room() );
		$request->set_param( 'token', 'tab-a' );
		$request->set_param( 'client_id', 0 );
		$response = $presence->handle_leave( $request );
		$this->assertSame( array( 'reset' => true ), $response->get_data() );
		$this->assertTrue( $this->room_is_empty( $storage ) );
	}

	public function test_a_reset_de_rtc_room_rebuilds_from_the_saved_post_not_its_old_canonical() {
		$post_id  = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => "<!-- wp:paragraph -->\n<p>Hello</p>\n<!-- /wp:paragraph -->",
			)
		);
		$room     = 'postType/post:' . $post_id;
		$storage  = new WP_Sync_Post_Meta_Storage();
		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$engine   = new WP_De_RTC_Engine( $storage );
		add_action( 'gutenberg_sync_engines_room_reset', array( 'WP_De_RTC_Engine', 'forget_room_state' ) );

		// A session advances the room past its genesis (canonical lives in
		// an options row the storage reset never sees).
		$this->assertStringContainsString( 'Hello', (string) $engine->materialize( $room ) );
		$result = $engine->handle_updates(
			$room,
			201,
			0,
			array(
				array(
					'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
					'data' => wp_json_encode(
						array(
							'proposalId'      => 'p-1',
							'baseVersion'     => 'v1',
							'proposedContent' => "<!-- wp:paragraph -->\n<p>Hello, unsaved</p>\n<!-- /wp:paragraph -->",
							'clientUpdate'    => null,
						)
					),
				),
			),
			array()
		);
		$this->assertSame( 'applied', $result['dispositions'][0]['status'] );
		$this->assertStringContainsString( 'unsaved', (string) $engine->materialize( $room ) );
		$presence->answer_probe(
			array(
				'room'  => $room,
				'token' => 'tab-a',
			)
		);

		// The last tab leaves: the room is reset, INCLUDING the canonical
		// row, so a fresh engine rebuilds genesis from the saved post.
		$this->assertTrue( $presence->leave( $room, 'tab-a', 201 ) );
		$fresh = new WP_De_RTC_Engine( $storage );
		$this->assertStringNotContainsString( 'unsaved', (string) $fresh->materialize( $room ) );
		$this->assertStringContainsString( 'Hello', (string) $fresh->materialize( $room ) );
		wp_delete_post( $post_id, true );
	}

	public function test_presence_reads_never_create_a_storage_post() {
		$this->beat( 'tok-a' );
		$posts = get_posts(
			array(
				'post_type'   => 'wp_sync_storage',
				'post_status' => 'any',
				'name'        => md5( $this->room() ),
				'fields'      => 'ids',
			)
		);
		$this->assertSame( array(), $posts );
	}

	public function test_presence_reads_never_create_a_room_in_the_plugins_tables() {
		$storage = gutenberg_sync_engines_storage();
		$this->assertInstanceOf( 'WP_Sync_Table_Storage', $storage );
		// Two tabs meet through the heartbeat alone (tokens and mail live
		// outside the sync storage); the room itself stays unwritten.
		$this->beat( 'tok-a' );
		wp_set_current_user( self::$other_editor_id );
		$this->assertTrue( $this->beat( 'tok-b' )['others'] );
		$this->assertFalse( $storage->peek_room( $this->room() )['found'] );
	}

	public function test_editor_settings_carry_the_chosen_link() {
		// The default: WebRTC, with its ICE servers and peer cap.
		$settings = $this->presence->editor_settings( get_post( self::$post_id ) );
		$this->assertSame( 'webrtc-advisory', $settings['channel'] );
		$this->assertNotEmpty( $settings['iceServers'] );
		$this->assertArrayNotHasKey( 'socketUrl', $settings );

		// The daemon relay: the socket URL the websocket transport
		// announces, whichever transport the site selected.
		update_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION, Gutenberg_Sync_Engines_Settings::ADVISORY_WEBSOCKET );
		$settings = $this->presence->editor_settings( get_post( self::$post_id ) );
		$this->assertSame( 'websocket-advisory', $settings['channel'] );
		$this->assertStringStartsWith( 'ws://', $settings['socketUrl'] );
		$this->assertArrayNotHasKey( 'iceServers', $settings );
		$this->assertTrue( Gutenberg_Sync_Engines_Advisory_Presence::is_enabled() );

		// The first release stored `web-rtc`: it still reads as WebRTC.
		update_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION, 'web-rtc' );
		$this->assertSame( 'webrtc-advisory', Gutenberg_Sync_Engines_Settings::advisory_channel() );
		$this->assertSame( 'webrtc-advisory', $this->presence->editor_settings( get_post( self::$post_id ) )['channel'] );

		// Anything else is off.
		$this->assertSame( '', Gutenberg_Sync_Engines_Settings::normalize_advisory( 'carrier-pigeon' ) );
		delete_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION );
	}
}
