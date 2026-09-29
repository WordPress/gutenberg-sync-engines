<?php
/**
 * WP_Sync_SSE_Connection unit tests.
 *
 * @package GutenbergSyncEngines
 */

/**
 * The receive-stream framing on WP_Sync_Connection.
 */
class Tests_Collaboration_WpSyncSseConnection extends WP_UnitTestCase {

	/**
	 * A pair of connected stream sockets, so the connection under test has
	 * something real to read from and write to.
	 *
	 * @var array<int, resource>
	 */
	private $pair;

	public function set_up() {
		parent::set_up();

		$this->pair = stream_socket_pair(
			STREAM_PF_UNIX,
			STREAM_SOCK_STREAM,
			STREAM_IPPROTO_IP
		);

		// Nothing in this class should be able to wedge the suite.
		stream_set_blocking( $this->pair[0], false );
		stream_set_blocking( $this->pair[1], false );
	}

	public function tear_down() {
		foreach ( $this->pair as $socket ) {
			if ( is_resource( $socket ) ) {
				fclose( $socket );
			}
		}

		parent::tear_down();
	}

	/**
	 * A connection whose peer has sent the given bytes.
	 *
	 * @param string $bytes What the browser sent.
	 * @return WP_Sync_SSE_Connection The connection under test.
	 */
	private function connection_after( string $bytes ): WP_Sync_SSE_Connection {
		fwrite( $this->pair[1], $bytes );

		$conn = new WP_Sync_SSE_Connection( $this->pair[0] );
		$conn->read_from_socket();

		return $conn;
	}

	/**
	 * A complete request with the given body.
	 *
	 * @param string $body Request body.
	 * @param string $path Request path.
	 * @return string The raw request.
	 */
	private function request( string $body = '', string $path = '/wp-sync/v1/stream' ): string {
		return "POST {$path} HTTP/1.1\r\n"
			. "Host: example.test\r\n"
			. 'Content-Length: ' . strlen( $body ) . "\r\n"
			. "\r\n"
			. $body;
	}

	/**
	 * Everything the connection has queued for the browser.
	 *
	 * @return string Queued bytes.
	 */
	private function written(): string {
		return (string) stream_get_contents( $this->pair[1] );
	}

	/**
	 * The connection's unconsumed bytes, consumed so the assertion sees them.
	 *
	 * @param WP_Sync_SSE_Connection $conn Connection.
	 * @return string Buffered bytes.
	 */
	private function buffered( WP_Sync_SSE_Connection $conn ): string {
		$buffered = $conn->buffered_bytes();
		$conn->adopt_buffered_bytes( '' );

		return $buffered;
	}

	public function test_a_stream_sends_no_messages_and_drops_what_arrives() {
		$conn = $this->connection_after( $this->request( '{}' ) );

		$this->assertFalse( $conn->sends_messages(), 'a receive stream sends nothing after its request' );
		$this->assertSame( array(), $conn->read_messages(), 'a receive stream reads nothing' );

		/*
		 * The socket stays in the daemon's read set so that the browser
		 * closing the stream is noticed, so bytes can still arrive after
		 * the request. They are dropped rather than buffered against.
		 */
		$conn->adopt_buffered_bytes( 'stray bytes' );

		$this->assertSame( array(), $conn->read_messages(), 'stray bytes are not messages' );
		$this->assertSame( '', $conn->buffered_bytes(), 'stray bytes are dropped, not held' );
	}

	public function test_the_head_is_parsed_and_the_body_left_buffered() {
		$conn = $this->connection_after( $this->request( '{"room":"postType/post:1"}' ) );

		$request = $conn->parse_handshake_request();

		$this->assertIsArray( $request, 'a complete request parses' );
		$this->assertSame( 'POST', $request['method'] );
		$this->assertSame( '/wp-sync/v1/stream', $request['path'] );
		$this->assertSame(
			'{"room":"postType/post:1"}',
			$this->buffered( $conn ),
			'the body survives the head being stripped'
		);
	}

