<?php
/**
 * WP_WebSocket_Sync_Server class
 *
 * @package gutenberg
 */

if ( ! class_exists( 'WP_WebSocket_Connection' ) ) {
	require_once __DIR__ . '/class-wp-websocket-connection.php';
}
if ( ! class_exists( 'WP_WebSocket_Token_Controller' ) ) {
	require_once __DIR__ . '/class-wp-websocket-token-controller.php';
}
if ( ! class_exists( 'WP_WebSocket_Access_Token' ) ) {
	require_once __DIR__ . '/class-wp-websocket-access-token.php';
}

if ( ! class_exists( 'WP_WebSocket_Sync_Server' ) ) {

	/**
	 * Experimental dependency-free PHP WebSocket server for collaborative
	 * editing.
	 *
	 * Runs a stream_select() event loop over non-blocking sockets. The wire
	 * protocol is JSON text frames sharing the HTTP polling semantics: the
	 * client sends `{type: 'sync', rooms: [...]}` room requests and the
	 * server replies with the same room-response shape as the REST endpoint.
	 * Updates are persisted through WP_Sync_Storage so late joiners and
	 * reconnecting clients catch up via their cursor, and new updates are
	 * pushed immediately to other connected sockets subscribed to the room.
	 *
	 * The same socket also serves the ADVISORY channel of tabs on the short
	 * polling transport (`{type: 'advisory', ...}` frames, see
	 * handle_advisory_message()): the daemon relays presence and "go and
	 * poll" notices between the tabs in a room and carries no rows for them.
	 *
	 * Auth: the handshake requires a valid WordPress logged_in cookie, an
	 * allowed Origin, and a one-time short-lived token minted via the
	 * `wp-sync/v1/ws-token` REST endpoint whose user must match the cookie
	 * user. In access-token mode (WP_WebSocket_Access_Token) the offered credential is
	 * instead a signed access token, verified here with the shared secret and no
	 * database read, and the cookie is optional: the same credential a
	 * host's own relay accepts. Per-room permission checks identical to
	 * the REST server run when a socket first references a room.
	 *
	 * @since 7.4.0
	 * @access private
	 */
	class WP_WebSocket_Sync_Server {
		/**
		 * Maximum number of rooms allowed per sync message.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const MAX_ROOMS_PER_MESSAGE = 50;

		/**
		 * Maximum length of a single update data string.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const MAX_UPDATE_DATA_SIZE = MB_IN_BYTES;

		/**
		 * Interval (in seconds) between keepalive pings.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const PING_INTERVAL_S = 15;

		/**
		 * Idle timeout (in seconds) after which an unresponsive socket is closed.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const IDLE_TIMEOUT_S = 45;

		/**
		 * Interval (in seconds) between awareness expiry sweeps.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const AWARENESS_SWEEP_INTERVAL_S = 10;

		/**
		 * Interval (in seconds) between out-of-band room scans. Rows can land
		 * in a room WITHOUT a socket message touching it — de-rtc sessions
		 * commit through the ordinary autosave endpoint (a web request), and
		 * healing/unaware-writer lanes append rows from web requests too. A
		 * push-only-on-message daemon never delivers those rows to its
		 * subscribers, so the scan re-reads each subscribed room on the
		 * polling transports' cadence and broadcasts when new rows exist.
		 * One DB read per subscribed room per interval — strictly cheaper
		 * than every client polling for itself.
		 *
		 * @since 0.3.0
		 * @var float
		 */
		const ROOM_SCAN_INTERVAL_S = 1;

		/**
		 * Default maximum number of concurrent connections. Filterable via
		 * 'wp_sync_websocket_max_connections'.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const DEFAULT_MAX_CONNECTIONS = 512;

		/**
		 * Default maximum number of concurrent connections per client IP.
		 * Filterable via 'wp_sync_websocket_max_connections_per_ip'.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const DEFAULT_MAX_CONNECTIONS_PER_IP = 20;

		/**
		 * Deadline (in seconds) for a socket to complete the WebSocket
		 * handshake. Enforced independently of read activity so a dribbling
		 * pre-upgrade connection cannot hold a socket open indefinitely.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const HANDSHAKE_TIMEOUT_S = 10;

		/**
		 * The base WebSocket subprotocol the client offers and the server
		 * echoes on accept.
		 */
		const SUBPROTOCOL = 'wp-sync';

		/**
		 * Prefix of the subprotocol offer that carries the one-time auth
		 * token (the only handshake header a browser page can set — see
		 * authenticate_handshake()).
		 */
		const TOKEN_PROTOCOL_PREFIX = 'wp-sync-token.';

		/**
		 * Maximum number of sync messages allowed per socket within the
		 * rolling MESSAGE_RATE_WINDOW_S window. Sockets exceeding the budget
		 * are closed with policy-violation code 1008.
		 *
		 * The client coalesces sends behind a 50 ms debounce, so its worst
		 * sustained rate is ~20 messages/second (100 per 5 s window); this
		 * budget leaves 2x headroom above that.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const MESSAGE_RATE_LIMIT = 200;

		/**
		 * Rolling window (in seconds) for the per-socket message rate budget.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const MESSAGE_RATE_WINDOW_S = 5;

		/**
		 * Maximum encoded size of one advisory presence state (who is here:
		 * user info, name, activity — never cursors or content).
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const MAX_ADVISORY_PRESENCE_BYTES = 16384;

		/**
		 * Maximum length of the room name an advisory notice carries.
		 *
		 * @since 0.0.1
		 * @var int
		 */
		const MAX_ADVISORY_ROOM_LENGTH = 200;

		/**
		 * Transport-agnostic sync server core.
		 *
		 * @since 7.4.0
		 * @var WP_HTTP_Polling_Sync_Server
		 */
		private WP_HTTP_Polling_Sync_Server $sync;

		/**
		 * Host to bind.
		 *
		 * @since 7.4.0
		 * @var string
		 */
		private string $host;

		/**
		 * Port to bind.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		private int $port;

		/**
		 * Listening socket.
		 *
		 * @since 7.4.0
		 * @var resource|null
		 */
		private $listener = null;

		/**
		 * Connected clients keyed by stream id.
		 *
		 * Each entry:
		 * - conn:          WP_WebSocket_Connection
		 * - user_id:       int WordPress user authenticated during the handshake.
		 * - cookie:        string Raw logged_in cookie value captured at the
		 *                  handshake, re-validated during the periodic sweep.
		 * - access token:        bool Whether a signed access token authenticated the
		 *                  handshake (the cookie may then be absent: the
		 *                  sweep still re-checks the user's capability but
		 *                  cannot see a logout before the socket closes).
		 * - ip:            string Peer IP address, used for per-IP caps.
		 * - rooms:         array<string, array{client_id: int, cursor: int}>
		 *                  The rooms this socket syncs (the websocket TRANSPORT).
		 * - advisory:      array<string, array{client_id: int, presence_token: string, presence: ?array, cursor: int}>
		 *                  The rooms this socket follows as an ADVISORY channel
		 *                  (see handle_advisory_message()): in memory only,
		 *                  never written to storage.
		 * - connected_at:  float Time the socket was accepted (handshake deadline).
		 * - last_seen:     float Last time bytes arrived from the peer.
		 * - message_times: float[] Recent sync-message timestamps (rate budget).
		 * - closing:       bool Whether to close once the write buffer drains.
		 *
		 * @since 7.4.0
		 * @var array<int, array<string, mixed>>
		 */
		private array $clients = array();

		/**
		 * Whether the event loop should keep running.
		 *
		 * @since 7.4.0
		 * @var bool
		 */
		private bool $running = false;

		/**
		 * Last time keepalive pings were sent.
		 *
		 * @since 7.4.0
		 * @var float
		 */
		private float $last_ping_at = 0;

		/**
		 * Last time the awareness expiry sweep ran.
		 *
		 * @since 7.4.0
		 * @var float
		 */
		private float $last_sweep_at = 0;

		/**
		 * Client ids each room held at the last sweep, so the next one can
		 * tell that somebody has since gone.
		 *
		 * @since 0.0.2
		 * @var array<string, array<int, int>>
		 */
		private array $swept_client_ids = array();

		/**
		 * Timestamp of the last out-of-band room scan.
		 *
		 * @since 0.3.0
		 * @var float
		 */
		private float $last_room_scan_at = 0;

		/**
		 * Constructor.
		 *
		 * @since 7.4.0
		 *
		 * @param WP_HTTP_Polling_Sync_Server $sync Transport seam driving rooms
		 *                                          through the engine registry.
		 * @param string                      $host Host to bind.
		 * @param int                         $port Port to bind.
		 */
		public function __construct( WP_HTTP_Polling_Sync_Server $sync, string $host = '127.0.0.1', int $port = 8787 ) {
			$this->sync = $sync;
			$this->host = $host;
			$this->port = $port;
		}

		/**
		 * Starts the event loop. Blocks until stop() is called or the
		 * process is terminated.
		 *
		 * @since 7.4.0
		 *
		 * @return true|WP_Error True when the loop exits cleanly, WP_Error if
		 *                       the listening socket could not be created.
		 */
		public function run() {
			$errno  = 0;
			$errstr = '';

			$this->listener = stream_socket_server(
				sprintf( 'tcp://%s:%d', $this->host, $this->port ),
				$errno,
				$errstr
			);

			if ( ! $this->listener ) {
				return new WP_Error(
					'websocket_listen_failed',
					sprintf( 'Could not listen on %s:%d: [%d] %s', $this->host, $this->port, $errno, $errstr )
				);
			}

			stream_set_blocking( $this->listener, false );

			$this->log( sprintf( 'Listening on ws://%s:%d', $this->host, $this->port ) );

			$this->install_signal_handlers();

			$this->running           = true;
			$this->last_ping_at      = microtime( true );
			$this->last_sweep_at     = microtime( true );
			$this->last_room_scan_at = microtime( true );

			while ( $this->running ) {
				$read  = array( $this->listener );
				$write = array();

				foreach ( $this->clients as $client ) {
					$stream = $client['conn']->get_stream();
					$read[] = $stream;

					if ( $client['conn']->has_pending_writes() ) {
						$write[] = $stream;
					}
				}

				$except = null;

				// Intentional silencing: stream_select() raises a warning when
				// interrupted by a signal; a false return is handled below.
				// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
				$changed = @stream_select( $read, $write, $except, 1 );

				if ( false !== $changed ) {
					foreach ( $read as $stream ) {
						if ( $stream === $this->listener ) {
							$this->accept_connection();
							continue;
						}

						$this->handle_readable( (int) $stream );
					}

					foreach ( $write as $stream ) {
						$key = (int) $stream;
						if ( isset( $this->clients[ $key ] ) ) {
							$this->clients[ $key ]['conn']->flush_writes();
						}
					}
				}

				$this->tick();
			}

			foreach ( array_keys( $this->clients ) as $key ) {
				$this->disconnect( $key );
			}

			fclose( $this->listener );
			$this->listener = null;

			return true;
		}

		/**
		 * Stops the event loop after the current iteration.
		 *
		 * @since 7.4.0
		 */
		public function stop(): void {
			$this->running = false;
		}

		/**
		 * Asks the loop to finish when the process is interrupted or asked to
		 * quit, so open connections are closed and the port is released.
		 *
		 * Registering a handler also decides whether the signal arrives at
		 * all when the daemon is PID 1 inside a container: the kernel drops
		 * signals that still carry their default action. Best effort — the
		 * pcntl extension is optional and absent from some CLI images, and
		 * without it Ctrl+C cannot be caught here.
		 *
		 * @since 0.0.1
		 */
		private function install_signal_handlers(): void {
			if ( ! function_exists( 'pcntl_signal' ) || ! function_exists( 'pcntl_async_signals' ) ) {
				return;
			}

			pcntl_async_signals( true );

			$handler = function () {
				if ( $this->running ) {
					$this->log( 'Stopping: closing connections.' );
				}
				$this->stop();
			};

			pcntl_signal( SIGINT, $handler );
			pcntl_signal( SIGTERM, $handler );
		}

		/**
		 * Accepts a pending connection on the listening socket, enforcing
		 * total and per-IP connection caps.
		 *
		 * @since 7.4.0
		 */
		private function accept_connection(): void {
			// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			$stream = @stream_socket_accept( $this->listener, 0 );

			if ( ! $stream ) {
				return;
			}

			/**
			 * Filters the maximum number of concurrent WebSocket connections.
			 *
			 * @since 7.4.0
			 *
			 * @param int $max_connections Maximum concurrent connections.
			 */
			$max_connections = (int) apply_filters( 'wp_sync_websocket_max_connections', self::DEFAULT_MAX_CONNECTIONS );

			if ( count( $this->clients ) >= $max_connections ) {
				$this->log( 'Connection refused: total connection cap reached' );
				// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
				@fclose( $stream );
				return;
			}

			$ip = $this->get_peer_ip( $stream );

			/**
			 * Filters the maximum number of concurrent WebSocket connections
			 * per client IP address.
			 *
			 * @since 7.4.0
			 *
			 * @param int $max_connections_per_ip Maximum concurrent connections per IP.
			 */
			$max_connections_per_ip = (int) apply_filters( 'wp_sync_websocket_max_connections_per_ip', self::DEFAULT_MAX_CONNECTIONS_PER_IP );

			if ( '' !== $ip ) {
				$ip_connections = 0;
				foreach ( $this->clients as $client ) {
					if ( $client['ip'] === $ip ) {
						++$ip_connections;
					}
				}

				if ( $ip_connections >= $max_connections_per_ip ) {
					$this->log( 'Connection refused: per-IP connection cap reached for ' . $ip );
					// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
					@fclose( $stream );
					return;
				}
			}

			$this->clients[ (int) $stream ] = array(
				'advisory'      => array(),
				'closing'       => false,
				'conn'          => new WP_WebSocket_Connection( $stream ),
				'connected_at'  => microtime( true ),
				'cookie'        => '',
				'ip'            => $ip,
				'last_seen'     => microtime( true ),
				'message_times' => array(),
				'rooms'         => array(),
				'user_id'       => 0,
			);
		}

		/**
		 * Gets the peer IP address for a stream.
		 *
		 * @since 7.4.0
		 *
		 * @param resource $stream Client stream.
		 * @return string IP address, or empty string if unavailable.
		 */
		private function get_peer_ip( $stream ): string {
			// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			$name = @stream_socket_get_name( $stream, true );

			if ( ! is_string( $name ) || '' === $name ) {
				return '';
			}

			// The peer name is "ip:port"; IPv6 addresses contain colons, so
			// strip only the final ":port" segment.
			$colon = strrpos( $name, ':' );

			return false === $colon ? $name : substr( $name, 0, $colon );
		}

		/**
		 * Handles readable bytes on a client socket.
		 *
		 * @since 7.4.0
		 *
		 * @param int $key Client key.
		 */
		private function handle_readable( int $key ): void {
			if ( ! isset( $this->clients[ $key ] ) ) {
				return;
			}

			$conn = $this->clients[ $key ]['conn'];

			if ( ! $conn->read_from_socket() ) {
				$this->disconnect( $key );
				return;
			}

			$this->clients[ $key ]['last_seen'] = microtime( true );

			if ( ! $conn->is_open() ) {
				$this->handle_handshake( $key );

				if ( ! isset( $this->clients[ $key ] ) || ! $conn->is_open() ) {
					return;
				}
			}

			$frames = $conn->read_frames();

			if ( is_wp_error( $frames ) ) {
				$this->log( 'Protocol error: ' . $frames->get_error_message() );
				$conn->send_close( 1002, 'Protocol error' );
				$this->disconnect( $key );
				return;
			}

			foreach ( $frames as $frame ) {
				switch ( $frame['opcode'] ) {
					case WP_WebSocket_Connection::OPCODE_TEXT:
						$this->handle_message( $key, $frame['payload'] );
						break;

					case WP_WebSocket_Connection::OPCODE_PING:
						$conn->send_pong( $frame['payload'] );
						break;

					case WP_WebSocket_Connection::OPCODE_PONG:
						// last_seen was already refreshed above.
						break;

					case WP_WebSocket_Connection::OPCODE_CLOSE:
						$conn->send_close();
						$this->disconnect( $key );
						return;

					default:
						$conn->send_close( 1003, 'Unsupported frame type' );
						$this->disconnect( $key );
						return;
				}

				if ( ! isset( $this->clients[ $key ] ) ) {
					return;
				}
			}
		}

		/**
		 * Attempts to complete the handshake for a connection.
		 *
		 * @since 7.4.0
		 *
		 * @param int $key Client key.
		 */
		private function handle_handshake( int $key ): void {
			$conn    = $this->clients[ $key ]['conn'];
			$request = $conn->parse_handshake_request();

			if ( null === $request ) {
				// Incomplete request; wait for more bytes.
				return;
			}

			if ( is_wp_error( $request ) ) {
				$conn->send_http_response( 400, 'Bad Request' );
				$this->disconnect( $key );
				return;
			}

			$headers    = $request['headers'];
			$is_upgrade = isset( $headers['sec-websocket-key'] )
				&& isset( $headers['upgrade'] )
				&& 'websocket' === strtolower( $headers['upgrade'] );

			// Plain HTTP health check used by test harnesses and monitoring.
			if ( ! $is_upgrade && '/health' === $request['path'] && 'GET' === $request['method'] ) {
				$conn->send_http_response( 200, 'OK', 'OK' );
				$this->finish_or_mark_closing( $key );
				return;
			}

			if ( ! $is_upgrade ) {
				$conn->send_http_response( 400, 'Bad Request', 'WebSocket upgrade required.' );
				$this->finish_or_mark_closing( $key );
				return;
			}

			/*
			 * This is a long-running process with an in-memory object cache.
			 * Sessions, users, and permissions change in other processes
			 * (web requests) without invalidating this process's cache, so
			 * flush before authenticating to validate against fresh data.
			 */
			wp_cache_flush();

			$auth = $this->authenticate_handshake( $request );

			if ( is_wp_error( $auth ) ) {
				$this->log( 'Handshake rejected: ' . $auth->get_error_message() );
				$conn->send_http_response( 403, 'Forbidden', 'Forbidden' );
				$this->finish_or_mark_closing( $key );
				return;
			}

			$this->clients[ $key ]['user_id']      = $auth['user_id'];
			$this->clients[ $key ]['cookie']       = $auth['cookie'];
			$this->clients[ $key ]['access_token'] = ! empty( $auth['access_token'] );
			// Echo the base subprotocol the client offered alongside its
			// token entry (browsers enforce the echo matches an offer).
			$offered_protocols = (string) ( $headers['sec-websocket-protocol'] ?? '' );
			$echoed_protocol   = false !== strpos( $offered_protocols, self::SUBPROTOCOL ) ? self::SUBPROTOCOL : '';
			$conn->accept_handshake( $headers['sec-websocket-key'], $echoed_protocol );
		}

		/**
		 * Authenticates a WebSocket handshake request.
		 *
		 * Requires all of:
		 * 1. A valid logged_in auth cookie.
		 * 2. An allowed Origin header.
		 * 3. A valid one-time token whose user matches the cookie user.
		 *
		 * @since 7.4.0
		 *
		 * @param array{headers: array<string, string>, query: array<string, mixed>} $request Parsed handshake request.
		 * @return array{user_id: int, cookie: string, access token: bool}|WP_Error
		 *         Authenticated user ID, the raw logged_in cookie value
		 *         (retained for periodic re-validation; '' when an access token
		 *         stood alone), and whether an access token authenticated it, or
		 *         WP_Error on failure.
		 */
		private function authenticate_handshake( array $request ) {
			$headers = $request['headers'];

			// 1. Origin allowlist.
			$origin          = $headers['origin'] ?? '';
			$default_origins = array_values(
				array_unique(
					array_filter(
						array(
							$this->get_url_origin( home_url() ),
							$this->get_url_origin( admin_url() ),
						)
					)
				)
			);

			/**
			 * Filters the origins allowed to open collaboration WebSocket
			 * connections.
			 *
			 * @since 7.4.0
			 *
			 * @param string[] $origins Allowed origins (scheme://host[:port]).
			 */
			$allowed_origins = apply_filters( 'wp_sync_websocket_allowed_origins', $default_origins );

			if ( '' === $origin || ! is_array( $allowed_origins ) || ! in_array( $origin, $allowed_origins, true ) ) {
				return new WP_Error( 'websocket_bad_origin', 'Origin not allowed: ' . $origin );
			}

			/*
			 * The credential minted via the ws-token REST endpoint rides the
			 * Sec-WebSocket-Protocol offer list (the one handshake header
			 * browsers let a page set), NOT the URL — a query-string token
			 * leaks into server/proxy access logs and referrer-adjacent
			 * tooling. The offer is `<SUBPROTOCOL>, <TOKEN_PROTOCOL_PREFIX><token>`;
			 * the server echoes only the base subprotocol.
			 */
			$token = '';
			foreach ( explode( ',', (string) ( $headers['sec-websocket-protocol'] ?? '' ) ) as $offer ) {
				$offer = trim( $offer );
				if ( 0 === strpos( $offer, self::TOKEN_PROTOCOL_PREFIX ) ) {
					$token = substr( $offer, strlen( self::TOKEN_PROTOCOL_PREFIX ) );
					break;
				}
			}

			$cookie_header = $headers['cookie'] ?? '';
			$cookie_value  = $this->get_cookie_value( $cookie_header, LOGGED_IN_COOKIE );

			/*
			 * 2a. Access-token mode: a signed access token proves the user by itself,
			 * the way it does to a relay without WordPress. The cookie is
			 * kept for the periodic re-validation when the browser sent one
			 * for the same user (a same-site daemon), and simply absent
			 * otherwise.
			 */
			if ( WP_WebSocket_Access_Token::is_enabled() && WP_WebSocket_Access_Token::looks_like_access_token( $token ) ) {
				$claims = WP_WebSocket_Access_Token::verify( $token );
				if ( is_wp_error( $claims ) ) {
					return $claims;
				}
				if ( ! get_userdata( $claims['user_id'] ) ) {
					return new WP_Error( 'websocket_invalid_access_token', 'Access token for an unknown user.' );
				}
				$cookie_user = '' !== $cookie_value ? wp_validate_auth_cookie( $cookie_value, 'logged_in' ) : false;
				return array(
					'cookie'       => $cookie_user && (int) $cookie_user === $claims['user_id'] ? $cookie_value : '',
					'access_token' => true,
					'user_id'      => $claims['user_id'],
				);
			}

			// 2. WordPress logged_in auth cookie.
			if ( '' === $cookie_value ) {
				return new WP_Error(
					'websocket_invalid_cookie',
					'' === $cookie_header
						? 'Missing Cookie header.'
						: 'Auth cookie not present in Cookie header.'
				);
			}

			$cookie_user = wp_validate_auth_cookie( $cookie_value, 'logged_in' );

			if ( ! $cookie_user ) {
				return new WP_Error( 'websocket_invalid_cookie', 'Invalid auth cookie.' );
			}

			// 3. One-time token whose user must match the cookie user.
			$token_user = WP_WebSocket_Token_Controller::consume_token( $token );

			if ( null === $token_user || $token_user !== (int) $cookie_user ) {
				return new WP_Error( 'websocket_invalid_token', 'Missing, expired, or mismatched token.' );
			}

			return array(
				'cookie'       => $cookie_value,
				'access_token' => false,
				'user_id'      => (int) $cookie_user,
			);
		}

		/**
		 * Handles a decoded text message from an open connection.
		 *
		 * @since 7.4.0
		 *
		 * @param int    $key     Client key.
		 * @param string $payload JSON message payload.
		 */
		private function handle_message( int $key, string $payload ): void {
			// Per-socket rolling rate budget. A well-behaved client
			// coalesces sends behind a debounce and stays far below this.
			$now          = microtime( true );
			$window_start = $now - self::MESSAGE_RATE_WINDOW_S;
			$recent_times = array();

			foreach ( $this->clients[ $key ]['message_times'] as $time ) {
				if ( $time > $window_start ) {
					$recent_times[] = $time;
				}
			}

			$recent_times[]                         = $now;
			$this->clients[ $key ]['message_times'] = $recent_times;

			if ( count( $recent_times ) > self::MESSAGE_RATE_LIMIT ) {
				$this->log( 'Closing connection: message rate budget exceeded' );
				$this->clients[ $key ]['conn']->send_close( 1008, 'Message rate exceeded' );
				$this->disconnect( $key );
				return;
			}

			$message = json_decode( $payload, true );

			if ( is_array( $message ) && 'advisory' === ( $message['type'] ?? '' ) ) {
				$this->handle_advisory_message( $key, $message );
				return;
			}

			if ( ! is_array( $message ) || 'sync' !== ( $message['type'] ?? '' ) || ! isset( $message['rooms'] ) || ! is_array( $message['rooms'] ) ) {
				$this->send_error( $key, new WP_Error( 'websocket_invalid_message', 'Expected a sync or advisory message.' ) );
				return;
			}

			$rooms = array_slice( array_values( $message['rooms'] ), 0, self::MAX_ROOMS_PER_MESSAGE );

			// Establish the current user before any capability checks.
			wp_set_current_user( (int) $this->clients[ $key ]['user_id'] );

			$responses     = array();
			$touched_rooms = array();
			$landed_rooms  = array();

			foreach ( $rooms as $room_request ) {
				$validated = $this->validate_room_request( $room_request );

				if ( is_wp_error( $validated ) ) {
					$this->send_error( $key, $validated );
					continue;
				}

				$room = $validated['room'];

				// Per-room permission checks when the socket first references
				// the room, mirroring the REST permission callback.
				if ( ! isset( $this->clients[ $key ]['rooms'][ $room ] ) ) {
					if ( ! current_user_can( 'edit_posts' ) ) {
						$this->send_error(
							$key,
							new WP_Error(
								'rest_cannot_edit',
								'You do not have permission to perform this action',
								array( 'rooms' => array( $room ) )
							)
						);
						continue;
					}

					if ( ! $this->sync->can_user_sync_room( $room ) ) {
						$this->send_error(
							$key,
							new WP_Error(
								'rest_cannot_edit',
								'You do not have permission to sync this room.',
								array( 'rooms' => array( $room ) )
							)
						);
						continue;
					}

					$this->clients[ $key ]['rooms'][ $room ] = array(
						'client_id'      => $validated['client_id'],
						'cursor'         => 0,
						// Remembered so a closed socket can leave the room
						// the way a closing tab's beacon does.
						'presence_token' => $validated['presence_token'] ?? '',
					);
				} elseif ( $this->clients[ $key ]['rooms'][ $room ]['client_id'] !== $validated['client_id'] ) {
					/*
					 * The client_id is bound to this (socket, room) pair at
					 * first subscribe. A different client_id afterwards is a
					 * protocol/policy violation: it could hijack or evict
					 * another user's awareness entry. Close the socket.
					 */
					$this->log( 'Closing connection: client_id changed for a subscribed room' );
					$this->clients[ $key ]['conn']->send_close( 1008, 'client_id mismatch' );
					$this->disconnect( $key );
					return;
				}

				/*
				 * Deliver monotonically per socket. A broadcast triggered by
				 * ANOTHER socket's message advances this socket's server-side
				 * cursor while the client's own frame — stamped with the older
				 * cursor it knew when it sent — is still in flight. Honoring
				 * that stale `after` would redeliver rows the broadcast
				 * already pushed. Log-based engines (intent-log) count every
				 * delivered row as a new log entry, so a duplicate permanently
				 * desyncs the replica: its local head passes the server's and
				 * all its later intents void as invalid-payload. max() keeps
				 * client-driven resync working (a reconnect is a new socket,
				 * which subscribes fresh at cursor 0) while making each
				 * socket's delivery window monotonic.
				 */
				$validated['after'] = max(
					$validated['after'],
					(int) $this->clients[ $key ]['rooms'][ $room ]['cursor']
				);

				$this->refresh_engine_state( $room );
				$room_response = $this->sync->process_room_request( $validated );

				if ( is_wp_error( $room_response ) ) {
					$this->send_error( $key, $room_response );
					continue;
				}

				$this->clients[ $key ]['rooms'][ $room ]['cursor'] = $room_response['end_cursor'];

				// A null awareness state is a disconnect signal for the room.
				if ( null === $validated['awareness'] ) {
					unset( $this->clients[ $key ]['rooms'][ $room ] );
				}

				$responses[]     = $room_response;
				$touched_rooms[] = $room;
				if ( count( $validated['updates'] ) > 0 ) {
					$landed_rooms[] = $room;
				}
			}

			if ( ! empty( $responses ) ) {
				$this->clients[ $key ]['conn']->send_text(
					wp_json_encode(
						array(
							'rooms' => $responses,
							'type'  => 'sync',
						)
					)
				);
			}

			// Push new updates and awareness to the other sockets in the room.
			foreach ( array_unique( $touched_rooms ) as $room ) {
				$this->broadcast_room( $room, $key );
			}
			// Tell the room's advisory followers (short-polling tabs) to
			// poll for the rows this socket landed, and note the head so
			// the scan does not announce the same rows again.
			foreach ( array_unique( $landed_rooms ) as $room ) {
				$this->notify_advisory_followers( $room );
			}
		}

		/**
		 * Handles an advisory frame: `{type: 'advisory', room, client_id,
		 * presence_token?, presence?, announce?}`. The first frame for a room
		 * subscribes the socket to it (permission-checked like a sync
		 * subscription, and bound to one client id); `presence` replaces
		 * this tab's presence in the room's roster; `announce` names a room
		 * (or `*`) the tab just landed rows in. The daemon answers roster
		 * changes with the room's full roster to every follower and relays
		 * notices to the other followers. Nothing here touches storage.
		 *
		 * @since 0.0.1
		 *
		 * @param int   $key     Client key.
		 * @param array $message Decoded frame.
		 */
		private function handle_advisory_message( int $key, array $message ): void {
			$validated = $this->validate_advisory_message( $message );

			if ( is_wp_error( $validated ) ) {
				$this->send_error( $key, $validated );
				return;
			}

			$room = $validated['room'];
			wp_set_current_user( (int) $this->clients[ $key ]['user_id'] );

			$roster_changed = false;
			if ( ! isset( $this->clients[ $key ]['advisory'][ $room ] ) ) {
				if ( ! current_user_can( 'edit_posts' ) || ! $this->sync->can_user_sync_room( $room ) ) {
					$this->send_error(
						$key,
						new WP_Error(
							'rest_cannot_edit',
							'You do not have permission to sync this room.',
							array( 'rooms' => array( $room ) )
						)
					);
					return;
				}

				$this->clients[ $key ]['advisory'][ $room ] = array(
					'client_id'      => $validated['client_id'],
					'presence_token' => $validated['presence_token'] ?? '',
					'presence'       => null,
					// Rows already in the room are the poll's business; the
					// scan announces only what lands from here on.
					'cursor'         => $this->room_head_cursor( $room ),
				);
				$roster_changed                             = true;
			} elseif ( $this->clients[ $key ]['advisory'][ $room ]['client_id'] !== $validated['client_id'] ) {
				// One client id per socket and room, as for sync (a different
				// id could impersonate another tab in the roster).
				$this->log( 'Closing connection: client_id changed for a followed room' );
				$this->clients[ $key ]['conn']->send_close( 1008, 'client_id mismatch' );
				$this->disconnect( $key );
				return;
			}

			if ( isset( $validated['presence_token'] ) && $validated['presence_token'] !== $this->clients[ $key ]['advisory'][ $room ]['presence_token'] ) {
				$this->clients[ $key ]['advisory'][ $room ]['presence_token'] = $validated['presence_token'];
				$roster_changed = true;
			}

			if ( array_key_exists( 'presence', $validated ) ) {
				$this->clients[ $key ]['advisory'][ $room ]['presence'] = $validated['presence'];
				$roster_changed = true;
			}

			if ( $roster_changed ) {
				$this->send_advisory_roster( $room );
			}

			if ( isset( $validated['announce'] ) ) {
				$this->send_advisory_announce( $room, $validated['announce'], $key );
				// A websocket-transport tab in the announced room gets the
				// rows now instead of on the next scan.
				if ( '*' !== $validated['announce'] && $this->has_sync_subscribers( $validated['announce'] ) ) {
					$this->broadcast_room( $validated['announce'] );
				}
			}
		}

		/**
		 * Validates an advisory frame.
		 *
		 * @since 0.0.1
		 *
		 * @param array $message Decoded frame.
		 * @return array|WP_Error Normalized fields, or WP_Error if invalid.
		 */
		private function validate_advisory_message( array $message ) {
			$room = $message['room'] ?? null;
			if ( ! is_string( $room ) || ! preg_match( '#^[^/]+/[^/:]+(?::\S+)?$#', $room ) ) {
				return new WP_Error( 'websocket_invalid_advisory', 'Invalid room identifier.' );
			}

			$client_id = $message['client_id'] ?? null;
			if ( ! is_int( $client_id ) || $client_id < 1 ) {
				return new WP_Error( 'websocket_invalid_advisory', 'Invalid client_id.', array( 'rooms' => array( $room ) ) );
			}

			$validated = array(
				'client_id' => $client_id,
				'room'      => $room,
			);

			$presence_token = $message['presence_token'] ?? null;
			if ( null !== $presence_token ) {
				if ( ! is_string( $presence_token ) || '' === $presence_token || strlen( $presence_token ) > 64 ) {
					return new WP_Error( 'websocket_invalid_advisory', 'Invalid presence token.', array( 'rooms' => array( $room ) ) );
				}
				$validated['presence_token'] = $presence_token;
			}

			if ( array_key_exists( 'presence', $message ) ) {
				$presence = $message['presence'];
				if ( null !== $presence && ! is_array( $presence ) ) {
					return new WP_Error( 'websocket_invalid_advisory', 'Invalid presence state.', array( 'rooms' => array( $room ) ) );
				}
				if ( null !== $presence && strlen( (string) wp_json_encode( $presence ) ) > self::MAX_ADVISORY_PRESENCE_BYTES ) {
					return new WP_Error( 'websocket_invalid_advisory', 'Presence state too large.', array( 'rooms' => array( $room ) ) );
				}
				$validated['presence'] = $presence;
			}

			$announce = $message['announce'] ?? null;
			if ( null !== $announce ) {
				if ( ! is_string( $announce ) || '' === $announce || strlen( $announce ) > self::MAX_ADVISORY_ROOM_LENGTH ) {
					return new WP_Error( 'websocket_invalid_advisory', 'Invalid announce.', array( 'rooms' => array( $room ) ) );
				}
				$validated['announce'] = $announce;
			}

			return $validated;
		}

		/**
		 * The room's head cursor (its newest row id), read through the
		 * storage API: a read past every row returns nothing but refreshes
		 * the storage's cursor cache, the API's only refresh path.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @return int Head cursor.
		 */
		private function room_head_cursor( string $room ): int {
			$storage = $this->sync->get_storage();
			$storage->get_updates_after_cursor( $room, PHP_INT_MAX );
			return (int) $storage->get_cursor( $room );
		}

		/**
		 * Whether any open socket syncs the room (the websocket transport).
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @return bool Whether the room has sync subscribers.
		 */
		private function has_sync_subscribers( string $room ): bool {
			foreach ( $this->clients as $client ) {
				if ( isset( $client['rooms'][ $room ] ) && $client['conn']->is_open() ) {
					return true;
				}
			}
			return false;
		}

		/**
		 * Sends a room's roster — every follower's client id, presence
		 * token, and latest presence — to each of its followers.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 */
		private function send_advisory_roster( string $room ): void {
			$peers     = array();
			$followers = array();
			foreach ( $this->clients as $key => $client ) {
				if ( ! isset( $client['advisory'][ $room ] ) || ! $client['conn']->is_open() ) {
					continue;
				}
				$subscription = $client['advisory'][ $room ];
				$peers[]      = array(
					'client_id' => (int) $subscription['client_id'],
					'presence'  => $subscription['presence'],
					'token'     => (string) $subscription['presence_token'],
				);
				$followers[]  = $key;
			}

			$frame = wp_json_encode(
				array(
					'event' => 'roster',
					'peers' => $peers,
					'room'  => $room,
					'type'  => 'advisory',
				)
			);
			foreach ( $followers as $key ) {
				$this->clients[ $key ]['conn']->send_text( $frame );
			}
		}

		/**
		 * Relays a "rows landed, go and poll" notice to a room's followers.
		 *
		 * @since 0.0.1
		 *
		 * @param string   $room        The room whose followers are told.
		 * @param string   $announced   The room the notice names (or `*`).
		 * @param int|null $exclude_key Client key to skip (the sender), or null.
		 */
		private function send_advisory_announce( string $room, string $announced, ?int $exclude_key = null ): void {
			$frame = wp_json_encode(
				array(
					'event' => 'announce',
					'room'  => $announced,
					'type'  => 'advisory',
				)
			);
			foreach ( $this->clients as $key => $client ) {
				if ( $key === $exclude_key || ! isset( $client['advisory'][ $room ] ) || ! $client['conn']->is_open() ) {
					continue;
				}
				$client['conn']->send_text( $frame );
			}
		}

		/**
		 * Rows landed in a room through this daemon or a web request: tell
		 * the room's followers to poll and move their scan cursors to the
		 * head, so the scan announces each row once.
		 *
		 * @since 0.0.1
		 *
		 * @param string   $room Room identifier.
		 * @param int|null $head The room's head cursor when the caller read
		 *                       it, else null to read it here.
		 */
		private function notify_advisory_followers( string $room, ?int $head = null ): void {
			$followers = array();
			foreach ( $this->clients as $key => $client ) {
				if ( isset( $client['advisory'][ $room ] ) && $client['conn']->is_open() ) {
					$followers[] = $key;
				}
			}
			if ( empty( $followers ) ) {
				return;
			}
			if ( null === $head ) {
				$head = $this->room_head_cursor( $room );
			}
			foreach ( $followers as $key ) {
				$this->clients[ $key ]['advisory'][ $room ]['cursor'] = max( (int) $this->clients[ $key ]['advisory'][ $room ]['cursor'], $head );
			}
			$this->send_advisory_announce( $room, $room );
		}

		/**
		 * Validates a room request against the same constraints as the REST
		 * route schema.
		 *
		 * @since 7.4.0
		 *
		 * @param mixed $room_request Raw room request from the message.
		 * @return array|WP_Error Normalized room request, or WP_Error if invalid.
		 */
		private function validate_room_request( $room_request ) {
			if ( ! is_array( $room_request ) ) {
				return new WP_Error( 'websocket_invalid_room', 'Room request must be an object.' );
			}

			$room = $room_request['room'] ?? null;
			if ( ! is_string( $room ) || ! preg_match( '#^[^/]+/[^/:]+(?::\S+)?$#', $room ) ) {
				return new WP_Error( 'websocket_invalid_room', 'Invalid room identifier.' );
			}

			$client_id = $room_request['client_id'] ?? null;
			if ( ! is_int( $client_id ) || $client_id < 1 ) {
				return new WP_Error( 'websocket_invalid_room', 'Invalid client_id.', array( 'rooms' => array( $room ) ) );
			}

			$after = $room_request['after'] ?? null;
			if ( ! is_int( $after ) || $after < 0 ) {
				return new WP_Error( 'websocket_invalid_room', 'Invalid after cursor.', array( 'rooms' => array( $room ) ) );
			}

			$awareness = $room_request['awareness'] ?? null;
			if ( null !== $awareness && ! is_array( $awareness ) ) {
				return new WP_Error( 'websocket_invalid_room', 'Invalid awareness state.', array( 'rooms' => array( $room ) ) );
			}

			/*
			 * Optional engine handshake stamps, forwarded VERBATIM to
			 * process_room_request like the HTTP transports forward them:
			 * they power the stale-tab engine fence (409
			 * rest_sync_engine_mismatch) and the switched-engine
			 * collection-room healing (reset_switched_room). Stripping them
			 * here used to disable both over websocket.
			 */
			$engine = $room_request['engine'] ?? null;
			if ( null !== $engine && ( ! is_string( $engine ) || '' === $engine ) ) {
				return new WP_Error( 'websocket_invalid_room', 'Invalid engine stamp.', array( 'rooms' => array( $room ) ) );
			}
			$engine_protocol = $room_request['engine_protocol'] ?? null;
			if ( null !== $engine_protocol && ( ! is_int( $engine_protocol ) || $engine_protocol < 1 ) ) {
				return new WP_Error( 'websocket_invalid_room', 'Invalid engine protocol.', array( 'rooms' => array( $room ) ) );
			}

			$presence_token = $room_request['presence_token'] ?? null;
			if ( null !== $presence_token && ( ! is_string( $presence_token ) || '' === $presence_token || strlen( $presence_token ) > 64 ) ) {
				return new WP_Error( 'websocket_invalid_room', 'Invalid presence token.', array( 'rooms' => array( $room ) ) );
			}

			$updates = $room_request['updates'] ?? null;
			if ( ! is_array( $updates ) ) {
				return new WP_Error( 'websocket_invalid_room', 'Invalid updates list.', array( 'rooms' => array( $room ) ) );
			}

			$valid_types = $this->sync->get_engine_registry()->get_all_update_types();

			$validated_updates = array();
			foreach ( $updates as $update ) {
				if ( ! is_array( $update )
					|| ! isset( $update['data'], $update['type'] )
					|| ! is_string( $update['data'] )
					|| strlen( $update['data'] ) > self::MAX_UPDATE_DATA_SIZE
					|| ! in_array( $update['type'], $valid_types, true )
				) {
					return new WP_Error( 'websocket_invalid_room', 'Invalid update.', array( 'rooms' => array( $room ) ) );
				}

				$validated_updates[] = array(
					'data' => $update['data'],
					'type' => $update['type'],
				);
			}

			$validated = array(
				'after'     => $after,
				'awareness' => $awareness,
				'client_id' => $client_id,
				// The inspector's opt-in server envelope; process_room_request
				// gates it behind is_debug_allowed() like the REST transports.
				'debug'     => ! empty( $room_request['debug'] ),
				'room'      => $room,
				'updates'   => $validated_updates,
			);
			// Optional keys stay ABSENT when unset (the fence and the
			// healing both key on presence, mirroring the REST schema).
			if ( null !== $engine ) {
				$validated['engine'] = $engine;
			}
			if ( null !== $engine_protocol ) {
				$validated['engine_protocol'] = $engine_protocol;
			}
			if ( null !== $presence_token ) {
				$validated['presence_token'] = $presence_token;
			}

			return $validated;
		}

		/**
		 * Pushes new updates and current awareness for a room to its
		 * subscribed sockets.
		 *
		 * @since 7.4.0
		 *
		 * @param string   $room        Room identifier.
		 * @param int|null $exclude_key Client key to skip (the sender), or null.
		 */
		private function broadcast_room( string $room, ?int $exclude_key = null ): void {
			$this->refresh_engine_state( $room );

			// Convert the raw storage entries to the client_id => state map
			// clients expect (the shape process_awareness_update() responds
			// with on the REST transports); the raw entry list crashes the
			// editor's collaborator UI.
			$awareness_map = array();
			foreach ( $this->awareness()->entries( $room, WP_HTTP_Polling_Sync_Server::AWARENESS_TIMEOUT ) as $entry ) {
				$awareness_map[ $entry['client_id'] ] = $entry['state'];
			}

			foreach ( $this->clients as $other_key => $other ) {
				if ( $other_key === $exclude_key || ! isset( $other['rooms'][ $room ] ) || ! $other['conn']->is_open() ) {
					continue;
				}

				$client_id = $other['rooms'][ $room ]['client_id'];
				$cursor    = $other['rooms'][ $room ]['cursor'];

				$room_response              = $this->sync->get_engine_registry()->get_engine_for_room( $room )->get_updates_since( $room, $client_id, $cursor, array() );
				$room_response['awareness'] = $awareness_map;

				// The room generation rides pushed frames too, so a socket
				// client notices a room restart between its own requests.
				$generation = $this->sync->room_generation( $room, (int) ( $room_response['end_cursor'] ?? 0 ) );
				if ( null !== $generation ) {
					$room_response['generation'] = $generation;
				}

				$this->clients[ $other_key ]['rooms'][ $room ]['cursor'] = $room_response['end_cursor'];

				$other['conn']->send_text(
					wp_json_encode(
						array(
							'rooms' => array( $room_response ),
							'type'  => 'sync',
						)
					)
				);
			}
		}

		/**
		 * Restores the web process's per-request state boundary for one
		 * room's engine. The registry holds ONE engine instance for this
		 * process's lifetime, and engines cache room state per "request";
		 * in this long-lived process that cache goes stale the moment
		 * another process (a web request — e.g. a de-rtc autosave commit)
		 * advances the room. Called before every message-driven
		 * process_room_request and every broadcast read.
		 *
		 * @since 0.3.0
		 *
		 * @param string $room Room identifier.
		 */
		private function refresh_engine_state( string $room ): void {
			$engine = $this->sync->get_engine_registry()->get_engine_for_room( $room );
			if ( null !== $engine && method_exists( $engine, 'flush_room_state_cache' ) ) {
				$engine->flush_room_state_cache();
			}
		}

		/**
		 * Sends an error message to a client.
		 *
		 * @since 7.4.0
		 *
		 * @param int      $key   Client key.
		 * @param WP_Error $error Error to send.
		 */
		private function send_error( int $key, WP_Error $error ): void {
			if ( ! isset( $this->clients[ $key ] ) ) {
				return;
			}

			$data = $error->get_error_data();

			$this->clients[ $key ]['conn']->send_text(
				wp_json_encode(
					array(
						'code'    => $error->get_error_code(),
						'message' => $error->get_error_message(),
						'rooms'   => is_array( $data ) && isset( $data['rooms'] ) ? $data['rooms'] : array(),
						'type'    => 'error',
					)
				)
			);
		}

		/**
		 * Runs periodic tasks: keepalive pings, idle timeouts, awareness
		 * expiry sweeps, and deferred closes.
		 *
		 * @since 7.4.0
		 */
		private function tick(): void {
			global $wpdb;

			$now = microtime( true );

			// Close connections whose write buffer has drained after a
			// deferred close (e.g. health checks and rejected handshakes).
			foreach ( $this->clients as $key => $client ) {
				if ( $client['closing'] && ! $client['conn']->has_pending_writes() ) {
					$this->disconnect( $key );
				}
			}

			/*
			 * Drop sockets that never completed the WebSocket handshake
			 * within the deadline. This is independent of last_seen, which a
			 * slow-dripping pre-upgrade connection could keep refreshing.
			 */
			foreach ( $this->clients as $key => $client ) {
				if (
					! $client['conn']->is_open()
					&& ! $client['closing']
					&& $now - $client['connected_at'] > self::HANDSHAKE_TIMEOUT_S
				) {
					$this->log( 'Closing connection: handshake deadline exceeded' );
					$this->disconnect( $key );
				}
			}

			/*
			 * Out-of-band room scan (see ROOM_SCAN_INTERVAL_S): deliver rows
			 * that landed through web requests rather than socket messages.
			 * Without this, a de-rtc session's accepted commit (which rides
			 * the autosave endpoint) stores its announce row but no peer on
			 * this transport ever hears about it — the whole lane silently
			 * fails to converge (found by the post-inversion websocket fuzz).
			 */
			if ( $now - $this->last_room_scan_at >= self::ROOM_SCAN_INTERVAL_S ) {
				$this->last_room_scan_at = $now;

				// The lowest cursor per room, for the sockets syncing it and
				// for the advisory followers separately.
				$sync_floors     = array();
				$advisory_floors = array();
				foreach ( $this->clients as $client ) {
					if ( ! $client['conn']->is_open() ) {
						continue;
					}
					foreach ( $client['rooms'] as $room => $subscription ) {
						$cursor = (int) $subscription['cursor'];
						if ( ! isset( $sync_floors[ $room ] ) || $cursor < $sync_floors[ $room ] ) {
							$sync_floors[ $room ] = $cursor;
						}
					}
					foreach ( $client['advisory'] ?? array() as $room => $subscription ) {
						$cursor = (int) $subscription['cursor'];
						if ( ! isset( $advisory_floors[ $room ] ) || $cursor < $advisory_floors[ $room ] ) {
							$advisory_floors[ $room ] = $cursor;
						}
					}
				}

				foreach ( array_unique( array_merge( array_keys( $sync_floors ), array_keys( $advisory_floors ) ) ) as $room ) {
					// One aggregate storage read per room (the head, no
					// rows); deliver only when something landed past a floor.
					$head = $this->room_head_cursor( (string) $room );
					if ( isset( $sync_floors[ $room ] ) && $head > $sync_floors[ $room ] ) {
						$this->broadcast_room( (string) $room );
					}
					if ( isset( $advisory_floors[ $room ] ) && $head > $advisory_floors[ $room ] ) {
						$this->notify_advisory_followers( (string) $room, $head );
					}
				}
			}

			// Keepalive pings and idle timeouts.
			if ( $now - $this->last_ping_at >= self::PING_INTERVAL_S ) {
				$this->last_ping_at = $now;

				foreach ( $this->clients as $key => $client ) {
					if ( $now - $client['last_seen'] > self::IDLE_TIMEOUT_S ) {
						$this->log( 'Closing idle connection' );
						$this->disconnect( $key );
						continue;
					}

					if ( $client['conn']->is_open() ) {
						$client['conn']->send_ping();
					}
				}
			}

			// Awareness expiry sweep.
			if ( $now - $this->last_sweep_at >= self::AWARENESS_SWEEP_INTERVAL_S ) {
				$this->last_sweep_at = $now;

				// Keep the database connection alive across idle periods.
				if ( isset( $wpdb ) && method_exists( $wpdb, 'check_connection' ) ) {
					$wpdb->check_connection( false );
				}

				// Bound staleness of this process's in-memory object cache
				// against changes made by web requests (users, posts, terms).
				wp_cache_flush();

				$this->revalidate_clients();
				$this->sweep_awareness();
			}
		}

		/**
		 * Re-validates authentication for every open socket.
		 *
		 * The handshake authenticates once, but sessions can be revoked and
		 * capabilities can change while a socket stays open. The surrounding
		 * sweep has already flushed the object cache, so these checks run
		 * against fresh data. Sockets that fail are closed with policy
		 * violation code 1008.
		 *
		 * @since 7.4.0
		 */
		private function revalidate_clients(): void {
			foreach ( $this->clients as $key => $client ) {
				if ( ! $client['conn']->is_open() || $client['user_id'] <= 0 ) {
					continue;
				}

				// An access token-authenticated socket may carry no cookie at all
				// (a browser on another origin never sends one): its
				// session is not re-checked, only the capability below.
				if ( '' !== $client['cookie'] || empty( $client['access_token'] ) ) {
					$cookie_user = '' !== $client['cookie']
						? wp_validate_auth_cookie( $client['cookie'], 'logged_in' )
						: false;

					if ( ! $cookie_user || (int) $cookie_user !== (int) $client['user_id'] ) {
						$this->log( 'Closing connection: session no longer valid' );
						$client['conn']->send_close( 1008, 'Session expired' );
						$this->disconnect( $key );
						continue;
					}
				}

				wp_set_current_user( (int) $client['user_id'] );

				if ( ! current_user_can( 'edit_posts' ) ) {
					$this->log( 'Closing connection: user lost required capability' );
					$client['conn']->send_close( 1008, 'Insufficient permissions' );
					$this->disconnect( $key );
				}
			}
		}

		/**
		 * Who is in a room, over whichever store is serving this process.
		 *
		 * @since 0.0.2
		 *
		 * @return WP_Sync_Awareness The awareness reader and writer.
		 */
		private function awareness(): WP_Sync_Awareness {
			return new WP_Sync_Awareness( $this->sync->get_storage() );
		}

		/**
		 * Refreshes awareness for connected clients and expires stale peers.
		 *
		 * Connected WebSocket clients only send awareness on change (unlike
		 * HTTP polling clients that refresh on every poll), so the server
		 * refreshes their timestamps while a socket remains open. Entries
		 * belonging to disconnected clients expire via the shared timeout and
		 * the removal is broadcast to the room.
		 *
		 * @since 7.4.0
		 */
		private function sweep_awareness(): void {
			$connected_clients_by_room = array();

			foreach ( $this->clients as $client ) {
				if ( ! $client['conn']->is_open() ) {
					continue;
				}

				foreach ( $client['rooms'] as $room => $room_state ) {
					$connected_clients_by_room[ $room ][ $room_state['client_id'] ] = true;
				}
			}

			$awareness = $this->awareness();
			$timeout   = WP_HTTP_Polling_Sync_Server::AWARENESS_TIMEOUT;

			foreach ( $connected_clients_by_room as $room => $connected_client_ids ) {
				$entries = $awareness->entries( $room, $timeout );

				foreach ( $entries as $entry ) {
					if ( ! isset( $connected_client_ids[ $entry['client_id'] ] ) ) {
						continue;
					}

					// Re-record the state so a quiet but connected socket is
					// not expired; the store skips the write if it can.
					$entries = $awareness->put( $room, $entry['client_id'], $entry['state'], $entry['wp_user_id'], $timeout );
				}

				// The store expires entries, so a departure shows up only as
				// a client id the last sweep had and this one does not.
				$present = array_column( $entries, 'client_id' );
				sort( $present );

				$gone                            = array_diff( $this->swept_client_ids[ $room ] ?? array(), $present );
				$this->swept_client_ids[ $room ] = $present;

				if ( ! empty( $gone ) ) {
					$this->broadcast_room( $room );
				}
			}

			// Rooms nobody is connected to no longer need a memo.
			$this->swept_client_ids = array_intersect_key( $this->swept_client_ids, $connected_clients_by_room );
		}

		/**
		 * Disconnects a client, removing its awareness entries and notifying
		 * room peers.
		 *
		 * @since 7.4.0
		 *
		 * @param int $key Client key.
		 */
		private function disconnect( int $key ): void {
			if ( ! isset( $this->clients[ $key ] ) ) {
				return;
			}

			$client         = $this->clients[ $key ];
			$rooms          = array_keys( $client['rooms'] );
			$advisory_rooms = array_keys( $client['advisory'] ?? array() );

			$client['conn']->close();
			unset( $this->clients[ $key ] );

			// An advisory follower leaves its rooms' rosters and nothing
			// else: its presence lives in memory here, and its tab's
			// server-side presence (awareness, the leave beacon) is the
			// polling transport's business — a dropped socket is not a
			// closed tab.
			foreach ( $advisory_rooms as $room ) {
				$this->send_advisory_roster( $room );
			}

			foreach ( $rooms as $room ) {
				// Removing the client's awareness entry immediately mirrors
				// the REST disconnect signal (awareness: null).
				if ( $client['user_id'] > 0 ) {
					wp_set_current_user( (int) $client['user_id'] );
				}
				$this->sync->update_awareness( $room, $client['rooms'][ $room ]['client_id'], null );
				// A socket close is the tab leaving: the presence lane may
				// reset a room nobody else is in.
				$presence = $this->sync->get_presence();
				$token    = $client['rooms'][ $room ]['presence_token'] ?? '';
				if ( null !== $presence && '' !== $token ) {
					$presence->leave( $room, $token, (int) $client['rooms'][ $room ]['client_id'] );
				}
				$this->broadcast_room( $room );
			}
		}

		/**
		 * Disconnects immediately if the write buffer has drained, otherwise
		 * marks the connection for closing once it does.
		 *
		 * @since 7.4.0
		 *
		 * @param int $key Client key.
		 */
		private function finish_or_mark_closing( int $key ): void {
			if ( ! isset( $this->clients[ $key ] ) ) {
				return;
			}

			if ( ! $this->clients[ $key ]['conn']->has_pending_writes() ) {
				$this->disconnect( $key );
				return;
			}

			$this->clients[ $key ]['closing'] = true;
		}

		/**
		 * Extracts scheme://host[:port] from a URL.
		 *
		 * @since 7.4.0
		 *
		 * @param string $url URL to parse.
		 * @return string Origin, or empty string if the URL is unparsable.
		 */
		private function get_url_origin( string $url ): string {
			$parts = wp_parse_url( $url );

			if ( empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
				return '';
			}

			$origin = $parts['scheme'] . '://' . $parts['host'];

			if ( ! empty( $parts['port'] ) ) {
				$origin .= ':' . $parts['port'];
			}

			return $origin;
		}

		/**
		 * Reads a cookie value from a raw Cookie header.
		 *
		 * @since 7.4.0
		 *
		 * @param string $cookie_header Raw Cookie header value.
		 * @param string $name          Cookie name to find.
		 * @return string Cookie value (URL-decoded), or empty string.
		 */
		private function get_cookie_value( string $cookie_header, string $name ): string {
			foreach ( explode( ';', $cookie_header ) as $pair ) {
				$parts = explode( '=', trim( $pair ), 2 );

				if ( 2 === count( $parts ) && $parts[0] === $name ) {
					return rawurldecode( $parts[1] );
				}
			}

			return '';
		}

		/**
		 * Logs a message to WP-CLI when available, or the PHP error log.
		 *
		 * @since 7.4.0
		 *
		 * @param string $message Message to log.
		 */
		private function log( string $message ): void {
			if ( defined( 'WP_CLI' ) && WP_CLI && class_exists( 'WP_CLI' ) ) {
				WP_CLI::log( '[wp-sync-ws] ' . $message );
				return;
			}

			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			error_log( '[wp-sync-ws] ' . $message );
		}
	}
}
