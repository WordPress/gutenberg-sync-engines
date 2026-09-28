<?php
/**
 * Correctness tests for the sync-engine benchmark harness.
 *
 * These assert what the harness MEASURES, not how fast it runs (timing is
 * for the CLI, not CI): the seam is driven correctly, the policy-correct
 * quality signal behaves (clean scenarios never escalate, contended ones
 * do, no workload loses work), and the relay path reports its quality as
 * unobservable rather than faking a score.
 *
 * @package Gutenberg
 *
 * @group collaboration
 */

// Loaded at file scope (not set_up_before_class): the fixture profile at
// the bottom of this file extends a benchmark class, and its definition
// executes when PHPUnit includes the file.
require_once dirname( __DIR__ ) . '/benchmarks/class-wp-sync-bench-memory-storage.php';
require_once dirname( __DIR__ ) . '/benchmarks/class-wp-sync-bench-workload.php';
require_once dirname( __DIR__ ) . '/benchmarks/class-wp-sync-bench-runner.php';

class Tests_Collaboration_WpSyncEngineBenchmark extends WP_UnitTestCase {

	/**
	 * The set_meta op's keys must be registered before any room genesis is
	 * primed (synced meta is registered meta): registration puts the
	 * `meta.<key>` registers, and the CRDT's nested meta map, in every
	 * engine's genesis seed. Every engine-driving scenario can carry field
	 * ops (editorial-session included), so register for every test.
	 */
	public function set_up() {
		parent::set_up();
		WP_Sync_Bench_Workload::register_bench_meta();
	}

	/**
	 * Runs a workload for one scenario against the intent-log engine.
	 *
	 * @param string $scenario Scenario slug.
	 * @return array Report.
	 */
	private function run_intent_log( string $scenario ): array {
		return $this->run_intent_log_rounds( $scenario, 8, 3 );
	}

