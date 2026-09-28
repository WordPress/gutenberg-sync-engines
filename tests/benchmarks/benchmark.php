<?php
/**
 * Sync-engine benchmark CLI — runs INSIDE WordPress (the engines need
 * get_post/serialize_block and a $wpdb for the ingest lock), so invoke it
 * through wp-cli's eval-file in the environment under test:
 *
 *   wp eval-file tests/benchmarks/benchmark.php \
 *       engine=intent-log scenario=mixed-newsroom \
 *       rounds=200 clients=4 paragraphs=8 seed=42 json=out.json
 *
 * (Pass options as bare `key=value` tokens — wp-cli would claim `--flags`
 * as its own parameters.)
 *
 * Compare engines by running the slugs over the same scenario/seed. The
 * intent log reports full cost AND policy-correct quality (applied /
 * escalated-for-review / lost); yjs-server reports full cost AND
 * CRDT-oracle quality (all-client convergence, lossless text, register
 * agreement) over real y-php-authored payloads. An engine that merges on
 * the client (like the retired yjs-relay) reports cost only — the server
 * cannot score quality (shown as unobservable, never faked). See README.md.
 *
 * @package gutenberg
 */

if ( ! defined( 'ABSPATH' ) ) {
	fwrite( STDERR, "Run this through: wp eval-file benchmark.php -- <options>\n" );
	exit( 1 );
}

require_once __DIR__ . '/class-wp-sync-bench-memory-storage.php';
require_once __DIR__ . '/class-wp-sync-bench-workload.php';
require_once __DIR__ . '/class-wp-sync-bench-runner.php';

/**
 * Parses `key=value` (or `--key=value`) tokens into an options map.
 *
 * @param array $tokens Argument tokens.
 * @return array Options map.
 */
if ( ! function_exists( 'wp_sync_bench_parse_args' ) ) {
	function wp_sync_bench_parse_args( array $tokens ): array {
		$options = array();
		foreach ( $tokens as $arg ) {
			if ( preg_match( '/^-{0,2}([a-z0-9-]+)=(.*)$/', (string) $arg, $m ) ) {
				$options[ $m[1] ] = $m[2];
			}
		}
		return $options;
	}
}

// wp-cli eval-file exposes positional tokens as $args; fall back to $argv.
$wp_sync_bench_opts = wp_sync_bench_parse_args(
	isset( $args ) && is_array( $args ) ? $args : ( $argv ?? array() )
);

$engine_slug = $wp_sync_bench_opts['engine'] ?? 'intent-log';
$scenario    = $wp_sync_bench_opts['scenario'] ?? 'mixed-newsroom';
$rounds      = (int) ( $wp_sync_bench_opts['rounds'] ?? 200 );
$clients     = (int) ( $wp_sync_bench_opts['clients'] ?? 4 );
$paragraphs  = (int) ( $wp_sync_bench_opts['paragraphs'] ?? 8 );
$seed        = (int) ( $wp_sync_bench_opts['seed'] ?? 42 );
$reps        = max( 1, (int) ( $wp_sync_bench_opts['reps'] ?? 3 ) );
$warmup      = max( 0, min( (int) ( $wp_sync_bench_opts['warmup'] ?? 1 ), $reps - 1 ) );
// fill=N pads every genesis paragraph to ~N chars — the document-size
// sweep axis (unset = the scenario default).
$fill = isset( $wp_sync_bench_opts['fill'] ) ? max( 0, (int) $wp_sync_bench_opts['fill'] ) : null;

