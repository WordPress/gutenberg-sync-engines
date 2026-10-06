<?php
/**
 * WP_Sync_Review_Permissions class
 *
 * @package gutenberg-sync-engines
 */

if ( ! class_exists( 'WP_Sync_Review_Permissions' ) ) {

	/**
	 * The permission check shared by every engine's REST review route.
	 *
	 * A review decision changes a room, and an accepted one writes content
	 * into it. So a review route must ask what the sync transports ask:
	 * may this user edit the thing the room belongs to? The general
	 * `edit_posts` capability alone is not enough. A Contributor has it,
	 * and could otherwise decide review items on any post by naming its
	 * room. The check lives here so the routes cannot drift apart.
	 *
	 * @since n.e.x.t
	 */
	final class WP_Sync_Review_Permissions {

		/**
		 * Whether the current user may decide review items in a room.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room Room identifier, e.g. `postType/post:100`.
		 * @return true|WP_Error True when allowed, otherwise the error to answer with.
		 */
		public static function check_room( string $room ) {
			if ( ! current_user_can( 'edit_posts' ) ) {
				return self::forbidden();
			}

			$parsed = WP_Sync_Config::parse_room( $room );
			if ( null === $parsed ) {
				return new WP_Error(
					'rest_invalid_param',
					__( 'The room name is not valid.', 'gutenberg-sync-engines' ),
					array( 'status' => 400 )
				);
			}

			// The same per-room rule as the sync transports: `edit_post` on
			// the room's post, and the post must be of the type the room names.
			if ( ! WP_Sync_Config::can_user_sync_entity_type( $parsed['entity_kind'], $parsed['entity_name'], $parsed['object_id'] ) ) {
				return self::forbidden();
			}

			return true;
		}

		/**
		 * The answer for a user who may not review in the room.
		 *
		 * @since n.e.x.t
		 *
		 * @return WP_Error The error.
		 */
		private static function forbidden(): WP_Error {
			return new WP_Error(
				'rest_cannot_edit',
				__( 'You do not have permission to review changes in this room.', 'gutenberg-sync-engines' ),
				array( 'status' => rest_authorization_required_code() )
			);
		}
	}
}
