<?php
/**
 * DE-RTC base-version preflight for wp_update_post().
 *
 * @package gutenberg-sync-engines
 */

if ( ! class_exists( 'WP_De_RTC_Base_Version_Preflight' ) ) {
	/**
	 * The cooperating-writer lane:
	 * "The addition of a single argument — base_version — makes it
	 * possible to … incorporate updates from API calls that explicitly
	 * request them to merge instead of replace."
	 *
	 * Any writer going through `wp_update_post()` (WP-CLI, plugins, REST —
	 * mapped from the request's `base_version` param) may pass
	 * `base_version`: the version whose content it read before editing.
	 * The save is then three-way merged through the room's own ingest lane
	 * — claims, per-block salvage, review parking, and attribution all
	 * apply exactly as they do to a browser proposal — and the merged
	 * canonical is what gets saved. A conflict the engine cannot salvage
	 * rejects the write, per the strategy: "your save is rejected if the
	 * document changed under you."
	 *
	 * Hook choreography mirrors the upstream branch's plugin adaptation
	 * (a plugin cannot patch `wp_update_post()` itself):
	 *
	 * - `content_save_pre` (min priority) captures the caller's raw
	 *   content before kses, so a filtered author's markup reaches the
	 *   engine's sequestration lane instead of being silently stripped.
	 * - `wp_insert_post_empty_content` runs the preflight. On rejection
	 *   the caller sees Core's generic `empty_content` error; the rich
	 *   reason is retrievable via `last_error()` (the same limitation the
	 *   upstream adaptation documents).
	 * - `wp_insert_post_data` (priority 10, before the co-location embed
	 *   at 20) replaces the content being saved with the merged canonical.
	 * - `wp_after_insert_post` clears any leftover per-request state.
	 */
	class WP_De_RTC_Base_Version_Preflight {

		/**
		 * Client id attributed to base-version writers in room rows
		 * (distinct from SERVER_CLIENT_ID; the user id rides the row's
		 * author attribution as with any ingest).
		 */
		const WRITER_CLIENT_ID = 2000000002;

		/**
		 * Raw content captured before kses, slashed. Null when none.
		 *
		 * @var string|null
		 */
		private static $raw_content = null;

		/**
		 * Merged canonical awaiting the data filter, keyed by post ID.
		 *
		 * @var array<int, string>
		 */
		private static $merged_content = array();

		/**
		 * The last preflight rejection, for callers that got Core's
		 * generic error.
		 *
		 * @var WP_Error|null
		 */
		private static $last_error = null;

		/**
		 * Hooks the preflight.
		 *
		 * @since 0.5.0
		 *
		 * @return void
		 */
		public static function register(): void {
			add_filter( 'content_save_pre', array( __CLASS__, 'capture_raw_content' ), -999999 );
			add_filter( 'wp_insert_post_empty_content', array( __CLASS__, 'preflight' ), 10, 2 );
			add_filter( 'wp_insert_post_data', array( __CLASS__, 'apply_merged_content' ), 10, 2 );
			add_action( 'wp_after_insert_post', array( __CLASS__, 'cleanup' ) );
			foreach ( array( 'post', 'page' ) as $type ) {
				add_filter( "rest_pre_insert_{$type}", array( __CLASS__, 'map_rest_base_version' ), 10, 2 );
			}
		}

		/**
		 * The last DE-RTC rejection produced by the preflight, or null.
		 *
		 * @since 0.5.0
		 *
		 * @return WP_Error|null Rejection reason.
		 */
		public static function last_error(): ?WP_Error {
			return self::$last_error;
		}

		/**
		 * Captures raw content before kses (see class docblock).
		 *
		 * @since 0.5.0
		 *
		 * @param string $content Slashed, unsanitized content.
		 * @return string The content, unchanged.
		 */
		public static function capture_raw_content( $content ) {
			self::$raw_content = is_string( $content ) ? $content : null;
			return $content;
		}

		/**
		 * Maps a REST request's `base_version` param onto the prepared
		 * post so it reaches `wp_update_post()`'s postarr.
		 *
		 * @since 0.5.0
		 *
		 * @param stdClass        $prepared Prepared post object.
		 * @param WP_REST_Request $request  Request.
		 * @return stdClass Prepared post.
		 */
		public static function map_rest_base_version( $prepared, $request ) {
			$base_version = $request['base_version'] ?? null;
			if ( is_string( $base_version ) && '' !== $base_version ) {
				$prepared->base_version = $base_version;
			}
			return $prepared;
		}

		/**
		 * Runs the merge for saves carrying `base_version`.
		 *
		 * @since 0.5.0
		 *
		 * @param bool  $maybe_empty Whether the post is considered empty.
		 * @param array $postarr     Slashed, sanitized post data.
		 * @return bool True aborts the write.
		 */
		public static function preflight( $maybe_empty, $postarr ) {
			$raw               = self::$raw_content;
			self::$raw_content = null; // Only valid for this invocation.

			if ( $maybe_empty || ! is_array( $postarr ) || empty( $postarr['base_version'] ) || ! is_string( $postarr['base_version'] ) ) {
				return $maybe_empty;
			}
			$post_id = isset( $postarr['ID'] ) ? (int) $postarr['ID'] : 0;
			if ( $post_id <= 0 || ! interface_exists( 'WP_Sync_Storage' ) ) {
				return $maybe_empty;
			}

			self::$last_error = null;

			$post_type = isset( $postarr['post_type'] ) ? (string) $postarr['post_type'] : (string) get_post_type( $post_id );
			$room      = 'postType/' . $post_type . ':' . $post_id;

			// The room must exist with de-rtc lineage — a base_version save
			// against a roomless post has nothing to merge with. The
			// NON-creating lookup matters twice over: the framework
			// storage's own lookups create storage posts, and lazily
			// initializing a room from the CURRENT post would make every
			// base version resolve trivially.
			if ( null === WP_De_RTC_Sync_Meta_Colocation::room_doc_state( $room ) ) {
				self::$last_error = new WP_Error(
					'de_rtc_base_version_no_room',
					__( 'This post has no Distributed Editing room to merge with.', 'gutenberg' ),
					array( 'status' => 409 )
				);
				return true;
			}

			$engine  = new WP_De_RTC_Engine( gutenberg_sync_engines_storage() );
			$content = null !== $raw
				? (string) wp_unslash( $raw )
				: (string) wp_unslash( $postarr['post_content'] ?? '' );

			// A round-tripping writer may carry an embedded sync-meta block;
			// the proposal content is the document alone.
			if ( function_exists( 'wp_de_rtc_count_post_content_sync_meta_scripts' ) && wp_de_rtc_count_post_content_sync_meta_scripts( $content ) > 0 ) {
				$parsed = wp_de_rtc_parse_post_content_sync_meta( $content, array( 'allow_script_stripped_sync_meta' => true ) );
				if ( is_array( $parsed ) && is_string( $parsed['content'] ?? null ) ) {
					$content = $parsed['content'];
				}
			}

			$result = $engine->handle_updates(
				$room,
				self::WRITER_CLIENT_ID,
				0,
				array(
					array(
						'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
						'data' => wp_json_encode(
							array(
								'proposalId'      => 'save-' . md5( $content . '|' . $postarr['base_version'] ),
								'baseVersion'     => (string) $postarr['base_version'],
								'proposedContent' => $content,
								'clientUpdate'    => null,
							)
						),
					),
				),
				array()
			);

			if ( is_wp_error( $result ) ) {
				self::$last_error = $result; // Retryable contention (503).
				return true;
			}

			$disposition = $result['dispositions'][0] ?? array();
			$status      = $disposition['status'] ?? '';

			if ( 'applied' === $status ) {
				$merged = $engine->materialize( $room );
				if ( is_string( $merged ) ) {
					self::$merged_content[ $post_id ] = $merged;
				}
				return $maybe_empty;
			}

			if ( 'escalated' === $status ) {
				// The engine parked the conflicting save for review; the
				// write itself is rejected so the caller knows the document
				// changed under it ("halt the save and surface the
				// conflict").
				self::$last_error = new WP_Error(
					'de_rtc_base_version_conflict',
					__( 'Distributed Editing could not merge this save: the document changed under the given base version. The conflicting content was set aside for review.', 'gutenberg' ),
					array(
						'status'      => 409,
						'disposition' => $disposition,
					)
				);
				return true;
			}

			self::$last_error = new WP_Error(
				'de_rtc_base_version_stale',
				__( 'Distributed Editing rejected this save: the given base version is unknown. Re-read the post and retry against its current version.', 'gutenberg' ),
				array(
					'status'      => 409,
					'disposition' => $disposition,
				)
			);
			return true;
		}

		/**
		 * Replaces the content being saved with the merged canonical.
		 *
		 * @since 0.5.0
		 *
		 * @param array $data    Slashed post data about to be saved.
		 * @param array $postarr Raw post array.
		 * @return array Post data.
		 */
		public static function apply_merged_content( array $data, array $postarr ): array {
			$post_id = isset( $postarr['ID'] ) ? (int) $postarr['ID'] : 0;
			if ( $post_id > 0 && isset( self::$merged_content[ $post_id ] ) ) {
				$data['post_content'] = wp_slash( self::$merged_content[ $post_id ] );
				unset( self::$merged_content[ $post_id ] );
			}
			return $data;
		}

		/**
		 * Clears leftover per-request state after a save completes.
		 *
		 * @since 0.5.0
		 *
		 * @return void
		 */
		public static function cleanup(): void {
			self::$raw_content    = null;
			self::$merged_content = array();
		}
	}
}
