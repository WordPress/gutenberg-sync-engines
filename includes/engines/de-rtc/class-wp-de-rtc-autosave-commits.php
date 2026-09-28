<?php
/**
 * DE-RTC commit lane on the REST autosave endpoint.
 *
 * @package gutenberg-sync-engines
 */

if ( ! class_exists( 'WP_De_RTC_Autosave_Commits' ) ) {
	/**
	 * The Save/Sync inversion's commit carrier: de-rtc sessions commit
	 * through the ordinary WordPress autosave endpoint instead of
	 * transport rows — "Save is the only commit primitive … wp_update_post
	 * / REST, autosaves included", "Pseudo-realtime is a save/autosave
	 * cadence dial, not a second commit channel". The transport is left
	 * fully advisory for documents: announces, on-demand snapshots, review
	 * rows, presence.
	 *
	 * A POST to `/wp/v2/(posts|pages)/<id>/autosaves` carrying the
	 * commit shape (`proposal_id` + `base_version` + `proposed_content`
	 * + `client_id`) short-circuits into the room's ingest lane — the
	 * SAME merge the transport proposals used and the base-version save
	 * preflight uses: claims, kses sequestration, per-block salvage,
	 * review parking, announce rows, attribution. The response returns
	 * the dispositions plus every room row this commit appended, in row
	 * order, so the session can settle exactly as if the rows arrived on
	 * a poll (rows first, dispositions after — the provider's own
	 * ordering contract).
	 *
	 * Editor-native autosaves (no commit shape) pass through untouched:
	 * two users of one route, distinguished by params. Real saves keep
	 * merging via WP_De_RTC_Base_Version_Preflight.
	 */
	class WP_De_RTC_Autosave_Commits {

		/**
		 * Hooks the commit lane.
		 *
		 * @since 0.6.0
		 *
		 * @return void
		 */
		public static function register(): void {
			add_filter( 'rest_pre_dispatch', array( __CLASS__, 'maybe_commit' ), 10, 3 );
		}

		/**
		 * Intercepts autosave requests carrying the de-rtc commit shape.
		 *
		 * @since 0.6.0
		 *
		 * @param mixed           $result  Dispatch short-circuit value.
		 * @param WP_REST_Server  $server  REST server.
		 * @param WP_REST_Request $request Current request.
		 * @return mixed Original value, or the commit response.
		 */
		public static function maybe_commit( $result, $server, $request ) { // phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- $server is part of the filter contract.
			if ( null !== $result || ! ( $request instanceof WP_REST_Request ) || 'POST' !== $request->get_method() ) {
				return $result;
			}
			if ( ! preg_match( '#^/wp/v2/(?:posts|pages)/(?P<id>\d+)/autosaves$#', (string) $request->get_route(), $matches ) ) {
				return $result;
			}

			$proposal_id  = $request->get_param( 'proposal_id' );
			$base_version = $request->get_param( 'base_version' );
			$content      = $request->get_param( 'proposed_content' );
			$client_id    = $request->get_param( 'client_id' );
			if (
				! is_string( $proposal_id ) || '' === $proposal_id ||
				! is_string( $base_version ) || '' === $base_version ||
				! is_string( $content ) ||
				! is_numeric( $client_id )
			) {
				return $result; // Not a commit: core's autosave handles it.
			}

			$post_id = (int) $matches['id'];
			$post    = get_post( $post_id );
			if ( ! $post instanceof WP_Post ) {
				return new WP_Error( 'rest_post_invalid_id', __( 'Invalid post ID.', 'gutenberg' ), array( 'status' => 404 ) );
			}
			if ( ! current_user_can( 'edit_post', $post_id ) ) {
				return new WP_Error( 'rest_cannot_edit', __( 'Sorry, you are not allowed to edit this post.', 'gutenberg' ), array( 'status' => rest_authorization_required_code() ) );
			}
			if ( ! function_exists( 'wp_is_collaboration_enabled' ) || ! wp_is_collaboration_enabled() ) {
				return new WP_Error( 'rest_sync_disabled', __( 'Collaboration is not enabled.', 'gutenberg' ), array( 'status' => 403 ) );
			}
			if ( ! interface_exists( 'WP_Sync_Storage' ) || ! class_exists( 'WP_De_RTC_Engine' ) ) {
				return $result;
			}

			$room = 'postType/' . $post->post_type . ':' . $post_id;

			// The room must already exist with de-rtc lineage (the session
			// only commits after bootstrap, so this is a hard error, not a
			// race). Non-creating lookup, like the save preflight.
			if ( null === WP_De_RTC_Sync_Meta_Colocation::room_doc_state( $room ) ) {
				return new WP_Error(
					'de_rtc_commit_no_room',
					__( 'This post has no Distributed Editing room to commit into.', 'gutenberg' ),
					array( 'status' => 409 )
				);
			}

			$engine    = new WP_De_RTC_Engine( gutenberg_sync_engines_storage() );
			$client_id = (int) $client_id;

			// Rows appended by THIS commit come back in the response: mark
			// the cursor first (an empty far-cursor read refreshes the
			// storage's per-request cursor cache without fetching rows).
			$before = $engine->get_updates_since( $room, $client_id, PHP_INT_MAX, array() );
			$cursor = (int) ( $before['end_cursor'] ?? 0 );

			$properties    = $request->get_param( 'proposed_properties' );
			$client_update = $request->get_param( 'client_update' );
			$block_bases   = $request->get_param( 'block_base_versions' );

			$ingest = $engine->handle_updates(
				$room,
				$client_id,
				0,
				array(
					array(
						'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
						'data' => wp_json_encode(
							array(
								'proposalId'         => $proposal_id,
								'baseVersion'        => $base_version,
								'proposedContent'    => $content,
								'proposedProperties' => is_array( $properties ) ? $properties : array(),
								'clientUpdate'       => is_array( $client_update ) ? $client_update : null,
								'blockBaseVersions'  => is_array( $block_bases ) ? $block_bases : null,
							)
						),
					),
				),
				array()
			);
			if ( is_wp_error( $ingest ) ) {
				return $ingest; // Retryable contention (503).
			}

			$after = $engine->get_updates_since( $room, $client_id, $cursor, array() );

			return rest_ensure_response(
				array(
					'dispositions' => $ingest['dispositions'] ?? array(),
					'updates'      => $after['updates'] ?? array(),
					'end_cursor'   => $after['end_cursor'] ?? $cursor,
				)
			);
		}
	}
}
