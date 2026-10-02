<?php
/**
 * WP_Sync_SSE_Connection class
 *
 * @package GutenbergSyncEngines
 * @since n.e.x.t
 */

if ( ! class_exists( 'WP_Sync_SSE_Connection' ) ) {

	/**
	 * One client connection receiving Server-sent events.
	 *
	 * The wire format is ordinary HTTP: the browser POSTs the room
	 * envelope it wants streamed, the server answers 200 with
	 * `text/event-stream`, and every later change is written to that
	 * response as it happens. The response has no Content-Length and is
	 * never closed by the server, so the framing's whole job is turning
	 * the daemon's payloads into `event:`/`data:` pairs.
	 *
	 * There is no return path: the client never writes after its request,
	 * so this connection reads nothing, and a close is the socket going
	 * away rather than a frame.
	 *
	 * @since n.e.x.t
	 * @access private
	 */
	class WP_Sync_SSE_Connection extends WP_Sync_Connection {
		/**
		 * Maximum request body (in bytes) accepted to open a stream.
		 *
		 * @since n.e.x.t
		 * @var int
		 */
		const MAX_BODY_SIZE = 2097152; // 2 MB.

		/**
		 * The request body, once it has been read.
		 *
		 * This is the room envelope the client wants streamed — the SAME
		 * payload the socket sends as a `sync` frame. The daemon needs it to
		 * know which rooms to subscribe the stream to; a stream that never
		 * subscribes receives nothing but keepalives.
		 *
		 * @since n.e.x.t
		 * @var string
		 */
		private string $body = '';

		/**
		 * A receive stream never sends another message.
		 *
		 * The whole stream is one request, and the client writes nothing
		 * after it. The daemon therefore cannot time a stream out for
		 * silence, and must not: a stream is live for as long as the socket
		 * takes writes, and the connection ends when the browser goes away
		 * and the daemon reads the end of the socket.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool Always false.
		 */
		public function sends_messages(): bool {
			return false;
		}

		/**
		 * Answers 200 with an event stream, once the request body has
		 * arrived.
		 *
		 * @since n.e.x.t
		 *
		 * @param array $request Parsed request head.
		 * @param array $context Framing context; `cors` is the CORS header
		 *                       block the daemon approved, or ''.
		 * @return true|null|WP_Error True once streaming, null while the body is
		 *                           still arriving, WP_Error to reject.
		 */
		public function accept_request( array $request, array $context = array() ) {
			$cors = (string) ( $context['cors'] ?? '' );

			$length = $this->body_length( $request['headers'] );

			if ( is_wp_error( $length ) ) {
				return $length;
			}

			if ( strlen( $this->buffered_bytes() ) < $length ) {
				return null;
			}

			$this->body = $this->take_buffered( $length );

			$this->queue_write(
				"HTTP/1.1 200 OK\r\n"
				. "Content-Type: text/event-stream; charset=UTF-8\r\n"
				. "Cache-Control: no-cache, no-store, no-transform\r\n"
				. "X-Accel-Buffering: no\r\n"
				. $cors
				. "\r\n"
			);

			$this->mark_open();

			return true;
		}

		/**
		 * The request body length this framing will accept.
		 *
		 * @since n.e.x.t
		 *
		 * @param array<string, string> $headers Request headers.
		 * @return int|WP_Error Body length in bytes, or WP_Error when it is unusable.
		 */
		private function body_length( array $headers ) {
			$declared = $headers['content-length'] ?? '0';

			if ( ! ctype_digit( $declared ) ) {
				return new WP_Error( 'sse_bad_content_length', 'Invalid Content-Length.' );
			}

			$length = (int) $declared;

			if ( $length > self::MAX_BODY_SIZE ) {
				return new WP_Error( 'sse_body_too_large', 'Request body too large.' );
			}

			return $length;
		}

		/**
		 * The room envelope the client asked to have streamed.
		 *
		 * Read once, when the stream opens, and handed to the daemon's
		 * ordinary room-request path so the stream subscribes to the same
		 * rooms a socket would.
		 *
		 * @since n.e.x.t
		 *
		 * @return string Request body, or '' before it has arrived.
		 */
		public function request_body(): string {
			return $this->body;
		}

		/**
		 * Nothing arrives on a stream.
		 *
		 * The socket stays in the daemon's read set so that the browser
		 * closing the stream is noticed, which means a readable event here
		 * is either that or a client that pipelined bytes after its
		 * request. There is nothing to parse in either case, and anything
		 * buffered is dropped so the read buffer cannot grow against it.
		 *
		 * @since n.e.x.t
		 *
		 * @return array<int, array<string, mixed>> Always empty.
		 */
		public function read_messages() {
			$this->take_buffered( strlen( $this->buffered_bytes() ) );

			return array();
		}

		/**
		 * Writes one payload as a `sync` event.
		 *
		 * The payload is already the room-response JSON the transports
		 * exchange, so it rides `data:` unchanged.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $payload UTF-8 text payload.
		 */
		public function send_text( string $payload ): void {
			$this->queue_write( "event: sync\ndata: " . $payload . "\n\n" );
		}

		/**
		 * Writes a keepalive comment.
		 *
		 * A comment is invisible to the browser's event parser and keeps
		 * proxy and load-balancer idle counters from firing on a quiet
		 * stream, which is the job the ping frame does for a socket.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $payload Unused; a comment carries no data.
		 */
		public function send_ping( string $payload = '' ): void {
			unset( $payload );

			$this->queue_write( ": keepalive\n\n" );
		}

		/**
		 * Nothing to send: a stream has no close frame.
		 *
		 * The daemon closes the socket, which ends the response; the
		 * browser then reconnects from its last applied cursor, exactly
		 * as it does when a held stream is cut.
		 *
		 * @since n.e.x.t
		 *
		 * @param int    $code   Unused.
		 * @param string $reason Unused.
		 */
		public function send_close( int $code = 1000, string $reason = '' ): void {
			unset( $code, $reason );
		}
	}
}
