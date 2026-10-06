<?php
/**
 * WP_WebSocket_Connection class
 *
 * @package gutenberg
 */

if ( ! class_exists( 'WP_WebSocket_Connection' ) ) {

	/**
	 * One client connection spoken over RFC 6455.
	 *
	 * Implements the parts of RFC 6455 the sync transport needs: the upgrade
	 * handshake, Sec-WebSocket-Accept computation, and frame encoding and
	 * decoding for text, close, ping, and pong frames. Client frames must be
	 * masked per the RFC. Fragmented messages are rejected with a clean
	 * close, which is acceptable for this experimental transport.
	 *
	 * The socket itself, and the HTTP request head every framing parses the
	 * same way, live in WP_Sync_Connection.
	 *
	 * @since 7.4.0
	 * @access private
	 */
	class WP_WebSocket_Connection extends WP_Sync_Connection {
		/**
		 * WebSocket handshake GUID from RFC 6455.
		 *
		 * @since 7.4.0
		 * @var string
		 */
		const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

		/**
		 * Maximum payload size (in bytes) accepted from a client.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const MAX_PAYLOAD_SIZE = 2097152; // 2 MB.

		/**
		 * Frame opcodes.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const OPCODE_CONTINUATION = 0x0;
		const OPCODE_TEXT         = 0x1;
		const OPCODE_BINARY       = 0x2;
		const OPCODE_CLOSE        = 0x8;
		const OPCODE_PING         = 0x9;
		const OPCODE_PONG         = 0xA;

		/**
		 * Completes the upgrade: answers 101 and echoes the subprotocol the
		 * daemon chose from the offer.
		 *
		 * @since n.e.x.t
		 *
		 * @param array $request Parsed request head.
		 * @param array $context Framing context; `subprotocol` is the
		 *                       protocol to echo, or '' for none.
		 * @return true|WP_Error True once upgraded, WP_Error to reject.
		 */
		public function accept_request( array $request, array $context = array() ) {
			$this->accept_handshake(
				$request['headers']['sec-websocket-key'],
				(string) ( $context['subprotocol'] ?? '' )
			);

			return true;
		}

		/**
		 * Computes the Sec-WebSocket-Accept value for a handshake key.
		 *
		 * @since 7.4.0
		 *
		 * @param string $key Client-provided Sec-WebSocket-Key.
		 * @return string Accept header value.
		 */
		public static function compute_accept_key( string $key ): string {
			// The RFC 6455 accept key requires raw binary SHA-1.
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
			return base64_encode( sha1( $key . self::HANDSHAKE_GUID, true ) );
		}

		/**
		 * Sends the 101 Switching Protocols response completing the handshake.
		 *
		 * @since 7.4.0
		 *
		 * @param string $key         Client-provided Sec-WebSocket-Key.
		 * @param string $subprotocol Accepted subprotocol to echo, or '' for
		 *                            none. RFC 6455 requires the server to
		 *                            select one of the client's offers when
		 *                            it accepts a subprotocol — the auth
		 *                            token rides the offer list, and the
		 *                            server echoes only the base protocol.
		 */
		public function accept_handshake( string $key, string $subprotocol = '' ): void {
			$response = "HTTP/1.1 101 Switching Protocols\r\n"
				. "Upgrade: websocket\r\n"
				. "Connection: Upgrade\r\n"
				. 'Sec-WebSocket-Accept: ' . self::compute_accept_key( $key ) . "\r\n";
			if ( '' !== $subprotocol ) {
				$response .= 'Sec-WebSocket-Protocol: ' . $subprotocol . "\r\n";
			}
			$response .= "\r\n";

			$this->queue_write( $response );
			$this->mark_open();
		}

		/**
		 * Every complete frame the client has sent.
		 *
		 * @since n.e.x.t
		 *
		 * @return array<int, array<string, mixed>>|WP_Error Frames, or WP_Error on a protocol violation.
		 */
		public function read_messages() {
			return $this->read_frames();
		}

		/**
		 * Extracts complete WebSocket frames from the read buffer.
		 *
		 * @since 7.4.0
		 *
		 * @return array<int, array{opcode: int, payload: string}>|WP_Error
		 *         Decoded frames, or WP_Error on a protocol violation.
		 */
		public function read_frames() {
			$frames = array();

			while ( true ) {
				$buffer          = $this->buffered_bytes();
				$buffered_length = strlen( $buffer );

				if ( $buffered_length < 2 ) {
					break;
				}

				$byte1 = ord( $buffer[0] );
				$byte2 = ord( $buffer[1] );

				$fin    = (bool) ( $byte1 & 0x80 );
				$rsv    = $byte1 & 0x70;
				$opcode = $byte1 & 0x0F;
				$masked = (bool) ( $byte2 & 0x80 );
				$length = $byte2 & 0x7F;

				if ( 0 !== $rsv ) {
					return new WP_Error( 'websocket_protocol_error', 'Reserved bits must be zero.' );
				}

				// Clients must mask frames per RFC 6455.
				if ( ! $masked ) {
					return new WP_Error( 'websocket_protocol_error', 'Client frames must be masked.' );
				}

				// Reject fragmented messages with a clean close.
				if ( ! $fin || self::OPCODE_CONTINUATION === $opcode ) {
					return new WP_Error( 'websocket_unsupported', 'Fragmented messages are not supported.' );
				}

				/*
				 * RFC 6455 section 5.5: control frames (close, ping, pong)
				 * must carry a payload of 125 bytes or less. Enforcing this
				 * also prevents a large ping from being echoed back as an
				 * equally large pong. The 7-bit length is checked before the
				 * extended-length decoding below, which control frames must
				 * not use (126/127 imply payloads over 125 bytes).
				 */
				if ( $opcode >= self::OPCODE_CLOSE && $length > 125 ) {
					return new WP_Error( 'websocket_protocol_error', 'Control frame payload too large.' );
				}

				$offset = 2;

				if ( 126 === $length ) {
					if ( $buffered_length < $offset + 2 ) {
						break;
					}

					$unpacked = unpack( 'n', substr( $buffer, $offset, 2 ) );
					$length   = $unpacked[1];
					$offset  += 2;
				} elseif ( 127 === $length ) {
					if ( $buffered_length < $offset + 8 ) {
						break;
					}

					$unpacked = unpack( 'J', substr( $buffer, $offset, 8 ) );
					$length   = $unpacked[1];
					$offset  += 8;
				}

				if ( $length < 0 || $length > self::MAX_PAYLOAD_SIZE ) {
					return new WP_Error( 'websocket_payload_too_large', 'Payload exceeds maximum size.' );
				}

				if ( $buffered_length < $offset + 4 + $length ) {
					break;
				}

				$mask_key = substr( $buffer, $offset, 4 );
				$offset  += 4;
				$payload  = substr( $buffer, $offset, $length );

				// Unmask the payload.
				$unmasked = '';
				for ( $i = 0; $i < $length; $i++ ) {
					$unmasked .= $payload[ $i ] ^ $mask_key[ $i % 4 ];
				}

				$this->take_buffered( $offset + $length );

				$frames[] = array(
					'opcode'  => $opcode,
					'payload' => $unmasked,
				);
			}

			return $frames;
		}

		/**
		 * Sends a text frame.
		 *
		 * @since 7.4.0
		 *
		 * @param string $payload UTF-8 text payload.
		 */
		public function send_text( string $payload ): void {
			$this->queue_write( self::encode_frame( self::OPCODE_TEXT, $payload ) );
		}

		/**
		 * Sends a ping frame.
		 *
		 * @since 7.4.0
		 *
		 * @param string $payload Optional ping payload.
		 */
		public function send_ping( string $payload = '' ): void {
			$this->queue_write( self::encode_frame( self::OPCODE_PING, $payload ) );
		}

		/**
		 * Sends a pong frame.
		 *
		 * @since 7.4.0
		 *
		 * @param string $payload Payload echoed from the ping frame.
		 */
		public function send_pong( string $payload = '' ): void {
			$this->queue_write( self::encode_frame( self::OPCODE_PONG, $payload ) );
		}

		/**
		 * Sends a close frame.
		 *
		 * @since 7.4.0
		 *
		 * @param int    $code   Close status code.
		 * @param string $reason Optional close reason.
		 */
		public function send_close( int $code = 1000, string $reason = '' ): void {
			$payload = pack( 'n', $code ) . $reason;
			$this->queue_write( self::encode_frame( self::OPCODE_CLOSE, $payload ) );
		}

		/**
		 * Encodes a server-to-client (unmasked) WebSocket frame.
		 *
		 * @since 7.4.0
		 *
		 * @param int    $opcode  Frame opcode.
		 * @param string $payload Frame payload.
		 * @return string Encoded frame bytes.
		 */
		public static function encode_frame( int $opcode, string $payload ): string {
			$length = strlen( $payload );
			$header = chr( 0x80 | ( $opcode & 0x0F ) );

			if ( $length < 126 ) {
				$header .= chr( $length );
			} elseif ( $length < 65536 ) {
				$header .= chr( 126 ) . pack( 'n', $length );
			} else {
				$header .= chr( 127 ) . pack( 'J', $length );
			}

			return $header . $payload;
		}
	}
}
