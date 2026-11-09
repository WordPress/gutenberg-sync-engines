<?php
/**
 * WP_De_RTC_Review_Controller class
 *
 * @package GutenbergSyncEngines
 */

if ( ! class_exists( 'WP_De_RTC_Review_Controller' ) ) {

	/**
	 * The de-rtc REST review lane (B5): review RESOLUTIONS are mutations,
	 * and mutations do not belong on the advisory transport. This route is
	 * the ONLY way clients send them (the engine rejects client-sent
	 * resolution rows); the stamped `resolved` row the engine appends
	 * still broadcasts to peers through the ordinary transport rows.
	 *
	 * @since 0.3.0
	 */
	final class WP_De_RTC_Review_Controller {
		/**
		 * Registers the route. Hook on `rest_api_init`.
		 *
		 * @since 0.3.0
		 *
		 * @return void
		 */
		public function register_routes(): void {
			register_rest_route(
				'wp-sync/v1',
				'/de-rtc/resolve',
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'resolve' ),
					'permission_callback' => array( $this, 'check_permissions' ),
					'args'                => array(
						'room'        => array(
							'type'     => 'string',
							'required' => true,
						),
						'proposalId'  => array(
							'type'     => 'string',
							'required' => true,
						),
						'resolution'  => array(
							'type'     => 'string',
							'required' => true,
							'enum'     => array( 'restored', 'dismissed', 'accepted' ),
						),
						'content'     => array(
							'type'        => 'string',
							'description' => 'The replacement content of an accepted resolution (serialized blocks, or the property value).',
						),
						'client_id'   => array(
							'type'    => 'integer',
							'default' => 0,
						),
						'seenVersion' => array(
							'type'        => 'string',
							'description' => 'The version the reviewer saw when they accepted. The accepted content is refused with a 409 (review_stale) when the parked blocks have changed since that version.',
						),
					),
				)
			);
		}

		/**
		 * Mirrors the sync transports' gate: the user must be able to edit
		 * the post the room belongs to, not just posts in general. An
		 * accepted resolution writes content into that post's room.
		 *
		 * @since 0.3.0
		 * @since n.e.x.t Checks the room's post, as the transports do.
		 *
		 * @param WP_REST_Request $request Request.
		 * @return true|WP_Error True when the current user may resolve review items in the room.
		 */
		public function check_permissions( WP_REST_Request $request ) {
			return WP_Sync_Review_Permissions::check_room( (string) $request['room'] );
		}

		/**
		 * Resolves one parked proposal.
		 *
		 * @since 0.3.0
		 *
		 * @param WP_REST_Request $request Request.
		 * @return WP_REST_Response|WP_Error Disposition envelope or error.
		 */
		public function resolve( WP_REST_Request $request ) {
			$room = (string) $request['room'];

			$storage = gutenberg_sync_engines_storage();
			$lineage = $storage->get_room_engine( $room );
			if ( null !== $lineage && WP_De_RTC_Engine::SLUG !== $lineage ) {
				// The same fence the transport applies: a resolution from a
				// tab speaking another engine must not mutate this room.
				return new WP_Error(
					'rest_sync_engine_mismatch',
					__( 'This room is not a Distributed Editing room.', 'gutenberg-sync-engines' ),
					array( 'status' => 409 )
				);
			}

			$engine      = new WP_De_RTC_Engine( $storage );
			$disposition = $engine->resolve_proposal(
				$room,
				(string) $request['proposalId'],
				(string) $request['resolution'],
				(int) $request['client_id'],
				isset( $request['content'] ) ? (string) $request['content'] : null,
				isset( $request['seenVersion'] ) ? (string) $request['seenVersion'] : null
			);
			if ( is_wp_error( $disposition ) ) {
				return $disposition;
			}

			return rest_ensure_response( array( 'disposition' => $disposition ) );
		}
	}
}
