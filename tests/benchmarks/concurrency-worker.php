<?php
/**
 * One simulated client for the multi-process concurrency measurement —
 * invoked N times IN PARALLEL against the same room by
 * `npm run bench -- --concurrency=N` (see bench.mjs).
 *
 * Unlike the single-process harness, this path uses the REAL table
 * storage (processes can only contend through a shared database) and
 * constructs a FRESH engine + storage per iteration (each production
 * request starts with empty per-request caches). What it measures is what
 * the single-process harness structurally cannot: per-request latency
 * INCLUDING genuine lock waits, 503 lock-timeout behavior, and MySQL
 * under concurrent writers. Quality oracles do not run here — that is
 * the deterministic single-process harness's job; this is a latency and
 * failure-mode probe (dispositions are still counted for context).
 *
 * Each iteration models one poll-then-type client beat: read (advance the
 * client's observed state through the authoring profile), author one text
 * edit, submit it timed. Output is one `BENCH_WORKER {json}` line.
 *
 *   wp eval-file tests/benchmarks/concurrency-worker.php \
 *       engine=intent-log post=123 worker=0 workers=4 requests=40 paragraphs=4
 *
 * @package gutenberg
 */

if ( ! defined( 'ABSPATH' ) ) {
	fwrite( STDERR, "Run this through: wp eval-file concurrency-worker.php -- <options>\n" );
	exit( 1 );
}

require_once __DIR__ . '/class-wp-sync-bench-runner.php';

$wp_sync_bench_opts = array();
foreach ( ( isset( $args ) && is_array( $args ) ? $args : array() ) as $wp_sync_bench_arg ) {
	if ( preg_match( '/^-{0,2}([a-z0-9-]+)=(.*)$/', (string) $wp_sync_bench_arg, $m ) ) {
		$wp_sync_bench_opts[ $m[1] ] = $m[2];
	}
}

$engine_slug = (string) ( $wp_sync_bench_opts['engine'] ?? 'intent-log' );
$post_id     = (int) ( $wp_sync_bench_opts['post'] ?? 0 );
$worker      = (int) ( $wp_sync_bench_opts['worker'] ?? 0 );
$workers     = max( 1, (int) ( $wp_sync_bench_opts['workers'] ?? 1 ) );
$requests    = max( 1, (int) ( $wp_sync_bench_opts['requests'] ?? 40 ) );
$paragraphs  = max( 1, (int) ( $wp_sync_bench_opts['paragraphs'] ?? 4 ) );

$room = 'postType/post:' . $post_id;

// The profile IS the client: it persists across iterations (a browser tab
// keeps its document/observed state between requests), while engine and
// storage are rebuilt per iteration (each HTTP request starts cold).
$wp_sync_bench_fresh_engine = static function () use ( $engine_slug ) {
	return ( new WP_Sync_Engine_Registry( new WP_Sync_Table_Storage() ) )->get_engine( $engine_slug );
};

$wp_sync_bench_workload = array(
	'scenario'      => 'concurrency-probe',
	'post_content'  => (string) get_post_field( 'post_content', $post_id ),
	'paragraphs'    => $paragraphs,
	'clients'       => $workers,
	// Each parallel process only sees its OWN dispositions, so a profile
	// must not assert its disposition model against the wire here; the
	// read-driven observed state is the only truth in this mode.
	'multi_process' => true,
);
$profile                = WP_Sync_Bench_Profiles::for_engine( $engine_slug, $post_id, $wp_sync_bench_workload );

$cursors = $profile->bootstrap( $wp_sync_bench_fresh_engine(), $room );
$cursor  = (int) ( $cursors[ $worker ] ?? 0 );

$latency_us       = array();
$errors           = array();
$void_reasons     = array();
$non_benign_voids = 0;
$dispositions     = array(
	'applied'   => 0,
	'escalated' => 0,
	'voided'    => 0,
);

for ( $i = 0; $i < $requests; $i++ ) {
	$engine   = $wp_sync_bench_fresh_engine();
	$response = $engine->get_updates_since( $room, $worker, $cursor, $profile->read_context() );
	$cursor   = (int) ( $response['end_cursor'] ?? $cursor );
	$profile->observe( $worker, $response );

	$edit = array(
		'client'    => $worker,
		'paragraph' => $worker % $paragraphs,
		'op'        => 'text',
		'text'      => ' w' . $worker . 'i' . $i . ';',
	);

	$updates = $profile->author( $worker, $edit, $i );

	// Same guard as the single-process runner: the per-edit bookkeeping
	// rests on one update per authored edit.
	if ( 1 !== count( $updates ) ) {
		fwrite( STDERR, sprintf( "Benchmark aborted (concurrency-worker authoring): profile \"%s\" authored %d update(s) for one edit; the worker submits exactly one update per edit.\n", $profile->name(), count( $updates ) ) );
		exit( 1 );
	}

	$engine       = $wp_sync_bench_fresh_engine();
	$start        = hrtime( true );
	$result       = $engine->handle_updates( $room, $worker, $cursor, $updates, array() );
	$latency_us[] = ( hrtime( true ) - $start ) / 1e3;

	if ( is_wp_error( $result ) ) {
		$code            = $result->get_error_code();
		$errors[ $code ] = ( $errors[ $code ] ?? 0 ) + 1;
		continue;
	}

	// Same guard as the single-process runner: a disposition list that does
	// not match the submitted updates one-to-one would corrupt the per-edit
	// bookkeeping, so abort loudly instead of reporting numbers.
	WP_Sync_Bench_Runner::assert_disposition_cardinality( $result, $updates, 'concurrency-worker ingest' );

	foreach ( (array) ( $result['dispositions'] ?? array() ) as $disposition ) {
		$status = $disposition['status'] ?? 'unknown';
		if ( isset( $dispositions[ $status ] ) ) {
			++$dispositions[ $status ];
		}
		if ( 'voided' === $status ) {
			$reason                  = (string) ( $disposition['reason'] ?? '(none)' );
			$void_reasons[ $reason ] = ( $void_reasons[ $reason ] ?? 0 ) + 1;
			// The profile knows which voids its client protocol absorbs
			// (idempotent redelivery, modeled resync recovery); anything
			// else is REAL lost work and fails the run.
			if ( ! $profile->is_benign_void( $reason ) ) {
				++$non_benign_voids;
			}
		}
		$profile->record_disposition( $worker, $edit, $disposition );
	}
}

echo 'BENCH_WORKER ' . wp_json_encode(
	array(
		'worker'           => $worker,
		'engine'           => $engine_slug,
		'requests'         => $requests,
		'latency_us'       => array_map( 'round', $latency_us ),
		'errors'           => $errors,
		'void_reasons'     => $void_reasons,
		'non_benign_voids' => $non_benign_voids,
		'dispositions'     => $dispositions,
	)
) . "\n";