if ( ! array_key_exists( $scenario, WP_Sync_Bench_Workload::scenarios() ) ) {
	fwrite( STDERR, "Unknown scenario: {$scenario}\n" );
	fwrite( STDERR, 'Scenarios: ' . implode( ', ', array_keys( WP_Sync_Bench_Workload::scenarios() ) ) . "\n" );
	exit( 1 );
}
// Engines are resolved through the framework's registry (the
// `wp_sync_engines` filter), so any engine registered by an active plugin —
// including third-party ones — is benchmarkable by slug. HOW each engine is
// driven is the authoring profile's job, resolved per slug through
// WP_Sync_Bench_Profiles (extensible via the
// `wp_sync_bench_authoring_profiles` filter); engines without a dedicated
// profile fall back to relay-convention opaque updates.
$wp_sync_bench_engine_slugs = ( new WP_Sync_Engine_Registry( new WP_Sync_Bench_Memory_Storage() ) )->get_engine_slugs();
if ( ! in_array( $engine_slug, $wp_sync_bench_engine_slugs, true ) ) {
	fwrite( STDERR, "Unknown engine: {$engine_slug}\n" );
	fwrite( STDERR, 'Registered engines: ' . ( $wp_sync_bench_engine_slugs ? implode( ', ', $wp_sync_bench_engine_slugs ) : '(none — is the engine plugin active?)' ) . "\n" );
	exit( 1 );
}

/**
 * Times the environment's database round-trips so the intent-log service
 * time can be decomposed: its handle_updates() holds a Core-style
 * options-row lock (WP_Sync_Room_Lock, the GET_LOCK replacement) for the
 * length of the request, so each timed request includes one
 * claim/release pair of DB writes that lock-free engines (yjs-server's
 * CRDT ingest, de-rtc's optimistic version claims) do not pay.
 *
 * @return array db_rtt and lock_pair p50, in milliseconds.
 */
if ( ! function_exists( 'wp_sync_bench_calibrate' ) ) {
	function wp_sync_bench_calibrate(): array {
		global $wpdb;

		$db_rtt    = array();
		$lock_pair = array();
		$lock_name = $wpdb->prefix . 'sync_bench_calibration';
		for ( $i = 0; $i < 100; $i++ ) {
			$start = hrtime( true );
			$wpdb->get_var( 'SELECT 1' );
			$db_rtt[] = ( hrtime( true ) - $start ) / 1e3;

			$start = hrtime( true );
			$token = WP_Sync_Room_Lock::acquire( $lock_name, 0.0 );
			if ( ! is_wp_error( $token ) ) {
				WP_Sync_Room_Lock::release( $lock_name, $token );
			}
			$lock_pair[] = ( hrtime( true ) - $start ) / 1e3;
		}

		return array(
			'db_rtt_p50_ms'    => WP_Sync_Bench_Runner::summary( $db_rtt )['p50'],
			'lock_pair_p50_ms' => WP_Sync_Bench_Runner::summary( $lock_pair )['p50'],
		);
	}
}

// The workload is deterministic, so every repetition replays the identical
// edit sequence: counted metrics (dispositions, storage, payloads) must not
// move between reps, and timing gets independent samples. Warmup reps run
// the same load but are excluded from timing (autoload, opcache, and the
// first lock acquisition all land in rep 0).
$wp_sync_bench_workload = WP_Sync_Bench_Workload::build( $scenario, $seed, $rounds, $clients, $paragraphs, $fill );

// The set_meta op's keys must be registered BEFORE genesis is primed:
// synced meta is registered meta, and registration is what puts the
// `meta.<key>` registers (and the CRDT's nested meta map) in every
// engine's genesis seed.
WP_Sync_Bench_Workload::register_bench_meta();

