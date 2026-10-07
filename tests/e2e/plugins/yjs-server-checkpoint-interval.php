<?php
/**
 * Plugin Name: Gutenberg Test Plugin, Yjs Server Checkpoint Interval
 * Description: Lowers the yjs-server checkpoint interval to a handful of rows so a spec can make the server compact a room in a few keystrokes.
 */

add_filter(
	'wp_sync_yjs_server_checkpoint_interval',
	static function () {
		return 5;
	}
);