	/**
	 * Runs a workload against the intent-log engine with explicit sizing.
	 *
	 * @param string $scenario Scenario slug.
	 * @param int    $rounds   Rounds.
	 * @param int    $clients  Clients.
	 * @return array Report.
	 */
	private function run_intent_log_rounds( string $scenario, int $rounds, int $clients ): array {
		$workload = WP_Sync_Bench_Workload::build( $scenario, 7, $rounds, $clients, 4 );
		$post_id  = self::factory()->post->create(
			array( 'post_content' => $workload['post_content'] )
		);
		$storage  = new WP_Sync_Bench_Memory_Storage();
		$engine   = new WP_Intent_Log_Engine( $storage );
		return WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );
	}

	public function test_parallel_paragraphs_merge_clean_and_lose_nothing() {
		$report = $this->run_intent_log( 'parallel-paragraphs' );

		$this->assertSame( 'intent-log', $report['engine'] );
		$this->assertGreaterThan( 0, $report['requests'] );
		// Distinct paragraphs never contend: everything applies.
		$this->assertSame( 0, $report['quality']['dispositions']['escalated'] );
		$this->assertSame( 0.0, $report['quality']['escalation_rate'] );
		$this->assertSame( 0, $report['quality']['lost_work'] );
		$this->assertSame( array(), $report['quality']['convergence_failures'] );
		$this->assertTrue( $report['quality']['converged'] );
		$this->assertGreaterThan( 0, $report['storage']['rows'] );
	}

	public function test_contended_paragraph_escalates_but_loses_nothing() {
		$report = $this->run_intent_log( 'contended-paragraph' );

		// Concurrent same-field authorship must produce review escalations…
		$this->assertGreaterThan( 0, $report['quality']['dispositions']['escalated'] );
		$this->assertGreaterThan( 0, $report['quality']['escalation_rate'] );
		// …and STILL lose nothing (escalated edits are preserved, not dropped).
		$this->assertSame( 0, $report['quality']['lost_work'] );
		$this->assertSame( array(), $report['quality']['convergence_failures'] );
		$this->assertTrue( $report['quality']['converged'] );
	}

	public function test_solo_typing_is_all_applied() {
		$report = $this->run_intent_log( 'solo-typing' );

		$this->assertSame( $report['requests'], $report['quality']['dispositions']['applied'] );
		$this->assertSame( 0, $report['quality']['dispositions']['escalated'] );
		$this->assertSame( 0, $report['quality']['lost_work'] );
	}

	public function test_cost_and_payload_metrics_are_populated() {
		$report = $this->run_intent_log( 'mixed-newsroom' );

		$this->assertArrayHasKey( 'mean', $report['service_us'] );
		$this->assertGreaterThanOrEqual( 0, $report['service_us']['mean'] );
		// Reads and idle polls are timed separately from ingest.
		$this->assertGreaterThan( 0, $report['read_us']['mean'] );
		$this->assertGreaterThan( 0, $report['idle_poll_us']['mean'] );
		$this->assertGreaterThan( 0, $report['payload_bytes']['request_p50'] );
		$this->assertGreaterThan( 0, $report['storage']['bytes'] );
		// The later-joiner read is timed, with the payload a fresh visitor
		// downloads to enter the room.
		$this->assertGreaterThan( 0, $report['join_us']['mean'] );
		$this->assertGreaterThan( 0, $report['payload_bytes']['join_response_p50'] );
		// The save path (cold materialize) is timed with its peak memory.
		$this->assertNotNull( $report['materialize_us'] );
		$this->assertGreaterThan( 0, $report['materialize_us']['mean'] );
		$this->assertGreaterThan( 0, $report['memory']['ingest_peak_bytes'] );
		$this->assertGreaterThan( 0, $report['memory']['materialize_peak_bytes'] );
		// Below the 100-row checkpoint interval: no history trims yet.
		$this->assertSame( 0, $report['storage']['trims'] );
		// Per-kind request counts and wire totals (the hosting cost card's
		// inputs) are populated and consistent.
		$counts = $report['request_counts'];
		$this->assertSame( $report['requests'], $counts['ingests'] );
		$this->assertGreaterThan( 0, $counts['reads_session'] );
		$this->assertSame( 3, $counts['reads_catchup'] );
		$this->assertGreaterThan( 0, $counts['idle_polls'] );
		$this->assertGreaterThan( 0, $report['wire']['request_bytes'] );
		$this->assertGreaterThan( 0, $report['wire']['response_bytes'] );
	}

	public function test_laggy_clients_escalate_or_settle_but_lose_nothing() {
		// 30 rounds so the laggy client (reads every 10th round) authors
		// from bases up to ~40 intents stale and catches up three times.
		$workload = WP_Sync_Bench_Workload::build( 'laggy-newsroom', 7, 30, 4, 4 );
		$post_id  = self::factory()->post->create(
			array( 'post_content' => $workload['post_content'] )
		);
		$storage  = new WP_Sync_Bench_Memory_Storage();
		$engine   = new WP_Intent_Log_Engine( $storage );

		$report = WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );

		// Stale bases may escalate or void benignly — but never lose work,
		// and the document must still match the engine's own dispositions.
		$this->assertSame( 0, $report['quality']['lost_work'] );
		$this->assertSame( array(), $report['quality']['convergence_failures'] );
		$this->assertTrue( $report['quality']['converged'] );
	}

	public function test_long_form_document_is_larger_and_converges() {
		$small = WP_Sync_Bench_Workload::build( 'solo-typing', 7, 8, 1, 4 );
		$large = WP_Sync_Bench_Workload::build( 'long-form', 7, 8, 1, 4 );
		$this->assertGreaterThan(
			5 * strlen( $small['post_content'] ),
			strlen( $large['post_content'] )
		);

		$report = $this->run_intent_log( 'long-form' );
		$this->assertSame( 0, $report['quality']['lost_work'] );
		$this->assertTrue( $report['quality']['converged'] );
	}

	public function test_convergence_oracle_accepts_matching_content() {
		$content = "<!-- wp:paragraph {\"align\":\"wide\"} -->\n<p> r0c0.0;Paragraph 1;</p>\n<!-- /wp:paragraph -->";

		$failures = WP_Sync_Bench_Intent_Log_Profile::verify_convergence(
			$content,
			1,
			array(
				array(
					'text'   => ' r0c0.0;',
					'status' => 'applied',
				),
				array(
					'text'   => ' r1c1.1;',
					'status' => 'escalated',
				),
			),
			array( 0 => 'wide' )
		);

		$this->assertSame( array(), $failures );
	}

	public function test_convergence_oracle_detects_corruption() {
		$content = "<!-- wp:paragraph -->\n<p>Paragraph 1 r9c9.9;</p>\n<!-- /wp:paragraph -->";

		$failures = WP_Sync_Bench_Intent_Log_Profile::verify_convergence(
			$content,
			2, // A dropped paragraph block.
			array(
				array(
					'text'   => ' r0c0.0;',
					'status' => 'applied', // Missing from content: lost.
				),
				array(
					'text'   => ' r9c9.9;',
					'status' => 'escalated', // Present in content: leaked.
				),
			),
			array( 0 => 'full' ) // Align register not honored.
		);

		$checks = array_column( $failures, 'check' );
		$this->assertContains( 'structure', $checks );
		$this->assertContains( 'applied-text', $checks );
		$this->assertContains( 'escalated-text', $checks );
		$this->assertContains( 'attr-register', $checks );
	}

	public function test_workload_generation_is_deterministic() {
		$a = WP_Sync_Bench_Workload::build( 'mixed-newsroom', 123, 10, 3, 5 );
		$b = WP_Sync_Bench_Workload::build( 'mixed-newsroom', 123, 10, 3, 5 );
		$this->assertSame( $a['rounds'], $b['rounds'] );

		$c = WP_Sync_Bench_Workload::build( 'mixed-newsroom', 124, 10, 3, 5 );
		$this->assertNotSame( $a['rounds'], $c['rounds'] );

		$d = WP_Sync_Bench_Workload::build( 'editorial-session', 123, 60, 3, 5 );
		$e = WP_Sync_Bench_Workload::build( 'editorial-session', 123, 60, 3, 5 );
		$this->assertSame( $d['rounds'], $e['rounds'] );
	}

	public function test_text_edits_carry_seeded_positions() {
		$workload  = WP_Sync_Bench_Workload::build( 'parallel-paragraphs', 7, 30, 3, 4 );
		$positions = array();
		foreach ( $workload['rounds'] as $edits ) {
			foreach ( $edits as $edit ) {
				if ( 'text' === $edit['op'] ) {
					// Every text edit carries an abstract position the
					// profiles map to engine coordinates (intent-log: an
					// offset from the client's observed field length;
					// yjs: an index in the client's own Y.Text; de-rtc: a
					// splice before the closing tag).
					$this->assertContains( $edit['position'], array( 'head', 'tail' ) );
					$positions[ $edit['position'] ] = true;
				} else {
					$this->assertArrayNotHasKey( 'position', $edit );
				}
			}
		}

		// The seeded draw exercises both positions (90 text edits here), so
		// typing is no longer all prepends.
		$this->assertArrayHasKey( 'head', $positions );
		$this->assertArrayHasKey( 'tail', $positions );
	}

	public function test_ingest_concurrency_histogram() {
		$workload  = WP_Sync_Bench_Workload::build( 'parallel-paragraphs', 7, 10, 3, 4 );
		$histogram = WP_Sync_Bench_Workload::ingest_concurrency_histogram( $workload['rounds'] );
		// Lock-step: every round has exactly 3 concurrent ingests.
		$this->assertSame( array( 3 => 10 ), $histogram );

		$session = WP_Sync_Bench_Workload::build( 'editorial-session', 7, 100, 3, 4 );
		$mixed   = WP_Sync_Bench_Workload::ingest_concurrency_histogram( $session['rounds'] );
		// Bursty session: concurrency varies round to round (and empty
		// rounds are excluded — nothing queues behind nothing).
		$this->assertNotEmpty( $mixed );
		$this->assertArrayNotHasKey( 0, $mixed );
	}

	public function test_workload_fill_controls_document_size() {
		$small = WP_Sync_Bench_Workload::build( 'solo-typing', 7, 4, 1, 8 );
		$big   = WP_Sync_Bench_Workload::build( 'solo-typing', 7, 4, 1, 8, 6000 );
		// ~6 KB x 8 paragraphs: the size-sweep axis.
		$this->assertGreaterThan( 40000, strlen( $big['post_content'] ) );
		$this->assertLessThan( 2000, strlen( $small['post_content'] ) );
	}

	public function test_structural_churn_generates_block_ops_with_discipline() {
		$workload = WP_Sync_Bench_Workload::build( 'structural-churn', 7, 30, 3, 4 );

		$inserts = array();
		$removes = array();
		$texts   = 0;
		foreach ( $workload['rounds'] as $edits ) {
			foreach ( $edits as $edit ) {
				if ( 'insert_block' === $edit['op'] ) {
					$inserts[ $edit['block_id'] ] = $edit['client'];
				} elseif ( 'remove_block' === $edit['op'] ) {
					$removes[] = $edit;
				} elseif ( 'text' === $edit['op'] ) {
					++$texts;
				}
			}
		}
		$this->assertNotEmpty( $inserts );
		$this->assertNotEmpty( $removes );
		$this->assertGreaterThan( 0, $texts );
		foreach ( $removes as $remove ) {
			// Discipline: removals only target the removing client's OWN
			// earlier insert (what keeps the marker oracle decidable).
			$this->assertArrayHasKey( $remove['block_id'], $inserts );
			$this->assertSame( $inserts[ $remove['block_id'] ], $remove['client'] );
		}
	}

	public function test_editorial_session_schedules_joins_bursts_and_readers() {
		$workload = WP_Sync_Bench_Workload::build( 'editorial-session', 7, 100, 3, 4 );

		$this->assertSame( 60, $workload['save_every'] );
		$first_round = $workload['rounds'][0];
		$this->assertArrayHasKey( 'edits', $first_round );
		$this->assertArrayHasKey( 'readers', $first_round );

		// The last-joining client reads nothing before its join round…
		$early_readers = array();
		foreach ( array_slice( $workload['rounds'], 0, 5 ) as $round ) {
			$early_readers = array_merge( $early_readers, $round['readers'] );
		}
		$this->assertNotContains( 2, $early_readers );
		// …and present clients poll even in rounds where they type nothing.
		$idle_reads = 0;
		foreach ( $workload['rounds'] as $round ) {
			$typed = array_column( $round['edits'], 'client' );
			foreach ( $round['readers'] as $reader ) {
				if ( ! in_array( $reader, $typed, true ) ) {
					++$idle_reads;
				}
			}
		}
		$this->assertGreaterThan( 0, $idle_reads );
	}

	public function test_structural_churn_converges_on_every_engine() {
		$workload = WP_Sync_Bench_Workload::build( 'structural-churn', 7, 30, 3, 4 );
		foreach ( array( 'WP_Intent_Log_Engine', 'WP_Yjs_Server_Engine', 'WP_De_RTC_Engine' ) as $engine_class ) {
			$post_id = self::factory()->post->create(
				array( 'post_content' => $workload['post_content'] )
			);
			$storage = new WP_Sync_Bench_Memory_Storage();
			$engine  = new $engine_class( $storage );

			$report = WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );

			$this->assertSame( 0, $report['quality']['lost_work'], $engine_class . ' lost work under structural churn' );
			$this->assertSame( array(), $report['quality']['convergence_failures'], $engine_class . ' failed convergence under structural churn' );
			$this->assertTrue( $report['quality']['converged'], $engine_class . ' did not converge under structural churn' );
			wp_delete_post( $post_id, true );
		}
	}

	public function test_save_sync_session_converges_on_every_engine() {
		// DE-RTC's native cadence, applied to every engine:
		// staggered ~10s save beats, 10s sync reads. The fair measurement
		// for the save-centric design; every engine must still converge
		// with zero loss at this cadence.
		$workload = WP_Sync_Bench_Workload::build( 'save-sync-session', 7, 60, 3, 6 );

		// The cadence shape itself: no client writes on two consecutive
		// rounds, and every client's reads are 10 rounds apart.
		foreach ( $workload['rounds'] as $round ) {
			$writers = array_unique( array_column( is_array( $round['edits'] ?? null ) ? $round['edits'] : $round, 'client' ) );
			$this->assertLessThanOrEqual( 1, count( $writers ), 'Save beats are staggered: at most one client saves per second.' );
		}
		$this->assertSame( array( 10, 10, 10 ), $workload['read_every'] );

		foreach ( array( 'WP_Intent_Log_Engine', 'WP_Yjs_Server_Engine', 'WP_De_RTC_Engine' ) as $engine_class ) {
			$post_id = self::factory()->post->create(
				array( 'post_content' => $workload['post_content'] )
			);
			$storage = new WP_Sync_Bench_Memory_Storage();
			$engine  = new $engine_class( $storage );

			$report = WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );

			$this->assertSame( 0, $report['quality']['lost_work'], $engine_class . ' lost work at save-sync cadence' );
			$this->assertSame( array(), $report['quality']['convergence_failures'], $engine_class . ' failed convergence at save-sync cadence' );
			$this->assertTrue( $report['quality']['converged'], $engine_class . ' did not converge at save-sync cadence' );
			wp_delete_post( $post_id, true );
		}
	}

	public function test_remove_contention_generates_cross_client_edit_vs_remove() {
		$workload = WP_Sync_Bench_Workload::build( 'remove-contention', 7, 30, 3, 4 );

		$seed_round = array(); // block_id => the round its insert was scripted.
		$inserter   = array(); // block_id => inserting client.
		$contended  = array(); // block_id => the round it was contended.
		foreach ( $workload['rounds'] as $round_index => $edits ) {
			$texts   = array(); // block_id => editing client (this round).
			$removes = array(); // block_id => removing client (this round).
			foreach ( $edits as $edit ) {
				if ( 'insert_block' === $edit['op'] ) {
					$seed_round[ $edit['block_id'] ] = $round_index;
					$inserter[ $edit['block_id'] ]   = $edit['client'];
				} elseif ( 'remove_block' === $edit['op'] ) {
					$removes[ $edit['block_id'] ] = $edit['client'];
				} elseif ( 'text' === $edit['op'] && isset( $edit['block_id'] ) ) {
					$texts[ $edit['block_id'] ] = $edit['client'];
				}
			}

			foreach ( $removes as $block_id => $remover ) {
				// Every removal is one half of a contention pair: a text
				// edit into the SAME block, in the SAME round, from a
				// DISTINCT client (clients=3 here, so the degenerate
				// same-client case cannot occur).
				$this->assertArrayHasKey( $block_id, $texts, 'a removal must pair with a concurrent text edit' );
				$this->assertNotSame( $texts[ $block_id ], $remover, 'editor and remover must be distinct clients' );
				// The block was seeded in an EARLIER round (every client
				// observed it before contending) and is contended once.
				$this->assertArrayHasKey( $block_id, $seed_round );
				$this->assertLessThan( $round_index, $seed_round[ $block_id ] );
				$this->assertArrayNotHasKey( $block_id, $contended );
				$contended[ $block_id ] = $round_index;
			}
		}
		$this->assertNotEmpty( $contended );

		// The point of the scenario: removals are NOT limited to the
		// remover's own inserts (the discipline every other scenario keeps).
		$cross_client = 0;
		foreach ( $contended as $block_id => $round_index ) {
			$remover = null;
			foreach ( $workload['rounds'][ $round_index ] as $edit ) {
				if ( 'remove_block' === $edit['op'] && $edit['block_id'] === $block_id ) {
					$remover = $edit['client'];
				}
			}
			if ( $remover !== $inserter[ $block_id ] ) {
				++$cross_client;
			}
		}
		$this->assertGreaterThan( 0, $cross_client );
	}

	public function test_field_sync_generates_property_writes_with_discipline() {
		$workload = WP_Sync_Bench_Workload::build( 'field-sync', 7, 30, 3, 4 );

		$writes    = array(
			'set_property' => 0,
			'set_terms'    => 0,
			'set_meta'     => 0,
		);
		$contended = 0;
		foreach ( $workload['rounds'] as $edits ) {
			$names  = array();
			$values = array();
			foreach ( $edits as $edit ) {
				if ( ! in_array( $edit['op'], WP_Sync_Bench_Workload::FIELD_OPS, true ) ) {
					continue;
				}
				++$writes[ $edit['op'] ];
				// Names come from the op's register palette; values are
				// DISTINCT within a round (the policy-isolation discipline:
				// identical concurrent writes read as agreement to a
				// three-way merge but escalate under a version check).
				if ( 'set_property' === $edit['op'] ) {
					$this->assertContains( $edit['name'], WP_Sync_Bench_Workload::PROPERTY_PALETTE );
					$this->assertIsString( $edit['value'] );
				} elseif ( 'set_terms' === $edit['op'] ) {
					// A taxonomy register: rest_base name, numerically
					// sorted whole term-ID set.
					$this->assertContains( $edit['name'], WP_Sync_Bench_Workload::TAXONOMY_PALETTE );
					$this->assertIsArray( $edit['value'] );
					$sorted = $edit['value'];
					sort( $sorted, SORT_NUMERIC );
					$this->assertSame( $sorted, $edit['value'] );
					foreach ( $edit['value'] as $term_id ) {
						$this->assertIsInt( $term_id );
					}
				} else {
					// A meta register: `meta.<key>` name from the palette.
					$this->assertContains( $edit['name'], WP_Sync_Bench_Workload::META_PALETTE );
					$this->assertStringStartsWith( 'meta.', $edit['name'] );
					$this->assertIsString( $edit['value'] );
				}
				$this->assertNotContains( $edit['value'], $values );
				$values[]               = $edit['value'];
				$names[ $edit['name'] ] = ( $names[ $edit['name'] ] ?? 0 ) + 1;
			}
			if ( array() !== $names && max( $names ) > 1 ) {
				++$contended;
			}
		}
		// The scenario exercises the whole register surface: scalar
		// properties, taxonomy term sets, and post meta all appear.
		$this->assertGreaterThan( 0, $writes['set_property'] );
		$this->assertGreaterThan( 0, $writes['set_terms'] );
		$this->assertGreaterThan( 0, $writes['set_meta'] );
		// ~25% of rounds put every client on the SAME register.
		$this->assertGreaterThan( 0, $contended );
	}

	public function test_field_sync_converges_on_every_engine() {
		$workload = WP_Sync_Bench_Workload::build( 'field-sync', 7, 30, 3, 4 );
		$reports  = array();
		foreach ( array( 'WP_Intent_Log_Engine', 'WP_Yjs_Server_Engine', 'WP_De_RTC_Engine' ) as $engine_class ) {
			$post_id = self::factory()->post->create(
				array( 'post_content' => $workload['post_content'] )
			);
			$storage = new WP_Sync_Bench_Memory_Storage();
			$engine  = new $engine_class( $storage );

			$report = WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );

			$this->assertSame( 0, $report['quality']['lost_work'], $engine_class . ' lost work under field sync' );
			$this->assertSame( array(), $report['quality']['convergence_failures'], $engine_class . ' failed convergence under field sync' );
			$this->assertTrue( $report['quality']['converged'], $engine_class . ' did not converge under field sync' );
			$reports[ $engine_class ] = $report;
			wp_delete_post( $post_id, true );
		}

		// The register-contention policies: intent-log escalates the later
		// writers of a same-register race (property-conflict); the CRDT
		// resolves silently (escalated is always 0). De-rtc parks property
		// conflicts as their own rows at PROPERTY grain while the proposal
		// reports applied, so field conflicts do not move its escalated
		// count — asserted implicitly by the profile's parked-row model
		// check inside the convergence assertions above.
		$this->assertGreaterThan( 0, $reports['WP_Intent_Log_Engine']['quality']['dispositions']['escalated'] );
		$this->assertSame( 0, $reports['WP_Yjs_Server_Engine']['quality']['dispositions']['escalated'] );
	}

	public function test_remove_contention_converges_on_every_engine() {
		$workload = WP_Sync_Bench_Workload::build( 'remove-contention', 7, 30, 3, 4 );
		foreach ( array( 'WP_Intent_Log_Engine', 'WP_Yjs_Server_Engine', 'WP_De_RTC_Engine' ) as $engine_class ) {
			$post_id = self::factory()->post->create(
				array( 'post_content' => $workload['post_content'] )
			);
			$storage = new WP_Sync_Bench_Memory_Storage();
			$engine  = new $engine_class( $storage );

			$report = WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );

			$this->assertSame( 0, $report['quality']['lost_work'], $engine_class . ' lost work under remove contention' );
			$this->assertSame( array(), $report['quality']['convergence_failures'], $engine_class . ' failed convergence under remove contention' );
			$this->assertTrue( $report['quality']['converged'], $engine_class . ' did not converge under remove contention' );
			wp_delete_post( $post_id, true );
		}
	}

	public function test_intent_log_floor_reset_retries_recover_stale_voided_edits() {
		$interval = static function () {
			return 20;
		};
		add_filter( 'wp_sync_intent_log_checkpoint_interval', $interval );

		try {
			// 30 rounds x 3 clients against a 20-row checkpoint interval:
			// checkpoints raise the retention floor mid-round, stale-voiding
			// in-flight intents, including seed-round INSERTS whose blocks
			// the workload later contends. The profile's floor-reset retry
			// lane must re-author them (visible as followups), or those
			// contentions would target blocks the room never had and show
			// phantom missing-target lost work.
			$report = $this->run_intent_log_rounds( 'remove-contention', 30, 3 );

			$this->assertGreaterThan( 0, $report['quality']['dispositions']['voided'], 'expected stale-base voids to exercise the retry lane' );
			$this->assertGreaterThan( 0, $report['storage']['followups'], 'expected floor-reset re-authoring follow-ups' );
			$this->assertSame( 0, $report['quality']['lost_work'] );
			$this->assertSame( array(), $report['quality']['convergence_failures'] );
			$this->assertTrue( $report['quality']['converged'] );
		} finally {
			remove_filter( 'wp_sync_intent_log_checkpoint_interval', $interval );
		}
	}

	public function test_editorial_session_runs_with_scheduled_readers_and_autosaves() {
		$workload = WP_Sync_Bench_Workload::build( 'editorial-session', 7, 120, 3, 4 );
		$post_id  = self::factory()->post->create(
			array( 'post_content' => $workload['post_content'] )
		);
		$storage  = new WP_Sync_Bench_Memory_Storage();
		$engine   = new WP_Intent_Log_Engine( $storage );

		$report = WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );

		$this->assertSame( 0, $report['quality']['lost_work'] );
		$this->assertSame( array(), $report['quality']['convergence_failures'] );
		$this->assertTrue( $report['quality']['converged'] );
		// 120 rounds / save_every 60 = 2 in-session autosaves, plus the 5
		// end-of-session cold samples.
		$this->assertCount( 7, $report['materialize_us_series'] );
		$this->assertSame( 2, $report['request_counts']['saves_session'] );
		// Present-but-idle clients read every round: far more reads than
		// edits (the burst duty cycle is well under 100%).
		$this->assertGreaterThan( $report['requests'], $report['request_counts']['reads_session'] );
	}

	/**
	 * Runs a workload for one scenario against the yjs-server engine
	 * (the real-Yjs authoring profile).
	 *
	 * @param string $scenario Scenario slug.
	 * @param int    $rounds   Rounds.
	 * @param int    $clients  Clients.
	 * @return array Report.
	 */
	private function run_yjs_server( string $scenario, int $rounds = 8, int $clients = 3 ): array {
		$workload = WP_Sync_Bench_Workload::build( $scenario, 7, $rounds, $clients, 4 );
		$post_id  = self::factory()->post->create(
			array( 'post_content' => $workload['post_content'] )
		);
		$storage  = new WP_Sync_Bench_Memory_Storage();
		$engine   = new WP_Yjs_Server_Engine( $storage );
		return WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );
	}

	public function test_yjs_server_gets_the_real_yjs_profile_and_observable_quality() {
		$report = $this->run_yjs_server( 'parallel-paragraphs' );

		$this->assertSame( 'yjs-server', $report['engine'] );
		$this->assertSame( 'yjs-server', $report['profile'] );
		// The server merges, so quality IS observable — the relay's
		// structural limitation does not apply here.
		$this->assertTrue( $report['quality']['observable'] );
		$this->assertTrue( $report['quality']['converged'] );
		$this->assertSame( array(), $report['quality']['convergence_failures'] );
		$this->assertSame( 0, $report['quality']['lost_work'] );
		// Clean parallel edits all merge.
		$this->assertSame( $report['requests'], $report['quality']['dispositions']['applied'] );
		// Real Yjs payloads, real storage bytes.
		$this->assertGreaterThan( 0, $report['payload_bytes']['request_p50'] );
		$this->assertGreaterThan( 0, $report['storage']['bytes'] );
	}

	public function test_yjs_server_contended_paragraph_merges_silently_and_converges() {
		$report = $this->run_yjs_server( 'contended-paragraph' );

		// The CRDT auto-merges register conflicts (last-writer-wins by CRDT
		// rules) instead of escalating — the policy difference with
		// intent-log, reported honestly: zero escalations, still converged,
		// no text lost.
		$this->assertSame( 0, $report['quality']['dispositions']['escalated'] );
		$this->assertSame( 0.0, $report['quality']['escalation_rate'] );
		$this->assertTrue( $report['quality']['converged'] );
		$this->assertSame( array(), $report['quality']['convergence_failures'] );
		$this->assertSame( 0, $report['quality']['lost_work'] );
	}

	public function test_yjs_server_laggy_clients_converge() {
		// The laggy client reads every 10th round: it authors from stale
		// state and its catch-up reads replay deep tails.
		$report = $this->run_yjs_server( 'laggy-newsroom', 30, 4 );

		$this->assertTrue( $report['quality']['converged'] );
		$this->assertSame( array(), $report['quality']['convergence_failures'] );
		$this->assertSame( 0, $report['quality']['lost_work'] );
	}

	/**
	 * Runs a workload for one scenario against the de-rtc engine (the
	 * whole-content proposal profile with the lineage oracle).
	 *
	 * @param string $scenario Scenario slug.
	 * @param int    $rounds   Rounds.
	 * @param int    $clients  Clients.
	 * @return array Report.
	 */
	private function run_de_rtc( string $scenario, int $rounds = 8, int $clients = 3 ): array {
		$workload = WP_Sync_Bench_Workload::build( $scenario, 7, $rounds, $clients, 4 );
		$post_id  = self::factory()->post->create(
			array( 'post_content' => $workload['post_content'] )
		);
		$storage  = new WP_Sync_Bench_Memory_Storage();
		$engine   = new WP_De_RTC_Engine( $storage );
		return WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );
	}

	public function test_de_rtc_gets_the_proposal_profile_and_observable_quality() {
		$report = $this->run_de_rtc( 'parallel-paragraphs' );

		$this->assertSame( 'de-rtc', $report['engine'] );
		$this->assertSame( 'de-rtc', $report['profile'] );
		$this->assertTrue( $report['quality']['observable'] );
		$this->assertTrue( $report['quality']['converged'] );
		$this->assertSame( array(), $report['quality']['convergence_failures'] );
		$this->assertSame( 0, $report['quality']['lost_work'] );
		// Distinct paragraphs three-way merge clean: everything applies.
		$this->assertSame( $report['requests'], $report['quality']['dispositions']['applied'] );
		$this->assertSame( 0, $report['quality']['dispositions']['escalated'] );
		// Whole-content proposals: request bytes scale with the document.
		$this->assertGreaterThan( 0, $report['payload_bytes']['request_p50'] );
		$this->assertGreaterThan( 0, $report['storage']['bytes'] );
	}

	public function test_de_rtc_contended_paragraph_salvages_conflicts_and_loses_nothing() {
		$workload = WP_Sync_Bench_Workload::build( 'contended-paragraph', 7, 8, 3, 4 );
		$post_id  = self::factory()->post->create(
			array( 'post_content' => $workload['post_content'] )
		);
		$storage  = new WP_Sync_Bench_Memory_Storage();
		$engine   = new WP_De_RTC_Engine( $storage );
		$report   = WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );

		// Concurrent restyles of the same block from the same base are a
		// genuine conflict. Since per-block salvage landed, the clean
		// remainder of each proposal lands while exactly the conflicted
		// blocks park for a human decision — surfaced as durable review
		// rows, never silently merged, never dropped.
		$response = $engine->get_updates_since( 'postType/post:' . $post_id, 999, 0, array() );
		$parked   = array_filter(
			$response['updates'],
			static function ( $update ) {
				return WP_De_RTC_Engine::UPDATE_TYPE_PARKED === $update['type'];
			}
		);
		$this->assertGreaterThan( 0, count( $parked ), 'Conflicts must surface as parked review rows.' );
		$this->assertSame( 0, $report['quality']['lost_work'] );
		$this->assertSame( array(), $report['quality']['convergence_failures'] );
		$this->assertTrue( $report['quality']['converged'] );
	}

	public function test_de_rtc_laggy_clients_converge_and_lose_nothing() {
		// The laggy client reads every 10th round while peers land ~3
		// versions per round. Its base still stays mostly fresh: like the
		// shipping codec (whose polling transport returns rows and
		// dispositions in the same response), every APPLIED proposal
		// advances the base at settle, so steady-state lag alone no longer
		// ages a base out of the version-snapshot window — deep transforms
		// and escalations happen, lost work must not.
		$report = $this->run_de_rtc( 'laggy-newsroom', 30, 4 );

		$this->assertSame( 0, $report['quality']['lost_work'] );
		$this->assertSame( array(), $report['quality']['convergence_failures'] );
		$this->assertTrue( $report['quality']['converged'] );
	}

	public function test_de_rtc_stale_base_voids_retry_after_deep_read_gap() {
		// The reconnect shape. Since per-block salvage landed, a
		// PRESENT client can barely age out anymore — even its conflicts
		// partially apply and advance its base. What still produces
		// stale-base voids is genuine ABSENCE: a client that goes silent
		// (offline tab) while peers advance the canonical past the
		// engine's bounded version-snapshot window (20; no aware saves
		// happen in this workload, so no revision carries the base
		// either), then writes from its ancient base before its first
		// read back. Those proposals void `unknown-base-version` and the
		// profile's retry-at-fresh-base lane re-proposes them after the
		// reconnect read.
		$workload                  = WP_Sync_Bench_Workload::build( 'contended-paragraph', 7, 30, 3, 4 );
		$workload['read_every'][2] = 25;
		foreach ( $workload['rounds'] as $i => $round ) {
			// Client 2 falls silent for rounds 2..24 (0-based 1..23).
			if ( $i >= 1 && $i < 24 && is_array( $round ) && ! isset( $round['edits'] ) ) {
				$workload['rounds'][ $i ] = array_values(
					array_filter(
						$round,
						static function ( $edit ) {
							return 2 !== (int) ( $edit['client'] ?? -1 );
						}
					)
				);
			}
		}
		$post_id = self::factory()->post->create(
			array( 'post_content' => $workload['post_content'] )
		);
		$storage = new WP_Sync_Bench_Memory_Storage();
		$engine  = new WP_De_RTC_Engine( $storage );

		$report = WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );

		$this->assertGreaterThan( 0, $report['quality']['dispositions']['voided'], 'expected stale-base voids to exercise the retry lane' );
		$this->assertGreaterThan( 0, $report['storage']['followups'], 'expected retry follow-up proposals' );
		$this->assertSame( 0, $report['quality']['lost_work'] );
		$this->assertSame( array(), $report['quality']['convergence_failures'] );
		$this->assertTrue( $report['quality']['converged'] );
	}

	public function test_de_rtc_solo_typing_is_all_applied() {
		$report = $this->run_de_rtc( 'solo-typing', 8, 1 );

		$this->assertSame( $report['requests'], $report['quality']['dispositions']['applied'] );
		$this->assertSame( 0, $report['quality']['dispositions']['escalated'] );
		$this->assertSame( 0, $report['quality']['lost_work'] );
		$this->assertTrue( $report['quality']['converged'] );
	}

	public function test_unknown_engine_falls_back_to_the_opaque_relay_profile() {
		// The relay fixture engine has no dedicated profile, so the registry
		// must resolve the opaque fallback: relay-convention updates that a
		// store-and-forward engine accepts, quality reported as
		// unobservable rather than faked, and the runner playing the
		// nominated compactor's part.
		$workload = WP_Sync_Bench_Workload::build( 'parallel-paragraphs', 7, 30, 3, 4 );
		$post_id  = self::factory()->post->create(
			array( 'post_content' => $workload['post_content'] )
		);
		$storage  = new WP_Sync_Bench_Memory_Storage();
		$engine   = new Test_Opaque_Relay_Engine( $storage );

		$report = WP_Sync_Bench_Runner::run( $engine, $storage, $post_id, $workload );

		$this->assertSame( 'test-opaque-relay', $report['engine'] );
		$this->assertSame( 'opaque-relay', $report['profile'] );
		$this->assertFalse( $report['quality']['observable'] );
		$this->assertNull( $report['quality']['converged'] );
		$this->assertSame( 0, $report['quality']['lost_work'] );
		// 30 rounds x 3 clients = 90 updates against the 50-row threshold:
		// the nominated compactor answered should_compact, and each accepted
		// compaction trimmed history.
		$this->assertGreaterThan( 0, $report['storage']['followups'] );
		$this->assertGreaterThan( 0, $report['storage']['trims'] );
		$this->assertGreaterThan( 0, $report['storage']['rows'] );
		// The relay has no document to materialize: reported as null, and
		// the join read is still timed (it is engine-generic).
		$this->assertNull( $report['materialize_us'] );
		$this->assertGreaterThan( 0, $report['join_us']['mean'] );
	}

	public function test_profile_registry_filter_maps_an_engine_to_a_profile() {
		$filter = static function ( array $profiles ): array {
			$profiles['test-opaque-relay'] = Bench_Test_Named_Relay_Profile::class;
			return $profiles;
		};
		add_filter( 'wp_sync_bench_authoring_profiles', $filter );

		try {
			$workload = WP_Sync_Bench_Workload::build( 'solo-typing', 7, 4, 1, 4 );
			$profile  = WP_Sync_Bench_Profiles::for_engine( 'test-opaque-relay', 0, $workload );
			$this->assertInstanceOf( Bench_Test_Named_Relay_Profile::class, $profile );
			$this->assertSame( 'bench-test-named-relay', $profile->name() );
		} finally {
			remove_filter( 'wp_sync_bench_authoring_profiles', $filter );
		}
	}

	public function test_profile_registry_rejects_a_broken_registration() {
		$filter = static function ( array $profiles ): array {
			// Not a class that implements the profile interface.
			$profiles['test-opaque-relay'] = 'Bench_Class_That_Does_Not_Exist';
			return $profiles;
		};
		add_filter( 'wp_sync_bench_authoring_profiles', $filter );

		try {
			$workload = WP_Sync_Bench_Workload::build( 'solo-typing', 7, 4, 1, 4 );
			$profile  = WP_Sync_Bench_Profiles::for_engine( 'test-opaque-relay', 0, $workload );
			// A broken registration must not fake a dedicated profile.
			$this->assertInstanceOf( WP_Sync_Bench_Opaque_Relay_Profile::class, $profile );
		} finally {
			remove_filter( 'wp_sync_bench_authoring_profiles', $filter );
		}
	}

	public function test_yjs_server_checkpoints_bound_storage_without_client_help() {
		$interval = static function () {
			return 20;
		};
		add_filter( 'wp_sync_yjs_server_checkpoint_interval', $interval );

		try {
			// 40 rounds x 3 clients = 120 updates against a 20-row interval.
			$report = $this->run_yjs_server( 'parallel-paragraphs', 40, 3 );

			// No client follow-ups (should_compact never fires)…
			$this->assertSame( 0, $report['storage']['followups'] );
			// …yet the room stays bounded: the server checkpointed and
			// trimmed by itself — and the trim count makes that cadence
			// visible (120 updates against a 20-row interval).
			$this->assertGreaterThan( 0, $report['storage']['trims'] );
			$this->assertLessThan( 60, $report['storage']['rows'] );
			$this->assertTrue( $report['quality']['converged'] );
			$this->assertSame( 0, $report['quality']['lost_work'] );
		} finally {
			remove_filter( 'wp_sync_yjs_server_checkpoint_interval', $interval );
		}
	}
}

if ( ! class_exists( 'Bench_Test_Named_Relay_Profile' ) ) {
	/**
	 * TEST FIXTURE: a distinctly-named profile, for asserting the
	 * `wp_sync_bench_authoring_profiles` filter resolves registrations.
	 */
	class Bench_Test_Named_Relay_Profile extends WP_Sync_Bench_Opaque_Relay_Profile {
		/**
		 * Profile name.
		 *
		 * @return string Profile name.
		 */
		public function name(): string {
			return 'bench-test-named-relay';
		}
	}
}
