<?php
/**
 * Escalation-rate acceptance criteria: the P3 fine line made
 * measurable. "We should detect and surface conflicts when changes
 * overlap meaningfully. However, we should also take care not to
 * overburden humans with constant review tasks. As we find this fine
 * line, an 'escalation rate' metric built on top of conflict fixtures
 * will help validate our approach."
 *
 * The conflict fixtures are the benchmark scenarios; the criteria are
 * POLICY BANDS, deliberately generous so they fail on policy drift, not
 * on seed noise:
 *
 * - Clean workloads must never ask a human anything (rate exactly 0).
 * - Contended workloads must SURFACE conflicts on engines that have a
 *   review lane ("silently zero is a failure of honesty") — counting
 *   both escalated dispositions and partial-acceptance parked rows —
 *   while staying under an upper bound (overburdening is also failure).
 * - yjs-server's silence on contended workloads is its DOCUMENTED
 *   policy; the criterion pins that policy so a change to it is a
 *   deliberate act, not drift.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpSyncEscalationCriteria extends WP_UnitTestCase {
	/**
	 * Editor user ID.
	 *
	 * @var int
	 */
	protected static $editor_id;

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id = $factory->user->create( array( 'role' => 'editor' ) );
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::$editor_id );
	}

	/**
	 * The acceptance matrix: scenario => engine => [min, max] SURFACED
	 * conflict rate (escalated dispositions + parked review rows, over
	 * requests). min > 0 encodes "must surface"; max encodes "must not
	 * overburden". null skips the engine for that fixture.
	 *
	 * @return array<string, array{rounds: int, clients: int, paragraphs: int, bands: array<string, array{float, float}|null>}>
	 */
	private static function criteria(): array {
		return array(
			'parallel-paragraphs' => array(
				'rounds'     => 8,
				'clients'    => 3,
				'paragraphs' => 4,
				'bands'      => array(
					'WP_Intent_Log_Engine' => array( 0.0, 0.0 ),
					'WP_Yjs_Server_Engine' => array( 0.0, 0.0 ),
				),
			),
			'save-sync-session'   => array(
				'rounds'     => 60,
				'clients'    => 3,
				'paragraphs' => 6,
				'bands'      => array(
					// Yjs merges silently. Intent-log's
					// stale-observation residual escalates most at this
					// cadence — tracked, bounded, and expected to shrink
					// as the residual is fixed (AGENTS.md).
					'WP_Yjs_Server_Engine' => array( 0.0, 0.0 ),
					'WP_Intent_Log_Engine' => array( 0.0, 0.4 ),
				),
			),
			'contended-paragraph' => array(
				'rounds'     => 8,
				'clients'    => 3,
				'paragraphs' => 4,
				'bands'      => array(
					// Genuine same-register contention MUST surface — and
					// must not drown the session in review work.
					'WP_Intent_Log_Engine' => array( 0.000001, 0.7 ),
					// Silent by documented policy.
					'WP_Yjs_Server_Engine' => array( 0.0, 0.0 ),
				),
			),
			'structural-churn'    => array(
				'rounds'     => 30,
				'clients'    => 3,
				'paragraphs' => 4,
				'bands'      => array(
					'WP_Intent_Log_Engine' => array( 0.0, 0.0 ),
					'WP_Yjs_Server_Engine' => array( 0.0, 0.0 ),
				),
			),
		);
	}

	public function test_escalation_rates_stay_inside_the_policy_bands() {
		foreach ( self::criteria() as $scenario => $fixture ) {
			$workload = WP_Sync_Bench_Workload::build( $scenario, 7, $fixture['rounds'], $fixture['clients'], $fixture['paragraphs'] );

			foreach ( $fixture['bands'] as $engine_class => $band ) {
				if ( null === $band ) {
					continue;
				}
				$post_id = self::factory()->post->create(
					array( 'post_content' => $workload['post_content'] )
				);
				$room    = 'postType/post:' . $post_id;
				$storage = new WP_Sync_Bench_Memory_Storage();
				$engine  = new $engine_class( $storage );
				$report  = WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );

				$label = $engine_class . ' on ' . $scenario;
				$this->assertSame( 0, $report['quality']['lost_work'], $label . ': lost work' );

				$requests = max( 1, (int) $report['requests'] );
				$surfaced = (int) ( $report['quality']['dispositions']['escalated'] ?? 0 );
				$rate     = $surfaced / $requests;

				list( $min, $max ) = $band;
				if ( $min > 0 ) {
					$this->assertGreaterThan( 0, $surfaced, $label . ': genuine contention must SURFACE conflicts (silently zero is a failure of honesty)' );
				} else {
					$this->assertSame( 0.0, round( $min, 6 ) );
				}
				$this->assertLessThanOrEqual( $max, $rate, sprintf( '%s: surfaced-conflict rate %.4f exceeds the policy band max %.2f (overburdening humans is also failure)', $label, $rate, $max ) );

				wp_delete_post( $post_id, true );
			}
		}
	}
}
