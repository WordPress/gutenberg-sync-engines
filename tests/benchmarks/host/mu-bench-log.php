<?php
/**
 * Plugin Name: Gutenberg Sync Engines benchmark measurement (mu)
 * Description: Whole-request server measurement for the host benchmark, following the community RTC performance harness's MU-plugin model. Measures ANY request tagged with X-RTC-Test — page loads, admin-ajax, REST — from mu-plugin load to shutdown, and works with the gutenberg-sync-engines plugin DEACTIVATED, which is what gives the benchmark's baseline phase real server-side CPU, memory, and worker numbers. Untagged requests pay one $_SERVER read. This repo's wp-env configs map this file into mu-plugins; on another site, copy it there yourself (it needs a plugin copy installed as "gutenberg-sync-engines" to load the log class from).
 * Version: 0.0.0
 * Author: Gutenberg Sync Engines benchmarks
 * License: GPL-2.0-or-later
 *
 * @package GutenbergSyncEngines
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// Same environment gate as the plugin's diagnostics loader: never on a
// production-shaped site.
if (
	! in_array( wp_get_environment_type(), array( 'local', 'development' ), true )
	&& ! defined( 'GUTENBERG_SYNC_ENGINES_DIAGNOSTICS' )
) {
	return;
}

// Benchmark wait pin (wake=cache|table on the host and transport
// benchmarks): keep the SSE transport off Redis for every request, so the
// version checks are what gets measured even while the Redis object cache
// drop-in makes Redis detectable. One autoloaded option read.
if ( in_array( get_option( 'gutenberg_sync_engines_bench_sse_wake', '' ), array( 'cache', 'table' ), true ) ) {
	add_filter( 'wp_sync_sse_redis_url', '__return_empty_string' );
}

// Untagged requests: one server-var read, nothing else.
// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Read-only measurement tag on a diagnostics-only lane.
if ( '1' !== ( $_SERVER['HTTP_X_RTC_TEST'] ?? '' ) && '1' !== ( $_GET['_rtctest'] ?? '' ) ) {
	return;
}

// The log class lives in the plugin directory, which is mounted whether or
// not the plugin is ACTIVE — that is the point: the baseline phase runs
// with it deactivated.
$gutenberg_sync_engines_request_log = WP_PLUGIN_DIR . '/gutenberg-sync-engines/includes/diagnostics/class-gutenberg-sync-engines-request-log.php';
if ( ! file_exists( $gutenberg_sync_engines_request_log ) ) {
	return;
}
require_once $gutenberg_sync_engines_request_log;
if ( ! class_exists( 'Gutenberg_Sync_Engines_Request_Log' ) ) {
	return;
}

// Database disk-I/O probe: a tagged request with `_rtcdbio` gets the
// server's InnoDB I/O counters as JSON and exits BEFORE any measurement
// arms — the probe must never log itself as traffic, and it must work
// with the plugin deactivated (the host benchmark's baseline phase
// samples these counters at span boundaries). Same environment gate as
// everything above; the counters are server load statistics, not site
// content.
// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Read-only counters on a diagnostics-only lane.
if ( isset( $_GET['_rtcdbio'] ) ) {
	header( 'Content-Type: application/json' );
	echo wp_json_encode( Gutenberg_Sync_Engines_Request_Log::db_io_counters() );
	exit;
}

( new Gutenberg_Sync_Engines_Request_Log() )->capture_whole_request();
