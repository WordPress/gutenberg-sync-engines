<?php
/**
 * Small RESP2 client for collaboration change notices. No PHP extension needed.
 *
 * @package GutenbergSyncEngines
 * @since 0.0.2
 */

/**
 * Redis socket for short notices.
 *
 * @since 0.0.2
 */
class WP_Sync_Redis implements WP_Sync_Change_Waiter {
	/**
	 * Redis socket.
	 *
	 * @var resource|null Redis socket.
	 */
	private $socket;

	/**
	 * Connect with a bounded timeout. Credentials never enter a browser URL.
	 *
	 * @param string $url Redis URL: redis://[user:password@]host:port,
	 *                    rediss:// for TLS, or unix:///path/to/redis.sock.
	 * @throws RuntimeException When Redis cannot be reached.
	 */
	public function __construct( string $url ) {
		$parts  = wp_parse_url( $url );
		$scheme = is_array( $parts ) ? ( $parts['scheme'] ?? '' ) : '';
		if ( preg_match( '#^unix:/*(/.+)$#', $url, $unix ) ) {
			// parse_url() rejects the empty host in unix:///path.
			$address = 'unix://' . $unix[1];
		} elseif ( in_array( $scheme, array( 'redis', 'rediss' ), true ) && ! empty( $parts['host'] ) ) {
			$address = ( 'rediss' === $scheme ? 'tls' : 'tcp' ) . '://' . $parts['host'] . ':' . ( $parts['port'] ?? 6379 );
		} else {
			throw new RuntimeException( 'Invalid collaboration Redis URL.' );
		}
		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		$this->socket = @stream_socket_client( $address, $errno, $errstr, 0.25 );
		if ( ! $this->socket ) {
			throw new RuntimeException( 'Collaboration Redis is unavailable.' );
		}
		stream_set_timeout( $this->socket, 1 );
		stream_set_read_buffer( $this->socket, 0 );
		if ( isset( $parts['pass'] ) ) {
			$args = array( 'AUTH' );
			if ( ! empty( $parts['user'] ) ) {
				$args[] = rawurldecode( $parts['user'] );
			}
			$args[] = rawurldecode( $parts['pass'] );
			$this->command( $args );
			$this->read();
		}
	}

	/**
	 * Send a RESP command, including partial socket writes.
	 *
	 * @param string[] $args Command and arguments.
	 * @throws RuntimeException When a write fails.
	 */
	public function command( array $args ): void {
		$data = '*' . count( $args ) . "\r\n";
		foreach ( $args as $arg ) {
			$data .= '$' . strlen( $arg ) . "\r\n" . $arg . "\r\n";
		}
		while ( '' !== $data ) {
			// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			$written = @fwrite( $this->socket, $data );
			if ( ! $written ) {
				throw new RuntimeException( 'Redis write failed.' );
			}
			$data = substr( $data, $written );
		}
	}

	/**
	 * Read a bounded RESP2 reply.
	 *
	 * @param int $depth Nesting depth.
	 * @return mixed Reply.
	 * @throws RuntimeException On disconnect, timeout, or invalid response.
	 */
	public function read( int $depth = 0 ) {
		$line = fgets( $this->socket, 4096 );
		if ( false === $line || "\r\n" !== substr( $line, -2 ) || $depth > 4 ) {
			throw new RuntimeException( 'Redis read failed.' );
		}
		$type  = $line[0];
		$value = substr( $line, 1, -2 );
		if ( '+' === $type ) {
			return $value;
		}
		if ( ':' === $type ) {
			return (int) $value;
		}
		if ( '$' === $type || '*' === $type ) {
			if ( ! preg_match( '/^\d+$/', $value ) || (int) $value > 65536 ) {
				throw new RuntimeException( 'Invalid Redis reply length.' );
			}
			$length = (int) $value;
			if ( '*' === $type ) {
				$items = array();
				for ( $i = 0; $i < $length; ++$i ) {
					$items[] = $this->read( $depth + 1 );
				}
				return $items;
			}
			$data     = '';
			$received = 0;
			while ( $received < $length + 2 ) {
				$chunk = fread( $this->socket, $length + 2 - strlen( $data ) );
				if ( false === $chunk || '' === $chunk ) {
					throw new RuntimeException( 'Redis reply interrupted.' );
				}
				$data     .= $chunk;
				$received += strlen( $chunk );
			}
			if ( "\r\n" !== substr( $data, -2 ) ) {
				throw new RuntimeException( 'Invalid Redis reply.' );
			}
			return substr( $data, 0, -2 );
		}
		throw new RuntimeException( 'Redis rejected the command.' );
	}

	/**
	 * Subscribe and wait for every acknowledgement before reading storage.
	 *
	 * @param string[] $channels Room channels.
	 * @throws RuntimeException When subscription fails.
	 */
	public function subscribe( array $channels ): void {
		if ( empty( $channels ) ) {
			// SUBSCRIBE with no channel is a Redis error; nothing to wait for.
			return;
		}
		$this->command( array_merge( array( 'SUBSCRIBE' ), $channels ) );
		foreach ( $channels as $channel ) {
			$reply            = $this->read();
			$kind             = $reply[0] ?? '';
			$received_channel = $reply[1] ?? '';
			if ( 'subscribe' !== $kind || $channel !== $received_channel ) {
				throw new RuntimeException( 'Redis subscription failed.' );
			}
		}
	}

	/**
	 * Sleep in the socket wait, not a storage check loop.
	 *
	 * @param float $seconds Maximum wait.
	 * @return bool Whether Redis sent a notice.
	 * @throws RuntimeException When the connection fails.
	 */
	public function wait( float $seconds ): bool {
		$read   = array( $this->socket );
		$write  = null;
		$except = null;
		$whole  = (int) $seconds;
		$ready  = 1;
		if ( empty( stream_get_meta_data( $this->socket )['unread_bytes'] ) ) {
			// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- A signal can interrupt the socket wait; the result is checked below.
			$ready = @stream_select( $read, $write, $except, $whole, (int) ( ( $seconds - $whole ) * 1000000 ) );
		}
		if ( false === $ready ) {
			throw new RuntimeException( 'Redis wait interrupted.' );
		}
		if ( 0 === $ready ) {
			return false;
		}
		$reply = $this->read();
		return 'message' === ( $reply[0] ?? '' );
	}

	/** Close the connection. */
	public function close(): void {
		if ( is_resource( $this->socket ) ) {
			fclose( $this->socket );
		}
		$this->socket = null;
	}

	/** Release sockets on errors too. */
	public function __destruct() {
		$this->close();
	}
}
