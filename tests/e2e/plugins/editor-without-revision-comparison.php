<?php
/**
 * Plugin Name: Gutenberg Test Plugin, Editor Without Revision Comparison
 * Description: E2E fixture: makes the editor look like a standalone Gutenberg's, which does not export the revision comparison the conflict review dialogs are built on. It removes those names from the editor package's private APIs before the sync-engines bundle reads them, so the dialogs must fall back to their plain text comparison. Active only during the test that opens a conflict card without the revision comparison.
 * Version: 0.0.0-fixture
 * Author: Gutenberg Sync Engines e2e fixtures
 * License: GPL-2.0-or-later
 *
 * @package GutenbergSyncEngines
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action(
	'enqueue_block_editor_assets',
	static function () {
		/*
		 * The names are the bundled Gutenberg's one addition to the editor
		 * package (AGENTS.md, "The gutenberg/ subtree"). The script runs
		 * right after the editor package loads. The sync-engines bundle
		 * depends on that package, so it always loads later and finds the
		 * names gone.
		 */
		$script = <<<'JS'
( function () {
	var consent =
		'I acknowledge private features are not for use in themes or plugins and doing so will break in the next version of WordPress.';
	var api = wp.privateApis
		.__dangerousOptInToUnstableAPIsOnlyForCoreModules(
			consent,
			'@wordpress/editor'
		)
		.unlock( wp.editor.privateApis );

	[
		'diffRevisionContent',
		'registerDiffFormatTypes',
		'unregisterDiffFormatTypes',
		'DiffDescriptions',
		'REVISION_DIFF_STYLES',
		'REVISION_REMOVED_FILTER_SVG',
		'RevisionsCodeDiff',
	].forEach( function ( name ) {
		delete api[ name ];
	} );
} )();
JS;

		wp_add_inline_script( 'wp-editor', $script, 'after' );
	}
);
