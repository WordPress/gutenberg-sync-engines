<?php
/**
 * WP_Sync_Block_Identity class
 *
 * @package gutenberg
 */

if ( ! class_exists( 'WP_Sync_Block_Identity' ) ) {

	/**
	 * The shared block-identity scheme: every block carries a durable
	 * `metadata.syncId`, and the blocks of a saved post get ids that any
	 * minter can compute on its own.
	 *
	 * Shared by every engine whose blocks carry a syncId (intent-log and
	 * de-rtc), so neither engine depends on the other. The editor-side
	 * stamper (`includes/shared/sync-id.js`) computes the same ids with
	 * WebCrypto; the frozen vectors in `sync-id.json` are the contract
	 * (replayed through `WP_Intent_Log_Planner::genesis_sync_id`, which
	 * delegates here).
	 *
	 * @since n.e.x.t
	 * @access private
	 */
	class WP_Sync_Block_Identity {

		/**
		 * Deterministic genesis syncId:
		 * base64url( sha256( "postId:revisionId:path.join('.')" )[0..16) ).
		 *
		 * @since n.e.x.t
		 *
		 * @param int   $post_id     Post ID.
		 * @param int   $revision_id Revision ID.
		 * @param int[] $path        Block path (child indices from the root).
		 * @return string 22-character base64url syncId.
		 */
		public static function genesis_sync_id( int $post_id, int $revision_id, array $path ): string {
			$input  = $post_id . ':' . $revision_id . ':' . implode( '.', $path );
			$digest = substr( hash( 'sha256', $input, true ), 0, 16 );

			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- Derives the base64url syncId from a binary digest.
			return rtrim( strtr( base64_encode( $digest ), '+/', '-_' ), '=' );
		}
	}
}