$wp_sync_bench_series       = array(
	'service_us'     => array(),
	'read_us'        => array(),
	'idle_poll_us'   => array(),
	'join_us'        => array(),
	'materialize_us' => array(),
);
$wp_sync_bench_rep_means    = array();
$wp_sync_bench_fingerprints = array();
$wp_sync_bench_memory       = array(
	'ingest_peak_bytes'      => null,
	'materialize_peak_bytes' => null,
);
$report                     = null;
for ( $wp_sync_bench_rep = 0; $wp_sync_bench_rep < $reps; $wp_sync_bench_rep++ ) {
	$storage = new WP_Sync_Bench_Memory_Storage();
	$engine  = ( new WP_Sync_Engine_Registry( $storage ) )->get_engine( $engine_slug );

	$post_id = wp_insert_post(
		array(
			'post_type'    => 'post',
			'post_status'  => 'draft',
			'post_title'   => 'Sync benchmark',
			'post_content' => $wp_sync_bench_workload['post_content'],
		)
	);

	$report = WP_Sync_Bench_Runner::run( $engine, $storage, (int) $post_id, $wp_sync_bench_workload );
	wp_delete_post( (int) $post_id, true );

	$series = array();
	foreach ( array_keys( $wp_sync_bench_series ) as $metric ) {
		$series[ $metric ] = $report[ $metric . '_series' ];
		unset( $report[ $metric . '_series' ] );
	}

	// Counted metrics must be identical across reps (deterministic workload);
	// a mismatch means engine nondeterminism and is worth surfacing.
	$wp_sync_bench_fingerprints[] = (string) wp_json_encode(
		array( $report['quality']['dispositions'], $report['storage'], $report['payload_bytes'] )
	);

	if ( $wp_sync_bench_rep >= $warmup ) {
		foreach ( $series as $metric => $samples ) {
			$wp_sync_bench_series[ $metric ] = array_merge( $wp_sync_bench_series[ $metric ], $samples );
		}
		$wp_sync_bench_rep_means[] = count( $series['service_us'] ) > 0
			? array_sum( $series['service_us'] ) / count( $series['service_us'] ) / 1000
			: 0.0;
		// Peak memory: the max across measured reps (warmup absorbs the
		// autoload/opcache spike, like the timing warmup).
		foreach ( $wp_sync_bench_memory as $wp_sync_bench_mem_key => $wp_sync_bench_mem_value ) {
			$rep_value = $report['memory'][ $wp_sync_bench_mem_key ] ?? null;
			if ( null !== $rep_value ) {
				$wp_sync_bench_memory[ $wp_sync_bench_mem_key ] = max( (int) $wp_sync_bench_mem_value, (int) $rep_value );
			}
		}
	}
}

// Timing across measured reps: pooled percentiles + spread of rep means.
foreach ( $wp_sync_bench_series as $metric => $samples ) {
	$report[ $metric ] = WP_Sync_Bench_Runner::summary( $samples );
}
// No materialize convention on this engine (e.g. an opaque relay).
if ( array() === $wp_sync_bench_series['materialize_us'] ) {
	$report['materialize_us'] = null;
}
$report['memory'] = $wp_sync_bench_memory;

/*
 * The hosting cost card: only wall-clock scenarios (1 round = N seconds)
 * can honestly compose per-request costs into what-does-this-do-to-my-box
 * numbers. Client-seconds = in-session reads (every present client reads
 * exactly once per round under those scenarios), which normalizes the
 * session to per-user-hour units a capacity plan can multiply out.
 */
