<?php
/**
 * The de-rtc authoring profile: whole-content proposals + the lineage
 * oracle.
 *
 * Each simulated client keeps a local working copy of the document and the
 * version whose canonical content that copy incorporates (base = last
 * version APPLIED to the doc — the client adapter's rule). An edit is
 * applied to the local copy and submitted as one proposal
 * `{proposalId, baseVersion, proposedContent, proposedProperties,
 * clientUpdate: null}` — `clientUpdate: null` is what the shipping client
 * sends; the server's engine-unaware-writer lane derives operations, and
 * `proposedProperties` re-carries the client's FULL entity-property map on
 * every proposal (the shipping client's rule; the server merges each
 * property three-way against the same base version, so unchanged entries
 * are no-ops). Scalar properties, taxonomy term sets (rest_base names,
 * whole term-ID arrays the engine set-compares), and `meta.<key>` meta
 * registers are all just entries in that map. A conflicting property parks as its own `parked`
 * row while the proposal itself still reports `applied` — the engine's
 * escalation grain for fields is a property, not the proposal — so the
 * profile mirrors the engine's per-property three-way rule to know how
 * each register write settled, and score() asserts both the canonical
 * property map and the parked rows match that model exactly. Reads deliver
 * server-authored canonical `content` rows, which the client adopts
 * wholesale (safe here because every edit settles synchronously: applied
 * work is already IN the canonical row, and parked work was reverted from
 * the local copy when its disposition arrived). An APPLIED proposal also
 * advances the client's base at settle time, mirroring the shipping
 * codec's own-accepted-row handling: the polling transport returns rows
 * and dispositions in the SAME response, so production's base advance is
 * row-driven and immediate — without it, a client that reads rarely
 * would re-propose already-applied content against a pre-apply base, a
 * duplication window production never has (see settle()).
 *
 * Retry is part of the protocol: the engine voids proposals whose base
 * version aged out of the bounded snapshot window (`unknown-base-version`)
 * and expects the client to re-propose against a fresher base. Without
 * modeling that, a laggy client would show phantom lost work. The profile
 * queues such edits and re-submits them — coalesced into ONE proposal,
 * like the adapter's single in-flight proposal — as a follow-up ingest
 * right after the next read hands the client a fresh base. One retry per
 * edit: a second stale-base void parks the edit instead.
 *
 * Dispositions map to the shared accounting: `applied` (merged, canonical
 * advanced), `escalated` (parked for human decision — the author keeps
 * their local copy in production; the harness reverts it so later
 * proposals stay clean and the oracle can assert it stayed OUT of the
 * canonical), `voided` (stale base → retry; anything else is lost work).
 *
 * Quality is scored with an oracle matched to the engine's merge
 * semantics: applied tokens appear in the canonical exactly once, parked
 * tokens not at all, block structure intact, each align register equal to
 * the last APPLIED write that actually changed it against its own base
 * (three-way merges preserve untouched registers, so a no-op write must
 * not move the expectation), plus the version lineage: content rows chain
 * v(N)→v(N+1) with no gaps, their version set matches the applied
 * dispositions exactly, and after full catch-up every client's adopted
 * copy equals the materialized canonical.
 *
 * @package gutenberg
 */

