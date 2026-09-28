<?php
/**
 * Plugin Name:       Gutenberg Sync Engines
 * Plugin URI:        https://github.com/WordPress/gutenberg
 * Description:       Pluggable real-time collaboration engines and transports for the Gutenberg collaborative-editing framework. Without this plugin active, real-time collaboration is effectively disabled.
 * Requires at least: 6.9
 * Requires PHP:      7.4
 * Version:           0.0.2
 * Author:            WordPress Contributors
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       gutenberg-sync-engines
 *
 * @package GutenbergSyncEngines
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/*
 * The storage schema (table names + create/upgrade/drop) loads before
 * everything else, including the double-mount guard below: the activation
 * hook creates the tables, `uninstall.php` drops them, and neither needs
 * the collaboration framework. The file guards its own class declaration.
 */
require_once __DIR__ . '/includes/storage/class-wp-sync-table-schema.php';

if ( ! function_exists( 'gutenberg_sync_engines_activate' ) ) {
	/**
	 * Sets a site up for collaboration when this plugin is activated:
	 * creates the storage tables and turns the Gutenberg real-time
	 * collaboration experiment on.
	 *
	 * The framework gates real-time collaboration on the
	 * `gutenberg-real-time-collaboration` experiment (the checkbox on the
	 * Gutenberg → Experiments screen), and every fresh site starts with it
	 * off. A site that installs this plugin wants collaboration, so
	 * activation flips the experiment on — once, preserving every other
	 * experiment. The checkbox stays live afterward: turning it off later
	 * is honored until the plugin is activated again.
	 *
	 * The storage tables are per site and are created here (dbDelta, so a
	 * re-activation is harmless). Deactivation leaves them and every
	 * room's rows in place; `uninstall.php` and
	 * `wp collaboration storage drop` are what remove them.
	 *
	 * On a network-wide activation both steps run for every site in the
	 * network, because the option and the tables are per site.
	 *
	 * @since 0.0.1
	 *
	 * @param bool $network_wide Whether the plugin is being activated for
	 *                           the whole network.
	 * @return void
	 */
	function gutenberg_sync_engines_activate( $network_wide = false ) {
		if ( $network_wide && is_multisite() ) {
			WP_Sync_Table_Schema::for_each_site( 'gutenberg_sync_engines_activate_site' );
			return;
		}
		gutenberg_sync_engines_activate_site();
	}
}

if ( ! function_exists( 'gutenberg_sync_engines_activate_site' ) ) {
	/**
	 * The per-site activation steps: storage tables, then the experiment.
	 *
	 * @since 0.0.1
	 *
	 * @return void
	 */
	function gutenberg_sync_engines_activate_site() {
		WP_Sync_Table_Schema::install();
		gutenberg_sync_engines_enable_collaboration_experiment();
	}
}