$report['hosting'] = null;
if ( ! empty( $wp_sync_bench_workload['seconds_per_round'] ) ) {
	$wp_sync_bench_counts = $report['request_counts'];
	$session_seconds      = $rounds * (int) $wp_sync_bench_workload['seconds_per_round'];
	$client_seconds       = max( 1, (int) $wp_sync_bench_counts['reads_session'] );
	$session_requests     = $wp_sync_bench_counts['ingests'] + $wp_sync_bench_counts['reads_session'] + $wp_sync_bench_counts['saves_session'];
	$cpu_seconds          = (
		$report['service_us']['mean'] * $wp_sync_bench_counts['ingests']
		+ $report['read_us']['mean'] * $wp_sync_bench_counts['reads_session']
		+ ( null !== $report['materialize_us'] ? $report['materialize_us']['mean'] * $wp_sync_bench_counts['saves_session'] : 0 )
	) / 1000;
	$wire_bytes           = $report['wire']['request_bytes'] + $report['wire']['response_bytes'];

	/*
	 * Modeled queueing: the harness executes requests one at a time, but
	 * production edits from the same round arrive near-simultaneously. For
	 * engines that serialize ingest per room (the GET_LOCK holders), the
	 * K-th concurrent writer waits for K-1 merges: convolving the
	 * workload's ingest-concurrency histogram with the MEASURED mean
	 * service time models that wait. yjs-server is lock-free (no room
	 * queue), but every in-flight ingest still holds a PHP WORKER, so its
	 * peak concurrent worker demand is reported instead. MODELED, not
	 * measured — `npm run bench -- --concurrency=N` measures it for real.
	 */
	$wp_sync_bench_histogram  = WP_Sync_Bench_Workload::ingest_concurrency_histogram( $wp_sync_bench_workload['rounds'] );
	$wp_sync_bench_serialized = in_array( $engine_slug, array( 'intent-log', 'de-rtc' ), true );
	$wp_sync_bench_wait_ms    = 0.0;
	$wp_sync_bench_wait_max   = 0.0;
	$wp_sync_bench_hist_edits = 0;
	foreach ( $wp_sync_bench_histogram as $wp_sync_bench_k => $wp_sync_bench_n ) {
		$wp_sync_bench_hist_edits += $wp_sync_bench_k * $wp_sync_bench_n;
		if ( $wp_sync_bench_serialized ) {
			// Sum of waits in a K-deep convoy: (0+1+…+K-1) x service.
			$wp_sync_bench_wait_ms += $wp_sync_bench_n * ( $wp_sync_bench_k * ( $wp_sync_bench_k - 1 ) / 2 ) * $report['service_us']['mean'];
			$wp_sync_bench_wait_max = max( $wp_sync_bench_wait_max, ( $wp_sync_bench_k - 1 ) * $report['service_us']['p90'] );
		}
	}

	$report['hosting'] = array(
		'session_seconds'             => $session_seconds,
		'client_seconds'              => $client_seconds,
		'requests_session'            => $session_requests,
		'requests_per_second'         => round( $session_requests / max( 1, $session_seconds ), 2 ),
		'requests_per_client_hour'    => (int) round( $session_requests * 3600 / $client_seconds ),
		'cpu_seconds_session'         => round( $cpu_seconds, 3 ),
		'cpu_core_share'              => round( $cpu_seconds / max( 1, $session_seconds ), 4 ),
		'cpu_seconds_per_client_hour' => round( $cpu_seconds * 3600 / $client_seconds, 2 ),
		'wire_bytes_session'          => $wire_bytes,
		'wire_mb_per_client_hour'     => round( $wire_bytes * 3600 / $client_seconds / 1048576, 2 ),
		'storage_bytes_at_rest'       => $report['storage']['bytes'],
		'join_payload_bytes'          => $report['payload_bytes']['join_response_p50'],
		'queueing_model'              => array(
			'ingest_concurrency'      => $wp_sync_bench_histogram,
			'serialized_ingest'       => $wp_sync_bench_serialized,
			'modeled_wait_ms_mean'    => $wp_sync_bench_hist_edits > 0
				? round( $wp_sync_bench_wait_ms / $wp_sync_bench_hist_edits, 4 )
				: 0.0,
			'modeled_wait_ms_worst'   => round( $wp_sync_bench_wait_max, 4 ),
			'peak_concurrent_workers' => array() === $wp_sync_bench_histogram ? 0 : max( array_keys( $wp_sync_bench_histogram ) ),
		),
	);
}

$wp_sync_bench_mean = array_sum( $wp_sync_bench_rep_means ) / count( $wp_sync_bench_rep_means );
$wp_sync_bench_var  = 0.0;
foreach ( $wp_sync_bench_rep_means as $m ) {
	$wp_sync_bench_var += ( $m - $wp_sync_bench_mean ) ** 2;
}
$wp_sync_bench_stddev = count( $wp_sync_bench_rep_means ) > 1
	? sqrt( $wp_sync_bench_var / ( count( $wp_sync_bench_rep_means ) - 1 ) )
	: 0.0;

$report['timing'] = array(
	'timer'                     => 'hrtime',
	'reps'                      => $reps,
	'warmup_reps'               => $warmup,
	'measured_reps'             => count( $wp_sync_bench_rep_means ),
	'rep_mean_ms'               => array_map(
		static function ( $m ) {
			return round( $m, 4 );
		},
		$wp_sync_bench_rep_means
	),
	'rep_mean_stddev_ms'        => round( $wp_sync_bench_stddev, 4 ),
	'deterministic_across_reps' => 1 === count( array_unique( $wp_sync_bench_fingerprints ) ),
);

