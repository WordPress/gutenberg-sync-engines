<?php
/**
 * Authoring-profile registry: resolves the profile the runner uses to
 * speak to an engine, by engine slug.
 *
 * Mirrors the engine registry's extension seam: this plugin maps its own
 * engines to their dedicated profiles, and a third-party engine plugin can
 * register a profile for its slug through the
 * `wp_sync_bench_authoring_profiles` filter. An engine with no profile
 * gets the opaque-relay fallback — meaningful for relay-style engines,
 * honest about everything else (unobservable quality; an engine that
 * rejects the generic updates shows it in the dispositions/storage
 * counts).
 *
 * @package gutenberg
 */

if ( ! class_exists( 'WP_Sync_Bench_Profiles' ) ) {
	require_once __DIR__ . '/class-wp-sync-bench-workload.php';
	require_once __DIR__ . '/interface-wp-sync-bench-authoring-profile.php';
	require_once __DIR__ . '/class-wp-sync-bench-intent-log-profile.php';
	require_once __DIR__ . '/class-wp-sync-bench-yjs-server-profile.php';
	require_once __DIR__ . '/class-wp-sync-bench-opaque-relay-profile.php';

	/**
	 * Resolves authoring profiles by engine slug.
	 */
	class WP_Sync_Bench_Profiles {
		/**
		 * Builds the authoring profile for an engine slug.
		 *
		 * @param string $engine_slug Engine slug (registry slug).
		 * @param int    $post_id     Seeded post (room target).
		 * @param array  $workload    Workload from the generator.
		 * @return WP_Sync_Bench_Authoring_Profile Profile instance.
		 */
		public static function for_engine( string $engine_slug, int $post_id, array $workload ): WP_Sync_Bench_Authoring_Profile {
			$profiles = array(
				'intent-log' => WP_Sync_Bench_Intent_Log_Profile::class,
				'yjs-server' => WP_Sync_Bench_Yjs_Server_Profile::class,
			);

			/**
			 * Filters the engine-slug => profile-class map, so an engine
			 * plugin can ship the authoring profile that speaks its wire
			 * vocabulary (constructed as `new $class( $post_id, $workload )`;
			 * see the interface's docblock for the contract).
			 *
			 * @param array<string, class-string> $profiles Slug => class map.
			 */
			$profiles = apply_filters( 'wp_sync_bench_authoring_profiles', $profiles );

			$profile_class = $profiles[ $engine_slug ] ?? WP_Sync_Bench_Opaque_Relay_Profile::class;
			if ( ! is_string( $profile_class )
				|| ! class_exists( $profile_class )
				|| ! in_array( WP_Sync_Bench_Authoring_Profile::class, (array) class_implements( $profile_class ), true )
			) {
				// A broken registration must not fake a dedicated profile.
				$profile_class = WP_Sync_Bench_Opaque_Relay_Profile::class;
			}

			return new $profile_class( $post_id, $workload );
		}
	}
}
