<?php
/**
 * Opt-in process measurements for the WebSocket daemon.
 *
 * @package gutenberg-sync-engines
 */
class Tests_Collaboration_WpWebSocketBenchmark extends WP_UnitTestCase {
	public function test_http_metrics_route_requires_explicit_opt_in() {
		$previous = getenv( 'GSE_BENCH_METRICS' );
		$server   = ( new ReflectionClass( WP_WebSocket_Sync_Server::class ) )->newInstanceWithoutConstructor();
		$conn     = new class() extends WP_WebSocket_Connection {
			public array $response = array();
			// phpcs:ignore Generic.CodeAnalysis.UselessOverridingMethod.Found -- No network socket in this test.
			public function __construct() {}
			public function parse_handshake_request() {
				return array(
					'headers' => array(),
					'path'    => '/bench-metrics',
					'method'  => 'GET',
				);
			}
			public function send_http_response( int $status_code, string $reason, string $body = '' ): void {
				$this->response = array( $status_code, $body );
			}
			public function has_pending_writes(): bool {
				return true; }
		};
		$clients  = new ReflectionProperty( $server, 'clients' );
		$clients->setAccessible( true );
		$clients->setValue(
			$server,
			array(
				1 => array(
					'conn'    => $conn,
					'request' => null,
				),
			)
		);
		$handle = new ReflectionMethod( $server, 'handle_handshake' );
		$handle->setAccessible( true );
		try {
			putenv( 'GSE_BENCH_METRICS=0' );
			$handle->invoke( $server, 1 );
			$this->assertSame( array( 404, '' ), $conn->response );
			putenv( 'GSE_BENCH_METRICS=1' );
			$handle->invoke( $server, 1 );
			$this->assertSame( 200, $conn->response[0] );
			$this->assertSame( 1, json_decode( $conn->response[1], true )['version'] );
		} finally {
			putenv( false === $previous ? 'GSE_BENCH_METRICS' : 'GSE_BENCH_METRICS=' . $previous );
		}
	}

	public function test_process_counters_match_cpu_and_database_work() {
		global $wpdb;
		$previous = getenv( 'GSE_BENCH_METRICS' );
		$server   = ( new ReflectionClass( WP_WebSocket_Sync_Server::class ) )->newInstanceWithoutConstructor();
		try {
			putenv( 'GSE_BENCH_METRICS=0' );
			$this->assertNull( $server->benchmark_snapshot() );
			putenv( 'GSE_BENCH_METRICS=1' );
			$before     = $server->benchmark_snapshot();
			$cpu_before = getrusage();
			$until      = hrtime( true ) + 20000000;
			do {
				hash( 'sha256', str_repeat( 'x', 1000 ) );
			} while ( hrtime( true ) < $until );
			$wpdb->get_var( 'SELECT 1' );
			$cpu_after = getrusage();
			$after     = $server->benchmark_snapshot();
			$cpu       = static function ( $value ) {
				return ( $value['ru_utime.tv_sec'] + $value['ru_stime.tv_sec'] ) * 1000 + ( $value['ru_utime.tv_usec'] + $value['ru_stime.tv_usec'] ) / 1000;
			};
			$this->assertSame( 1, $after['queries'] - $before['queries'] );
			$this->assertEqualsWithDelta( $cpu( $cpu_after ) - $cpu( $cpu_before ), $after['cpu_ms'] - $before['cpu_ms'], 5 );
			$this->assertSame( $before['process_id'], $after['process_id'] );
			$this->assertGreaterThanOrEqual( 20, $after['elapsed_ms'] - $before['elapsed_ms'] );
			$this->assertSame( 'php-allocated', $after['memory_kind'] );
			$this->assertGreaterThan( 0, $after['memory_bytes'] );
		} finally {
			putenv( false === $previous ? 'GSE_BENCH_METRICS' : 'GSE_BENCH_METRICS=' . $previous );
		}
	}
}
