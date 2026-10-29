<?php
/**
 * Seeded workload generator for the sync-engine benchmark.
 *
 * A workload is a document of N paragraphs plus a list of ROUNDS. Each round
 * carries a set of (client, op, target) edits authored from the same
 * observed sequence, then delivered. Whether clients share a target in a
 * round is what produces contention: two clients typing the SAME paragraph
 * field concurrently escalate (the second loses the one-sided-transform
 * race); typing DIFFERENT paragraphs merges clean. Scenarios pick that mix,
 * so the quality metric has a controllable escalation rate to report.
 *
 * Seven operations:
 *
 * - `text` — insert a unique token into a paragraph's content field (a
 *   keystroke batch) at a seeded abstract position: `head` (offset 0) or
 *   `tail` (the end of the field as the authoring client observed it).
 *   Targets a genesis paragraph by index, or, in `remove-contention`, an
 *   inserted block by `block_id`. Profiles map the position to engine
 *   coordinates from each client's own observed state; the token-counting
 *   oracles are position-independent.
 * - `attr` — set a genesis paragraph's align register (a restyle).
 * - `set_property` — set an entity-property register (slug, template, …)
 *   on the document itself, the field-sync traffic PR #22 added. Names
 *   come from PROPERTY_PALETTE: scalar registers that every engine's
 *   session codec carries as a plain last-writer register (title/excerpt
 *   are deliberately absent — the CRDT codec models them as merging
 *   Y.Text, a different op class).
 * - `set_terms` — replace a taxonomy's whole term-ID set. The register is
 *   named by the taxonomy's rest_base (TAXONOMY_PALETTE) and its value is
 *   a numerically-sorted term-ID array; the engines compare term sets
 *   order-insensitively, exactly like the shipping clients send them.
 * - `set_meta` — set a registered post-meta register (`meta.<key>` names
 *   from META_PALETTE). Intent-log carry these as flat
 *   per-name registers; the CRDT codec nests them per key under the
 *   document's `meta` Y.Map. The harness registers the palette's keys
 *   (see register_bench_meta()) because synced meta IS registered meta.
 * - `insert_block` — insert a NEW paragraph (its body is a unique marker)
 *   after a genesis paragraph.
 * - `remove_block` — remove a block the SAME client inserted earlier
 *   (`remove-contention`: any client's earlier insert).
 *
 * Structural discipline keeps the oracles sound under concurrency: attr
 * edits target GENESIS paragraphs only (identified by their
 * delimiter-terminated markers `Paragraph N;`, which are never removed),
 * and each inserted block is removed at most once. In most scenarios text
 * edits also stay on genesis paragraphs and removals target only the
 * removing client's own earlier inserts; `remove-contention` deliberately
 * relaxes both (a text edit may target an inserted block, addressed by
 * `block_id`, that ANOTHER client concurrently removes) and stays
 * decidable through the profiles' scoping rule: a text token is expected
 * in the materialized content iff its edit applied AND its target block's
 * final state is alive, both facts the dispositions already determine.
 *
 * The generator is engine-agnostic and deterministic: same seed, same
 * rounds. Each round's edit list is shuffled at build time with the seeded
 * draw (see shuffle_edits()), so which contending writer reaches the
 * server first varies by seed instead of always being client 0. The runner
 * binds each edit to real engine coordinates (syncIds, Y.Map handles, base
 * versions) at submit time through the authoring profiles.
 *
 * Rounds are plain edit lists by default (every ACTIVE client reads per
 * its `read_every` cadence). A scenario may instead emit
 * `array( 'edits' => …, 'readers' => … )` rounds to schedule reads
 * explicitly — how `editorial-session` models present-but-idle clients
 * polling every second.
 *
 * @package gutenberg
 */

