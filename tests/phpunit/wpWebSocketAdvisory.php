<?php
/**
 * Tests for the WebSocket daemon's ADVISORY mode: tabs on the short
 * polling transport open a socket that carries presence and "go and poll"
 * notices between the tabs in a room and never a row. The daemon keeps an
 * in-memory roster per room, relays what a follower sends, and tells
 * followers about rows its once-a-second scan finds — without writing to
 * storage or treating a dropped socket as a closed tab.
 *
 * @package gutenberg-sync-engines
 *
 * @group collaboration
 */
class Tests_Collaboration_WpWebSocketAdvisory extends WP_UnitTestCase {
	const GENESIS_CONTENT = "<!-- wp:paragraph -->\n<p>Advisory room.</p>\n<!-- /wp:paragraph -->";

	protected static int $editor_id;
	protected static int $other_editor_id;
	protected static int $subscriber_id;
	protected static int $post_id;
	protected static int $other_post_id;

	/**
	 * @var WP_WebSocket_Sync_Server
	 */
	private $server;

	/**
	 * @var WP_Sync_Table_Storage
	 */
	private $storage;

	/**
	 * @var WP_HTTP_Polling_Sync_Server
	 */
	private $sync;

	/**
	 * Recording connections keyed by client key.
	 *
	 * @var array<int, WP_WebSocket_Connection>
	 */
	private $connections = array();

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id       = $factory->user->create( array( 'role' => 'editor' ) );
		self::$other_editor_id = $factory->user->create( array( 'role' => 'editor' ) );
		self::$subscriber_id   = $factory->user->create( array( 'role' => 'subscriber' ) );
		self::$post_id         = $factory->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
		self::$other_post_id   = $factory->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => self::GENESIS_CONTENT,
			)
		);
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
		self::delete_user( self::$other_editor_id );
		self::delete_user( self::$subscriber_id );
		wp_delete_post( self::$post_id, true );
		wp_delete_post( self::$other_post_id, true );
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::$editor_id );
		$this->storage     = new WP_Sync_Table_Storage();
		$this->sync        = new WP_HTTP_Polling_Sync_Server( $this->storage );
		$this->server      = new WP_WebSocket_Sync_Server( $this->sync, '127.0.0.1', 8798 );
		$this->connections = array();
	}

	private function room(): string {
		return 'postType/post:' . self::$post_id;
	}

	/**
	 * A recording stand-in for WP_WebSocket_Connection: always open,
	 * captures every text frame the daemon sends.
	 *
	 * @return WP_WebSocket_Connection Recording connection.
	 */
	private function recording_connection(): WP_WebSocket_Connection {
		return new class() extends WP_WebSocket_Connection {
			/**
			 * Captured text frames.
			 *
			 * @var string[]
			 */
			public $sent = array();

			/**
			 * Whether the daemon closed it.
			 *
			 * @var bool
			 */
			public $closed = false;

			// phpcs:ignore Generic.CodeAnalysis.UselessOverridingMethod.Found -- Deliberately skips the parent's stream wiring.
			public function __construct() {
			}

			public function is_open(): bool {
				return ! $this->closed;
			}

			public function has_pending_writes(): bool {
				return false;
			}

			public function send_text( string $payload ): void {
				$this->sent[] = $payload;
			}

			public function send_ping( string $payload = '' ): void {
			}

			public function send_close( int $code = 1000, string $reason = '' ): void {
				$this->closed = true;
			}

			public function close(): void {
				$this->closed = true;
			}
		};
	}

	/**
	 * Adds an authenticated client to the daemon.
	 *
	 * @param int           $key     Client key.
	 * @param int           $user_id The user the handshake authenticated.
	 * @param string[]|null $granted The access token's `rooms` claim, or
	 *                               null for a cookie socket.
	 */
	private function add_client( int $key, int $user_id, ?array $granted = null ): void {
		$conn                      = $this->recording_connection();
		$this->connections[ $key ] = $conn;
		$clients                   = new ReflectionProperty( WP_WebSocket_Sync_Server::class, 'clients' );
		$clients->setAccessible( true );
		$all         = $clients->getValue( $this->server );
		$all[ $key ] = array(
			'advisory'           => array(),
			'closing'            => false,
			'conn'               => $conn,
			'connected_at'       => microtime( true ),
			'cookie'             => '',
			'ip'                 => '127.0.0.1',
			'last_seen'          => microtime( true ),
			'message_times'      => array(),
			'rooms'              => array(),
			'access_token'       => null !== $granted,
			'access_token_rooms' => $granted,
			'user_id'            => $user_id,
		);
		$clients->setValue( $this->server, $all );
	}

	private function message( int $key, array $frame ): void {
		$method = new ReflectionMethod( WP_WebSocket_Sync_Server::class, 'handle_message' );
		$method->setAccessible( true );
		$method->invoke( $this->server, $key, wp_json_encode( $frame ) );
	}

	/**
	 * Decoded frames a client received since the last call.
	 *
	 * @param int $key Client key.
	 * @return array<int, array> Frames.
	 */
	private function take_frames( int $key ): array {
		$frames                          = array_map(
			static function ( $raw ) {
				return json_decode( $raw, true );
			},
			$this->connections[ $key ]->sent
		);
		$this->connections[ $key ]->sent = array();
		return $frames;
	}

	private function scan(): void {
		$scan_at = new ReflectionProperty( WP_WebSocket_Sync_Server::class, 'last_room_scan_at' );
		$scan_at->setAccessible( true );
		$scan_at->setValue( $this->server, 0.0 );
		// Keep the awareness sweep (and its cookie revalidation, which
		// these cookie-less fake sockets would fail) out of the tick.
		$sweep_at = new ReflectionProperty( WP_WebSocket_Sync_Server::class, 'last_sweep_at' );
		$sweep_at->setAccessible( true );
		$sweep_at->setValue( $this->server, microtime( true ) );
		$tick = new ReflectionMethod( WP_WebSocket_Sync_Server::class, 'tick' );
		$tick->setAccessible( true );
		$tick->invoke( $this->server );
	}

	/**
	 * Bootstraps the room through the polling seam (genesis lands), the way
	 * a short-polling tab does before its advisory socket opens.
	 *
	 * @return int The room's head cursor.
	 */
	private function bootstrap_room(): int {
		$response = $this->sync->process_room_request(
			array(
				'room'      => $this->room(),
				'client_id' => 7,
				'after'     => 0,
				'awareness' => null,
				'updates'   => array(),
			)
		);
		$this->assertIsArray( $response );
		return (int) $response['end_cursor'];
	}

	public function test_followers_exchange_roster_presence_and_notices_without_touching_storage() {
		$room = $this->room();
		$this->bootstrap_room();
		$awareness_before = $this->storage->get_awareness_state( $room );

		$this->add_client( 1, self::$editor_id );
		$this->add_client( 2, self::$editor_id );

		// A follows: it gets the roster, itself alone, with its token.
		$this->message(
			1,
			array(
				'type'           => 'advisory',
				'room'           => $room,
				'client_id'      => 7,
				'presence_token' => 'tok-a',
			)
		);
		$frames = $this->take_frames( 1 );
		$this->assertCount( 1, $frames );
		$this->assertSame( 'advisory', $frames[0]['type'] );
		$this->assertSame( 'roster', $frames[0]['event'] );
		$this->assertSame( $room, $frames[0]['room'] );
		$this->assertSame(
			array(
				array(
					'client_id' => 7,
					'presence'  => null,
					'token'     => 'tok-a',
				),
			),
			$frames[0]['peers']
		);

		// B follows with its presence: both get the two-tab roster.
		$this->message(
			2,
			array(
				'type'           => 'advisory',
				'room'           => $room,
				'client_id'      => 8,
				'presence_token' => 'tok-b',
				'presence'       => array( 'name' => 'B' ),
			)
		);
		$at_a = $this->take_frames( 1 );
		$at_b = $this->take_frames( 2 );
		$this->assertCount( 1, $at_a );
		$this->assertCount( 1, $at_b );
		$this->assertSame( $at_a[0], $at_b[0] );
		$this->assertSame( array( 7, 8 ), array_column( $at_a[0]['peers'], 'client_id' ) );
		$this->assertSame( array( 'name' => 'B' ), $at_a[0]['peers'][1]['presence'] );

		// A presence change reaches the peer; an unchanged frame is quiet.
		$this->message(
			1,
			array(
				'type'      => 'advisory',
				'room'      => $room,
				'client_id' => 7,
				'presence'  => array( 'name' => 'A' ),
			)
		);
		$at_b = $this->take_frames( 2 );
		$this->assertCount( 1, $at_b );
		$this->assertSame( array( 'name' => 'A' ), $at_b[0]['peers'][0]['presence'] );
		$this->take_frames( 1 );
		$this->message(
			2,
			array(
				'type'      => 'advisory',
				'room'      => $room,
				'client_id' => 8,
			)
		);
		$this->assertSame( array(), $this->take_frames( 1 ) );
		$this->assertSame( array(), $this->take_frames( 2 ) );

		// A notice is relayed to the other followers only, naming the
		// room the sender wrote to.
		$this->message(
			2,
			array(
				'type'      => 'advisory',
				'room'      => $room,
				'client_id' => 8,
				'announce'  => $room,
			)
		);
		$this->assertSame(
			array(
				array(
					'event' => 'announce',
					'room'  => $room,
					'type'  => 'advisory',
				),
			),
			$this->take_frames( 1 )
		);
		$this->assertSame( array(), $this->take_frames( 2 ) );

		// Presence never reached storage.
		$this->assertSame( $awareness_before, $this->storage->get_awareness_state( $room ) );

		// A quiet room scans quietly.
		$this->scan();
		$this->assertSame( array(), $this->take_frames( 1 ) );
		$this->assertSame( array(), $this->take_frames( 2 ) );

		// Rows landed off the channel (a script, WP-CLI): the scan tells
		// every follower once.
		$this->assertTrue( $this->storage->add_update( $room, 'off-channel-row' ) );
		$this->scan();
		$this->assertSame( 'announce', $this->take_frames( 1 )[0]['event'] );
		$this->assertSame( 'announce', $this->take_frames( 2 )[0]['event'] );
		$this->scan();
		$this->assertSame( array(), $this->take_frames( 1 ) );
		$this->assertSame( array(), $this->take_frames( 2 ) );

		// B's socket drops: A's roster shrinks, and nothing else happens
		// (a dropped socket is not a closed tab).
		$disconnect = new ReflectionMethod( WP_WebSocket_Sync_Server::class, 'disconnect' );
		$disconnect->setAccessible( true );
		$disconnect->invoke( $this->server, 2 );
		$at_a = $this->take_frames( 1 );
		$this->assertCount( 1, $at_a );
		$this->assertSame( 'roster', $at_a[0]['event'] );
		$this->assertSame( array( 7 ), array_column( $at_a[0]['peers'], 'client_id' ) );
		$this->assertSame( $awareness_before, $this->storage->get_awareness_state( $room ) );
	}

	public function test_following_is_permission_checked_and_bound_to_one_client_id() {
		$room = $this->room();
		$this->bootstrap_room();

		// A user who may not sync the post gets an error and no roster.
		$this->add_client( 1, self::$subscriber_id );
		$this->message(
			1,
			array(
				'type'      => 'advisory',
				'room'      => $room,
				'client_id' => 7,
			)
		);
		$frames = $this->take_frames( 1 );
		$this->assertCount( 1, $frames );
		$this->assertSame( 'error', $frames[0]['type'] );
		$this->assertSame( 'rest_cannot_edit', $frames[0]['code'] );

		// A malformed frame is answered with an error, not a roster.
		$this->add_client( 2, self::$editor_id );
		$this->message(
			2,
			array(
				'type'      => 'advisory',
				'room'      => 'not a room',
				'client_id' => 7,
			)
		);
		$this->assertSame( 'websocket_invalid_advisory', $this->take_frames( 2 )[0]['code'] );

		// A follower that changes its client id is closed.
		$this->message(
			2,
			array(
				'type'      => 'advisory',
				'room'      => $room,
				'client_id' => 7,
			)
		);
		$this->take_frames( 2 );
		$this->message(
			2,
			array(
				'type'      => 'advisory',
				'room'      => $room,
				'client_id' => 9,
			)
		);
		$this->assertTrue( $this->connections[2]->closed );
	}

	/**
	 * A sync frame naming a room and client id, with awareness.
	 *
	 * @param string $room      Room identifier.
	 * @param int    $client_id Client id.
	 * @param array  $awareness Awareness state.
	 * @return array The frame.
	 */
	private function sync_frame( string $room, int $client_id, array $awareness ): array {
		return array(
			'type'  => 'sync',
			'rooms' => array(
				array(
					'room'      => $room,
					'client_id' => $client_id,
					'after'     => 0,
					'awareness' => $awareness,
					'updates'   => array(),
				),
			),
		);
	}

	/**
	 * The live awareness entries of a room, keyed by client id.
	 *
	 * @param string $room Room identifier.
	 * @return array<int, array> Entries.
	 */
	private function awareness_by_client( string $room ): array {
		$entries = ( new WP_Sync_Awareness( $this->storage ) )->entries( $room, WP_HTTP_Polling_Sync_Server::AWARENESS_TIMEOUT );
		return array_column( $entries, null, 'client_id' );
	}

	public function test_a_client_id_another_user_holds_is_refused_like_the_rest_route_refuses_it() {
		$room = $this->room();
		$this->bootstrap_room();
		$this->sync->update_awareness( $room, 7, array( 'name' => 'victim' ) );

		// Another editor of the post names the victim's client id: refused
		// on both lanes, and the victim's entry is untouched.
		$this->add_client( 1, self::$other_editor_id );
		$this->message( 1, $this->sync_frame( $room, 7, array( 'name' => 'impostor' ) ) );
		$this->message(
			1,
			array(
				'type'      => 'advisory',
				'room'      => $room,
				'client_id' => 7,
			)
		);
		$frames = $this->take_frames( 1 );
		$this->assertCount( 2, $frames );
		foreach ( $frames as $frame ) {
			$this->assertSame( 'error', $frame['type'] );
			$this->assertSame( 'rest_cannot_edit', $frame['code'] );
			$this->assertSame( 'Client ID is already in use by another user.', $frame['message'] );
		}

		// Nor does the socket's close remove the victim's entry.
		$disconnect = new ReflectionMethod( WP_WebSocket_Sync_Server::class, 'disconnect' );
		$disconnect->setAccessible( true );
		$disconnect->invoke( $this->server, 1 );
		$entries = $this->awareness_by_client( $room );
		$this->assertSame( array( 'name' => 'victim' ), $entries[7]['state'] );
		$this->assertSame( self::$editor_id, (int) $entries[7]['wp_user_id'] );

		// The owner itself (a reload on a new socket) keeps its client id.
		$this->add_client( 2, self::$editor_id );
		$this->message( 2, $this->sync_frame( $room, 7, array( 'name' => 'victim again' ) ) );
		$this->assertSame( array( 'sync' ), array_column( $this->take_frames( 2 ), 'type' ) );
	}

	public function test_an_access_token_socket_follows_only_the_rooms_its_token_names() {
		$room       = $this->room();
		$other_room = 'postType/post:' . self::$other_post_id;
		$follow     = function ( int $key, string $room ): array {
			$this->message(
				$key,
				array(
					'type'      => 'advisory',
					'room'      => $room,
					'client_id' => 40 + $key,
				)
			);
			return $this->take_frames( $key );
		};

		// A token minted for one post follows that post and the collection
		// rooms, but not another post its user may also edit.
		$this->add_client( 1, self::$editor_id, WP_WebSocket_Access_Token::grants( $room ) );
		$this->assertSame( 'roster', $follow( 1, $room )[0]['event'] );
		$this->assertSame( 'roster', $follow( 1, 'taxonomy/category' )[0]['event'] );
		$refused = $follow( 1, $other_room );
		$this->assertCount( 1, $refused );
		$this->assertSame( 'error', $refused[0]['type'] );
		$this->assertSame( 'rest_cannot_edit', $refused[0]['code'] );
		$this->assertSame( array( $other_room ), $refused[0]['rooms'] );

		// A cookie socket has no claim; its capabilities decide.
		$this->add_client( 2, self::$editor_id );
		$this->assertSame( 'roster', $follow( 2, $other_room )[0]['event'] );

		// Sync rooms rest on capabilities alone: the websocket transport's
		// token names no post, yet its socket syncs the editor's post.
		$this->add_client( 3, self::$editor_id, WP_WebSocket_Access_Token::grants( null ) );
		$this->message( 3, $this->sync_frame( $room, 43, array( 'name' => 'transport tab' ) ) );
		$this->assertSame( array( 'sync' ), array_column( $this->take_frames( 3 ), 'type' ) );
	}
}
