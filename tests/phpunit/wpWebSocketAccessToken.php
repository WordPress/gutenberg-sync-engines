<?php
/**
 * Tests for WebSocket ACCESS-TOKEN mode: with a shared secret configured, the
 * token route mints a signed, expiring access token naming the user, the site,
 * and the rooms the tab may follow; a server verifies it with the secret
 * alone (no cookie, no database read), which is what lets a host run its
 * own relay. The plugin's daemon accepts access tokens too.
 *
 * @package gutenberg-sync-engines
 *
 * @group collaboration
 */
class Tests_Collaboration_WpWebSocketAccessToken extends WP_UnitTestCase {
	const SECRET = 'unit-test-access token-secret-0123456789abcdef0123456789abcdef';

	protected static int $editor_id;
	protected static int $contributor_id;
	protected static int $subscriber_id;
	protected static int $post_id;

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id      = $factory->user->create( array( 'role' => 'editor' ) );
		self::$contributor_id = $factory->user->create( array( 'role' => 'contributor' ) );
		self::$subscriber_id  = $factory->user->create( array( 'role' => 'subscriber' ) );
		self::$post_id        = $factory->post->create( array( 'post_author' => self::$editor_id ) );
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
		self::delete_user( self::$contributor_id );
		self::delete_user( self::$subscriber_id );
		wp_delete_post( self::$post_id, true );
	}

	public function set_up() {
		parent::set_up();
		add_filter( 'wp_sync_websocket_access_token_secret', array( $this, 'secret' ) );
	}

	public function tear_down() {
		remove_filter( 'wp_sync_websocket_access_token_secret', array( $this, 'secret' ) );
		global $wp_rest_server;
		$wp_rest_server = null;
		parent::tear_down();
	}

	public function secret(): string {
		return self::SECRET;
	}

	private function room(): string {
		return 'postType/post:' . self::$post_id;
	}

	private static function b64( string $bytes ): string {
		return rtrim( strtr( base64_encode( $bytes ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
	}

	/**
	 * Builds an access token by hand, so a test can vary any part of it.
	 *
	 * @param array       $claims Payload claims.
	 * @param array|null  $header The header, default HS256.
	 * @param string|null $secret Signing secret, default the configured one.
	 * @return string The access token.
	 */
	private function forge( array $claims, ?array $header = null, ?string $secret = null ): string {
		$header  = self::b64(
			wp_json_encode(
				$header ?? array(
					'alg' => 'HS256',
					'typ' => 'JWT',
				)
			)
		);
		$payload = self::b64( wp_json_encode( $claims ) );
		$input   = $header . '.' . $payload;
		return $input . '.' . self::b64( hash_hmac( 'sha256', $input, $secret ?? self::SECRET, true ) );
	}

	private function claims( int $now ): array {
		return array(
			'user_id' => self::$editor_id,
			'blog_id' => get_current_blog_id(),
			'rooms'   => WP_WebSocket_Access_Token::grants( $this->room() ),
			'iat'     => $now,
			'exp'     => $now + WP_WebSocket_Access_Token::TTL,
		);
	}

	public function test_access_token_mode_is_off_without_a_secret() {
		remove_filter( 'wp_sync_websocket_access_token_secret', array( $this, 'secret' ) );

		$this->assertFalse( WP_WebSocket_Access_Token::is_enabled() );
		$refused = WP_WebSocket_Access_Token::verify( $this->forge( $this->claims( time() ) ) );
		$this->assertWPError( $refused );

		// The route keeps minting one-time tokens (hex, consumed once).
		wp_set_current_user( self::$editor_id );
		$response = $this->dispatch( array( 'room' => $this->room() ) );
		$this->assertSame( 200, $response->get_status() );
		$token = $response->get_data()['token'];
		$this->assertTrue( ctype_xdigit( $token ) );
		$this->assertFalse( WP_WebSocket_Access_Token::looks_like_access_token( $token ) );
		$this->assertSame( self::$editor_id, WP_WebSocket_Token_Controller::consume_token( $token ) );
	}

	public function test_mints_a_signed_expiring_access_token_naming_the_user_the_site_and_the_rooms() {
		$now          = 1700000000;
		$rooms        = WP_WebSocket_Access_Token::grants( $this->room() );
		$access_token = WP_WebSocket_Access_Token::mint( self::$editor_id, $rooms, $now );

		$this->assertTrue( WP_WebSocket_Access_Token::looks_like_access_token( $access_token ) );
		list( $header, $payload ) = explode( '.', $access_token );
		$this->assertSame(
			array(
				'alg' => 'HS256',
				'typ' => 'JWT',
			),
			json_decode( base64_decode( strtr( $header, '-_', '+/' ) ), true ) // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		);
		$this->assertSame(
			array(
				'user_id' => self::$editor_id,
				'blog_id' => get_current_blog_id(),
				'rooms'   => $rooms,
				'iat'     => $now,
				'exp'     => $now + 120,
			),
			json_decode( base64_decode( strtr( $payload, '-_', '+/' ) ), true ) // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		);
		// Byte-identical to a hand-built HS256 JWT: any JWT library
		// verifies it.
		$this->assertSame( $this->forge( $this->claims( $now ) ), $access_token );

		$claims = WP_WebSocket_Access_Token::verify( $access_token, $now + 60 );
		$this->assertSame( self::$editor_id, $claims['user_id'] );
		$this->assertSame( $rooms, $claims['rooms'] );
		$this->assertSame( $now + 120, $claims['exp'] );

		// Expiry, with the clock-skew leeway.
		$this->assertIsArray( WP_WebSocket_Access_Token::verify( $access_token, $now + 120 + WP_WebSocket_Access_Token::LEEWAY - 1 ) );
		$expired = WP_WebSocket_Access_Token::verify( $access_token, $now + 120 + WP_WebSocket_Access_Token::LEEWAY );
		$this->assertWPError( $expired );
		$this->assertSame( 'websocket_invalid_access_token', $expired->get_error_code() );
	}

	public function test_refuses_tampered_foreign_and_malformed_access_tokens() {
		$now    = 1700000000;
		$claims = $this->claims( $now );

		$cases = array(
			'other secret'       => $this->forge( $claims, null, 'some-other-secret' ),
			'alg none'           => $this->forge( $claims, array( 'alg' => 'none' ) ),
			'alg HS512'          => $this->forge( $claims, array( 'alg' => 'HS512' ) ),
			'other site'         => $this->forge( array_merge( $claims, array( 'blog_id' => 99 ) ) ),
			'no user'            => $this->forge( array_merge( $claims, array( 'user_id' => 0 ) ) ),
			'rooms not a list'   => $this->forge( array_merge( $claims, array( 'rooms' => 'postType/post:1' ) ) ),
			'from the future'    => $this->forge( array_merge( $claims, array( 'iat' => $now + 3600 ) ) ),
			'two segments'       => 'abc.def',
			'a one-time token'   => str_repeat( 'ab', 32 ),
			'empty'              => '',
			'bad base64 payload' => explode( '.', $this->forge( $claims ) )[0] . '.!!!.sig',
		);
		foreach ( $cases as $label => $access_token ) {
			$result = WP_WebSocket_Access_Token::verify( $access_token, $now );
			$this->assertWPError( $result, $label );
			$this->assertSame( 'websocket_invalid_access_token', $result->get_error_code(), $label );
		}

		// A single changed character in the payload breaks the signature.
		$good                                 = $this->forge( $claims );
		list( $header, $payload, $signature ) = explode( '.', $good );
		$flipped                              = substr( $payload, 0, 5 ) . ( 'A' === $payload[5] ? 'B' : 'A' ) . substr( $payload, 6 );
		$this->assertWPError( WP_WebSocket_Access_Token::verify( $header . '.' . $flipped . '.' . $signature, $now ) );
		$this->assertIsArray( WP_WebSocket_Access_Token::verify( $good, $now ) );
	}

	public function test_the_rooms_claim_names_the_post_room_and_the_collection_rooms() {
		$rooms = WP_WebSocket_Access_Token::grants( $this->room() );
		$this->assertSame( array( $this->room(), 'postType/*', 'taxonomy/*', 'root/*' ), $rooms );
		$this->assertSame( array( 'postType/*', 'taxonomy/*', 'root/*' ), WP_WebSocket_Access_Token::grants( null ) );

		// The rule a relay implements: exact, or `<kind>/*` for a
		// collection room (no object id) of that kind.
		$this->assertTrue( WP_WebSocket_Access_Token::allows( $rooms, $this->room() ) );
		$this->assertTrue( WP_WebSocket_Access_Token::allows( $rooms, 'taxonomy/category' ) );
		$this->assertTrue( WP_WebSocket_Access_Token::allows( $rooms, 'root/comment' ) );
		$this->assertTrue( WP_WebSocket_Access_Token::allows( $rooms, 'postType/page' ) );
		$this->assertFalse( WP_WebSocket_Access_Token::allows( $rooms, 'postType/post:' . ( self::$post_id + 1 ) ), 'Another post' );
		$this->assertFalse( WP_WebSocket_Access_Token::allows( $rooms, 'taxonomy/category:5' ), 'A term room is not a collection' );
		$this->assertFalse( WP_WebSocket_Access_Token::allows( $rooms, 'widget/sidebar' ), 'An unlisted kind' );
		$this->assertFalse( WP_WebSocket_Access_Token::allows( array(), 'taxonomy/category' ) );
	}

	public function test_the_token_route_mints_a_access_token_allowing_the_tabs_post_room() {
		wp_set_current_user( self::$editor_id );
		$response = $this->dispatch( array( 'room' => $this->room() ) );
		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertSame( WP_WebSocket_Access_Token::TTL, $data['expires_in'] );
		$claims = WP_WebSocket_Access_Token::verify( $data['token'] );
		$this->assertIsArray( $claims );
		$this->assertSame( self::$editor_id, $claims['user_id'] );
		$this->assertSame( WP_WebSocket_Access_Token::grants( $this->room() ), $claims['rooms'] );
		// Nothing was stored: an access token is verified, never looked up.
		$this->assertFalse( get_transient( WP_WebSocket_Token_Controller::TOKEN_TRANSIENT_PREFIX . $data['token'] ) );

		// Without a room (the websocket transport's request): collection
		// grants only.
		$claims = WP_WebSocket_Access_Token::verify( $this->dispatch( array() )->get_data()['token'] );
		$this->assertSame( WP_WebSocket_Access_Token::grants( null ), $claims['rooms'] );

		// A room the user may not sync is refused, not silently dropped.
		wp_set_current_user( self::$contributor_id );
		$refused = $this->dispatch( array( 'room' => $this->room() ) );
		$this->assertSame( 403, $refused->get_status() );
		$this->assertSame( 'rest_cannot_edit', $refused->get_data()['code'] );
		foreach ( array( 'taxonomy/category', 'postType/post', 'not a room' ) as $room ) {
			$this->assertSame( 403, $this->dispatch( array( 'room' => $room ) )->get_status(), $room );
		}

		// No `edit_posts` at all: no access token of any kind.
		wp_set_current_user( self::$subscriber_id );
		$this->assertSame( 403, $this->dispatch( array() )->get_status() );
	}

	public function test_the_daemon_accepts_a_access_token_without_a_cookie_and_keeps_the_socket_through_revalidation() {
		$storage = new WP_Sync_Table_Storage();
		$server  = new WP_WebSocket_Sync_Server( new WP_HTTP_Polling_Sync_Server( $storage ), '127.0.0.1', 8797 );
		$auth    = new ReflectionMethod( WP_WebSocket_Sync_Server::class, 'authenticate_handshake' );
		$auth->setAccessible( true );
		$origin       = wp_parse_url( home_url() );
		$origin       = $origin['scheme'] . '://' . $origin['host'] . ( isset( $origin['port'] ) ? ':' . $origin['port'] : '' );
		$request      = static function ( string $access_token, string $origin ) {
			return array(
				'headers' => array(
					'origin'                 => $origin,
					'sec-websocket-protocol' => 'wp-sync, wp-sync-token.' . $access_token,
				),
				'method'  => 'GET',
				'path'    => '/',
				'query'   => array(),
			);
		};
		$access_token = WP_WebSocket_Access_Token::mint( self::$editor_id, WP_WebSocket_Access_Token::grants( $this->room() ) );

		$accepted = $auth->invoke( $server, $request( $access_token, $origin ) );
		$this->assertSame(
			array(
				'cookie'       => '',
				'access_token' => true,
				'user_id'      => self::$editor_id,
			),
			$accepted
		);

		// The Origin allowlist still stands in front of the access token.
		$this->assertWPError( $auth->invoke( $server, $request( $access_token, 'https://evil.example' ) ) );

		$tampered = $auth->invoke( $server, $request( $access_token . 'x', $origin ) );
		$this->assertWPError( $tampered );
		$this->assertSame( 'websocket_invalid_access_token', $tampered->get_error_code() );

		$unknown = $auth->invoke( $server, $request( $this->forge( array_merge( $this->claims( time() ), array( 'user_id' => 987654321 ) ) ), $origin ) );
		$this->assertWPError( $unknown );
		$this->assertSame( 'websocket_invalid_access_token', $unknown->get_error_code() );

		// Access-token mode off: an access token is just a token nobody minted, and the
		// cookie path (which needs a cookie) refuses.
		remove_filter( 'wp_sync_websocket_access_token_secret', array( $this, 'secret' ) );
		$this->assertWPError( $auth->invoke( $server, $request( $access_token, $origin ) ) );
		add_filter( 'wp_sync_websocket_access_token_secret', array( $this, 'secret' ) );

		// The sweep: an access token socket with no cookie stays open while its
		// user keeps the capability; a cookie socket without a cookie,
		// or an access token socket whose user lost it, is closed.
		$connections = array();
		$clients     = new ReflectionProperty( WP_WebSocket_Sync_Server::class, 'clients' );
		$clients->setAccessible( true );
		$entries = array();
		foreach (
			array(
				1 => array( self::$editor_id, true ),
				2 => array( self::$editor_id, false ),
				3 => array( self::$subscriber_id, true ),
			) as $key => list( $user_id, $by_access_token )
		) {
			$connections[ $key ] = $this->recording_connection();
			$entries[ $key ]     = array(
				'advisory'      => array(),
				'closing'       => false,
				'conn'          => $connections[ $key ],
				'connected_at'  => microtime( true ),
				'cookie'        => '',
				'ip'            => '127.0.0.1',
				'last_seen'     => microtime( true ),
				'message_times' => array(),
				'rooms'         => array(),
				'access_token'  => $by_access_token,
				'user_id'       => $user_id,
			);
		}
		$clients->setValue( $server, $entries );

		$revalidate = new ReflectionMethod( WP_WebSocket_Sync_Server::class, 'revalidate_clients' );
		$revalidate->setAccessible( true );
		$revalidate->invoke( $server );

		$this->assertFalse( $connections[1]->closed, 'An access token socket stays open without a cookie' );
		$this->assertTrue( $connections[2]->closed, 'A cookie socket needs its cookie' );
		$this->assertTrue( $connections[3]->closed, 'An access token socket whose user lost edit_posts is closed' );
	}

	/**
	 * Dispatches a POST to the token route as the current user.
	 *
	 * @param array $params Body parameters.
	 * @return WP_REST_Response The response.
	 */
	private function dispatch( array $params ): WP_REST_Response {
		global $wp_rest_server;
		if ( ! $wp_rest_server instanceof Spy_REST_Server ) {
			$wp_rest_server = new Spy_REST_Server();
			do_action( 'rest_api_init', $wp_rest_server );
			( new WP_WebSocket_Token_Controller() )->register_routes();
		}
		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/ws-token' );
		$request->set_body_params( $params );
		return rest_get_server()->dispatch( $request );
	}

	/**
	 * A stand-in for WP_WebSocket_Connection that records a close.
	 *
	 * @return WP_WebSocket_Connection Recording connection.
	 */
	private function recording_connection(): WP_WebSocket_Connection {
		return new class() extends WP_WebSocket_Connection {
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
}
