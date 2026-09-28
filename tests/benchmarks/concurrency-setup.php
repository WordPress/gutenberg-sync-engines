<?php
/**
 * Seeds one room for the multi-process concurrency measurement: creates a
 * post from the workload generator's genesis content and primes the
 * room's genesis snapshot BEFORE workers race, then prints the post id as
 * `BENCH_POST <id>`. Pass teardown=<id> instead to delete a seeded post
 * and its room (the room's rows live in the plugin's storage tables, so
 * the room is reset explicitly before the post goes).
 *
 * @package gutenberg
 */

if ( ! defined( 'ABSPATH' ) ) {
	fwrite( STDERR, "Run this through: wp eval-file concurrency-setup.php -- <options>\n" );
	exit( 1 );
}

require_once __DIR__ . '/class-wp-sync-bench-runner.php';

$wp_sync_bench_opts = array();
foreach ( ( isset( $args ) && is_array( $args ) ? $args : array() ) as $wp_sync_bench_arg ) {
	if ( preg_match( '/^-{0,2}([a-z0-9-]+)=(.*)$/', (string) $wp_sync_bench_arg, $m ) ) {
		$wp_sync_bench_opts[ $m[1] ] = $m[2];
	}
}

if ( ! empty( $wp_sync_bench_opts['teardown'] ) ) {
	$wp_sync_bench_teardown_id   = (int) $wp_sync_bench_opts['teardown'];
	$wp_sync_bench_teardown_post = get_post( $wp_sync_bench_teardown_id );
	if ( $wp_sync_bench_teardown_post ) {
		( new WP_Sync_Table_Storage() )->reset_room( 'postType/' . $wp_sync_bench_teardown_post->post_type . ':' . $wp_sync_bench_teardown_id );
	}
	wp_delete_post( $wp_sync_bench_teardown_id, true );
	echo "BENCH_TEARDOWN_OK\n";
	return;
}

$engine_slug = (string) ( $wp_sync_bench_opts['engine'] ?? 'intent-log' );
$paragraphs  = max( 1, (int) ( $wp_sync_bench_opts['paragraphs'] ?? 4 ) );

$wp_sync_bench_workload = WP_Sync_Bench_Workload::build( 'solo-typing', 1, 1, 1, $paragraphs );

// Genesis is primed below, so the set_meta op's keys must be registered
// here (synced meta is registered meta; registration puts the
// `meta.<key>` registers and the CRDT's nested meta map in the seed).
WP_Sync_Bench_Workload::register_bench_meta();

$post_id = wp_insert_post(
	array(
		'post_type'    => 'post',
		'post_status'  => 'draft',
		'post_title'   => 'Sync concurrency benchmark',
		'post_content' => $wp_sync_bench_workload['post_content'],
	)
);

$engine = ( new WP_Sync_Engine_Registry( new WP_Sync_Table_Storage() ) )->get_engine( $engine_slug );
$engine->get_updates_since( 'postType/post:' . $post_id, 999, 0, array() );

echo 'BENCH_POST ' . (int) $post_id . "\n";
