<?php
/**
 * WP_WebSocket_Token_Controller class
 *
 * @package gutenberg
 */

if ( ! class_exists( 'WP_WebSocket_Token_Controller' ) ) {

	/**
	 * Mints one-time, short-lived tokens used to authenticate WebSocket
	 * connections for the 'php-websocket' collaboration transport.
	 *
	 * The browser cannot attach custom headers to a WebSocket handshake, so
	 * the client requests a token over the (cookie- and nonce-authenticated)
	 * REST API and offers it on the `Sec-WebSocket-Protocol` header. The
	 * WebSocket server consumes the token (single use) and requires that the
	 * token's user matches the user authenticated by the logged_in cookie.
	 *
	 * In ACCESS-TOKEN mode (a `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` is configured,
	 * see WP_WebSocket_Access_Token) the same route returns a signed, expiring
	 * access token instead, which a server verifies with the shared secret and
	 * no database — the credential a host's own relay needs. The request
	 * may name the tab's post room (`room`), which the access token then allows.
	 *
	 * @since 7.4.0
	 * @access private
	 */
	class WP_WebSocket_Token_Controller {
		/**
		 * REST API namespace.
		 *
		 * @since 7.4.0
		 * @var string
		 */
		const REST_NAMESPACE = 'wp-sync/v1';

		/**
		 * Transient prefix for stored tokens.
		 *
		 * @since 7.4.0
		 * @var string
		 */
		const TOKEN_TRANSIENT_PREFIX = 'wp_sync_ws_token_';

		/**
		 * Token time-to-live in seconds.
		 *
		 * @since 7.4.0
		 * @var int
		 */
		const TOKEN_TTL = 2 * MINUTE_IN_SECONDS;

		/**
		 * Registers REST API routes.
		 *
		 * @since 7.4.0
		 */
		public function register_routes(): void {
			register_rest_route(
				self::REST_NAMESPACE,
				'/ws-token',
				array(
					'methods'             => array( WP_REST_Server::CREATABLE ),
					'callback'            => array( $this, 'handle_request' ),
					'permission_callback' => array( $this, 'check_permissions' ),
					'args'                => array(
						'room' => array(
							'description' => 'The post room the tab follows; an access token allows it (access-token mode only).',
							'type'        => 'string',
							'required'    => false,
						),
					),
				)
			);
		}

		/**
		 * Checks if the current user may request a WebSocket token.
		 *
		 * @since 7.4.0
		 *
		 * @return bool|WP_Error True if user has permission, otherwise WP_Error.
		 */
		public function check_permissions() {
			if ( ! current_user_can( 'edit_posts' ) ) {
				return new WP_Error(
					'rest_cannot_edit',
					__( 'You do not have permission to perform this action', 'gutenberg' ),
					array( 'status' => rest_authorization_required_code() )
				);
			}

			return true;
		}

		/**
		 * Mints a one-time token bound to the current user — or, in access token
		 * mode, a signed access token allowing the tab's post room.
		 *
		 * @since 7.4.0
		 * @since 0.0.1 Access-token mode, and the optional `room` parameter.
		 *
		 * @param WP_REST_Request|null $request The request.
		 * @return WP_REST_Response|WP_Error Response containing the token,
		 *                                   or why the room was refused.
		 */
		public function handle_request( ?WP_REST_Request $request = null ) {
			if ( class_exists( 'WP_WebSocket_Access_Token' ) && WP_WebSocket_Access_Token::is_enabled() ) {
				$room = $request ? $request->get_param( 'room' ) : null;
				if ( null !== $room && '' !== $room ) {
					if ( ! is_string( $room ) || ! $this->can_sync_post_room( $room ) ) {
						return new WP_Error(
							'rest_cannot_edit',
							__( 'You do not have permission to perform this action', 'gutenberg' ),
							array( 'status' => rest_authorization_required_code() )
						);
					}
				} else {
					$room = null;
				}

				return new WP_REST_Response(
					array(
						'expires_in' => WP_WebSocket_Access_Token::TTL,
						'token'      => WP_WebSocket_Access_Token::mint( get_current_user_id(), WP_WebSocket_Access_Token::grants( $room ) ),
					),
					200
				);
			}

			$token = bin2hex( random_bytes( 32 ) );

			set_transient( self::TOKEN_TRANSIENT_PREFIX . $token, get_current_user_id(), self::TOKEN_TTL );

			return new WP_REST_Response(
				array(
					'expires_in' => self::TOKEN_TTL,
					'token'      => $token,
				),
				200
			);
		}

		/**
		 * Whether the current user may sync a single-post room: the room
		 * an access token names must be a `postType/<type>:<id>` room the user
		 * can edit, the same check the sync endpoints make.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room The room.
		 * @return bool Whether the user may sync it.
		 */
		private function can_sync_post_room( string $room ): bool {
			if ( strlen( $room ) > 200 || ! class_exists( 'WP_Sync_Config' ) ) {
				return false;
			}
			$parsed = WP_Sync_Config::parse_room( $room );
			if ( null === $parsed || 'postType' !== $parsed['entity_kind'] || null === $parsed['object_id'] ) {
				return false;
			}
			return WP_Sync_Config::can_user_sync_entity_type( $parsed['entity_kind'], $parsed['entity_name'], $parsed['object_id'] );
		}

		/**
		 * Consumes a token, deleting it so it cannot be reused.
		 *
		 * @since 7.4.0
		 *
		 * @param string $token Token to consume.
		 * @return int|null User ID the token was minted for, or null if invalid.
		 */
		public static function consume_token( string $token ): ?int {
			if ( '' === $token || strlen( $token ) > 64 || ! ctype_xdigit( $token ) ) {
				return null;
			}

			$transient_key = self::TOKEN_TRANSIENT_PREFIX . $token;
			$user_id       = get_transient( $transient_key );

			if ( false === $user_id ) {
				return null;
			}

			delete_transient( $transient_key );

			$user_id = (int) $user_id;

			return $user_id > 0 ? $user_id : null;
		}
	}
}
