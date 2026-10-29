<?php
/**
 * Plugin Name: Gutenberg Test Plugin, Semantic Capture Prototype
 * Description: Loads the local action observer and editing-history prototype. Development only.
 */

add_action(
	'enqueue_block_editor_assets',
	static function () {
		wp_enqueue_script(
			'gse-semantic-capture-prototype',
			plugins_url( 'gutenberg-sync-engines/build/semantic-capture/index.js' ),
			array( 'gutenberg-sync-engines', 'wp-block-editor', 'wp-editor', 'wp-sync' ),
			(string) time(),
			true
		);
	}
);
