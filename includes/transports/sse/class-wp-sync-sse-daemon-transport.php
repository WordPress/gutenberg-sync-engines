<?php
/**
 * WP_Sync_SSE_Daemon_Transport class
 *
 * @package GutenbergSyncEngines
 * @since n.e.x.t
 */

if ( ! class_exists( 'WP_Sync_SSE_Daemon_Transport' ) ) {

	/**
	 * The receive-stream TRANSPORT, served by the sync daemon.
	 *
	 * The same daemon that answers the websocket transport answers this one:
	 * one listener, one event loop, one `$clients` table, and the framing
	 * chosen from the request the browser actually sent (see
	 * `WP_WebSocket_Sync_Server::handle_handshake()`). This class is the
	 * web-process half — the part that registers no route of its own and
	 * exists only to give the client a name to negotiate and a URL to reach.
	 *
	 * What it buys over the `sse` transport is where the stream runs. There,
	 * a PHP web worker is held open for the life of every stream; here, the
	 * daemon holds the socket and the worker is released. Streams are
	 * receive-only either way: updates still go out over the ordinary
	 * `POST /wp-sync/v1/updates`, beside the stream.
	 *
	 * @since n.e.x.t
	 * @access private
	 */
	class WP_Sync_SSE_Daemon_Transport implements WP_Sync_Transport {
		/**
		 * Transport slug.
		 *
		 * @since n.e.x.t
		 * @var string
		 */
		const TRANSPORT_SLUG = 'sse-daemon';

		/**
		 * Transport protocol version.
		 *
		 * @since n.e.x.t
		 * @var int
		 */
		const TRANSPORT_PROTOCOL = 1;

		/**
		 * The path the daemon serves receive streams on.
		 *
		 * The daemon answers any request that did not ask to upgrade, so
		 * this name is a convention both sides agree on rather than a
		 * switch in the daemon.
		 *
		 * @since n.e.x.t
		 * @var string
		 */
		const STREAM_PATH = '/wp-sync/v1/sse';

		/**
		 * Constructor. Storage and the engine registry are accepted for a
		 * uniform transport signature; neither is used here.
		 *
		 * @since n.e.x.t
		 *
		 * @param WP_Sync_Storage         $storage Storage backend (unused here).
		 * @param WP_Sync_Engine_Registry $engines Engine registry (unused here).
		 */
		public function __construct( WP_Sync_Storage $storage, WP_Sync_Engine_Registry $engines ) {
			unset( $storage, $engines );
		}

		/**
		 * The transport slug.
		 *
		 * @since n.e.x.t
		 *
		 * @return string Slug.
		 */
		public function get_slug(): string {
			return self::TRANSPORT_SLUG;
		}

		/**
		 * The transport protocol version.
		 *
		 * @since n.e.x.t
		 *
		 * @return int Protocol version.
		 */
		public function get_protocol_version(): int {
			return self::TRANSPORT_PROTOCOL;
		}

		/**
		 * Registers no route: the stream lives on the daemon, not in the web
		 * request path.
		 *
		 * @since n.e.x.t
		 *
		 * @return void
		 */
		public function register_routes(): void {
		}

		/**
		 * The stream URL the client should open.
		 *
		 * The daemon address is the websocket transport's — it is one process
		 * on one port — but the scheme is HTTP rather than WS, because this
		 * connection is an ordinary request that never leaves HTTP mode.
		 *
		 * @since n.e.x.t
		 *
		 * @return string Stream URL.
		 */
		public static function get_stream_url(): string {
			$url = class_exists( 'Gutenberg_Sync_Engines_Settings' ) ? Gutenberg_Sync_Engines_Settings::websocket_url() : '';
			if ( '' === $url ) {
				$host = defined( 'WP_SYNC_WEBSOCKET_HOST' ) ? (string) WP_SYNC_WEBSOCKET_HOST : '127.0.0.1';
				$port = defined( 'WP_SYNC_WEBSOCKET_PORT' ) ? (int) WP_SYNC_WEBSOCKET_PORT : 8787;
				$url  = sprintf( 'http://%s:%d', $host, $port );
			}

			$url = self::to_http_url( $url );

			/**
			 * Filters the receive-stream URL announced to clients. A host
			 * fronting the daemon with TLS termination enters its public
			 * `https://` address here, or proxies this path to the daemon.
			 *
			 * @since n.e.x.t
			 *
			 * @param string $url Stream URL, before the path is appended.
			 */
			$url = (string) apply_filters( 'wp_sync_sse_daemon_url', $url );

			return untrailingslashit( $url ) . self::STREAM_PATH;
		}

		/**
		 * Rewrites a ws:// or wss:// daemon address as the http:// or
		 * https:// one the same host answers.
		 *
		 * The daemon is the same server either way; only the scheme the
		 * browser speaks changes, and an operator who already configured
		 * `wss://` for the websocket transport should not have to configure
		 * the same host twice.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $url Daemon address.
		 * @return string The address in HTTP form.
		 */
		private static function to_http_url( string $url ): string {
			if ( 0 === stripos( $url, 'ws://' ) ) {
				return 'http://' . substr( $url, 5 );
			}

			if ( 0 === stripos( $url, 'wss://' ) ) {
				return 'https://' . substr( $url, 6 );
			}

			return $url;
		}
	}
}
