<?php
/**
 * Gutenberg_Sync_Engines_Session_Capture class
 *
 * @package GutenbergSyncEngines
 */

if ( ! class_exists( 'Gutenberg_Sync_Engines_Session_Capture' ) ) {

	/**
	 * Records real collaboration sessions at the transport seam: while a
	 * capture session is active, every `/wp-sync/` REST request (optionally
	 * filtered to one room) is stored as a frame — arrival time, client id,
	 * request body, response body. Frames export as the community RTC
	 * performance harness's capture fixture format
	 * (WordPress/distributed-rtc-performance-testing `capture-export`), so
	 * its replay tooling and this repo's `tests/debugging/replay/` tools
	 * both consume them:
	 *
	 *     {
	 *       "session_id":  "...",
	 *       "frame_count": N,
	 *       "frames": [ {
	 *         "n": 1, "elapsed_ms": 123.4, "client_id": 10001,
	 *         "room": "postType/post:42",
	 *         "request":  { "rooms": [ ... ] },
	 *         "response": { ... }
	 *       } ]
	 *     }
	 *
	 * plus additive top-level keys the community format does not carry (and
	 * its sanitizer simply drops): `engine`, `transport`, `base_title`, and
	 * `base_content` — the post state when capture started, which replay
	 * needs to recreate a faithful starting document for engines that
	 * validate against server state (all of this plugin's engines do; the
	 * community harness's relay endpoint did not).
	 *
	 * Raw frames contain document content and user awareness (names,
	 * colors). Sanitize before sharing a fixture —
	 * `tests/debugging/replay/sanitize.mjs` mirrors the community
	 * harness's sanitizer.
	 *
	 * Driven by `wp collaboration capture` (see
	 * Gutenberg_Sync_Engines_Capture_CLI_Command). This file only loads on
	 * local/development sites (or under the
	 * GUTENBERG_SYNC_ENGINES_DIAGNOSTICS constant) — see
	 * Gutenberg_Sync_Engines_Plugin::load().
	 *
	 * @since 0.4.0
	 */
	final class Gutenberg_Sync_Engines_Session_Capture {

		/**
		 * Frames table schema version.
		 *
		 * @since 0.4.0
		 * @var string
		 */
		const DB_VERSION = '1';

		/**
		 * Option holding the installed schema version.
		 *
		 * @since 0.4.0
		 * @var string
		 */
		const DB_VERSION_OPTION = 'gutenberg_sync_engines_capture_db_version';

		/**
		 * Option holding the active capture session id ('' = none).
		 * Autoloaded while a session is active so per-request overhead is a
		 * cache read.
		 *
		 * @since 0.4.0
		 * @var string
		 */
		const SESSION_OPTION = 'gutenberg_sync_engines_capture_session';

		/**
		 * Option holding the active session's start time (microseconds).
		 *
		 * @since 0.4.0
		 * @var string
		 */
		const STARTED_OPTION = 'gutenberg_sync_engines_capture_started_us';

		/**
		 * Option holding the active session's room filter ('' = all rooms).
		 *
		 * @since 0.4.0
		 * @var string
		 */
		const ROOM_FILTER_OPTION = 'gutenberg_sync_engines_capture_room_filter';

		/**
		 * Option holding per-session export metadata (engine, transport,
		 * base post state), keyed by session id.
		 *
		 * @since 0.4.0
		 * @var string
		 */
		const META_OPTION = 'gutenberg_sync_engines_capture_meta';

		/**
		 * In-flight frame state captured at pre-dispatch, or null.
		 *
		 * @since 0.4.0
		 * @var array|null
		 */
		private $pending = null;

		/**
		 * Whether an instance has hooked the filters (double registration
		 * would record every frame twice).
		 *
		 * @since 0.4.0
		 * @var bool
		 */
		private static $registered = false;

		/**
		 * Hooks the frame-recording filters. Idempotent: only the first
		 * instance registers.
		 *
		 * @since 0.4.0
		 *
		 * @return void
		 */
		public function register(): void {
			if ( self::$registered ) {
				return;
			}
			self::$registered = true;
			add_filter( 'rest_pre_dispatch', array( $this, 'pre_dispatch' ), 5, 3 );
			add_filter( 'rest_post_dispatch', array( $this, 'post_dispatch' ), 99, 3 );
		}

		/**
		 * The frames table name.
		 *
		 * @since 0.4.0
		 *
		 * @return string Table name.
		 */
		public static function table(): string {
			global $wpdb;
			return $wpdb->prefix . 'sync_capture_frames';
		}

		/**
		 * Creates the frames table when missing or outdated.
		 *
		 * @since 0.4.0
		 *
		 * @return void
		 */
		public static function ensure_table(): void {
			global $wpdb;
			$table = self::table();

			if ( get_option( self::DB_VERSION_OPTION ) === self::DB_VERSION ) {
				// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- Schema spot-check on a diagnostics-only table.
				if ( null !== $wpdb->get_var( "SHOW COLUMNS FROM `{$table}` LIKE 'elapsed_ms'" ) ) {
					return;
				}
			}

			$charset_collate = $wpdb->get_charset_collate();
			// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- Direct CREATE TABLE on a diagnostics-only table.
			$wpdb->query(
				"CREATE TABLE IF NOT EXISTS `{$table}` (
					id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
					session_id varchar(100) NOT NULL DEFAULT '',
					ts_us bigint(20) NOT NULL DEFAULT 0,
					elapsed_ms float NOT NULL DEFAULT 0,
					client_id bigint(20) NOT NULL DEFAULT 0,
					room varchar(200) NOT NULL DEFAULT '',
					request_body longtext NOT NULL,
					response_body longtext NOT NULL,
					PRIMARY KEY (id),
					KEY session_id (session_id)
				) {$charset_collate}"
			);
			// phpcs:enable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.SchemaChange, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			update_option( self::DB_VERSION_OPTION, self::DB_VERSION, true );
		}

		/**
		 * Snapshots the request when a capture session is active and the
		 * request matches the room filter.
		 *
		 * @since 0.4.0
		 *
		 * @param mixed           $result  Dispatch short-circuit value.
		 * @param WP_REST_Server  $server  REST server (unused).
		 * @param WP_REST_Request $request Request being dispatched.
		 * @return mixed Unmodified $result.
		 */
		public function pre_dispatch( $result, $server, $request ) {
			if ( false === strpos( $request->get_route(), '/wp-sync/' ) ) {
				return $result;
			}

			$session = (string) get_option( self::SESSION_OPTION, '' );
			if ( '' === $session ) {
				return $result;
			}

			$rooms = $request->get_param( 'rooms' );
			if ( ! is_array( $rooms ) || array() === $rooms ) {
				return $result;
			}

			$room_filter = (string) get_option( self::ROOM_FILTER_OPTION, '' );
			$frame_room  = null;
			foreach ( $rooms as $room ) {
				$name = isset( $room['room'] ) ? (string) $room['room'] : '';
				if ( '' === $room_filter || $name === $room_filter ) {
					$frame_room = $room;
					break;
				}
			}
			if ( null === $frame_room ) {
				return $result;
			}

			$body = (string) $request->get_body();
			if ( '' === $body ) {
				// Requests dispatched without a raw body (tests, internal
				// dispatch): reconstruct the JSON the wire would carry.
				$body = (string) wp_json_encode( array( 'rooms' => $rooms ) );
			}

			$this->pending = array(
				'session_id' => $session,
				'ts_us'      => (int) round( microtime( true ) * 1000000 ),
				'started_us' => (int) get_option( self::STARTED_OPTION, 0 ),
				'client_id'  => isset( $frame_room['client_id'] ) ? (int) $frame_room['client_id'] : 0,
				'room'       => isset( $frame_room['room'] ) ? (string) $frame_room['room'] : '',
				'body'       => $body,
			);

			return $result;
		}

		/**
		 * Stores the frame after dispatch.
		 *
		 * @since 0.4.0
		 *
		 * @param WP_REST_Response $response Dispatched response.
		 * @param WP_REST_Server   $server   REST server (unused).
		 * @param WP_REST_Request  $request  Request (unused).
		 * @return WP_REST_Response Unmodified response.
		 */
		public function post_dispatch( $response, $server, $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter.FoundAfterLastUsed -- Filter signature.
			if ( null === $this->pending || ! $response instanceof WP_REST_Response ) {
				return $response;
			}

			global $wpdb;
			$pending       = $this->pending;
			$this->pending = null;

			self::ensure_table();
			$elapsed_ms = $pending['started_us'] > 0
				? round( ( $pending['ts_us'] - $pending['started_us'] ) / 1000, 2 )
				: 0.0;

			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery -- Diagnostics-only table.
			$wpdb->insert(
				self::table(),
				array(
					'session_id'    => $pending['session_id'],
					'ts_us'         => $pending['ts_us'],
					'elapsed_ms'    => $elapsed_ms,
					'client_id'     => $pending['client_id'],
					'room'          => $pending['room'],
					'request_body'  => $pending['body'],
					'response_body' => (string) wp_json_encode( $response->get_data() ),
				),
				array( '%s', '%d', '%f', '%d', '%s', '%s', '%s' )
			);

			return $response;
		}

		// -----------------------------------------------------------------
		// Session control (consumed by the WP-CLI command)
		// -----------------------------------------------------------------

		/**
		 * Starts a capture session, snapshotting the engine/transport
		 * configuration and — when the room filter names a post room — the
		 * post's base state, all of which export alongside the frames.
		 *
		 * @since 0.4.0
		 *
		 * @param string $session_id  Session identifier ([A-Za-z0-9_-]).
		 * @param string $room_filter Room to capture ('' = all rooms).
		 * @return array|WP_Error Session descriptor, or error when one is
		 *                        already active or the id is invalid.
		 */
		public static function start( string $session_id, string $room_filter = '' ) {
			if ( 1 !== preg_match( '/^[A-Za-z0-9_-]{1,100}$/', $session_id ) ) {
				return new WP_Error( 'invalid_session_id', 'Session ids are 1-100 chars of [A-Za-z0-9_-].' );
			}
			$active = (string) get_option( self::SESSION_OPTION, '' );
			if ( '' !== $active ) {
				return new WP_Error( 'capture_active', "Capture session \"{$active}\" is already active. Stop it first." );
			}

			self::ensure_table();

			$engine = (string) get_option( 'wp_sync_engine', '' );
			if ( '' === $engine && class_exists( 'WP_Sync_Engine_Registry' ) ) {
				$engine = WP_Sync_Engine_Registry::DEFAULT_ENGINE;
			}

			$session_meta = array(
				'engine'       => $engine,
				'transport'    => (string) get_option( 'gutenberg_sync_engines_transport', 'http-polling' ),
				'room'         => $room_filter,
				'base_title'   => '',
				'base_content' => '',
			);
			if ( '' !== $room_filter && class_exists( 'WP_Sync_Config' ) ) {
				$parsed = WP_Sync_Config::parse_room( $room_filter );
				if ( is_array( $parsed ) && 'postType' === ( $parsed['entity_kind'] ?? '' ) && ! empty( $parsed['object_id'] ) ) {
					$post = get_post( (int) $parsed['object_id'] );
					if ( $post instanceof WP_Post ) {
						$session_meta['base_title']   = (string) $post->post_title;
						$session_meta['base_content'] = (string) $post->post_content;
					}
				}
			}

			$all_meta                = self::all_meta();
			$all_meta[ $session_id ] = $session_meta;

			$now_us = (int) round( microtime( true ) * 1000000 );
			update_option( self::SESSION_OPTION, $session_id, true );
			update_option( self::STARTED_OPTION, $now_us, true );
			update_option( self::ROOM_FILTER_OPTION, $room_filter, true );
			update_option( self::META_OPTION, $all_meta, false );

			return array(
				'session_id'  => $session_id,
				'room_filter' => $room_filter,
				'started_us'  => $now_us,
				'engine'      => $session_meta['engine'],
				'transport'   => $session_meta['transport'],
			);
		}

		/**
		 * Stops the active capture session.
		 *
		 * @since 0.4.0
		 *
		 * @return array|WP_Error { session_id, frames }, or error when no
		 *                        session is active.
		 */
		public static function stop() {
			global $wpdb;

			$session = (string) get_option( self::SESSION_OPTION, '' );
			if ( '' === $session ) {
				return new WP_Error( 'no_capture_active', 'No capture session is active.' );
			}

			update_option( self::SESSION_OPTION, '', true );
			update_option( self::ROOM_FILTER_OPTION, '', true );

			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Diagnostics-only table.
			$frames = (int) $wpdb->get_var(
				$wpdb->prepare( 'SELECT COUNT(*) FROM `' . self::table() . '` WHERE session_id = %s', $session ) // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared -- Trusted internal table name.
			);

			return array(
				'session_id' => $session,
				'frames'     => $frames,
			);
		}

		/**
		 * Lists captured sessions.
		 *
		 * @since 0.4.0
		 *
		 * @return array<int, array<string, mixed>> Session summaries.
		 */
		public static function sessions(): array {
			global $wpdb;
			self::ensure_table();

			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Diagnostics-only table.
			$rows = $wpdb->get_results(
				'SELECT session_id, COUNT(*) AS frames, MIN(ts_us) AS first_us, MAX(ts_us) AS last_us FROM `' . self::table() . '` GROUP BY session_id ORDER BY first_us ASC', // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared -- Trusted internal table name.
				ARRAY_A
			);

			$active   = (string) get_option( self::SESSION_OPTION, '' );
			$all_meta = self::all_meta();
			$sessions = array();
			foreach ( $rows as $row ) {
				$session_meta = $all_meta[ $row['session_id'] ] ?? array();
				$sessions[]   = array(
					'session_id'  => $row['session_id'],
					'frames'      => (int) $row['frames'],
					'duration_ms' => (int) round( ( (int) $row['last_us'] - (int) $row['first_us'] ) / 1000 ),
					'engine'      => (string) ( $session_meta['engine'] ?? '' ),
					'transport'   => (string) ( $session_meta['transport'] ?? '' ),
					'room'        => (string) ( $session_meta['room'] ?? '' ),
					'active'      => $row['session_id'] === $active,
				);
			}

			return $sessions;
		}

		/**
		 * Exports one session as the community capture fixture format (see
		 * the class doc block), or null when the session has no frames.
		 *
		 * @since 0.4.0
		 *
		 * @param string $session_id Session to export.
		 * @return array|null Fixture array, or null when not found.
		 */
		public static function export( string $session_id ): ?array {
			global $wpdb;
			self::ensure_table();

			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Diagnostics-only table.
			$rows = $wpdb->get_results(
				$wpdb->prepare( 'SELECT * FROM `' . self::table() . '` WHERE session_id = %s ORDER BY id ASC', $session_id ), // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared -- Trusted internal table name.
				ARRAY_A
			);
			if ( array() === $rows ) {
				return null;
			}

			$frames = array();
			$n      = 1;
			foreach ( $rows as $row ) {
				$frames[] = array(
					'n'          => $n,
					'elapsed_ms' => (float) $row['elapsed_ms'],
					'client_id'  => (int) $row['client_id'],
					'room'       => (string) $row['room'],
					'request'    => json_decode( (string) $row['request_body'], true ) ?? array(),
					'response'   => json_decode( (string) $row['response_body'], true ) ?? array(),
				);
				++$n;
			}

			$all_meta     = self::all_meta();
			$session_meta = $all_meta[ $session_id ] ?? array();

			return array(
				'session_id'   => $session_id,
				'frame_count'  => count( $frames ),
				// Additive keys — the community sanitizer drops them; ours
				// (tests/debugging/replay/sanitize.mjs) preserves them.
				'engine'       => (string) ( $session_meta['engine'] ?? '' ),
				'transport'    => (string) ( $session_meta['transport'] ?? '' ),
				'base_title'   => (string) ( $session_meta['base_title'] ?? '' ),
				'base_content' => (string) ( $session_meta['base_content'] ?? '' ),
				'frames'       => $frames,
			);
		}

		/**
		 * Deletes one session's frames, or every session's.
		 *
		 * @since 0.4.0
		 *
		 * @param string|null $session_id Session to drop, or null for all.
		 * @return int Frames deleted.
		 */
		public static function drop( ?string $session_id ): int {
			global $wpdb;
			self::ensure_table();

			$all_meta = self::all_meta();
			if ( null === $session_id ) {
				// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.NotPrepared -- Diagnostics-only table.
				$deleted  = (int) $wpdb->query( 'DELETE FROM `' . self::table() . '`' );
				$all_meta = array();
			} else {
				// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery -- Diagnostics-only table.
				$deleted = (int) $wpdb->delete( self::table(), array( 'session_id' => $session_id ), array( '%s' ) );
				unset( $all_meta[ $session_id ] );
			}
			update_option( self::META_OPTION, $all_meta, false );

			return $deleted;
		}

		/**
		 * The stored per-session metadata map.
		 *
		 * @since 0.4.0
		 *
		 * @return array<string, array<string, string>> Metadata by session id.
		 */
		private static function all_meta(): array {
			$meta = get_option( self::META_OPTION, array() );
			return is_array( $meta ) ? $meta : array();
		}
	}
}