$report['calibration'] = wp_sync_bench_calibrate();

global $wp_version, $wpdb;
$opcache_status = false;

if ( function_exists( 'opcache_get_status' ) ) {
	$opcache_status = opcache_get_status( false );
}

$report['environment'] = array(
	'php'     => PHP_VERSION,
	'os'      => php_uname( 's' ) . ' ' . php_uname( 'm' ),
	'wp'      => (string) $wp_version,
	'db'      => $wpdb->db_server_info(),
	'opcache' => is_array( $opcache_status ) && ! empty( $opcache_status['opcache_enabled'] ),
);

$report['config'] = array(
	'engine'     => $engine_slug,
	'scenario'   => $scenario,
	'rounds'     => $rounds,
	'clients'    => $clients,
	'paragraphs' => $paragraphs,
	'fill'       => $fill,
	'doc_bytes'  => strlen( (string) $wp_sync_bench_workload['post_content'] ),
	'seed'       => $seed,
	'reps'       => $reps,
	'warmup'     => $warmup,
);

$q = $report['quality'];
printf( "\n== %s / %s ==\n", $report['engine'], $report['scenario'] );
printf( "config: rounds=%d clients=%d paragraphs=%d doc=%dB seed=%d reps=%d(+%d warmup)\n", $rounds, $clients, $paragraphs, $report['config']['doc_bytes'], $seed, $report['timing']['measured_reps'], $warmup );
printf(
	"environment: PHP %s / WP %s / %s / %s / opcache %s\n",
	$report['environment']['php'],
	$report['environment']['wp'],
	$report['environment']['db'],
	$report['environment']['os'],
	$report['environment']['opcache'] ? 'on' : 'off'
);
printf(
	"calibration: db rtt p50=%.4f ms, lock pair p50=%.4f ms%s\n",
	$report['calibration']['db_rtt_p50_ms'],
	$report['calibration']['lock_pair_p50_ms'],
	in_array( $engine_slug, array( 'intent-log', 'de-rtc' ), true ) ? ' (each request below holds one lock pair)' : ''
);
printf( "requests: %d per rep\n", $report['requests'] );
printf(
	"service ms: p50=%.4f p90=%.4f p99=%.4f max=%.4f mean=%.4f\n",
	$report['service_us']['p50'],
	$report['service_us']['p90'],
	$report['service_us']['p99'],
	$report['service_us']['max'],
	$report['service_us']['mean']
);
printf(
	"rep means ms: %s (stddev %.4f)%s\n",
	implode( ', ', array_map( 'strval', $report['timing']['rep_mean_ms'] ) ),
	$report['timing']['rep_mean_stddev_ms'],
	$report['timing']['deterministic_across_reps'] ? '' : ' — WARNING: counted metrics varied across reps'
);
printf(
	"read ms: p50=%.4f p99=%.4f max=%.4f mean=%.4f\n",
	$report['read_us']['p50'],
	$report['read_us']['p99'],
	$report['read_us']['max'],
	$report['read_us']['mean']
);
printf(
	"idle poll ms: p50=%.4f p99=%.4f max=%.4f mean=%.4f\n",
	$report['idle_poll_us']['p50'],
	$report['idle_poll_us']['p99'],
	$report['idle_poll_us']['max'],
	$report['idle_poll_us']['mean']
);
printf(
	"join ms: p50=%.4f max=%.4f mean=%.4f (cold read at cursor 0; resp bytes p50=%d max=%d)\n",
	$report['join_us']['p50'],
	$report['join_us']['max'],
	$report['join_us']['mean'],
	$report['payload_bytes']['join_response_p50'],
	$report['payload_bytes']['join_response_max']
);
if ( null !== $report['materialize_us'] ) {
	printf(
		"materialize ms: p50=%.4f max=%.4f mean=%.4f (cold engine, the save path)\n",
		$report['materialize_us']['p50'],
		$report['materialize_us']['max'],
		$report['materialize_us']['mean']
	);
}
if ( null !== $report['memory']['ingest_peak_bytes'] ) {
	printf(
		"memory peak: ingest=%.2f MB%s\n",
		$report['memory']['ingest_peak_bytes'] / 1048576,
		null !== $report['memory']['materialize_peak_bytes']
			? sprintf( ', materialize=%.2f MB', $report['memory']['materialize_peak_bytes'] / 1048576 )
			: ''
	);
}
printf(
	"payload bytes: req p50=%d max=%d / resp p50=%d max=%d\n",
	$report['payload_bytes']['request_p50'],
	$report['payload_bytes']['request_max'],
	$report['payload_bytes']['response_p50'],
	$report['payload_bytes']['response_max']
);
printf( "storage: rows=%d bytes=%d followups=%d trims=%d\n", $report['storage']['rows'], $report['storage']['bytes'], $report['storage']['followups'], $report['storage']['trims'] );
if ( $q['observable'] ) {
	printf(
		"quality: converged=%s applied=%d escalated=%d voided=%d escalation_rate=%.4f lost_work=%d\n",
		$q['converged'] ? 'yes' : 'NO',
		$q['dispositions']['applied'],
		$q['dispositions']['escalated'],
		$q['dispositions']['voided'],
		$q['escalation_rate'],
		$q['lost_work']
	);
	foreach ( $q['convergence_failures'] as $failure ) {
		printf( "  convergence failure [%s]: %s\n", $failure['check'], $failure['detail'] );
	}
} else {
	printf( "quality: NOT SERVER-OBSERVABLE (client-side CRDT merge)\n" );
}
if ( null !== $report['hosting'] ) {
	$h = $report['hosting'];
	printf( "hosting cost card (1 round = 1 s; engine seam only — the transport envelope, HTTP headers and awareness add overhead on top):\n" );
	printf(
		"  session: %d s wall clock, %d client-seconds of presence, %d requests (%.2f req/s)\n",
		$h['session_seconds'],
		$h['client_seconds'],
		$h['requests_session'],
		$h['requests_per_second']
	);
	printf(
		"  per user-hour: %d requests, %.2f PHP-CPU-seconds, %.2f MB engine wire\n",
		$h['requests_per_client_hour'],
		$h['cpu_seconds_per_client_hour'],
		$h['wire_mb_per_client_hour']
	);
	printf(
		"  server CPU: %.3f s over the session = %.2f%% of one core sustained\n",
		$h['cpu_seconds_session'],
		100 * $h['cpu_core_share']
	);
	printf(
		"  at rest afterwards: %d KB stored; the next visitor downloads %d KB to join\n",
		(int) round( $h['storage_bytes_at_rest'] / 1024 ),
		(int) round( $h['join_payload_bytes'] / 1024 )
	);
	$q = $h['queueing_model'];
	if ( $q['serialized_ingest'] ) {
		printf(
			"  queueing (MODELED from the workload's concurrency, not measured): +%.2f ms mean / +%.2f ms worst-case ingest wait behind the per-room lock; measure for real with `npm run bench -- --concurrency=N`\n",
			$q['modeled_wait_ms_mean'],
			$q['modeled_wait_ms_worst']
		);
	} else {
		printf(
			"  queueing: lock-free ingest (no per-room queue), but up to %d concurrent ingests each hold a PHP worker for the full service time; measure for real with `npm run bench -- --concurrency=N`\n",
			$q['peak_concurrent_workers']
		);
	}
}
if ( 'opaque-relay' === ( $report['profile'] ?? '' ) ) {
	printf(
		"note: engine '%s' has no dedicated authoring profile — driven with relay-convention opaque updates ('update'/'compaction'); if the engine rejects them, the dispositions/storage counts above reflect that. An engine plugin can register a profile via the wp_sync_bench_authoring_profiles filter.\n",
		$engine_slug
	);
}

if ( ! empty( $wp_sync_bench_opts['json'] ) ) {
	file_put_contents( (string) $wp_sync_bench_opts['json'], wp_json_encode( $report ) );
	printf( "wrote %s\n", $wp_sync_bench_opts['json'] );
}
echo "\n";