if ( ! class_exists( 'WP_Sync_Bench_De_RTC_Profile' ) ) {

	/**
	 * Simulated de-rtc proposal clients.
	 */
	class WP_Sync_Bench_De_RTC_Profile implements WP_Sync_Bench_Authoring_Profile {
		/** Void reasons that are NOT lost work for this engine: a stale base
		 * is retried against a fresher one (the protocol's contract), and a
		 * malformed row never carries real content. The edit-vs-remove
		 * contention class adds nothing here: whichever side of the conflict
		 * reaches the server second ESCALATES (the whole proposal parks for
		 * review; a three-way merge refuses to auto-resolve
		 * removed-in-one/modified-in-the-other), which the shared accounting
		 * already covers.
		 *
		 * @var string[]
		 */
		const BENIGN_VOID_REASONS = array(
			'unknown-base-version',
			'invalid-payload',
		);

		/**
		 * Workload from the generator.
		 *
		 * @var array
		 */
		private $workload;

		/**
		 * Simulated client count.
		 *
		 * @var int
		 */
		private $client_count;

		/**
		 * Per-client local working copy.
		 *
		 * @var string[]
		 */
		private $content = array();

		/**
		 * Per-client base: the version whose canonical content the local
		 * copy incorporates.
		 *
		 * @var string[]
		 */
		private $base_version = array();

		/**
		 * Per-client entity-property map: the canonical map the client last
		 * adopted, plus its own applied local changes (parked changes are
		 * reverted, so between reads the map always equals the canonical at
		 * the client's base except for names it is actively writing).
		 *
		 * @var array<int, array<string, mixed>>
		 */
		private $client_props = array();

		/**
		 * Model of the CANONICAL property map, advanced in server order by
		 * replaying the engine's per-property three-way rule at settle time.
		 * This is the oracle's expected final property state.
		 *
		 * @var array<string, mixed>
		 */
		private $canonical_props = array();

		/**
		 * Model snapshots of the canonical property map per applied version
		 * ( version => map ), for checking each broadcast content row's
		 * `properties` against the model.
		 *
		 * @var array<string, array<string, mixed>>
		 */
		private $model_props_by_version = array();

		/**
		 * Property writes the model says the engine parked
		 * ( parked id "proposalId:name" => array( name, value ) ).
		 *
		 * @var array<string, array>
		 */
		private $expected_parked_props = array();

		/**
		 * Property-conflict `parked` rows actually delivered on the
		 * wire ( parked id => array( name, value ) ).
		 *
		 * @var array<string, array>
		 */
		private $observed_parked_props = array();

		/**
		 * Whether the model sees EVERY ingest and can be asserted against
		 * the wire (false in the multi-process concurrency probe, where each
		 * process only observes its own proposals). Also gates the
		 * settle-time base advance: its fast-forward reasoning holds only in
		 * the synchronous single-process runner.
		 *
		 * @var bool
		 */
		private $assert_model = true;

		/**
		 * Engine under test, stashed at bootstrap for the settle-time
		 * canonical adoption (see settle()).
		 *
		 * @var WP_Sync_Engine|null
		 */
		private $engine = null;

		/**
		 * Room identifier, stashed at bootstrap.
		 *
		 * @var string
		 */
		private $room = '';

		/**
		 * In-flight bookkeeping: client => proposalId => edit records.
		 *
		 * @var array<int, array<string, array>>
		 */
		private $pending = array();

		/**
		 * Per-client edits voided at a stale base, awaiting one retry.
		 *
		 * @var array<int, array>
		 */
		private $retry_queue = array();

		/**
		 * Monotonic proposalId counter.
		 *
		 * @var int
		 */
		private $proposal_seq = 0;

		/**
		 * Oracle input: token => final settlement ('applied' or 'parked').
		 *
		 * @var array<string, string>
		 */
		private $expected_texts = array();

		/**
		 * Oracle input: token => the INSERTED block's marker it was written
		 * into (absent for genesis-targeted tokens). An applied token whose
		 * target block ends up removed is expected to vanish with it, the
		 * edit-vs-remove scoping rule.
		 *
		 * @var array<string, string>
		 */
		private $text_targets = array();

		/**
		 * Oracle input: paragraph index => last applied CHANGED align write.
		 *
		 * @var array<int, string|null>
		 */
		private $expected_align = array();

		/**
		 * Oracle input: inserted-block marker => 'alive' | 'absent', from
		 * insert/remove dispositions.
		 *
		 * @var array<string, string>
		 */
		private $expected_markers = array();

		/**
		 * Lineage: content-row version => its baseVersion, from read rows.
		 *
		 * @var array<string, string>
		 */
		private $row_lineage = array();

		/**
		 * Lineage: applied-disposition version => proposalId.
		 *
		 * @var array<string, string>
		 */
		private $applied_versions = array();

		/**
		 * Content of the highest-version row any client received.
		 *
		 * @var array{seq: int, content: string}|null
		 */
		private $latest_row = null;

		/**
		 * Lineage failures detected while observing (inconsistent rows).
		 *
		 * @var array
		 */
		private $observe_failures = array();

		/**
		 * Constructor (the factory contract).
		 *
		 * @param int   $post_id  Seeded post (room target, unused here).
		 * @param array $workload Workload from the generator.
		 */
		public function __construct( int $post_id, array $workload ) { // phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- $post_id is part of the factory contract.
			$this->workload     = $workload;
			$this->client_count = max( 1, (int) $workload['clients'] );
			// The concurrency worker marks its workload multi_process: this
			// profile's canonical-property model only sees the local
			// process's ingests there, so wire asserts would false-alarm.
			$this->assert_model = empty( $workload['multi_process'] );
		}

		/**
		 * Profile name.
		 *
		 * @return string Profile name.
		 */
		public function name(): string {
			return 'de-rtc';
		}

		/**
		 * Bootstraps each client from the genesis snapshot row (an untimed
		 * join read, like the yjs-server profile's).
		 *
		 * @param WP_Sync_Engine $engine Engine under test.
		 * @param string         $room   Room identifier.
		 * @return array<int, int> Initial read cursor per client.
		 */
		public function bootstrap( WP_Sync_Engine $engine, string $room ): array {
			$this->engine = $engine;
			$this->room   = $room;

			$cursors = array();
			for ( $client = 0; $client < $this->client_count; $client++ ) {
				$response = $engine->get_updates_since( $room, $client, 0, array() );
				$latest   = null;
				foreach ( $response['updates'] as $row ) {
					$decoded = json_decode( (string) $row['data'], true );
					if ( is_array( $decoded ) && is_string( $decoded['version'] ?? null ) && is_string( $decoded['content'] ?? null ) ) {
						$latest = $decoded;
					}
				}
				$this->content[ $client ]      = is_array( $latest ) ? (string) $latest['content'] : '';
				$this->base_version[ $client ] = is_array( $latest ) ? (string) $latest['version'] : 'v1';
				$this->client_props[ $client ] = is_array( $latest ) && is_array( $latest['properties'] ?? null ) ? $latest['properties'] : array();
				$this->pending[ $client ]      = array();
				$this->retry_queue[ $client ]  = array();
				$cursors[ $client ]            = (int) $response['end_cursor'];

				// The canonical-property model starts at the genesis seed
				// (identical for every client — the same row).
				if ( 0 === $client && is_array( $latest ) ) {
					$this->canonical_props = $this->client_props[ $client ];

					$this->model_props_by_version[ (string) $latest['version'] ] = $this->canonical_props;
				}
			}
			return $cursors;
		}

		/**
		 * De-rtc reads carry no extra context (awareness rides the transport
		 * envelope, not the engine read).
		 *
		 * @return array Read context.
		 */
		public function read_context(): array {
			return array();
		}

		/**
		 * Applies the edit to the client's local copy and proposes the whole
		 * document against the client's base version.
		 *
		 * @param int   $client      Authoring client index.
		 * @param array $edit        Workload edit.
		 * @param int   $round_index Round the edit belongs to.
		 * @return array Updates payload.
		 */
		public function author( int $client, array $edit, int $round_index ): array {
			$record = $this->build_edit_record( $edit );
			$this->apply_edit( $client, $record );

			$proposal_id = 'b' . $round_index . '-' . ( $this->proposal_seq++ );

			$this->pending[ $client ][ $proposal_id ] = array( $record );

			return $this->proposal_updates( $client, $proposal_id );
		}

		/**
		 * Settles the primary proposal's disposition (1:1 with the edit).
		 *
		 * @param int   $client      Authoring client index.
		 * @param array $edit        The workload edit the disposition settles.
		 * @param array $disposition Engine disposition.
		 */
		public function record_disposition( int $client, array $edit, array $disposition ): void { // phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- $edit is tracked via the pending proposal record.
			$this->settle( $client, $disposition );
		}

		/**
		 * Benign-void classification for de-rtc: a stale base is retried,
		 * never lost.
		 *
		 * @param string $reason Void reason.
		 * @return bool True when not lost work.
		 */
		public function is_benign_void( string $reason ): bool {
			return in_array( $reason, self::BENIGN_VOID_REASONS, true );
		}

		/**
		 * Adopts the newest canonical row wholesale and collects lineage.
		 *
		 * Safe adoption: every one of this client's edits has settled by the
		 * time it reads (applied work is in the row; parked and queued work
		 * was already reverted from the local copy), so the canonical IS the
		 * client's correct next base.
		 *
		 * @param int   $client   Reading client index.
		 * @param array $response get_updates_since() response.
		 */
		public function observe( int $client, array $response ): void {
			$latest    = null;
			$announced = null;
			foreach ( (array) ( $response['updates'] ?? array() ) as $row ) {
				$decoded = json_decode( (string) $row['data'], true );
				if ( ! is_array( $decoded ) ) {
					continue;
				}

				// A property conflict parks as its own row (the proposal
				// itself reports applied); collect them so score() can match
				// the wire against the model's predicted parks. Rows are
				// broadcast to every client — keyed by parked id, so
				// re-observations are idempotent.
				if ( WP_De_RTC_Engine::UPDATE_TYPE_PARKED === ( $row['type'] ?? '' ) && is_array( $decoded['property'] ?? null ) ) {
					$parked_id = (string) ( $decoded['proposalId'] ?? '' );
					if ( '' !== $parked_id ) {
						$this->observed_parked_props[ $parked_id ] = array(
							'name'  => (string) ( $decoded['property']['name'] ?? '' ),
							'value' => $decoded['property']['value'] ?? null,
						);
					}
					continue;
				}

				$is_announce = WP_De_RTC_Engine::UPDATE_TYPE_ANNOUNCE === ( $row['type'] ?? '' );
				if ( ! is_string( $decoded['version'] ?? null ) || ( ! $is_announce && ! is_string( $decoded['content'] ?? null ) ) ) {
					continue;
				}
				if ( $is_announce && is_string( $decoded['baseVersion'] ?? null ) ) {
					$version = $decoded['version'];
					if ( isset( $this->row_lineage[ $version ] ) && $this->row_lineage[ $version ] !== $decoded['baseVersion'] ) {
						$this->observe_failures[] = array(
							'check'  => 'lineage',
							'detail' => sprintf( "broadcast row '%s' was delivered with two different base versions ('%s', '%s')", $version, $this->row_lineage[ $version ], $decoded['baseVersion'] ),
						);
					}
					$this->row_lineage[ $version ] = $decoded['baseVersion'];
				}

				// Each broadcast row's property map must match the model's
				// canonical map at that version (the property analog of the
				// lineage check). Only assertable when the model saw every
				// ingest (not in the multi-process probe).
				if (
					$this->assert_model &&
					is_array( $decoded['properties'] ?? null ) &&
					isset( $this->model_props_by_version[ $decoded['version'] ] ) &&
					self::props_json( $decoded['properties'] ) !== self::props_json( $this->model_props_by_version[ $decoded['version'] ] )
				) {
					$this->observe_failures[] = array(
						'check'  => 'prop-lineage',
						'detail' => sprintf( "broadcast row '%s' carries a property map that does not match the per-property three-way model", $decoded['version'] ),
					);
				}

				if ( $is_announce ) {
					// Announce model: version + hash + properties,
					// no content — the newest one drives a fetch below.
					$seq = (int) ltrim( $decoded['version'], 'v' );
					if ( null === $announced || $seq > $announced['seq'] ) {
						$announced = array(
							'seq'     => $seq,
							'version' => $decoded['version'],
						);
					}
					continue;
				}

				$latest = $decoded;

				$seq = (int) ltrim( $decoded['version'], 'v' );
				if ( null === $this->latest_row || $seq > $this->latest_row['seq'] ) {
					$this->latest_row = array(
						'seq'        => $seq,
						'content'    => $decoded['content'],
						'properties' => is_array( $decoded['properties'] ?? null ) ? $decoded['properties'] : array(),
					);
				}
			}

			/*
			 * Announce model catch-up: behind an announced version with no
			 * content in the batch — fetch canonical exactly as the real
			 * session codec does (a `fetch` row answered by one synthesized
			 * snapshot). The fetch cost is deliberately part of the profile:
			 * it is what real clients now pay.
			 */
			$base_seq = (int) ltrim( (string) $this->base_version[ $client ], 'v' );
			if ( null !== $announced && $announced['seq'] > $base_seq && null !== $this->engine && ( null === $latest || (int) ltrim( (string) $latest['version'], 'v' ) < $announced['seq'] ) ) {
				$this->engine->handle_updates(
					$this->room,
					$client,
					0,
					array(
						array(
							'type' => WP_De_RTC_Engine::UPDATE_TYPE_FETCH,
							'data' => (string) wp_json_encode( array( 'haveVersion' => (string) $this->base_version[ $client ] ) ),
						),
					),
					array()
				);
				$fetch_response = $this->engine->get_updates_since( $this->room, $client, PHP_INT_MAX, array() );
				foreach ( (array) ( $fetch_response['updates'] ?? array() ) as $row ) {
					$decoded = json_decode( (string) $row['data'], true );
					if ( is_array( $decoded ) && is_string( $decoded['version'] ?? null ) && is_string( $decoded['content'] ?? null ) ) {
						$latest = $decoded;
						$seq    = (int) ltrim( $decoded['version'], 'v' );
						if ( null === $this->latest_row || $seq > $this->latest_row['seq'] ) {
							$this->latest_row = array(
								'seq'        => $seq,
								'content'    => $decoded['content'],
								'properties' => is_array( $decoded['properties'] ?? null ) ? $decoded['properties'] : array(),
							);
						}
					}
				}
			}

			/*
			 * Version gate, the shipping bridge's applyCanonical rule: a
			 * content row at or below the client's current version is
			 * IGNORED, never adopted. The row stream re-delivers old
			 * content-carrying rows as a matter of course — a compaction
			 * checkpoint stores a snapshot of the head at checkpoint TIME,
			 * which lands at a cursor many rows later — so a client whose
			 * settle-time advance already carried it past that version must
			 * not roll back to it (a client that adopted a checkpoint row
			 * older than its own accepted proposals ended the session behind
			 * the canonical; issue #70).
			 */
			if ( is_array( $latest ) && (int) ltrim( (string) $latest['version'], 'v' ) > $base_seq ) {
				$this->content[ $client ]      = (string) $latest['content'];
				$this->base_version[ $client ] = (string) $latest['version'];
				if ( is_array( $latest['properties'] ?? null ) ) {
					// Adopt the canonical property map wholesale, like the
					// content: every one of this client's property writes has
					// settled by the time it reads (applied work is in the
					// map; parked work was reverted at settle).
					$this->client_props[ $client ] = $latest['properties'];
				}
			}
		}

		/**
		 * Re-proposes stale-base-voided edits against the base the client
		 * just observed — ONE coalesced proposal, like the adapter's single
		 * in-flight proposal. A real, timed request the deployed protocol
		 * makes.
		 *
		 * @param int   $client   Reading client index.
		 * @param array $response get_updates_since() response (unused; the
		 *                        adoption already happened in observe()).
		 * @return array|null Proposal updates, or null when nothing queued.
		 */
		public function followup_request( int $client, array $response ): ?array { // phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- $response is part of the profile contract.
			if ( empty( $this->retry_queue[ $client ] ) ) {
				return null;
			}

			$records = array();
			foreach ( $this->retry_queue[ $client ] as $record ) {
				// apply_edit() re-derives each record's baseline (prev_align
				// / changed / prev_value) against the fresh base the retry
				// authors from.
				$this->apply_edit( $client, $record );
				$records[] = $record;
			}
			$this->retry_queue[ $client ] = array();

			$proposal_id                              = 'retry-' . ( $this->proposal_seq++ );
			$this->pending[ $client ][ $proposal_id ] = $records;

			return $this->proposal_updates( $client, $proposal_id );
		}

		/**
		 * Settles the retry proposal's dispositions.
		 *
		 * @param int            $client Client index that sent the follow-up.
		 * @param array|WP_Error $result handle_updates() result.
		 */
		public function record_followup_result( int $client, $result ): void {
			if ( is_wp_error( $result ) ) {
				// The whole request failed (e.g. lock timeout): park every
				// in-flight retry so the oracle accounts for it — score()
				// reports any token that then leaks into the canonical.
				foreach ( $this->pending[ $client ] as $records ) {
					foreach ( $records as $record ) {
						$this->park( $client, $record );
					}
				}
				$this->pending[ $client ] = array();
				return;
			}
			foreach ( (array) ( $result['dispositions'] ?? array() ) as $disposition ) {
				// An applied retry advances the client's base inside
				// settle(), like any other applied proposal (a retry is
				// authored against the head the client observed on the read
				// immediately before it, so it is always a fast-forward).
				$this->settle( $client, $disposition );
			}
		}

		/**
		 * Scores the canonical against the accumulated dispositions and the
		 * version lineage.
		 *
		 * @param WP_Sync_Engine $engine Engine under test.
		 * @param string         $room   Room identifier.
		 * @return array Failures (empty when converged).
		 */
		public function score( WP_Sync_Engine $engine, string $room ): ?array {
			$content = (string) $engine->materialize( $room );
			if ( '' === $content ) {
				return array(
					array(
						'check'  => 'materialize',
						'detail' => 'materialized content is empty',
					),
				);
			}

			$failures = $this->observe_failures;

			// Nothing may still be in flight: an edit that never settled
			// (or a retry that never got its follow-up) is unaccounted work.
			foreach ( $this->pending as $client => $proposals ) {
				if ( array() !== $proposals ) {
					$failures[] = array(
						'check'  => 'unsettled',
						'detail' => sprintf( 'client %d ended the session with %d unsettled proposal(s)', $client, count( $proposals ) ),
					);
				}
			}
			foreach ( $this->retry_queue as $client => $queue ) {
				if ( array() !== $queue ) {
					$failures[] = array(
						'check'  => 'unsettled',
						'detail' => sprintf( 'client %d ended the session with %d edit(s) still queued for retry', $client, count( $queue ) ),
					);
				}
			}

			$blocks = array_values(
				array_filter(
					parse_blocks( $content ),
					static function ( $block ) {
						return 'core/paragraph' === ( $block['blockName'] ?? null );
					}
				)
			);

			$paragraph_count = (int) $this->workload['paragraphs'];
			$alive           = count(
				array_filter(
					$this->expected_markers,
					static function ( $state ) {
						return 'alive' === $state;
					}
				)
			);
			if ( count( $blocks ) !== $paragraph_count + $alive ) {
				$failures[] = array(
					'check'  => 'structure',
					'detail' => sprintf( 'expected %d paragraph blocks (%d genesis + %d live inserts), found %d', $paragraph_count + $alive, $paragraph_count, $alive, count( $blocks ) ),
				);
			}
			for ( $i = 0; $i < $paragraph_count; $i++ ) {
				if ( 1 !== substr_count( $content, WP_Sync_Bench_Workload::genesis_marker( $i ) ) ) {
					$failures[] = array(
						'check'  => 'structure',
						'detail' => sprintf( "genesis block '%s' is missing or duplicated", WP_Sync_Bench_Workload::genesis_marker( $i ) ),
					);
				}
			}
			foreach ( $this->expected_markers as $marker => $state ) {
				$found = substr_count( $content, $marker );
				if ( ( 'alive' === $state ? 1 : 0 ) !== $found ) {
					$failures[] = array(
						'check'  => 'structure',
						'detail' => sprintf( "inserted block '%s' should be %s, found %d times", $marker, $state, $found ),
					);
				}
			}

			foreach ( $this->expected_texts as $token => $status ) {
				$found = substr_count( $content, $token );
				// Scoping rule for the edit-vs-remove class: an applied token
				// whose inserted target block was subsequently removed by an
				// APPLIED proposal vanishes with the block; expected, not
				// lost work.
				$target         = $this->text_targets[ $token ] ?? null;
				$target_removed = null !== $target && 'absent' === ( $this->expected_markers[ $target ] ?? null );
				if ( 'applied' === $status && $target_removed ) {
					if ( 0 !== $found ) {
						$failures[] = array(
							'check'  => 'applied-text',
							'detail' => sprintf( "token '%s' survived the removal of its target block '%s'", $token, $target ),
						);
					}
				} elseif ( 'applied' === $status && 1 !== $found ) {
					$failures[] = array(
						'check'  => 'applied-text',
						'detail' => sprintf( "applied token '%s' found %d times (expected exactly 1)", $token, $found ),
					);
				} elseif ( 'parked' === $status && 0 !== $found ) {
					$failures[] = array(
						'check'  => 'parked-text',
						'detail' => sprintf( "parked token '%s' leaked into the canonical (must be set aside, not merged)", $token ),
					);
				}
			}

			foreach ( $this->expected_align as $paragraph => $align ) {
				$marker = WP_Sync_Bench_Workload::genesis_marker( (int) $paragraph );
				$actual = null;
				foreach ( $blocks as $block ) {
					if ( false !== strpos( (string) ( $block['innerHTML'] ?? '' ), $marker ) ) {
						$actual = $block['attrs']['align'] ?? null;
						break;
					}
				}
				if ( $actual !== $align ) {
					$failures[] = array(
						'check'  => 'attr-register',
						'detail' => sprintf( "paragraph %d align is '%s', last applied changed write was '%s'", $paragraph, (string) $actual, (string) $align ),
					);
				}
			}

			// Version lineage: content rows chain without gaps from genesis
			// (v1), and their version set matches the applied dispositions.
			foreach ( $this->row_lineage as $version => $base ) {
				$seq = (int) ltrim( (string) $version, 'v' );
				if ( 'v' . ( $seq - 1 ) !== $base ) {
					$failures[] = array(
						'check'  => 'lineage',
						'detail' => sprintf( "content row '%s' does not chain from its predecessor (baseVersion '%s')", $version, $base ),
					);
				}
			}
			$row_versions     = array_keys( $this->row_lineage );
			$applied_versions = array_keys( $this->applied_versions );
			sort( $row_versions );
			sort( $applied_versions );
			if ( $row_versions !== $applied_versions ) {
				$failures[] = array(
					'check'  => 'lineage',
					'detail' => sprintf(
						'content-row versions do not match applied dispositions (%d rows vs %d applied)',
						count( $row_versions ),
						count( $applied_versions )
					),
				);
			}

			// The materialized canonical is the newest broadcast row, and
			// after full catch-up every client adopted exactly it (this is
			// the floored/laggy delivery path check).
			if ( null !== $this->latest_row && $this->latest_row['content'] !== $content ) {
				$failures[] = array(
					'check'  => 'materialize',
					'detail' => 'materialized content differs from the newest broadcast content row',
				);
			}
			foreach ( $this->content as $client => $client_content ) {
				if ( $client_content !== $content ) {
					$failures[] = array(
						'check'  => 'client-convergence',
						'detail' => sprintf( 'client %d local copy differs from the canonical after full catch-up', $client ),
					);
				}
			}

			// Entity-property registers: the newest broadcast map and every
			// client's adopted copy must match the per-property three-way
			// model, and the wire's property-conflict parked rows must match
			// the parks the model predicted — the register analog of the
			// align + lineage checks. (Per-version row maps were already
			// checked against the model in observe().)
			$canonical_json = self::props_json( $this->canonical_props );
			if ( null !== $this->latest_row && self::props_json( $this->latest_row['properties'] ?? array() ) !== $canonical_json ) {
				$failures[] = array(
					'check'  => 'prop-register',
					'detail' => 'the newest broadcast property map does not match the per-property three-way model',
				);
			}
			foreach ( $this->client_props as $client => $client_props ) {
				if ( self::props_json( $client_props ) !== $canonical_json ) {
					$failures[] = array(
						'check'  => 'client-convergence',
						'detail' => sprintf( 'client %d property map differs from the canonical after full catch-up', $client ),
					);
				}
			}
			$expected_parked = array_keys( $this->expected_parked_props );
			$observed_parked = array_keys( $this->observed_parked_props );
			sort( $expected_parked );
			sort( $observed_parked );
			if ( $expected_parked !== $observed_parked ) {
				$failures[] = array(
					'check'  => 'prop-escalation',
					'detail' => sprintf(
						'property-conflict parked rows do not match the model (model predicted %d, wire delivered %d)',
						count( $expected_parked ),
						count( $observed_parked )
					),
				);
			}

			return $failures;
		}

		/**
		 * Canonical JSON form of a property map for order-insensitive
		 * comparison (names appear in maps in first-write order).
		 *
		 * @param array $props Property map.
		 * @return string Key-sorted JSON encoding.
		 */
		private static function props_json( array $props ): string {
			ksort( $props );
			return (string) wp_json_encode( $props );
		}

		/**
		 * Settles one disposition against its pending proposal's records.
		 *
		 * @param int   $client      Client index.
		 * @param array $disposition Engine disposition.
		 */
		private function settle( int $client, array $disposition ): void {
			$proposal_id = (string) ( $disposition['intentId'] ?? '' );
			$records     = $this->pending[ $client ][ $proposal_id ] ?? null;
			if ( null === $records ) {
				return; // Not ours / already settled.
			}
			unset( $this->pending[ $client ][ $proposal_id ] );

			$status = $disposition['status'] ?? 'unknown';
			$reason = (string) ( $disposition['reason'] ?? '' );

			if ( 'applied' === $status ) {
				$version = (string) ( $disposition['version'] ?? '' );
				if ( '' !== $version ) {
					$this->applied_versions[ $version ] = $proposal_id;
				}

				/*
				 * Partial acceptance (the engine's per-block conflict
				 * salvage): the proposal applied, but `parkedBlocks`
				 * conflicted blocks parked for review instead of landing.
				 * The runner is synchronous, so the canonical AT SETTLE is
				 * exactly the applied version — consult it to classify each
				 * record as landed (applied expectations) or parked.
				 */
				$salvage_canonical = null;
				if ( (int) ( $disposition['parkedBlocks'] ?? 0 ) > 0 && null !== $this->engine ) {
					$salvage_canonical = (string) $this->engine->materialize( $this->room );
				}

				foreach ( $records as $record ) {
					if ( null !== $salvage_canonical && ! $this->record_landed( $record, $salvage_canonical ) ) {
						$this->park( $client, $record );
						continue;
					}
					if ( 'text' === $record['op'] ) {
						$this->expected_texts[ $record['token'] ] = 'applied';
						if ( ! empty( $record['inserted_target'] ) ) {
							// Scope the token to its inserted target block:
							// a later applied removal takes the token with
							// it, and the oracle must expect that.
							$this->text_targets[ $record['token'] ] = $record['marker'];
						}
					} elseif ( 'insert_block' === $record['op'] ) {
						$this->expected_markers[ $record['marker'] ] = 'alive';
					} elseif ( 'remove_block' === $record['op'] ) {
						// Covers the no-op case too: a remove of a block whose
						// insert never landed applies as a version-only
						// advance, and the marker is absent either way.
						$this->expected_markers[ $record['marker'] ] = 'absent';
					} elseif ( 'set_property' === $record['op'] ) {
						$this->settle_property_write( $client, $proposal_id, $record );
					} elseif ( $record['changed'] ) {
						// Three-way merges only move a register the proposal
						// actually changed against its own base; a no-op
						// write must not move the expectation.
						$this->expected_align[ $record['paragraph'] ] = $record['align'];
					}
				}

				// Snapshot the model's canonical property map at this
				// version: every applied proposal broadcasts a content row
				// carrying the map, and observe() checks each row against
				// the snapshot for its version.
				if ( '' !== $version ) {
					$this->model_props_by_version[ $version ] = $this->canonical_props;
				}

				/*
				 * Mirror the codec's own-accepted-row handling. In
				 * production the polling transport returns the room's rows
				 * and the dispositions in the SAME response (rows first),
				 * so the client's accepted content row advances its base
				 * row-driven in the very response that acks the proposal: a
				 * round-tripped-unchanged row advances the version only,
				 * and a server-merged row is incorporated. A client can
				 * therefore never author its next proposal against a base
				 * that predates its own applied proposal while re-carrying
				 * the applied content — base→ours vs base→canonical would
				 * insert the SAME text twice, the duplication window the
				 * codec's row-driven advance closes (the laggy client hit
				 * exactly that before this settle-time advance existed).
				 * The runner's seam splits ingest from read, so the profile
				 * restores that pairing at settle: the runner is
				 * synchronous, so the canonical at settle time IS the
				 * just-applied version. A fast-forward (nothing ingested
				 * between this client's base and the apply) means the
				 * canonical equals the proposed content and the base
				 * advances version-only; otherwise the client adopts the
				 * merged canonical — with no local edits newer than the
				 * proposal, that is exactly what the codec's
				 * incorporateCanonicalPreservingLocalEdits reduces to.
				 * Gated on assert_model: in the multi-process probe another
				 * process may ingest between apply and settle, so neither
				 * the fast-forward arithmetic nor the adoption is sound
				 * there (its workers read every iteration instead).
				 */
				if ( $this->assert_model && '' !== $version ) {
					$applied_seq = (int) ltrim( $version, 'v' );
					$base_seq    = (int) ltrim( (string) $this->base_version[ $client ], 'v' );

					if ( null !== $salvage_canonical ) {
						// A salvaged apply is NEVER a plain fast-forward:
						// the canonical differs from the proposed content
						// (conflicted blocks reverted), so adopt it.
						$this->content[ $client ]      = $salvage_canonical;
						$this->client_props[ $client ] = $this->canonical_props;
					} elseif ( $applied_seq !== $base_seq + 1 && null !== $this->engine ) {
						$this->content[ $client ]      = (string) $this->engine->materialize( $this->room );
						$this->client_props[ $client ] = $this->canonical_props;
					}

					$this->base_version[ $client ] = $version;
				}
				return;
			}

			if ( 'voided' === $status && 'unknown-base-version' === $reason ) {
				foreach ( $records as $record ) {
					// Revert from the local state now; the retry re-applies
					// against the base the next read hands this client.
					$this->revert_edit( $client, $record );
					if ( empty( $record['retried'] ) ) {
						$record['retried']              = true;
						$this->retry_queue[ $client ][] = $record;
					} else {
						// One retry per edit: park a second stale-base void.
						$this->park_settled( $record );
					}
				}
				return;
			}

			// Escalated (parked for human decision) or a non-benign void
			// (counted as lost work by the runner): either way the canonical
			// must not contain it, and later proposals must not re-send it.
			foreach ( $records as $record ) {
				$this->park( $client, $record );
			}
		}

		/**
		 * Settles one applied proposal's property write through the engine's
		 * per-property three-way rule, in server order (the runner is
		 * synchronous, so settle order IS server order).
		 *
		 * The engine's rule against the proposal's base version: a property
		 * changed only by the client applies (canonical equals base, or
		 * already equals the proposed value); a property changed BOTH by the
		 * client and concurrently in canonical parks as its own
		 * `parked` row (`property-conflict`) while the proposal
		 * still reports applied — canonical keeps the concurrent winner. The
		 * base value is the one captured from the client's adopted map when
		 * the write was authored (the client adopts canonical wholesale, so
		 * its map at authoring time IS the canonical at its base version).
		 *
		 * @param int    $client      Client index.
		 * @param string $proposal_id Proposal id the write rode in.
		 * @param array  $record      Property edit record.
		 */
		private function settle_property_write( int $client, string $proposal_id, array $record ): void {
			$name            = (string) $record['name'];
			$base_value      = $record['had_prev'] ? $record['prev_value'] : null;
			$canonical_value = array_key_exists( $name, $this->canonical_props ) ? $this->canonical_props[ $name ] : null;

			if (
				self::property_values_equal( $canonical_value, $base_value ) ||
				self::property_values_equal( $record['value'], $canonical_value )
			) {
				$this->canonical_props[ $name ] = $record['value'];
				return;
			}

			// Both sides changed it to different values: the engine parks
			// this register under "proposalId:name" for a human decision.
			// Canonical keeps the concurrent winner; the harness reverts the
			// client's local value (production keeps it on screen pending
			// the review — the same simplification as escalated content).
			$this->expected_parked_props[ $proposal_id . ':' . $name ] = array(
				'name'  => $name,
				'value' => $record['value'],
			);
			$this->revert_edit( $client, $record );
		}

		/**
		 * Whether a record's effect is present in the given canonical —
		 * used to classify records of a PARTIALLY accepted proposal (the
		 * engine's per-block conflict salvage) as landed or parked.
		 *
		 * @param array  $record    Edit record.
		 * @param string $canonical Canonical content at settle.
		 * @return bool Whether the record landed.
		 */
		private function record_landed( array $record, string $canonical ): bool {
			if ( 'text' === $record['op'] ) {
				return 1 === substr_count( $canonical, (string) $record['token'] );
			}
			if ( 'insert_block' === $record['op'] ) {
				return 1 === substr_count( $canonical, (string) $record['marker'] );
			}
			if ( 'remove_block' === $record['op'] ) {
				return 0 === substr_count( $canonical, (string) $record['marker'] );
			}
			if ( 'set_property' === $record['op'] ) {
				return true; // Properties merge on the accepted path regardless of content salvage.
			}
			if ( ! empty( $record['changed'] ) ) {
				// Attr register write: read the block's actual align.
				$marker = WP_Sync_Bench_Workload::genesis_marker( (int) $record['paragraph'] );
				foreach ( parse_blocks( $canonical ) as $block ) {
					if ( 'core/paragraph' === ( $block['blockName'] ?? null ) && false !== strpos( (string) ( $block['innerHTML'] ?? '' ), $marker ) ) {
						return ( $block['attrs']['align'] ?? null ) === $record['align'];
					}
				}
				return false;
			}
			return true; // A no-op write neither lands nor parks.
		}

		/**
		 * Parks an edit: reverts it from the client's local state and records
		 * the expectation that it stayed out of the canonical.
		 *
		 * @param int   $client Client index.
		 * @param array $record Edit record.
		 */
		private function park( int $client, array $record ): void {
			$this->revert_edit( $client, $record );
			$this->park_settled( $record );
		}

		/**
		 * Records a parked edit's oracle expectation (local copy untouched).
		 *
		 * @param array $record Edit record.
		 */
		private function park_settled( array $record ): void {
			if ( 'text' === $record['op'] ) {
				$this->expected_texts[ $record['token'] ] = 'parked';
			} elseif ( 'insert_block' === $record['op'] ) {
				// A parked insert never landed: the marker must stay out of
				// the canonical.
				$this->expected_markers[ $record['marker'] ] = 'absent';
			}
			// A parked attr write or block removal leaves the document where
			// it was: no expectation to move (the block's fate stays with its
			// insert's settlement). A property write parked WITH its whole
			// proposal never reached the property merge, so the canonical
			// model is equally untouched — the revert is the settlement.
		}

		/**
		 * Builds the internal record for a workload edit.
		 *
		 * @param array $edit Workload edit.
		 * @return array Edit record.
		 */
		private function build_edit_record( array $edit ): array {
			$op = $edit['op'] ?? 'text';
			if ( 'attr' === $op ) {
				return array(
					'op'         => 'attr',
					'paragraph'  => (int) $edit['paragraph'],
					'marker'     => WP_Sync_Bench_Workload::genesis_marker( (int) $edit['paragraph'] ),
					'align'      => (string) $edit['align'],
					'prev_align' => null,  // Captured by apply_record().
					'changed'    => true,  // Recomputed by apply_record().
					'retried'    => false,
				);
			}
			if ( 'insert_block' === $op ) {
				return array(
					'op'           => 'insert_block',
					'marker'       => (string) $edit['marker'],
					'after_marker' => WP_Sync_Bench_Workload::genesis_marker( (int) $edit['after'] ),
					'retried'      => false,
				);
			}
			if ( 'remove_block' === $op ) {
				return array(
					'op'            => 'remove_block',
					'marker'        => (string) $edit['marker'],
					'after_marker'  => WP_Sync_Bench_Workload::genesis_marker( (int) $edit['after'] ),
					'removed_block' => null, // Captured by apply_record(), for revert.
					'noop'          => false,
					'retried'       => false,
				);
			}
			if ( in_array( $op, WP_Sync_Bench_Workload::FIELD_OPS, true ) ) {
				// Terms and meta are entries in the SAME proposal property
				// map as scalar properties — taxonomy registers by
				// rest_base (whole term-ID sets, which the engine's
				// property_values_equal compares order-insensitively) and
				// meta registers under `meta.<key>` names — so all three
				// ops normalize to one record shape and share the
				// settle/apply/revert lanes.
				return array(
					'op'         => 'set_property',
					'name'       => (string) $edit['name'],
					'value'      => $edit['value'],
					'prev_value' => null,  // Captured by apply_edit().
					'had_prev'   => false, // Captured by apply_edit().
					'retried'    => false,
				);
			}
			// A text edit addresses its target by identity marker: a genesis
			// paragraph's, or (remove-contention's contended case) the
			// inserted block's own marker.
			if ( isset( $edit['block_id'] ) ) {
				$marker          = (string) $edit['marker'];
				$inserted_target = true;
			} else {
				$marker          = WP_Sync_Bench_Workload::genesis_marker( (int) $edit['paragraph'] );
				$inserted_target = false;
			}

			return array(
				'op'              => 'text',
				'marker'          => $marker,
				'token'           => (string) $edit['text'],
				'position'        => (string) ( $edit['position'] ?? 'head' ),
				'inserted_target' => $inserted_target,
				'retried'         => false,
			);
		}

		/**
		 * Applies an edit record to the client's local state: content
		 * records to the working copy, property records to the client's
		 * property map (capturing the base value for the three-way model
		 * and a possible revert — the client adopts canonical wholesale, so
		 * its map at authoring time IS the canonical at its base version).
		 *
		 * @param int   $client Client index.
		 * @param array $record Edit record (modified: captured baselines).
		 */
		private function apply_edit( int $client, array &$record ): void {
			if ( 'set_property' === $record['op'] ) {
				$record['had_prev']   = array_key_exists( $record['name'], $this->client_props[ $client ] );
				$record['prev_value'] = $record['had_prev'] ? $this->client_props[ $client ][ $record['name'] ] : null;

				$this->client_props[ $client ][ $record['name'] ] = $record['value'];
				return;
			}

			$this->content[ $client ] = $this->apply_record( $this->content[ $client ], $record );
		}

		/**
		 * Reverts an edit record from the client's local state (the inverse
		 * of apply_edit()).
		 *
		 * @param int   $client Client index.
		 * @param array $record Edit record.
		 */
		private function revert_edit( int $client, array $record ): void {
			if ( 'set_property' === $record['op'] ) {
				if ( $record['had_prev'] ) {
					$this->client_props[ $client ][ $record['name'] ] = $record['prev_value'];
				} else {
					unset( $this->client_props[ $client ][ $record['name'] ] );
				}
				return;
			}

			$this->content[ $client ] = $this->revert_record( $this->content[ $client ], $record );
		}

		/**
		 * Mirrors the engine's property equality rule: numeric term-ID-style
		 * arrays compare as sets (order-insensitive), everything else by
		 * JSON encoding.
		 *
		 * @param mixed $a First value.
		 * @param mixed $b Second value.
		 * @return bool Whether the engine treats the values as equal.
		 */
		private static function property_values_equal( $a, $b ): bool {
			if ( is_array( $a ) && is_array( $b ) && wp_is_numeric_array( $a ) && wp_is_numeric_array( $b ) ) {
				$a_ints = array_filter( $a, 'is_numeric' );
				$b_ints = array_filter( $b, 'is_numeric' );
				if ( count( $a_ints ) === count( $a ) && count( $b_ints ) === count( $b ) ) {
					$a_sorted = array_map( 'intval', array_values( $a ) );
					$b_sorted = array_map( 'intval', array_values( $b ) );
					sort( $a_sorted, SORT_NUMERIC );
					sort( $b_sorted, SORT_NUMERIC );
					return $a_sorted === $b_sorted;
				}
			}

			return wp_json_encode( $a ) === wp_json_encode( $b );
		}

		/**
		 * Applies an edit record to serialized block content. Attr records
		 * capture their baseline (prev_align / changed) in the same pass, by
		 * reference into the record the caller stores.
		 *
		 * @param string $content Serialized blocks.
		 * @param array  $record  Edit record (modified: attr baseline).
		 * @return string Updated serialized blocks.
		 */
		private function apply_record( string $content, array &$record ): string {
			$op = $record['op'];

			if ( 'insert_block' === $op ) {
				return $this->splice_block_after( $content, $record['after_marker'], self::new_paragraph_block( $record['marker'] ) );
			}

			if ( 'remove_block' === $op ) {
				$removed = null;
				$content = $this->extract_block( $content, $record['marker'], $removed );
				// Absent target (the insert never landed at this client): the
				// proposal degenerates to a no-op — the engine applies it as
				// a version-only advance, which is correct either way.
				$record['noop']          = null === $removed;
				$record['removed_block'] = $removed;
				return $content;
			}

			return $this->with_marker_block(
				$content,
				$record['marker'],
				function ( array $block ) use ( $op, &$record ): array {
					if ( 'attr' === $op ) {
						$record['prev_align']    = $block['attrs']['align'] ?? null;
						$record['changed']       = ( $record['prev_align'] !== $record['align'] );
						$block['attrs']['align'] = $record['align'];
						return $block;
					}
					return $this->insert_paragraph_text( $block, $record['token'], (string) ( $record['position'] ?? 'head' ) );
				}
			);
		}

		/**
		 * Reverts an edit record from serialized block content.
		 *
		 * @param string $content Serialized blocks.
		 * @param array  $record  Edit record.
		 * @return string Updated serialized blocks.
		 */
		private function revert_record( string $content, array $record ): string {
			$op = $record['op'];

			if ( 'text' === $op ) {
				// Tokens are unique and delimiter-terminated (the workload
				// generator's guarantee), so plain removal is exact.
				return str_replace( $record['token'], '', $content );
			}

			if ( 'insert_block' === $op ) {
				$removed = null;
				return $this->extract_block( $content, $record['marker'], $removed );
			}

			if ( 'remove_block' === $op ) {
				if ( ! empty( $record['noop'] ) || ! is_array( $record['removed_block'] ) ) {
					return $content;
				}
				return $this->splice_block_after( $content, $record['after_marker'], $record['removed_block'] );
			}

			$prev = $record['prev_align'];
			return $this->with_marker_block(
				$content,
				$record['marker'],
				static function ( array $block ) use ( $prev ): array {
					if ( null === $prev ) {
						unset( $block['attrs']['align'] );
					} else {
						$block['attrs']['align'] = $prev;
					}
					return $block;
				}
			);
		}

		/**
		 * Rewrites the block carrying an identity marker through a callback.
		 * Blocks are addressed by marker, never by position — concurrent
		 * structural edits shift positions.
		 *
		 * @param string   $content  Serialized blocks.
		 * @param string   $marker   Identity marker.
		 * @param callable $callback Receives and returns the block.
		 * @return string Updated serialized blocks.
		 */
		private function with_marker_block( string $content, string $marker, callable $callback ): string {
			$blocks = parse_blocks( $content );
			foreach ( $blocks as $i => $block ) {
				if ( 'core/paragraph' !== ( $block['blockName'] ?? null ) ) {
					continue;
				}
				if ( false !== strpos( (string) $block['innerHTML'], $marker ) ) {
					$blocks[ $i ] = $callback( $block );
					break;
				}
			}
			return serialize_blocks( $blocks );
		}

		/**
		 * Inserts a block (plus a blank-line separator) after the block
		 * carrying the anchor marker, or appends when the anchor is absent.
		 *
		 * @param string $content   Serialized blocks.
		 * @param string $anchor    Anchor block's identity marker.
		 * @param array  $new_block Parsed block to insert.
		 * @return string Updated serialized blocks.
		 */
		private function splice_block_after( string $content, string $anchor, array $new_block ): string {
			$blocks    = parse_blocks( $content );
			$separator = array(
				'blockName'    => null,
				'attrs'        => array(),
				'innerBlocks'  => array(),
				'innerHTML'    => "\n\n",
				'innerContent' => array( "\n\n" ),
			);
			$at        = count( $blocks );
			foreach ( $blocks as $i => $block ) {
				if ( 'core/paragraph' === ( $block['blockName'] ?? null )
					&& false !== strpos( (string) $block['innerHTML'], $anchor ) ) {
					$at = $i + 1;
					break;
				}
			}
			array_splice( $blocks, $at, 0, array( $separator, $new_block ) );
			return serialize_blocks( $blocks );
		}

		/**
		 * Removes the block carrying a marker (and its preceding blank-line
		 * separator), handing the removed block back for a possible revert.
		 *
		 * @param string     $content Serialized blocks.
		 * @param string     $marker  Identity marker.
		 * @param array|null $removed Set to the removed block, or null.
		 * @return string Updated serialized blocks.
		 */
		private function extract_block( string $content, string $marker, ?array &$removed ): string {
			$removed = null;
			$blocks  = parse_blocks( $content );
			foreach ( $blocks as $i => $block ) {
				if ( 'core/paragraph' !== ( $block['blockName'] ?? null ) ) {
					continue;
				}
				if ( false !== strpos( (string) $block['innerHTML'], $marker ) ) {
					$removed = $block;
					$from    = $i;
					$length  = 1;
					$prior   = $blocks[ $i - 1 ] ?? null;
					if ( $i > 0 && null === ( $prior['blockName'] ?? null ) && '' === trim( (string) ( $prior['innerHTML'] ?? '' ) ) ) {
						--$from;
						++$length;
					}
					array_splice( $blocks, $from, $length );
					break;
				}
			}
			return serialize_blocks( $blocks );
		}

		/**
		 * A fresh client-born paragraph block whose body is its marker.
		 *
		 * It carries a random `metadata.syncId`, exactly as the editor-side
		 * stamper gives every block born in a session before the client
		 * proposes it. Without one the engine would treat this profile's
		 * descriptor-less proposal as an engine-unaware writer's and stamp
		 * the id server-side — a canonical that differs from the proposed
		 * content on what the model expects to be a plain fast-forward, so
		 * the client copy never converges.
		 *
		 * @param string $marker Identity marker.
		 * @return array Parsed-block-shaped array.
		 */
		private static function new_paragraph_block( string $marker ): array {
			$html = "\n<p>" . $marker . "</p>\n";
			return array(
				'blockName'    => 'core/paragraph',
				'attrs'        => array( 'metadata' => array( 'syncId' => wp_generate_uuid4() ) ),
				'innerBlocks'  => array(),
				'innerHTML'    => $html,
				'innerContent' => array( $html ),
			);
		}

		/**
		 * Inserts a token into a paragraph's content field at the edit's
		 * abstract position: `head` lands right after the opening tag,
		 * `tail` right before the closing tag — the same field coordinates
		 * the intent-log profile's insert_text offsets name.
		 *
		 * @param array  $block    Paragraph block.
		 * @param string $token    Unique token.
		 * @param string $position 'head' or 'tail'.
		 * @return array Updated block.
		 */
		private function insert_paragraph_text( array $block, string $token, string $position ): array {
			$html = (string) $block['innerHTML'];

			if ( 'tail' === $position ) {
				$pos = strrpos( $html, '<' );
			} else {
				$open = strpos( $html, '>' );
				$pos  = false === $open ? false : $open + 1;
			}

			if ( false === $pos ) {
				$html .= $token;
			} else {
				$html = substr( $html, 0, $pos ) . $token . substr( $html, $pos );
			}

			$block['innerHTML']    = $html;
			$block['innerContent'] = array( $html );
			return $block;
		}

		/**
		 * Builds the proposal updates array for a pending proposal.
		 *
		 * @param int    $client      Client index.
		 * @param string $proposal_id Proposal id.
		 * @return array Updates payload.
		 */
		private function proposal_updates( int $client, string $proposal_id ): array {
			return array(
				array(
					'type' => WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL,
					'data' => wp_json_encode(
						array(
							'proposalId'         => $proposal_id,
							'baseVersion'        => $this->base_version[ $client ],
							'proposedContent'    => $this->content[ $client ],
							// The shipping client re-carries its FULL property
							// map on every proposal; the server's three-way
							// rule no-ops every entry the client did not
							// change against its base.
							'proposedProperties' => $this->client_props[ $client ],
							'clientUpdate'       => null,
						)
					),
				),
			);
		}
	}
}