if ( ! function_exists( 'gutenberg_sync_engines_initialize_site' ) ) {
	/**
	 * Sets up a site created on a network where this plugin is
	 * network-active: the activation hook ran before the site existed, so
	 * its tables and experiment are created here instead. A site on a
	 * network where the plugin is active per site gets them when it
	 * activates the plugin itself.
	 *
	 * @since 0.0.1
	 *
	 * @param WP_Site $new_site The site just created.
	 * @return void
	 */
	function gutenberg_sync_engines_initialize_site( $new_site ) {
		if ( ! function_exists( 'is_plugin_active_for_network' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		if ( ! is_plugin_active_for_network( plugin_basename( __FILE__ ) ) ) {
			return;
		}
		switch_to_blog( (int) $new_site->id );
		gutenberg_sync_engines_activate_site();
		restore_current_blog();
	}
}

if ( ! function_exists( 'gutenberg_sync_engines_enable_collaboration_experiment' ) ) {
	/**
	 * Turns on the `gutenberg-real-time-collaboration` experiment for the
	 * current site, leaving the other experiments as they are.
	 *
	 * @since 0.0.1
	 *
	 * @return void
	 */
	function gutenberg_sync_engines_enable_collaboration_experiment() {
		$experiments = get_option( 'gutenberg-experiments', array() );
		if ( ! is_array( $experiments ) ) {
			$experiments = array();
		}
		if ( ! empty( $experiments['gutenberg-real-time-collaboration'] ) ) {
			return;
		}
		$experiments['gutenberg-real-time-collaboration'] = true;
		update_option( 'gutenberg-experiments', $experiments );
	}
}

/*
 * Registered BEFORE the double-mount guard below: a worktree's second copy
 * returns early from this file, and activating that copy should still turn
 * the experiment on.
 */
register_activation_hook( __FILE__, 'gutenberg_sync_engines_activate' );

/*
 * In a git worktree, wp-env mounts this plugin TWICE (under the checkout's
 * directory name and as gutenberg-sync-engines), and both copies can end up
 * activated — wp-env re-activates its plugins list on every start. Loading
 * a second copy used to be a fatal redeclare; instead, let the first loaded
 * copy win and make any other mount a no-op. (The bootstrap declaration
 * below must stay inside its function_exists guard: PHP early-binds
 * unconditional top-level functions at COMPILE time, before this return
 * could run.)
 */
if ( function_exists( 'gutenberg_sync_engines_bootstrap' ) ) {
	return;
}

define( 'GUTENBERG_SYNC_ENGINES_VERSION', '0.0.2' );
define( 'GUTENBERG_SYNC_ENGINES_PATH', plugin_dir_path( __FILE__ ) );
define( 'GUTENBERG_SYNC_ENGINES_URL', plugin_dir_url( __FILE__ ) );
define( 'GUTENBERG_SYNC_ENGINES_FILE', __FILE__ );

// Before anything reads $wpdb->sync_updates / $wpdb->sync_room_meta.
WP_Sync_Table_Schema::register_tables();

if ( is_multisite() ) {
	add_action( 'wp_initialize_site', 'gutenberg_sync_engines_initialize_site', 10, 1 );
}

if ( ! function_exists( 'gutenberg_sync_engines_load_bundled_gutenberg' ) ) {
	/**
	 * Loads the bundled Gutenberg plugin (the collaborative-editing framework)
	 * when no other copy of Gutenberg is present, so the release zip works on
	 * any WordPress installation with nothing else installed.
	 *
	 * The standalone-Gutenberg check must read the active-plugins options, not
	 * just look for loaded symbols: 'gutenberg-sync-engines/…' sorts BEFORE
	 * 'gutenberg/gutenberg.php' in the active-plugins list, so this plugin
	 * loads first, and loading the bundled copy while a standalone Gutenberg
	 * is about to load would fatal with duplicate declarations. (Corollary:
	 * activating a standalone Gutenberg while the bundled copy is already
	 * loaded fails that activation request safely — WordPress's plugin
	 * sandbox catches the redeclare — and the next request defers to it.)
	 *
	 * @since 0.0.1
	 *
	 * @return void
	 */
	function gutenberg_sync_engines_load_bundled_gutenberg() {
		if ( defined( 'GUTENBERG_VERSION' ) || function_exists( 'gutenberg_pre_init' ) ) {
			return; // Gutenberg is already loaded.
		}

		$entry = GUTENBERG_SYNC_ENGINES_PATH . 'gutenberg/gutenberg.php';
		if ( ! file_exists( $entry ) ) {
			return;
		}

		$active = (array) get_option( 'active_plugins', array() );
		if ( is_multisite() ) {
			$active = array_merge(
				$active,
				array_keys( (array) get_site_option( 'active_sitewide_plugins', array() ) )
			);
		}
		if (
			in_array( 'gutenberg/gutenberg.php', $active, true )
			// A stale activation entry whose plugin file is gone (deleted
			// over FTP, an unmounted dev checkout) must not disable bundled
			// loading — WordPress itself skips missing active plugins.
			&& file_exists( WP_PLUGIN_DIR . '/gutenberg/gutenberg.php' )
		) {
			return; // A standalone Gutenberg will load; defer to it.
		}

		require_once $entry;
	}
}
gutenberg_sync_engines_load_bundled_gutenberg();

require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-gutenberg-sync-engines-plugin.php';

if ( ! function_exists( 'gutenberg_sync_engines_storage' ) ) {
	/**
	 * The sync storage the plugin's engines, transports, and tools use.
	 *
	 * Prefers the framework's filterable factory (`wp_get_sync_storage`,
	 * `__unstable_wp_sync_storage` filter — where this plugin substitutes
	 * its table storage) so a drop-in storage backend applies everywhere
	 * at once; falls back to the plugin's table storage directly on a
	 * framework build that predates the factory. Only called from
	 * framework-gated code paths.
	 *
	 * @since 0.4.0
	 *
	 * @return WP_Sync_Storage Storage implementation.
	 */
	function gutenberg_sync_engines_storage() {
		return function_exists( 'wp_get_sync_storage' )
			? wp_get_sync_storage()
			: new WP_Sync_Table_Storage();
	}
}

if ( ! function_exists( 'gutenberg_sync_engines_bootstrap' ) ) {
	/**
	 * Boots the plugin once all plugins are loaded, so the collaborative-editing
	 * framework (shipped in Gutenberg / WordPress core) is already available to
	 * feature-detect.
	 *
	 * @since 0.1.0
	 *
	 * @return void
	 */
	function gutenberg_sync_engines_bootstrap() {
		Gutenberg_Sync_Engines_Plugin::instance()->boot();
	}
}
add_action( 'plugins_loaded', 'gutenberg_sync_engines_bootstrap' );