	public function test_an_incomplete_head_is_not_yet_a_request() {
		$conn = $this->connection_after( "POST /wp-sync/v1/stream HTTP/1.1\r\nHost: exa" );

		$this->assertNull( $conn->parse_handshake_request(), 'a partial head waits for the rest' );
	}

	public function test_a_body_still_arriving_asks_the_daemon_to_come_back() {
		// The head promises 99 bytes of body; only six have been sent.
		$conn     = $this->connection_after(
			"POST /wp-sync/v1/stream HTTP/1.1\r\nHost: example.test\r\nContent-Length: 99\r\n\r\n{\"a\":"
		);
		$request  = $conn->parse_handshake_request();
		$accepted = $conn->accept_request( $request );

		$this->assertNull( $accepted, 'a body that has not landed means retry, not reject' );
		$this->assertFalse( $conn->is_open(), 'and the connection is not open yet' );
		$this->assertSame( '', $this->written(), 'nothing is answered before the body lands' );
	}

	public function test_a_complete_request_answers_an_event_stream() {
		$conn     = $this->connection_after( $this->request( '{"a":1}' ) );
		$request  = $conn->parse_handshake_request();
		$accepted = $conn->accept_request( $request );

		$this->assertTrue( $accepted );
		$this->assertTrue( $conn->is_open() );

		$written = $this->written();

		$this->assertStringStartsWith( "HTTP/1.1 200 OK\r\n", $written );
		$this->assertStringContainsString( 'Content-Type: text/event-stream; charset=UTF-8', $written );
		$this->assertStringContainsString( 'X-Accel-Buffering: no', $written );
		$this->assertStringNotContainsString( 'Content-Length', $written, 'a stream has no length' );
		$this->assertStringNotContainsString( 'Connection: close', $written, 'and is not closed' );
	}

	public function test_a_payload_arrives_as_a_sync_event() {
		$conn = $this->connection_after( $this->request( '{"a":1}' ) );
		$conn->accept_request( $conn->parse_handshake_request() );
		$this->written();

		$conn->send_text( '{"rooms":[]}' );

		$this->assertSame(
			"event: sync\ndata: {\"rooms\":[]}\n\n",
			$this->written(),
			'the room response rides data: unchanged'
		);
	}

	public function test_the_keepalive_is_an_invisible_comment() {
		$conn = $this->connection_after( $this->request( '{"a":1}' ) );
		$conn->accept_request( $conn->parse_handshake_request() );
		$this->written();

		$conn->send_keepalive();

		$this->assertSame( ": keepalive\n\n", $this->written() );
	}

	public function test_closing_a_stream_writes_nothing() {
		$conn = $this->connection_after( $this->request( '{"a":1}' ) );
		$conn->accept_request( $conn->parse_handshake_request() );
		$this->written();

		$conn->send_close( 1008, 'rate budget exceeded' );

		$this->assertSame( '', $this->written(), 'a stream has no close frame' );
		$this->assertTrue( $conn->is_open(), 'the socket closing ends the response instead' );
	}

	public function test_an_oversized_body_is_refused() {
		$conn                             = $this->connection_after( $this->request( '{}' ) );
		$request                          = $conn->parse_handshake_request();
		$request['headers']['content-length'] = (string) ( WP_Sync_SSE_Connection::MAX_BODY_SIZE + 1 );

		$accepted = $conn->accept_request( $request );

		$this->assertWPError( $accepted );
		$this->assertSame( 'sse_body_too_large', $accepted->get_error_code() );
	}

	public function test_a_non_numeric_content_length_is_refused() {
		$conn                             = $this->connection_after( $this->request( '{}' ) );
		$request                          = $conn->parse_handshake_request();
		$request['headers']['content-length'] = 'lots';

		$accepted = $conn->accept_request( $request );

		$this->assertWPError( $accepted );
		$this->assertSame( 'sse_bad_content_length', $accepted->get_error_code() );
	}
}
