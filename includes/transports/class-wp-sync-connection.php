<?php
/**
 * WP_Sync_Connection class
 *
 * @package GutenbergSyncEngines
 * @since n.e.x.t
 */

if ( ! class_exists( 'WP_Sync_Connection' ) ) {

	/**
	 * One client connection to the sync daemon, independent of the wire
	 * format spoken over it.
	 *
	 * This is the socket half of a connection: the stream, the read and
	 * write buffers, and generic HTTP request parsing. Everything that
	 * differs between the framings the daemon serves — what a completed
	 * handshake looks like, what an inbound message is, how a payload
	 * reaches the browser, how a keepalive is written — belongs to the
	 * subclass, so the daemon can hold either in one `$clients` table and
	 * fan out to both through the same call sites.
	 *
	 * The subclasses are WP_WebSocket_Connection (RFC 6455) and
	 * WP_Sse_Connection (a chunked `text/event-stream` response).
	 *
	 * @since n.e.x.t
	 * @access private
	 */
	abstract class WP_Sync_Connection {
		/**
		 * Maximum size (in bytes) of an HTTP request head.
		 *
		 * @since n.e.x.t
		 * @var int
		 */
		const MAX_REQUEST_HEAD_SIZE = 16384; // 16 KB.

		/**
		 * Underlying stream resource.
		 *
		 * @since n.e.x.t
		 * @var resource
		 */
		private $stream;

		/**
		 * Buffered bytes read from the socket, not yet consumed.
		 *
		 * @since n.e.x.t
		 * @var string
		 */
		private string $read_buffer = '';

		/**
		 * Buffered bytes waiting to be written to the socket.
		 *
		 * @since n.e.x.t
		 * @var string
		 */
		private string $write_buffer = '';

		/**
		 * Whether the framing handshake has completed.
		 *
		 * @since n.e.x.t
		 * @var bool
		 */
		private bool $is_open = false;

		/**
		 * Whether the connection has been closed.
		 *
		 * @since n.e.x.t
		 * @var bool
		 */
		private bool $is_closed = false;

		/**
		 * Constructor.
		 *
		 * @since n.e.x.t
		 *
		 * @param resource $stream Accepted client stream (non-blocking).
		 */
		public function __construct( $stream ) {
			$this->stream = $stream;
			stream_set_blocking( $stream, false );
		}

		/**
		 * Gets the underlying stream resource.
		 *
		 * @since n.e.x.t
		 *
		 * @return resource Stream resource.
		 */
		public function get_stream() {
			return $this->stream;
		}

		/**
		 * Whether the framing handshake has completed.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool True once the connection is ready to carry traffic.
		 */
		public function is_open(): bool {
			return $this->is_open && ! $this->is_closed;
		}

		/**
		 * Whether the connection has been closed.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool True if closed.
		 */
		public function is_closed(): bool {
			return $this->is_closed;
		}

		/**
		 * Whether bytes are waiting to be flushed to the socket.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool True if the write buffer is non-empty.
		 */
		public function has_pending_writes(): bool {
			return '' !== $this->write_buffer;
		}

		/**
		 * The request body, for a framing that carries one.
		 *
		 * A socket carries its first message as a frame and has none; a
		 * receive stream carries its whole room envelope in the body and
		 * never frames anything. Defaults to none so the daemon can ask
		 * either framing without caring which it holds.
		 *
		 * @since n.e.x.t
		 *
		 * @return string Request body, or '' when the framing has none.
		 */
		public function request_body(): string {
			return '';
		}

		/**
		 * Whether the client ever sends another message on this connection.
		 *
		 * A socket answers the daemon's pings, so its silence is evidence it
		 * has gone. A receive stream writes its request and then nothing, so
		 * silence carries no information about it at all: it is live until
		 * the socket stops taking writes, which flush_writes() establishes
		 * by closing the connection the moment a write fails.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool True when the client sends messages.
		 */
		public function sends_messages(): bool {
			return true;
		}

		/**
		 * Marks the framing handshake complete.
		 *
		 * @since n.e.x.t
		 */
		protected function mark_open(): void {
			$this->is_open = true;
		}

		/**
		 * Reads available bytes from the socket into the buffer.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool False when the peer closed the connection.
		 */
		public function read_from_socket(): bool {
			if ( $this->is_closed ) {
				return false;
			}

			$data = fread( $this->stream, 65536 );

			if ( false === $data ) {
				return ! feof( $this->stream );
			}

			if ( '' === $data ) {
				return ! feof( $this->stream );
			}

			$this->read_buffer .= $data;

			return true;
		}

		/**
		 * Bytes read from the socket but not yet consumed.
		 *
		 * The request head is stripped as it is parsed, so whatever follows
		 * it — a request body, or a client that pipelined early — is what
		 * this returns.
		 *
		 * @since n.e.x.t
		 *
		 * @return string Buffered bytes.
		 */
		public function buffered_bytes(): string {
			return $this->read_buffer;
		}

		/**
		 * Consumes bytes already in the read buffer.
		 *
		 * @since n.e.x.t
		 *
		 * @param int $length Number of bytes to take.
		 * @return string The consumed bytes, or '' when fewer are buffered.
		 */
		protected function take_buffered( int $length ): string {
			if ( $length <= 0 || strlen( $this->read_buffer ) < $length ) {
				return '';
			}

			$take              = substr( $this->read_buffer, 0, $length );
			$this->read_buffer = substr( $this->read_buffer, $length );

			return $take;
		}

		/**
		 * Attempts to parse a complete HTTP request head from the buffer.
		 *
		 * The head ends at the blank line; a body, where the framing has
		 * one, stays buffered for that framing to read.
		 *
		 * @since n.e.x.t
		 *
		 * @return array{method: string, path: string, query: array<string, string>, headers: array<string, string>}|null|WP_Error
		 *         Parsed request, null when the head is incomplete, or WP_Error on a malformed one.
		 */
		public function parse_handshake_request() {
			$head_end = strpos( $this->read_buffer, "\r\n\r\n" );

			if ( false === $head_end ) {
				if ( strlen( $this->read_buffer ) > self::MAX_REQUEST_HEAD_SIZE ) {
					return new WP_Error( 'sync_request_head_too_large', 'Request head too large.' );
				}

				return null;
			}

			$raw_head          = substr( $this->read_buffer, 0, $head_end );
			$this->read_buffer = substr( $this->read_buffer, $head_end + 4 );

			$lines        = explode( "\r\n", $raw_head );
			$request_line = array_shift( $lines );
			$parts        = explode( ' ', $request_line );

			if ( count( $parts ) < 3 ) {
				return new WP_Error( 'sync_bad_request', 'Malformed request line.' );
			}

			$method      = strtoupper( $parts[0] );
			$request_uri = $parts[1];
			$path        = (string) wp_parse_url( $request_uri, PHP_URL_PATH );
			$query_str   = (string) wp_parse_url( $request_uri, PHP_URL_QUERY );

			$query = array();
			if ( '' !== $query_str ) {
				parse_str( $query_str, $query );
			}

			$headers = array();
			foreach ( $lines as $line ) {
				$colon = strpos( $line, ':' );
				if ( false === $colon ) {
					continue;
				}

				$name             = strtolower( trim( substr( $line, 0, $colon ) ) );
				$headers[ $name ] = trim( substr( $line, $colon + 1 ) );
			}

			return array(
				'headers' => $headers,
				'method'  => $method,
				'path'    => $path,
				'query'   => $query,
			);
		}

		/**
		 * Takes over bytes another connection already read from this socket.
		 *
		 * The daemon does not know which framing a request uses until it has
		 * read the head, so it hands the remainder to the framing that turns
		 * out to be right.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $bytes Bytes read from the socket, not yet consumed.
		 */
		public function adopt_buffered_bytes( string $bytes ): void {
			$this->read_buffer = $bytes;
		}

		/**
		 * Sends a complete plain HTTP response, for pre-handshake answers on
		 * any framing: a health check, a rejection.
		 *
		 * @since n.e.x.t
		 *
		 * @param int    $status_code HTTP status code.
		 * @param string $reason      HTTP reason phrase.
		 * @param string $body        Response body.
		 */
		public function send_http_response( int $status_code, string $reason, string $body = '' ): void {
			$response = sprintf( "HTTP/1.1 %d %s\r\n", $status_code, $reason )
				. "Content-Type: text/plain\r\n"
				. 'Content-Length: ' . strlen( $body ) . "\r\n"
				. "Connection: close\r\n\r\n"
				. $body;

			$this->queue_write( $response );
		}

		/**
		 * Answers a CORS preflight and stops there.
		 *
		 * A cross-origin stream carrying an Authorization header is
		 * preflighted by the browser, and the preflight is a bare OPTIONS
		 * with no body — nothing in the framing would consume it.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $cors_headers The CORS header block, ending in a
		 *                             blank line, or '' to refuse.
		 */
		public function queue_cors_response( string $cors_headers ): void {
			$status = '' === $cors_headers ? '403 Forbidden' : '204 No Content';
			$body   = '' === $cors_headers ? 'Forbidden' : '';

			$response = 'HTTP/1.1 ' . $status . "\r\n"
				. $cors_headers
				. 'Content-Length: ' . strlen( $body ) . "\r\n"
				. "Connection: close\r\n\r\n"
				. $body;

			$this->queue_write( $response );
		}

		/**
		 * Writes a liveness probe in this framing.
		 *
		 * The daemon calls this on its ping tick whatever the framing is, so
		 * the name is the generic one; each framing writes the bytes its own
		 * protocol uses for it.
		 *
		 * @since n.e.x.t
		 */
		final public function send_keepalive(): void {
			$this->send_ping();
		}

		/**
		 * Queues bytes for writing and attempts an immediate flush.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $data Bytes to write.
		 */
		protected function queue_write( string $data ): void {
			if ( $this->is_closed ) {
				return;
			}

			$this->write_buffer .= $data;
			$this->flush_writes();
		}

		/**
		 * Flushes as much of the write buffer as the socket accepts.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool False if the connection failed while writing.
		 */
		public function flush_writes(): bool {
			if ( $this->is_closed || '' === $this->write_buffer ) {
				return true;
			}

			// Intentional silencing: a peer disconnect mid-write raises a
			// warning; the false return value is handled below.
			// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			$written = @fwrite( $this->stream, $this->write_buffer );

			if ( false === $written ) {
				$this->close();
				return false;
			}

			$this->write_buffer = substr( $this->write_buffer, $written );

			return true;
		}

		/**
		 * Closes the underlying stream.
		 *
		 * @since n.e.x.t
		 */
		public function close(): void {
			if ( $this->is_closed ) {
				return;
			}

			$this->is_closed = true;
			$this->is_open   = false;

			if ( is_resource( $this->stream ) ) {
				// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
				@fclose( $this->stream );
			}
		}

		/**
		 * Completes the framing handshake for a parsed request.
		 *
		 * @since n.e.x.t
		 *
		 * @param array $request Parsed request head.
		 * @param array $context Framing context, for values the daemon has
		 *                       already resolved from the request.
		 * @return true|null|WP_Error True once the connection is open, null when
		 *                           the request is not yet complete and the daemon
		 *                           should call again once more bytes arrive,
		 *                           WP_Error to reject it.
		 */
		abstract public function accept_request( array $request, array $context = array() );

		/**
		 * Every complete inbound message the client has sent.
		 *
		 * @since n.e.x.t
		 *
		 * @return array<int, array<string, mixed>>|WP_Error Messages, or WP_Error on a protocol violation.
		 */
		abstract public function read_messages();

		/**
		 * Delivers one application payload to the client.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $payload UTF-8 text payload.
		 */
		abstract public function send_text( string $payload ): void;

		/**
		 * Writes this framing's liveness probe.
		 *
		 * Reached through send_keepalive(), which is what the daemon calls.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $payload Optional payload, where the framing has one.
		 */
		abstract public function send_ping( string $payload = '' ): void;

		/**
		 * Ends the connection, carrying a close code and reason where the
		 * framing has them.
		 *
		 * @since n.e.x.t
		 *
		 * @param int    $code   Close status code.
		 * @param string $reason Optional close reason.
		 */
		abstract public function send_close( int $code = 1000, string $reason = '' ): void;
	}
}