if ( ! class_exists( 'WP_Sync_Bench_Workload' ) ) {

	/**
	 * Generates deterministic benchmark workloads.
	 */
	class WP_Sync_Bench_Workload {
		/**
		 * Entity-property register names the field-sync ops write.
		 *
		 * Scalar registers from the shared genesis property seed
		 * (WP_Sync_Post_Genesis_Props) that EVERY engine's session codec
		 * transmits as a plain last-writer register: intent-log
		 * as per-name registers, the CRDT codec via a plain Y.Map value.
		 * `title`/`excerpt` are deliberately excluded — the CRDT codec
		 * models them as merging Y.Text, so they are not registers there.
		 *
		 * @var string[]
		 */
		const PROPERTY_PALETTE = array( 'slug', 'template', 'comment_status', 'ping_status', 'format' );

		/**
		 * Taxonomy registers the set_terms op writes, named by rest_base
		 * like the REST record and the shared genesis seed. Both built-in
		 * post taxonomies are show_in_rest, so genesis seeds both registers
		 * on every engine (values are whole term-ID sets, compared
		 * order-insensitively).
		 *
		 * @var string[]
		 */
		const TAXONOMY_PALETTE = array( 'categories', 'tags' );

		/**
		 * Post-meta registers the set_meta op writes (`meta.<key>` names,
		 * the shared register-name convention). The harness registers the
		 * bare keys before genesis (register_bench_meta()): synced meta IS
		 * registered meta, and the registration is what makes every
		 * engine's genesis seed these registers — in particular the CRDT
		 * genesis creates the nested `meta` Y.Map, without which
		 * concurrent first meta writes would each create their own nested
		 * map and the CRDT would drop one wholesale (a genesis-avoidable
		 * artifact, not an engine policy difference).
		 *
		 * @var string[]
		 */
		const META_PALETTE = array( 'meta.bench_subtitle', 'meta.bench_kicker', 'meta.bench_byline' );

		/**
		 * The field-sync register ops (every op whose edit carries a
		 * `name` + whole-value register write). Profiles treat all three
		 * as the same register lane; only the naming and, for the CRDT
		 * codec, the meta nesting differ.
		 *
		 * @var string[]
		 */
		const FIELD_OPS = array( 'set_property', 'set_terms', 'set_meta' );

		/**
		 * The available scenarios and their descriptions.
		 *
		 * @return array<string, string> Slug => description.
		 */
		public static function scenarios(): array {
			return array(
				'solo-typing'         => 'One editor typing into one document (baseline cost, no contention).',
				'long-form'           => 'One editor in a much LARGER document (does engine cost scale with document size? Combine with fill= for a size sweep).',
				'parallel-paragraphs' => 'Several editors, each in their own paragraph (clean concurrent merges).',
				'contended-paragraph' => 'Several editors typing into the SAME paragraph (high escalation).',
				'mixed-newsroom'      => 'Mostly parallel editing with occasional collisions.',
				'laggy-newsroom'      => 'Mixed newsroom where the last client reads only every 10th round (stale bases, deep transforms, catch-up reads).',
				'structural-churn'    => 'Concurrent block inserts/removals alongside typing (block-structure stress).',
				'field-sync'          => 'Entity-field register writes (scalar properties, taxonomy term sets, post meta) alongside typing: clean parallel field sync plus rounds where every client writes the SAME register (the register-contention analog of contended-paragraph).',
				'remove-contention'   => 'One client edits an inserted block another client concurrently removes (edit-vs-remove conflict class; degenerates to sequential same-client edit-then-remove at clients=1).',
				'editorial-session'   => 'A wall-clock editing session: one round per second, staggered joins/leaves, typing bursts with think-time pauses, every present client polling every round, periodic saves. rounds=3600 clients=3 is a one-hour three-user session.',
				'save-sync-session'   => 'Batched editing cadence, applied to every engine: rounds are wall-clock seconds, each client submits its typing burst only on staggered ~10s save beats and syncs every 10th round — the "$3/mo host polling every ten seconds" shape the Distributed Editing vision prescribes.',
			);
		}

		/**
		 * The combined field-register surface the field ops draw from:
		 * one ( op, name ) descriptor per register, spanning scalar
		 * properties, taxonomy term sets, and post meta.
		 *
		 * @return array<int, array{op: string, name: string}> Registers.
		 */
		public static function field_registers(): array {
			$registers = array();
			foreach ( self::PROPERTY_PALETTE as $name ) {
				$registers[] = array(
					'op'   => 'set_property',
					'name' => $name,
				);
			}

			foreach ( self::TAXONOMY_PALETTE as $name ) {
				$registers[] = array(
					'op'   => 'set_terms',
					'name' => $name,
				);
			}

			foreach ( self::META_PALETTE as $name ) {
				$registers[] = array(
					'op'   => 'set_meta',
					'name' => $name,
				);
			}

			return $registers;
		}

		/**
		 * Registers the META_PALETTE keys as show_in_rest post meta.
		 *
		 * Call BEFORE any room genesis is primed (the runner, the
		 * concurrency setup, the PHPUnit tests). Synced meta is registered
		 * meta — the framework only syncs registered keys — and
		 * registration is what makes WP_Sync_Post_Genesis_Props include
		 * `meta.<key>` registers in every engine's genesis seed. The CRDT
		 * genesis in particular creates the nested `meta` Y.Map only when
		 * registered meta exists; without it, concurrent first meta writes
		 * would race to create the nested map (see META_PALETTE).
		 */
		public static function register_bench_meta(): void {
			foreach ( self::META_PALETTE as $name ) {
				$key = substr( $name, strlen( 'meta.' ) );

				if ( registered_meta_key_exists( 'post', $key, 'post' ) ) {
					continue;
				}

				register_post_meta(
					'post',
					$key,
					array(
						'show_in_rest' => true,
						'single'       => true,
						'type'         => 'string',
						'default'      => '',
					)
				);
			}
		}

		/**
		 * Builds a workload.
		 *
		 * @param string   $scenario   Scenario slug.
		 * @param int      $seed       Deterministic seed.
		 * @param int      $rounds     Number of edit rounds.
		 * @param int      $clients    Number of concurrent editors.
		 * @param int      $paragraphs Document paragraph count.
		 * @param int|null $fill       Filler characters per genesis paragraph
		 *                             (document-size sweeps); null = the
		 *                             scenario default (long-form pads ~600,
		 *                             everything else is near-empty).
		 * @return array Workload: post_content, paragraphs, clients, rounds, …
		 */
		public static function build( string $scenario, int $seed, int $rounds, int $clients, int $paragraphs, ?int $fill = null ): array {
			// Portable deterministic draws: crc32 of (seed, counter) — a
			// fixed 32-bit hash, so the workload never depends on PHP's rng
			// seeding or int width across versions.
			$counter = 0;
			$rand    = static function ( int $modulo ) use ( $seed, &$counter ): int {
				$hash = crc32( $seed . ':' . ( $counter++ ) ) & 0x7fffffff;
				return $modulo > 0 ? $hash % $modulo : 0;
			};

			// long-form pads every paragraph to ~600 chars, so the default 8
			// paragraphs make a ~5 KB document (raise `paragraphs` or pass
			// $fill for more) — against solo-typing's near-empty one, this
			// shows whether engine cost scales with document size.
			if ( null === $fill ) {
				$fill = 'long-form' === $scenario ? 567 : 0;
			}
			$filler = $fill > 0
				? substr( str_repeat( ' lorem ipsum dolor sit amet consectetur adipiscing elit sed do', (int) ceil( $fill / 63 ) ), 0, $fill )
				: '';

			// Genesis paragraph bodies start with a delimiter-terminated
			// MARKER ("Paragraph 3;") — unique, never a substring of another
			// marker, and never removed — so the oracles can locate blocks
			// by identity even after concurrent structural edits shift
			// positions.
			$content_parts = array();
			for ( $i = 0; $i < $paragraphs; $i++ ) {
				$content_parts[] = "<!-- wp:paragraph -->\n<p>" . self::genesis_marker( $i ) . $filler . "</p>\n<!-- /wp:paragraph -->";
			}
			$post_content = implode( "\n\n", $content_parts );

			// Which rounds each client reads on: 1 = every round (the default
			// lock-step model); k = only every k-th round (a laggy client whose
			// baseSeq falls up to k rounds behind, forcing deeper transforms
			// and bigger catch-up reads).
			$read_every = array_fill( 0, max( 1, $clients ), 1 );
			if ( 'laggy-newsroom' === $scenario && $clients > 1 ) {
				$read_every[ $clients - 1 ] = 10;
			}
			if ( 'save-sync-session' === $scenario ) {
				// The sync cadence: every client reads every 10th round.
				$read_every = array_fill( 0, max( 1, $clients ), 10 );
			}

			$workload = array(
				'scenario'          => $scenario,
				'post_content'      => $post_content,
				'paragraphs'        => $paragraphs,
				'clients'           => $clients,
				'read_every'        => $read_every,
				'save_every'        => 0,
				// Wall-clock scenarios map rounds to time, which lets the
				// CLI compose per-request costs into a hosting cost card.
				'seconds_per_round' => 0,
				'rounds'            => array(),
			);

			if ( 'editorial-session' === $scenario ) {
				$workload['rounds']            = self::session_rounds( $rand, $rounds, $clients, $paragraphs );
				$workload['save_every']        = 60; // An autosave a "minute".
				$workload['seconds_per_round'] = 1;
				return $workload;
			}

			// Two operation kinds drive the two settlement paths. Concurrent
			// text inserts MERGE (the text interleaves — correct, not a
			// conflict), so contention is modelled as concurrent writes to a
			// versioned register: two editors changing the SAME block's
			// alignment from the same observed version. The later writer
			// escalates (attr-conflict) — the everyday "we both restyled
			// this block" collision.
			$round_list = array();
			// Per-client roster of own inserted-and-not-yet-removed blocks
			// (structural-churn's removal pool).
			$own_blocks = array_fill( 0, max( 1, $clients ), array() );
			// remove-contention's SHARED pool: inserted blocks every client
			// has observed (each is contended, and thereby consumed, at most
			// once). $pending_remove staggers the single-client degenerate
			// case across rounds.
			$pool           = array();
			$pending_remove = null;
			for ( $r = 0; $r < $rounds; $r++ ) {
				$edits = array();

				switch ( $scenario ) {
					case 'solo-typing':
					case 'long-form':
						$edits[] = array(
							'client'    => 0,
							'paragraph' => $rand( $paragraphs ),
							'op'        => 'text',
						);
						break;

					case 'parallel-paragraphs':
						for ( $c = 0; $c < $clients; $c++ ) {
							$edits[] = array(
								'client'    => $c,
								'paragraph' => $c % $paragraphs,
								'op'        => 'text',
							);
						}
						break;

					case 'contended-paragraph':
						// Every client restyles the same block concurrently.
						$target = $rand( $paragraphs );
						for ( $c = 0; $c < $clients; $c++ ) {
							$edits[] = array(
								'client'    => $c,
								'paragraph' => $target,
								'op'        => 'attr',
							);
						}
						break;

					case 'save-sync-session':
						/*
						 * Batched editing cadence: rounds are wall-clock
						 * seconds; a client WRITES only on its staggered
						 * ~10s save beats, submitting the burst it typed
						 * since its last save as one batch, and reads
						 * on the sync cadence (read_every = 10 for every
						 * client). Engine-agnostic like every scenario — it
						 * measures each engine at the cadence the
						 * Distributed Editing vision prescribes instead of
						 * per-second RTC hammering.
						 */
						for ( $c = 0; $c < $clients; $c++ ) {
							if ( 0 !== ( ( $r + 3 * $c ) % 10 ) ) {
								continue; // Between saves: typing stays local.
							}
							$burst = 2 + $rand( 3 );
							for ( $b = 0; $b < $burst; $b++ ) {
								$edits[] = array(
									'client'    => $c,
									'paragraph' => $rand( $paragraphs ),
									'op'        => $rand( 4 ) < 3 ? 'text' : 'attr',
								);
							}
						}
						break;

					case 'structural-churn':
						// Typing continues while blocks are inserted and
						// removed concurrently: ~50% text, ~30% insert,
						// ~20% remove (of the client's own earlier insert;
						// falls back to text when it has none left).
						for ( $c = 0; $c < $clients; $c++ ) {
							$draw = $rand( 100 );
							if ( $draw < 50 || ( $draw >= 80 && array() === $own_blocks[ $c ] ) ) {
								$edits[] = array(
									'client'    => $c,
									'paragraph' => $rand( $paragraphs ),
									'op'        => 'text',
								);
							} elseif ( $draw < 80 ) {
								$edits[] = self::insert_edit( $c, $r, count( $edits ), $rand( $paragraphs ), $own_blocks );
							} else {
								$edits[] = self::remove_edit( $c, $rand( count( $own_blocks[ $c ] ) ), $own_blocks );
							}
						}
						break;

					case 'field-sync':
						// Entity-field register traffic across the whole
						// register surface (scalar properties, taxonomy term
						// sets, post meta). ~25% of rounds every client
						// writes the SAME register concurrently from the same
						// observed base (contention: intent-log escalates the
						// later writers,
						// the CRDT resolves by its own rules); the rest is
						// clean parallel field sync — each client on its own
						// register — mixed with typing so field and content
						// traffic coexist.
						$registers       = self::field_registers();
						$field_collision = $rand( 100 ) < 25;
						$field_target    = $registers[ $rand( count( $registers ) ) ];
						for ( $c = 0; $c < $clients; $c++ ) {
							if ( $field_collision ) {
								$edits[] = array(
									'client' => $c,
									'op'     => $field_target['op'],
									'name'   => $field_target['name'],
								);
							} elseif ( $rand( 100 ) < 50 ) {
								$register = $registers[ $c % count( $registers ) ];
								$edits[]  = array(
									'client' => $c,
									'op'     => $register['op'],
									'name'   => $register['name'],
								);
							} else {
								$edits[] = array(
									'client'    => $c,
									'paragraph' => $rand( $paragraphs ),
									'op'        => 'text',
								);
							}
						}
						break;

					case 'remove-contention':
						// The edit-vs-remove conflict class: one client types
						// into an inserted block while another concurrently
						// removes it. When the pool of contendable blocks is
						// dry, a SEED round has every client insert one block;
						// those become contendable the NEXT round (every
						// client authors every round, so every client's
						// end-of-round read delivers the inserts before
						// anyone contends them). Otherwise one pool block is
						// contended by a distinct editor/remover pair while
						// the remaining clients type into genesis paragraphs.
						// This is the ONE scenario where a removal targets
						// another client's insert and a text edit targets an
						// inserted block; the oracles stay decidable by
						// scoping each text token's expectation to its target
						// block's final state (see the profiles).
						//
						// At clients=1 there is no second client to contend
						// with, and a real client cannot type into a block it
						// already removed (its canvas no longer has it), so
						// the pair degenerates to SEQUENTIAL edit-then-remove
						// across consecutive rounds; the read between them
						// keeps the single client's authoring realizable.
						if ( 1 === $clients && null !== $pending_remove ) {
							$edits[]        = $pending_remove;
							$pending_remove = null;
							break;
						}

						if ( array() === $pool ) {
							for ( $c = 0; $c < $clients; $c++ ) {
								$seed_edit = self::insert_edit( $c, $r, count( $edits ), $rand( $paragraphs ), $own_blocks );
								$edits[]   = $seed_edit;
								$pool[]    = array(
									'block_id' => $seed_edit['block_id'],
									'marker'   => $seed_edit['marker'],
									'after'    => $seed_edit['after'],
								);
							}
							break;
						}

						$picked      = array_splice( $pool, $rand( count( $pool ) ), 1 );
						$block       = $picked[0];
						$editor      = $rand( $clients );
						$remover     = ( $editor + 1 + $rand( $clients - 1 ) ) % $clients;
						$edits[]     = array(
							'client'   => $editor,
							'op'       => 'text',
							'block_id' => $block['block_id'],
							'marker'   => $block['marker'],
						);
						$remove_edit = array(
							'client'   => $remover,
							'op'       => 'remove_block',
							'block_id' => $block['block_id'],
							'marker'   => $block['marker'],
							'after'    => $block['after'],
						);

						if ( 1 === $clients ) {
							$pending_remove = $remove_edit;
						} else {
							$edits[] = $remove_edit;
						}
						for ( $c = 0; $c < $clients; $c++ ) {
							if ( $c !== $editor && $c !== $remover ) {
								$edits[] = array(
									'client'    => $c,
									'paragraph' => $rand( $paragraphs ),
									'op'        => 'text',
								);
							}
						}
						break;

					case 'mixed-newsroom':
					case 'laggy-newsroom':
					default:
						// ~25% of rounds collide (concurrent restyle of one
						// block); the rest is clean parallel typing.
						$collision = $rand( 100 ) < 25;
						$hotspot   = $rand( $paragraphs );
						for ( $c = 0; $c < $clients; $c++ ) {
							$edits[] = array(
								'client'    => $c,
								'paragraph' => $collision ? $hotspot : $rand( $paragraphs ),
								'op'        => $collision ? 'attr' : 'text',
							);
						}
						break;
				}

				self::finalize_edits( $edits, $r, $rand );
				self::shuffle_edits( $edits, $rand );
				$round_list[] = $edits;
			}

			$workload['rounds'] = $round_list;
			return $workload;
		}

		/**
		 * How often K ingests land in the same round — the workload's
		 * concurrency profile. In production, same-round edits arrive
		 * near-simultaneously, so under a per-room serialized engine the
		 * K-th writer queues behind K-1 merges; this histogram is what the
		 * CLI's queueing model multiplies against measured service time.
		 *
		 * @param array $rounds Workload rounds.
		 * @return array<int, int> Concurrent-ingest count => rounds seen.
		 */
		public static function ingest_concurrency_histogram( array $rounds ): array {
			$histogram = array();
			foreach ( $rounds as $round ) {
				$edits = $round['edits'] ?? $round;
				$k     = count( $edits );
				if ( $k > 0 ) {
					$histogram[ $k ] = ( $histogram[ $k ] ?? 0 ) + 1;
				}
			}
			ksort( $histogram );
			return $histogram;
		}

		/**
		 * The identity marker a genesis paragraph's body starts with.
		 *
		 * @param int $paragraph Paragraph index.
		 * @return string Marker ("Paragraph 3;" — ';' terminates so no
		 *                marker is a substring of another).
		 */
		public static function genesis_marker( int $paragraph ): string {
			return 'Paragraph ' . ( $paragraph + 1 ) . ';';
		}

		/**
		 * Builds the wall-clock session rounds: one round per second.
		 *
		 * Clients join staggered (client c enters at c/(c+1)-spread offsets
		 * across the first tenth of the session) and leave in the last
		 * twentieth; while present they alternate typing BURSTS (3–8 rounds
		 * of one keystroke batch per second) with think-time PAUSES (2–12
		 * rounds); edits are mostly text with occasional restyles and
		 * structure changes. EVERY present client reads every round — the
		 * polling transport's 1 s cadence — expressed as an explicit
		 * `readers` list, so idle-but-open tabs pay their real read cost.
		 *
		 * @param callable $rand       Deterministic draw.
		 * @param int      $rounds     Session length in rounds (seconds).
		 * @param int      $clients    Client count.
		 * @param int      $paragraphs Genesis paragraph count.
		 * @return array Round list (each: array( 'edits', 'readers' )).
		 */
		private static function session_rounds( callable $rand, int $rounds, int $clients, int $paragraphs ): array {
			$clients = max( 1, $clients );
			$join    = array();
			$leave   = array();
			for ( $c = 0; $c < $clients; $c++ ) {
				// Staggered entry across the first tenth; staggered exit
				// across the last twentieth (nobody leaves before joining).
				$join[ $c ]  = (int) floor( $c * $rounds / ( 10 * max( 1, $clients - 1 ) ) );
				$leave[ $c ] = $rounds - 1 - (int) floor( ( $clients - 1 - $c ) * $rounds / ( 20 * max( 1, $clients - 1 ) ) );
				if ( $leave[ $c ] <= $join[ $c ] ) {
					$leave[ $c ] = min( $rounds - 1, $join[ $c ] + 1 );
				}
			}

			// Burst state per client: > 0 = typing rounds left, < 0 = pause
			// rounds left (as a negative count).
			$burst      = array_fill( 0, $clients, 0 );
			$own_blocks = array_fill( 0, $clients, array() );
			$round_list = array();

			for ( $r = 0; $r < $rounds; $r++ ) {
				$edits   = array();
				$readers = array();

				for ( $c = 0; $c < $clients; $c++ ) {
					if ( $r < $join[ $c ] || $r > $leave[ $c ] ) {
						continue;
					}
					$readers[] = $c;

					if ( 0 === $burst[ $c ] ) {
						// Start typing (3–8 rounds) or thinking (2–12).
						$burst[ $c ] = $rand( 2 ) ? 3 + $rand( 6 ) : -( 2 + $rand( 11 ) );
					}
					if ( $burst[ $c ] < 0 ) {
						++$burst[ $c ];
						continue; // Thinking: present, polling, not typing.
					}
					--$burst[ $c ];

					// Typing: mostly text, ~8% restyle, ~2% an entity-field
					// tweak (a scalar property, taxonomy term set, or meta
					// register), ~4% insert a block, ~2% remove an own
					// earlier insert.
					$draw = $rand( 100 );
					if ( $draw < 84 || ( $draw >= 98 && array() === $own_blocks[ $c ] ) ) {
						$edits[] = array(
							'client'    => $c,
							'paragraph' => $rand( $paragraphs ),
							'op'        => 'text',
						);
					} elseif ( $draw < 92 ) {
						$edits[] = array(
							'client'    => $c,
							'paragraph' => $rand( $paragraphs ),
							'op'        => 'attr',
						);
					} elseif ( $draw < 94 ) {
						$registers = self::field_registers();
						$register  = $registers[ $rand( count( $registers ) ) ];
						$edits[]   = array(
							'client' => $c,
							'op'     => $register['op'],
							'name'   => $register['name'],
						);
					} elseif ( $draw < 98 ) {
						$edits[] = self::insert_edit( $c, $r, count( $edits ), $rand( $paragraphs ), $own_blocks );
					} else {
						$edits[] = self::remove_edit( $c, $rand( count( $own_blocks[ $c ] ) ), $own_blocks );
					}
				}

				self::finalize_edits( $edits, $r, $rand );
				self::shuffle_edits( $edits, $rand );
				$round_list[] = array(
					'edits'   => $edits,
					'readers' => $readers,
				);
			}

			return $round_list;
		}

		/**
		 * Builds an insert_block edit and records it in the client's roster.
		 *
		 * @param int   $client     Client index.
		 * @param int   $round      Round index.
		 * @param int   $index      Edit index within the round.
		 * @param int   $after      Genesis paragraph index to insert after.
		 * @param array $own_blocks Per-client roster (by reference).
		 * @return array Edit.
		 */
		private static function insert_edit( int $client, int $round, int $index, int $after, array &$own_blocks ): array {
			$block_id = 'n' . $round . 'c' . $client . '.' . $index;
			$edit     = array(
				'client'   => $client,
				'op'       => 'insert_block',
				'block_id' => $block_id,
				'marker'   => ' b' . $block_id . ';',
				'after'    => $after,
			);

			$own_blocks[ $client ][] = array(
				'block_id' => $block_id,
				'marker'   => $edit['marker'],
				'after'    => $after,
			);
			return $edit;
		}

		/**
		 * Builds a remove_block edit for one of the client's own inserts and
		 * removes it from the roster (each block is removed at most once).
		 *
		 * @param int   $client     Client index.
		 * @param int   $pick       Roster pick index.
		 * @param array $own_blocks Per-client roster (by reference).
		 * @return array Edit.
		 */
		private static function remove_edit( int $client, int $pick, array &$own_blocks ): array {
			$block = $own_blocks[ $client ][ $pick ];
			array_splice( $own_blocks[ $client ], $pick, 1 );
			return array(
				'client'   => $client,
				'op'       => 'remove_block',
				'block_id' => $block['block_id'],
				'marker'   => $block['marker'],
				'after'    => $block['after'],
			);
		}

		/**
		 * Stamps text/attr/property edits with their unique token or value.
		 *
		 * Text edits also draw a seeded abstract position — `head` (offset
		 * 0) or `tail` (the observed end of the field) — so typing is not
		 * all prepends (offset 0 is a special case for both OT transform
		 * paths and CRDT ordering). Profiles map the position to concrete
		 * engine coordinates from each client's own observed state.
		 *
		 * @param array    $edits Round edits (by reference).
		 * @param int      $round Round index.
		 * @param callable $rand  Deterministic draw.
		 */
		private static function finalize_edits( array &$edits, int $round, callable $rand ): void {
			foreach ( $edits as $index => &$edit ) {
				if ( 'text' === $edit['op'] ) {
					// A unique, delimiter-terminated token per edit: the
					// convergence oracles count these in the materialized
					// content, so no token may be a substring of another
					// (';' terminates).
					$edit['text']     = ' r' . $round . 'c' . $edit['client'] . '.' . $index . ';';
					$edit['position'] = 0 === $rand( 2 ) ? 'head' : 'tail';
				} elseif ( 'attr' === $edit['op'] ) {
					$edit['align'] = self::align_value( $round, (int) $edit['client'] );
				} elseif ( 'set_property' === $edit['op'] ) {
					// DISTINCT per client within any round and changing every
					// round, for the same policy-isolation reason as
					// align_value(): identical concurrent register writes
					// read as agreement to a three-way merge but escalate
					// under a version check, so value collisions would turn
					// measured policy differences into artifacts. Registers
					// are compared whole, so no delimiter is needed.
					$edit['value'] = 'f' . $round . 'c' . $edit['client'];
				} elseif ( 'set_terms' === $edit['op'] ) {
					// A whole term-ID set, numerically sorted like the
					// shipping clients and the genesis seed normalize it
					// (engines compare term sets order-insensitively, but
					// generating sorted keeps whole-value comparisons
					// byte-stable for the register oracles). The small ID is
					// client-scoped and the large one rotates per round, so
					// sets follow the same distinctness discipline as
					// set_property values. The IDs need not exist as real
					// terms: registers are opaque to the engines.
					$edit['value'] = array( 2 + (int) $edit['client'], 5000 + $round );
				} elseif ( 'set_meta' === $edit['op'] ) {
					// Same distinctness discipline as set_property values.
					$edit['value'] = 'm' . $round . 'c' . $edit['client'];
				}
			}
			unset( $edit );
		}

		/**
		 * The align value a client writes in a round: DISTINCT per client
		 * within any round, rotating per round so consecutive writes to the
		 * same register keep changing it.
		 *
		 * Distinctness is what isolates POLICY in the cross-engine
		 * escalation comparison: identical concurrent register writes read
		 * as the same value but still escalate under intent-log's version
		 * check. Any accidental
		 * value agreement between contending writers turns part of the
		 * measured difference into an artifact of the value scheme. Clients
		 * beyond the palette get a numbered variant, which keeps the values
		 * distinct at any client count.
		 *
		 * @param int $round  Round index.
		 * @param int $client Client index.
		 * @return string Align value.
		 */
		private static function align_value( int $round, int $client ): string {
			$palette = array( 'left', 'center', 'right', 'wide', 'full' );
			$size    = count( $palette );
			$value   = $palette[ ( $round + $client ) % $size ];

			if ( $client >= $size ) {
				$value .= '-' . intdiv( $client, $size );
			}

			return $value;
		}

		/**
		 * Seeded Fisher-Yates shuffle of a round's edit list.
		 *
		 * Scenarios emit each round's edits in client order 0..N-1, and the
		 * runner submits them in list order. Unshuffled, client 0 would win
		 * every same-round register race, making the escalation rate
		 * arithmetic ((N-1)/N under contended-paragraph) instead of a
		 * measurement, and hiding any order-dependent engine bugs. Shuffling
		 * HERE, at build time, keeps the workload array the single
		 * deterministic source of truth: same seed, same submission order,
		 * identical counted metrics across repetitions.
		 *
		 * @param array    $edits Round edits (by reference).
		 * @param callable $rand  Deterministic draw.
		 */
		private static function shuffle_edits( array &$edits, callable $rand ): void {
			for ( $i = count( $edits ) - 1; $i > 0; $i-- ) {
				$j = $rand( $i + 1 );

				if ( $j !== $i ) {
					$swap        = $edits[ $i ];
					$edits[ $i ] = $edits[ $j ];
					$edits[ $j ] = $swap;
				}
			}
		}
	}
}
