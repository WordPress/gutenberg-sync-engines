<?php
/**
 * Tests for the sync daemon's handling of a connection whose peer is gone.
 *
 * A write to such a peer fails and closes the stream right there, wherever
 * the write happened. The daemon's next pass handed that closed stream to
 * stream_select(), which throws a TypeError on it: the daemon exited and
 * every websocket and sse-daemon user lost their connection. Found by the
 * de-rtc/websocket fuzzer, which crashed the daemon on every sweep.
 *
 * @package Gutenberg
 *
 * @group collaboration
 */
class Tests_Collaboration_WpWebSocketClosedStream extends WP_UnitTestCase {

	/**
	 * @var WP_WebSocket_Sync_Server
	 */
	private $server;

	/**
	 * Every socket the test opened, closed in tear_down().
	 *
	 * @var resource[]
	 */
	private $sockets = array();

	public function set_up() {
		parent::set_up();

		$this->server = new WP_WebSocket_Sync_Server(
			new WP_HTTP_Polling_Sync_Server( new WP_Sync_Table_Storage() )
		);

		// A real listener on a free port, so a loop pass has one to watch.
		$listener = stream_socket_server( 'tcp://127.0.0.1:0' );
		stream_set_blocking( $listener, false );
		$this->sockets[] = $listener;
		$this->set_property( 'listener', $listener );
	}

	public function tear_down() {
		foreach ( $this->sockets as $socket ) {
			if ( is_resource( $socket ) ) {
				fclose( $socket );
			}
		}

		parent::tear_down();
	}

	private function set_property( string $name, $value ): void {
		$property = new ReflectionProperty( WP_WebSocket_Sync_Server::class, $name );
		$property->setAccessible( true );
		$property->setValue( $this->server, $value );
	}

	private function clients(): array {
		$property = new ReflectionProperty( WP_WebSocket_Sync_Server::class, 'clients' );
		$property->setAccessible( true );
		return $property->getValue( $this->server );
	}

	/**
	 * Adds an open connection whose browser has already gone away: its end
	 * of the socket pair is closed, so the next write to it fails.
	 *
	 * @param string $framing  WP_Sync_Connection subclass to frame it with.
	 * @param array  $advisory The client's advisory subscriptions.
	 * @return WP_Sync_Connection The connection.
	 */
	private function add_departed_client( string $framing, array $advisory = array() ): WP_Sync_Connection {
		$pair = stream_socket_pair( STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP );
		fclose( $pair[1] );
		$this->sockets[] = $pair[0];

		$conn      = new $framing( $pair[0] );
		$mark_open = new ReflectionMethod( WP_Sync_Connection::class, 'mark_open' );
		$mark_open->setAccessible( true );
		$mark_open->invoke( $conn );

		$clients                   = $this->clients();
		$clients[ (int) $pair[0] ] = array(
			'advisory'      => $advisory,
			'closing'       => false,
			'conn'          => $conn,
			'connected_at'  => microtime( true ),
			'cookie'        => '',
			'ip'            => '127.0.0.1',
			'last_seen'     => microtime( true ),
			'message_times' => array(),
			'rooms'         => array(),
			'user_id'       => 0,
		);
		$this->set_property( 'clients', $clients );

		return $conn;
	}

	private function poll_once(): void {
		$method = new ReflectionMethod( WP_WebSocket_Sync_Server::class, 'poll_once' );
		$method->setAccessible( true );
		$method->invoke( $this->server );
	}

	public function data_framings(): array {
		return array(
			'websocket' => array( WP_WebSocket_Connection::class ),
			'stream'    => array( WP_Sync_SSE_Connection::class ),
		);
	}

	/**
	 * @dataProvider data_framings
	 *
	 * @param string $framing WP_Sync_Connection subclass under test.
	 */
	public function test_a_failed_write_drops_the_client_instead_of_ending_the_daemon( string $framing ) {
		$conn = $this->add_departed_client( $framing );

		// A send from anywhere in the daemon, e.g. a room broadcast.
		$conn->send_text( '{"type":"sync"}' );
		$this->assertTrue( $conn->is_closed(), 'The failed write closes the stream.' );

		$this->poll_once();

		$this->assertSame( array(), $this->clients() );
	}

	public function test_a_failed_write_while_dropping_a_client_drops_that_client_too() {
		$follow = static function ( int $client_id ): array {
			return array(
				'room' => array(
					'client_id'      => $client_id,
					'cursor'         => 0,
					'presence'       => null,
					'presence_token' => '',
				),
			);
		};

		// Both browsers followed the same room and are gone. The one added
		// FIRST is still marked open; the second one's failed write has
		// already closed it. Dropping the second sends the first the new
		// roster, that write fails too, and the first must go in the same
		// pass, or the next stream_select() meets its closed stream.
		$first  = $this->add_departed_client( WP_WebSocket_Connection::class, $follow( 1 ) );
		$second = $this->add_departed_client( WP_WebSocket_Connection::class, $follow( 2 ) );
		$second->send_text( '{"type":"sync"}' );
		$this->assertFalse( $first->is_closed() );
		$this->assertTrue( $second->is_closed() );

		$this->poll_once();

		$this->assertTrue( $first->is_closed(), 'The roster write to the first client failed.' );
		$this->assertSame( array(), $this->clients() );
	}
}
