<?php
/**
 * Uninstall: drops the plugin's storage tables.
 *
 * WordPress runs this file when the plugin is DELETED from the plugins
 * screen (never on deactivation, which leaves the tables and every room
 * alone). On multisite every site's tables go, because the plugin may
 * have been active on any of them.
 *
 * @package GutenbergSyncEngines
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

require_once __DIR__ . '/includes/storage/class-wp-sync-table-schema.php';

if ( is_multisite() ) {
	WP_Sync_Table_Schema::drop_network();
} else {
	WP_Sync_Table_Schema::drop();
}
