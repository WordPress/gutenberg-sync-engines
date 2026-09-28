<?php
/**
 * PHPUnit bootstrap.
 *
 * These tests exercise the plugin's engines and transports through the
 * collaborative-editing FRAMEWORK (the WP_Sync_* contracts, registries, and
 * REST transport routes that ship in Gutenberg / WordPress core). The
 * framework must therefore load BEFORE this plugin — both are required in on
 * `muplugins_loaded` below. The framework's plugin entry path resolves from,
 * in order: the `WP_SYNC_FRAMEWORK_PLUGIN` env var, a same-named constant, or
 * the plugin's own bundled Gutenberg subtree (`gutenberg/gutenberg.php` at
 * the repo root — the same copy the plugin loads at runtime). Override the
 * env var to point at a different Gutenberg checkout.
 *
 * @package GutenbergSyncEngines
 */

$gse_tests_dir = getenv( 'WP_TESTS_DIR' );
if ( ! $gse_tests_dir ) {
	$gse_tests_dir = getenv( 'WP_PHPUNIT__DIR' );
}
if ( ! $gse_tests_dir ) {
	$gse_tests_dir = '/wordpress-phpunit';
}

require_once $gse_tests_dir . '/includes/functions.php';

// The diagnostics module (request log, session capture) is environment-gated
// in the plugin bootstrap; force it on so its tests behave the same whether
// or not the test environment reports 'local'.
if ( ! defined( 'GUTENBERG_SYNC_ENGINES_DIAGNOSTICS' ) ) {
	define( 'GUTENBERG_SYNC_ENGINES_DIAGNOSTICS', true );
}

tests_add_filter(
	'muplugins_loaded',
	static function () {
		$framework = getenv( 'WP_SYNC_FRAMEWORK_PLUGIN' );
		if ( ! $framework && defined( 'WP_SYNC_FRAMEWORK_PLUGIN' ) ) {
			$framework = WP_SYNC_FRAMEWORK_PLUGIN;
		}
		if ( ! $framework ) {
			// The plugin's own bundled Gutenberg subtree (also what the
			// plugin entry loads at runtime; requiring it here first keeps
			// the framework-before-plugin order explicit).
			$framework = dirname( __DIR__ ) . '/gutenberg/gutenberg.php';
		}
		if ( $framework && file_exists( $framework ) ) {
			require $framework;
		}
		require dirname( __DIR__ ) . '/gutenberg-sync-engines.php';
		// Test fixture engine (naive opaque relay) used by the transport and
		// registry machinery tests; registered per-test, never in production.
		require __DIR__ . '/phpunit/fixtures/class-test-opaque-relay-engine.php';

		/*
		 * Turn real-time collaboration on for the whole suite. Since
		 * WordPress/gutenberg#80658 the framework gates RTC on the
		 * `gutenberg-real-time-collaboration` experiment (the old
		 * `wp_collaboration_enabled` option is gone), and the gate is
		 * consulted on `init` — when the `wp_sync_storage` post type and the
		 * CRDT post meta register — and again on `rest_api_init` for the
		 * transport routes. That is earlier than any test's set_up, so it has
		 * to happen here. This matches the posture the suite always had: the
		 * old option was registered with a default of true.
		 */
		$gse_experiments = get_option( 'gutenberg-experiments', array() );
		if ( ! is_array( $gse_experiments ) ) {
			$gse_experiments = array();
		}
		$gse_experiments['gutenberg-real-time-collaboration'] = true;
		update_option( 'gutenberg-experiments', $gse_experiments );
	}
);

/*
 * The plugin's storage tables. Activation hooks never fire under PHPUnit,
 * and the WP test installer only recreates WordPress's own tables, so the
 * plugin's tables persist across runs while the options table (with the
 * recorded schema version) does not. The plugin's own upgrade path
 * recreates them on `plugins_loaded`; this runs after it and EMPTIES them,
 * so a row that escaped a previous run's transaction rollback cannot leak
 * into this one (post ids restart at 1 every run, so stale rooms would
 * collide). Outside any test transaction — dbDelta's DDL would commit one.
 */
tests_add_filter(
	'plugins_loaded',
	static function () {
		if ( ! WP_Sync_Table_Schema::install() ) {
			fwrite( STDERR, "Could not create the plugin's storage tables.\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite
			exit( 1 );
		}
		WP_Sync_Table_Schema::delete_all_rows();
	},
	20
);

require $gse_tests_dir . '/includes/bootstrap.php';
