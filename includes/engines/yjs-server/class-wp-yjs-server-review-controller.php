<?php
/**
 * REST lane for yjs-server security holds.
 *
 * The kses lane sanitizes a filtered author's markup in the canonical
 * document and HOLDS what it stripped (see
 * WP_Yjs_Server_Engine::hold_markup()). Deciding a hold is a mutation, so
 * it travels over this authenticated route rather than the transport,
 * which only carries the announcements.
 *
 * @package gutenberg-sync-engines
 */

if ( ! class_exists( 'WP_Yjs_Server_Review_Controller' ) ) {

	/**
	 * Decides yjs-server security holds.
	 *
	 * @since n.e.x.t
	 */
	final class WP_Yjs_Server_Review_Controller {

		/**
		 * Registers the route.
		 *
		 * @since n.e.x.t
		 *
		 * @return void
		 */
		public function register_routes(): void {
			register_rest_route(
				'wp-sync/v1',
				'/yjs-server/resolve',
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'resolve' ),
					'permission_callback' => array( $this, 'check_permissions' ),
					'args'                => array(
						'room'       => array(
							'type'     => 'string',
							'required' => true,
						),
						'holdId'     => array(
							'type'     => 'string',
							'required' => true,
						),
						'resolution' => array(
							'type'     => 'string',
							'required' => true,
							'enum'     => array( 'accepted', 'dismissed' ),
						),
						'content'    => array(
							'type'        => 'string',
							'description' => 'The replacement content of an accepted hold, as serialized blocks. Omitted, the held markup lands as it was written.',
						),
					),
				)
			);
		}

		/**
		 * Whether the user may decide holds at all. Accepting one needs
		 * the unfiltered_html capability on top; the engine enforces it.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool Whether the request may proceed.
		 */
		public function check_permissions(): bool {
			return current_user_can( 'edit_posts' );
		}

		/**
		 * Decides one hold.
		 *
		 * @since n.e.x.t
		 *
		 * @param WP_REST_Request $request The request.
		 * @return WP_REST_Response|WP_Error The disposition, or an error.
		 */
		public function resolve( WP_REST_Request $request ) {
			$room    = (string) $request['room'];
			$storage = gutenberg_sync_engines_storage();
			$lineage = $storage->get_room_engine( $room );
			if ( null !== $lineage && WP_Yjs_Server_Engine::SLUG !== $lineage ) {
				// The same fence the transport applies: a decision from a
				// tab speaking another engine must not mutate this room.
				return new WP_Error(
					'rest_sync_engine_mismatch',
					__( 'This room is not a yjs-server room.', 'gutenberg-sync-engines' ),
					array( 'status' => 409 )
				);
			}

			$engine      = new WP_Yjs_Server_Engine( $storage );
			$disposition = $engine->resolve_hold(
				$room,
				(string) $request['holdId'],
				(string) $request['resolution'],
				isset( $request['content'] ) ? (string) $request['content'] : null
			);
			if ( is_wp_error( $disposition ) ) {
				return $disposition;
			}

			return rest_ensure_response( array( 'disposition' => $disposition ) );
		}
	}
}
