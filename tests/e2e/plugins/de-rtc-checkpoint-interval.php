<?php
/**
 * Plugin Name: Gutenberg Test Plugin, De-RTC Checkpoint Interval
 * Description: Lowers the de-rtc checkpoint interval to two rows so a spec can make the server compact a room in a few keystrokes.
 */

add_filter(
	'wp_sync_de_rtc_checkpoint_interval',
	static function () {
		return 2;
	}
);
