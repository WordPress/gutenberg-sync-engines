<?php
/**
 * Gutenberg_Sync_Engines_Capture_CLI_Command class
 *
 * @package GutenbergSyncEngines
 */

if ( ! class_exists( 'Gutenberg_Sync_Engines_Capture_CLI_Command' ) && defined( 'WP_CLI' ) && WP_CLI ) {

	/**
	 * Manages collaboration capture sessions: record real editor sessions at
	 * the transport seam and export them as replayable fixtures in the
	 * community capture format (see
	 * Gutenberg_Sync_Engines_Session_Capture). The capture→sanitize→replay
	 * workflow is documented in tests/debugging/replay/README.md.
	 *
	 * A development tool, loaded only where diagnostics are allowed — see
	 * Gutenberg_Sync_Engines_Plugin::load().
	 *
	 * @since 0.4.0
	 */
	final class Gutenberg_Sync_Engines_Capture_CLI_Command {

		/**
		 * Starts a capture session.
		 *
		 * ## OPTIONS
		 *
		 * <session-id>
		 * : Session identifier (1-100 chars of [A-Za-z0-9_-]).
		 *
		 * [--room=<room>]
		 * : Only capture requests touching this room (e.g.
		 * postType/post:42). For post rooms, the post's current title and
		 * content are snapshotted into the export so replay can recreate
		 * the starting document. Omit to capture all rooms.
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration capture start two-editors --room=postType/post:42
		 *
		 * @since 0.4.0
		 *
		 * @param array $args       Positional arguments.
		 * @param array $assoc_args Named arguments.
		 * @return void
		 */
		public function start( $args, $assoc_args ) {
			$result = Gutenberg_Sync_Engines_Session_Capture::start(
				(string) $args[0],
				(string) ( $assoc_args['room'] ?? '' )
			);
			if ( is_wp_error( $result ) ) {
				WP_CLI::error( $result->get_error_message() );
			}
			WP_CLI::log( "Capturing session \"{$result['session_id']}\" (engine {$result['engine']}, transport {$result['transport']})." );
			if ( '' !== $result['room_filter'] ) {
				WP_CLI::log( "Room filter: {$result['room_filter']}" );
			}
			WP_CLI::log( 'Open editor windows and collaborate, then: wp collaboration capture stop' );
		}

		/**
		 * Stops the active capture session.
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration capture stop
		 *
		 * @since 0.4.0
		 *
		 * @return void
		 */
		public function stop() {
			$result = Gutenberg_Sync_Engines_Session_Capture::stop();
			if ( is_wp_error( $result ) ) {
				WP_CLI::error( $result->get_error_message() );
			}
			WP_CLI::success( "Captured {$result['frames']} frames for session \"{$result['session_id']}\"." );
			WP_CLI::log( "Export: wp collaboration capture export {$result['session_id']}" );
		}

		/**
		 * Lists captured sessions.
		 *
		 * ## OPTIONS
		 *
		 * [--format=<format>]
		 * : Output format: table, json, csv, yaml, count.
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration capture list
		 *
		 * @subcommand list
		 *
		 * @since 0.4.0
		 *
		 * @param array $args       Positional arguments (unused).
		 * @param array $assoc_args Named arguments.
		 * @return void
		 */
		public function list_sessions( $args, $assoc_args ) { // phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- $args is part of the WP-CLI command signature.
			$sessions = Gutenberg_Sync_Engines_Session_Capture::sessions();
			if ( array() === $sessions ) {
				WP_CLI::log( 'No captured sessions.' );
				return;
			}
			WP_CLI\Utils\format_items(
				$assoc_args['format'] ?? 'table',
				$sessions,
				array( 'session_id', 'frames', 'duration_ms', 'engine', 'transport', 'room', 'active' )
			);
		}

		/**
		 * Exports one session as a replay fixture (community capture-export
		 * JSON) on stdout.
		 *
		 * The raw export contains document content and user awareness
		 * (names, colors); sanitize before sharing:
		 * node tests/debugging/replay/sanitize.mjs <fixture.json>.
		 *
		 * ## OPTIONS
		 *
		 * <session-id>
		 * : Session to export.
		 *
		 * [--pretty]
		 * : Pretty-print the JSON.
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration capture export two-editors > fixture.json
		 *
		 * @since 0.4.0
		 *
		 * @param array $args       Positional arguments.
		 * @param array $assoc_args Named arguments.
		 * @return void
		 */
		public function export( $args, $assoc_args ) {
			$fixture = Gutenberg_Sync_Engines_Session_Capture::export( (string) $args[0] );
			if ( null === $fixture ) {
				WP_CLI::error( "Session \"{$args[0]}\" not found or has no frames." );
			}
			$flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
			if ( isset( $assoc_args['pretty'] ) ) {
				$flags |= JSON_PRETTY_PRINT;
			}
			WP_CLI::line( (string) wp_json_encode( $fixture, $flags ) );
		}

		/**
		 * Deletes one session's frames, or all sessions'.
		 *
		 * ## OPTIONS
		 *
		 * [<session-id>]
		 * : Session to drop.
		 *
		 * [--all]
		 * : Drop every captured session.
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration capture drop two-editors
		 *     wp collaboration capture drop --all
		 *
		 * @since 0.4.0
		 *
		 * @param array $args       Positional arguments.
		 * @param array $assoc_args Named arguments.
		 * @return void
		 */
		public function drop( $args, $assoc_args ) {
			$all        = isset( $assoc_args['all'] );
			$session_id = isset( $args[0] ) ? (string) $args[0] : null;
			$targets    = ( $all ? 1 : 0 ) + ( null !== $session_id ? 1 : 0 );
			if ( 1 !== $targets ) {
				WP_CLI::error( 'Pass exactly one of <session-id> or --all.' );
			}
			$deleted = Gutenberg_Sync_Engines_Session_Capture::drop( $all ? null : $session_id );
			WP_CLI::success( "Deleted {$deleted} frames." );
		}
	}

	WP_CLI::add_command( 'collaboration capture', 'Gutenberg_Sync_Engines_Capture_CLI_Command' );
}
