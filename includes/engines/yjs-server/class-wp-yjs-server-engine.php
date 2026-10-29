<?php
/**
 * WP_Yjs_Server_Engine class
 *
 * @package gutenberg
 */

if ( ! class_exists( 'WP_Yjs_Server_Engine' ) ) {

	/**
	 * The server-authoritative Yjs sync engine.
	 *
	 * Where a naive relay engine (like the retired yjs-relay) stores opaque
	 * client blobs and lets the merge happen in each client's CRDT, this
	 * engine understands Yjs on the server (via the vendored y-php
	 * library): it maintains a canonical room document, merges every
	 * incoming update into it, performs compaction itself, and can
	 * materialize the document back to post content — the same
	 * server-side authority the intent-log engine has, built on CRDT
	 * merge semantics instead of a transform log.
	 *
	 * Storage model (the append-log-plus-canonical-document design):
	 *
	 * - The UPDATE LOG is the source of truth. Each accepted client update
	 *   is stored as an `update` row whose data is the base64 Yjs V2 diff of
	 *   what that update added beyond the server's state at ingest
	 *   (diffUpdateV2 against the pre-apply state vector), so redelivered
	 *   or overlapping payloads do not bloat rows with known structs.
	 * - The CANONICAL DOCUMENT is derived state: a compact V2 snapshot in
	 *   room meta, stamped with the log cursor it reflects. Loading applies
	 *   any rows past that cursor on top, so a canonical write that loses a
	 *   save race is repaired from the log on the next load. Ingest adds a
	 *   second repair lane: an update that references items the loaded
	 *   document lacks triggers a full log replay and a retry, and only a
	 *   client genuinely ahead of the log is voided `resync-required`. Yjs
	 *   updates are commutative and idempotent, which is what makes this
	 *   safe WITHOUT the per-room ingest lock the intent-log engine
	 *   requires: over-application converges, and no server-assigned total
	 *   order is needed.
	 * - `snapshot` rows carry the full canonical state (base64 V2): one at
	 *   genesis (built deterministically from post content — a fixed
	 *   per-room clientID and a fixed operation order make concurrent
	 *   genesis writers produce byte-identical, idempotently-mergeable
	 *   rows), and one per server-side compaction checkpoint.
	 *
	 * Compaction is server-driven: once enough rows accumulate past the
	 * previous checkpoint, the engine appends a checkpoint snapshot, trims
	 * history below the PREVIOUS checkpoint (the intent-log retention
	 * invariant: at least one full interval of history is always kept), and
	 * records the floor. Clients whose cursor falls below the floor are
	 * served from the retained checkpoint and re-bootstrap. `should_compact`
	 * is always false — no client is ever nominated.
	 *
	 * Clients may only SEND `update` rows (incremental Yjs V2 updates).
	 * There is no sync_step1/step2 peer dance: a joining client receives
	 * the snapshot row plus the update tail, and uploads its own full state
	 * as an ordinary update when it has local content the server lacks.
	 *
	 * The kses/capability lane runs at ingest and SANITIZES (see
	 * sanitize_unfiltered_html): blocks an unfiltered author's batch
	 * touched whose serialization wp_kses_post would rewrite are replaced
	 * with their sanitized form and the compensating delta broadcasts to
	 * every client. This is what filtering on save does, applied to every
	 * update. What the lane stripped is HELD for review (`held` rows, the
	 * room's hold ledger): someone allowed to publish unfiltered HTML
	 * approves it, edits it, or discards it over the REST review lane.
	 *
	 * KNOWN GAP (relative to intent-log, tracked in
	 * docs/engine-comparison.md): no proposal/review lane — genuine
	 * conflicts resolve by CRDT rules (last-writer-wins on map registers)
	 * rather than escalating; surfacing them would first require conflict
	 * DETECTION, which CRDT merge does not provide.
	 *
	 * Materialization mirrors the intent-log engine's Phase 2a
	 * simplification: a block's rich-text content maps opaquely onto the
	 * inner HTML of its single wrapper element, with the stripped wrapper
	 * kept server-side (room meta, keyed by block clientId) so post content
	 * can be rebuilt. Blocks born in-session fall back to a per-block-type
	 * default wrapper.
	 *
	 * @since 0.2.0
	 * @access private
	 */
	class WP_Yjs_Server_Engine implements WP_Sync_Engine {
		/**
		 * Engine slug.
		 *
		 * @since 0.2.0
		 * @var string
		 */
		const SLUG = 'yjs-server';

		/**
		 * Engine protocol version.
		 *
		 * @since 0.2.0
		 * @var int
		 */
		const PROTOCOL_VERSION = 1;

		/**
		 * Update type: incremental Yjs V2 update (client → server → clients).
		 *
		 * @since 0.2.0
		 * @var string
		 */
		const UPDATE_TYPE_UPDATE = 'update';

		/**
		 * Update type: full-state snapshot (server-emitted only): the genesis
		 * row and compaction checkpoints. Data is `{ doc: <base64 V2> }`.
		 *
		 * @since 0.2.0
		 * @var string
		 */
		const UPDATE_TYPE_SNAPSHOT = 'snapshot';

		/**
		 * The Yjs clientID used for server-authored genesis items. A fixed
		 * value keeps the genesis build fully deterministic (the lock-free
		 * concurrent-genesis guarantee) AND byte-stable across rooms and
		 * benchmark repetitions. Above the editor's pseudo-random client id
		 * range (0..1e9), below 2^31.
		 *
		 * @since 0.2.0
		 * @var int
		 */
		const GENESIS_CLIENT_ID = 2000000000;

		/**
		 * Room meta key: canonical document snapshot + the log cursor it
		 * reflects (`{ doc: <base64 V2>, cursor: int }`).
		 *
		 * @since 0.2.0
		 * @var string
		 */
		const META_DOC = 'yjs_server_doc';

		/**
		 * Room meta key: previous checkpoint (`{ cursor: int }`).
		 *
		 * @since 0.2.0
		 * @var string
		 */
		const META_CHECKPOINT = 'yjs_server_checkpoint';

		/**
		 * Room meta key: trim floor (int cursor).
		 *
		 * @since 0.2.0
		 * @var string
		 */
		const META_FLOOR = 'yjs_server_floor';

		/**
		 * Room meta key: genesis wrapper map (block clientId => open/close).
		 *
		 * @since 0.2.0
		 * @var string
		 */
		const META_WRAPPERS = 'yjs_server_wrappers';

		/**
		 * Update type for a security hold: markup the kses lane stripped
		 * from a filtered author's block, kept for a reviewer who may
		 * publish unfiltered HTML. Server-emitted only. The data is JSON
		 * (see hold_markup()).
		 *
		 * @since n.e.x.t
		 * @var string
		 */
		const UPDATE_TYPE_HELD = 'held';

		/**
		 * Update type closing a security hold (see store_hold_closure()).
		 * Server-emitted only.
		 *
		 * @since n.e.x.t
		 * @var string
		 */
		const UPDATE_TYPE_HELD_RESOLVED = 'held-resolved';

		/**
		 * Room meta key for the open security holds, by hold id. The
		 * durable ledger: the `held` rows announce it, and a checkpoint
		 * re-announces what is still open after it trims the log.
		 *
		 * @since n.e.x.t
		 * @var string
		 */
		const META_HELD = 'yjs_server_held';

		/**
		 * Storage backend.
		 *
		 * @since 0.2.0
		 * @var WP_Sync_Storage
		 */
		private WP_Sync_Storage $storage;

		/**
		 * Per-request cache of loaded room documents, keyed by room:
		 * `array( 'doc' => \Yjs\Utils\Doc, 'cursor' => int )`.
		 *
		 * @since 0.2.0
		 * @var array<string, array|null>
		 */
		private array $room_docs = array();

		/**
		 * Per-request debug info stash, keyed by room (ingest fills it,
		 * get_updates_since attaches it as the `_debug` envelope when the
		 * request opted in). Mirrors the intent-log engine's stash.
		 *
		 * @since 0.2.0
		 * @var array<string, array>
		 */
		private array $debug_stash = array();

		/**
		 * Constructor. Loads the vendored y-php library on first use.
		 *
		 * @since 0.2.0
		 *
		 * @param WP_Sync_Storage $storage Storage backend.
		 */
		public function __construct( WP_Sync_Storage $storage ) {
			$this->storage = $storage;
			require_once dirname( __DIR__, 2 ) . '/lib/y-php-loader.php';
			gutenberg_sync_engines_load_y_php();
		}

		/**
		 * Returns the engine slug.
		 *
		 * @since 0.2.0
		 *
		 * @return string Engine slug.
		 */
		public function get_slug(): string {
			return self::SLUG;
		}

		/**
		 * Returns the engine protocol version.
		 *
		 * @since 0.2.0
		 *
		 * @return int Protocol version.
		 */
		public function get_protocol_version(): int {
			return self::PROTOCOL_VERSION;
		}

		/**
		 * Returns the update types this engine accepts on the route. Clients
		 * may only SEND `update`; `snapshot` is server-emitted (enforced in
		 * handle_updates).
		 *
		 * @since 0.2.0
		 *
		 * @return string[] Accepted update types.
		 */
		public function get_update_types(): array {
			return array(
				self::UPDATE_TYPE_UPDATE,
				self::UPDATE_TYPE_SNAPSHOT,
				self::UPDATE_TYPE_HELD,
				self::UPDATE_TYPE_HELD_RESOLVED,
			);
		}

		/**
		 * Ingests one client's updates for a room.
		 *
		 * Each update is decoded and merged into the canonical document; the
		 * stored row is the diff of what the update contributed beyond the
		 * server's pre-apply state. A batch that changes nothing (a
		 * redelivery after an unknown outcome) settles as benign
		 * `already-merged` voids and appends no rows. Malformed payloads
		 * settle per-update as `invalid-payload` voids rather than failing
		 * the batch — one bad row must not starve valid edits.
		 *
		 * An update that PARSES but references items the loaded document
		 * lacks is not malformed: the canonical snapshot may have lost
		 * content to a save or read-visibility race. The log is the source
		 * of truth, so the document is rebuilt from the full retained log
		 * (bypassing the canonical snapshot) and the update retried, once
		 * per request. Only when even the log cannot supply the
		 * dependencies does the update settle as a `resync-required` void,
		 * telling the client an earlier send never landed and it must
		 * upload its full state (idempotent; the server stores only the
		 * diff).
		 *
		 * No ingest lock is taken: CRDT merge needs no server-assigned total
		 * order, and a concurrent canonical save that loses the race is
		 * repaired from the update log on the next load (see load_room())
		 * or by the in-request replay above.
		 *
		 * @since 0.2.0
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Client identifier.
		 * @param int    $cursor    Client cursor (unused: rows are self-contained).
		 * @param array  $updates   Typed updates.
		 * @param array  $context   Transport context (unused).
		 * @return array|WP_Error array( 'dispositions' => array ) or error.
		 */
		public function handle_updates( string $room, int $client_id, int $cursor, array $updates, array $context ) { // phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- $cursor is part of the WP_Sync_Engine contract.
			if ( array() === $updates ) {
				return array( 'dispositions' => null );
			}

			/*
			 * Ingest always reloads from storage: in production every request
			 * is a fresh process that pays the canonical-document load, and a
			 * warm in-memory doc would also mask rows written by concurrent
			 * requests since this instance last loaded. (This is also what
			 * keeps the benchmark honest about per-request cost.)
			 */
			$this->room_docs[ $room ] = null;
			$state                    = $this->load_room( $room );
			if ( is_wp_error( $state ) ) {
				return $state;
			}
			$doc         = $state['doc'];
			$load_cursor = (int) $state['cursor'];

			$before_bytes = \Yjs\encodeStateAsUpdateV2( $doc )->toBinaryString();
			// The blocks the room has before this batch, to tell afterwards
			// which ones the batch removed (see close_holds_of_removed_blocks()).
			$ids_before = self::all_block_ids( $doc );

			/*
			 * Post-genesis growth policing (tiers 1+2). The genesis
			 * size gate refuses to INITIALIZE an oversized room; this is the
			 * terminal backstop for a room that GROWS past reason afterward:
			 * further writes 413 (reads and saves continue — nothing already
			 * merged is lost, the room just stops accumulating). A soft
			 * warning narrates via qm/debug from 75% so operators see the
			 * growth before the ceiling bites. Tier 3 (epoch compaction that
			 * SHRINKS the canonical) stays parked with incremental canonical
			 * maintenance.
			 */
			$max_room_bytes = (int) apply_filters( 'wp_sync_yjs_server_max_room_bytes', 8 * MB_IN_BYTES, $room );
			if ( $max_room_bytes > 0 && strlen( $before_bytes ) > $max_room_bytes ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: yjs-server room {$room} is over the room-size ceiling (" . strlen( $before_bytes ) . ' bytes); rejecting writes' );
				return new WP_Error(
					'rest_sync_room_full',
					__( 'This collaboration room has grown past its size ceiling; further updates are rejected. Save the post and start a fresh session.', 'gutenberg' ),
					array( 'status' => 413 )
				);
			}
			if ( $max_room_bytes > 0 && strlen( $before_bytes ) > (int) ( 0.75 * $max_room_bytes ) ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: yjs-server room {$room} at " . strlen( $before_bytes ) . ' of ' . $max_room_bytes . ' ceiling bytes' );
			}

			$dispositions = array();
			$diffs        = array();
			$replayed     = false;
			foreach ( $updates as $update ) {
				if ( self::UPDATE_TYPE_UPDATE !== $update['type'] ) {
					return new WP_Error(
						'rest_invalid_update_type',
						__( 'Clients may only send update rows to a yjs-server room.', 'gutenberg' ),
						array( 'status' => 400 )
					);
				}

				// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- Decodes the client's binary CRDT update from the wire format.
				$binary = base64_decode( (string) $update['data'], true );
				if ( false === $binary || '' === $binary ) {
					$dispositions[] = array(
						'status' => 'voided',
						'reason' => 'invalid-payload',
					);
					continue;
				}
				$buffer = \Yjs\Lib0\Buffer::fromBinaryString( $binary );

				$diff = self::apply_update_for_row( $doc, $buffer );
				if ( null !== $diff ) {
					$diffs[ count( $dispositions ) ] = $diff;
					$dispositions[]                  = array( 'status' => 'applied' );
					continue;
				}

				/*
				 * The update did not integrate cleanly: a throw can leave
				 * the document partially mutated, and a missing-dependency
				 * apply can integrate a prefix and park the rest as pending.
				 * Restore the batch baseline exactly (batch-start state plus
				 * the diffs accepted so far) before deciding how to settle.
				 */
				$doc                      = self::rebuild_doc( $before_bytes, $diffs );
				$this->room_docs[ $room ] = null;

				if ( ! self::is_decodable( $buffer ) ) {
					// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
					do_action( 'qm/debug', "wp-sync: yjs-server rejected a malformed update in {$room}" );
					$dispositions[] = array(
						'status' => 'voided',
						'reason' => 'invalid-payload',
					);
					continue;
				}

				/*
				 * Decodable but not integrable: the update references items
				 * this document lacks. The canonical snapshot may have lost
				 * content to a save or read-visibility race, so rebuild from
				 * the full retained log (the source of truth, bypassing the
				 * canonical) and retry, once per request. The baseline and
				 * the stamp cursor move to the replay: the replayed document
				 * reflects every retained row at or below the fresh
				 * watermark, so the under-claim invariant holds.
				 */
				if ( ! $replayed ) {
					$replayed     = true;
					$replay       = $this->replay_room_log( $room );
					$doc          = $replay['doc'];
					$load_cursor  = $replay['cursor'];
					$before_bytes = \Yjs\encodeStateAsUpdateV2( $doc )->toBinaryString();
					foreach ( $diffs as $accepted ) {
						\Yjs\applyUpdateV2( $doc, \Yjs\Lib0\Buffer::fromBase64( $accepted ) );
					}
				}

				$diff = self::apply_update_for_row( $doc, $buffer );
				if ( null !== $diff ) {
					// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
					do_action( 'qm/debug', "wp-sync: yjs-server repaired {$room} from the update log during ingest" );
					$diffs[ count( $dispositions ) ] = $diff;
					$dispositions[]                  = array( 'status' => 'applied' );
					continue;
				}

				/*
				 * Even the full log cannot supply this update's
				 * dependencies: the client is ahead of the room (an earlier
				 * send never landed). Only the client can close that gap,
				 * with a full-state recovery update.
				 */
				$doc                      = self::rebuild_doc( $before_bytes, $diffs );
				$this->room_docs[ $room ] = null;
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: yjs-server update depends on items missing from {$room}; client must resync" );
				$dispositions[] = array(
					'status' => 'voided',
					'reason' => 'resync-required',
				);
			}

			$after_bytes = \Yjs\encodeStateAsUpdateV2( $doc )->toBinaryString();
			if ( $after_bytes === $before_bytes ) {
				// Nothing new: settle would-be applies as benign idempotent
				// voids and leave the row log untouched. A replay-repaired
				// canonical is still worth persisting.
				if ( $replayed ) {
					// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- Encodes the canonical document's binary bytes for storage.
					$this->save_canonical( $room, $doc, $load_cursor, base64_encode( $after_bytes ) );
				}
				foreach ( $dispositions as $i => $disposition ) {
					if ( 'applied' === $disposition['status'] ) {
						$dispositions[ $i ] = array(
							'status' => 'voided',
							'reason' => 'already-merged',
						);
					}
				}
				$this->stash_ingest_debug( $room, $context, $dispositions, 0, $replayed, strlen( $after_bytes ) );
				return array( 'dispositions' => $dispositions );
			}

			if ( array() === $diffs ) {
				/*
				 * The document changed but no diff row was recorded: an update
				 * threw mid-apply and left partial state. Do NOT persist the
				 * canonical snapshot — the log is the source of truth, and the
				 * next load rebuilds a clean document from it.
				 */
				$this->room_docs[ $room ] = null;
				$this->stash_ingest_debug( $room, $context, $dispositions, 0, $replayed, strlen( $after_bytes ) );
				return array( 'dispositions' => $dispositions );
			}

			/*
			 * The kses/capability lane, AFTER the batch integrated: content
			 * from an author without unfiltered_html is FILTERED, not
			 * refused — rejecting an already-integrated CRDT update would
			 * permanently diverge the author's replica (its later updates
			 * depend on the rejected items). Blocks this batch touched
			 * whose serialization kses would rewrite are sanitized in the
			 * canonical document, and the compensating delta broadcasts as
			 * a server-authored row every client (the author included)
			 * converges on — mirroring WordPress's own filter-on-save
			 * semantics at the per-update grain.
			 */
			$kses_diffs = array();
			if ( ! current_user_can( 'unfiltered_html' ) ) {
				$kses_diffs = $this->sanitize_unfiltered_html( $room, $doc, $before_bytes, $client_id );
			}

			foreach ( $diffs as $diff ) {
				if ( ! $this->add_row( $room, $client_id, self::UPDATE_TYPE_UPDATE, $diff ) ) {
					return new WP_Error(
						'rest_sync_storage_error',
						__( 'Failed to store sync update.', 'gutenberg' ),
						array( 'status' => 500 )
					);
				}
			}
			foreach ( $kses_diffs as $kses_diff ) {
				// Server attribution: the read path filters a client's OWN
				// rows, and the sanitizing author must receive this one.
				if ( ! $this->add_row( $room, self::GENESIS_CLIENT_ID, self::UPDATE_TYPE_UPDATE, $kses_diff ) ) {
					return new WP_Error(
						'rest_sync_storage_error',
						__( 'Failed to store sync update.', 'gutenberg' ),
						array( 'status' => 500 )
					);
				}
			}
			if ( array() !== $kses_diffs ) {
				$after_bytes = \Yjs\encodeStateAsUpdateV2( $doc )->toBinaryString();
			}

			// After the rows that removed the blocks, so a client reads the
			// removal first and the closed hold second.
			$this->close_holds_of_removed_blocks( $room, array_diff_key( $ids_before, self::all_block_ids( $doc ) ) );

			// $after_bytes IS the canonical encoding at the new head; reuse
			// it rather than encoding the document a third time.
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- Encodes the canonical document's binary bytes for storage.
			$this->save_canonical( $room, $doc, $load_cursor, base64_encode( $after_bytes ) );
			$this->maybe_checkpoint( $room, $client_id, $doc );

			$this->stash_ingest_debug( $room, $context, $dispositions, count( $diffs ), $replayed, strlen( $after_bytes ), count( $kses_diffs ) );
			return array( 'dispositions' => $dispositions );
		}

		/**
		 * Sanitizes protected markup an unfiltered author's batch introduced.
		 *
		 * Judged at the top-level-block grain against the batch baseline:
		 * a block whose serialization is byte-identical to a pre-batch
		 * block was not touched here and is never judged (privileged
		 * content survives untouched); a touched block whose serialization
		 * `wp_kses_post` would rewrite is REPLACED in the canonical
		 * document with its sanitized form (rebuilt through the genesis
		 * block builder, wrappers recorded). The sanitized form keeps the
		 * block's id: to every editor it is the same block with other
		 * content, and an open hold over it still names it. Returns the
		 * compensating deltas to broadcast, empty when nothing was
		 * sanitized.
		 *
		 * The stripped markup is not thrown away: each sanitized block is
		 * HELD for review (see hold_markup()), so someone allowed to
		 * publish unfiltered HTML can approve it, edit it, or discard it.
		 *
		 * @since 0.4.0
		 *
		 * @param string         $room         Room identifier.
		 * @param \Yjs\Utils\Doc $doc          Canonical document (mutated).
		 * @param string         $before_bytes Batch-start encoding.
		 * @param int            $client_id    The authoring client.
		 * @return string[] Base64 compensation deltas (zero or one).
		 */
		private function sanitize_unfiltered_html( string $room, \Yjs\Utils\Doc $doc, string $before_bytes, int $client_id = 0 ): array {
			$wrappers = $this->room_wrappers( $room );
			$after    = self::materialize_blocks( $doc, $wrappers );

			$dirty = array();
			foreach ( $after as $index => $serialized ) {
				if ( wp_kses_post( $serialized ) !== $serialized ) {
					$dirty[ $index ] = $serialized;
				}
			}
			if ( array() === $dirty ) {
				return array();
			}

			// Only blocks THIS batch touched are judged: byte-identical
			// pre-batch blocks pass through (a privileged author's raw
			// HTML is not destroyed by an unprivileged peer's unrelated
			// edit).
			$before_doc  = self::rebuild_doc( $before_bytes, array() );
			$before_list = self::materialize_blocks( $before_doc, $wrappers );
			$before_set  = array_fill_keys( $before_list, true );
			$before_ids  = self::all_block_ids( $before_doc );
			foreach ( $dirty as $index => $serialized ) {
				if ( isset( $before_set[ $serialized ] ) ) {
					unset( $dirty[ $index ] );
				}
			}
			if ( array() === $dirty ) {
				return array();
			}

			$record  = $doc->getMap( 'document' );
			$yblocks = $record->get( 'blocks' );
			if ( ! ( $yblocks instanceof \Yjs\Types\YArray ) ) {
				return array();
			}

			// phpcs:ignore WordPress.NamingConventions.ValidVariableName.UsedPropertyNotSnakeCase -- clientID is the y-php Doc property, mirroring JS Yjs naming.
			$doc->clientID = self::GENESIS_CLIENT_ID;
			$state_vector  = \Yjs\encodeStateVector( $doc );

			// Replace from the highest index down so earlier indices stay
			// valid while later entries are swapped.
			krsort( $dirty );
			$sanitized_count = 0;
			$holds           = array();
			foreach ( $dirty as $index => $serialized ) {
				$sanitized = wp_kses_post( $serialized );
				$parsed    = self::parse_content_blocks( $sanitized );
				// The id of the block the author wrote into. The sanitized
				// form keeps it, so every open hold over this block, by
				// this author or another, still names the block (see
				// blocks_to_yblocks()).
				$replaced    = $yblocks->get( $index );
				$replaced_id = null;
				if ( $replaced instanceof \Yjs\Types\YMap && is_string( $replaced->get( 'clientId' ) ) && '' !== $replaced->get( 'clientId' ) ) {
					$replaced_id = $replaced->get( 'clientId' );
					// The wrapper recorded under the id is for the form
					// that goes away.
					unset( $wrappers[ $replaced_id ] );
				}
				$id_base = 'kses-' . substr( md5( $room . '|' . $index . '|' . $serialized ), 0, 8 );
				$specs   = self::blocks_to_yblocks( $parsed, $id_base, $wrappers, $replaced_id );
				$yblocks->delete( $index, 1 );
				$block_id = null;
				// Where an approval puts the markup back when nothing of
				// the block is left: after the block that is before it now
				// ('' at the start of the document).
				$after_id = '';
				if ( $index > 0 ) {
					$neighbour = $yblocks->get( $index - 1 );
					if ( $neighbour instanceof \Yjs\Types\YMap && is_string( $neighbour->get( 'clientId' ) ) ) {
						$after_id = $neighbour->get( 'clientId' );
					}
				}
				if ( array() !== $specs ) {
					$yblocks->insert( $index, $specs );
					// The block's id in every editor: the review card's
					// anchor. A block that had no id gets a new one.
					$block_id = $replaced_id ?? $id_base . '-0';
					// The hold records the block as the document now has
					// it, written out the way an approval reads it back
					// (see apply_held_content()): the two then match byte
					// for byte for as long as nobody edits the block.
					$inserted = $yblocks->get( $index );
					if ( $inserted instanceof \Yjs\Types\YMap ) {
						$sanitized = self::materialize_yblock( $inserted, $wrappers );
					}
				}
				$holds[] = array(
					'blockId'    => $block_id,
					'index'      => (int) $index,
					'held'       => $serialized,
					'sanitized'  => $sanitized,
					// What the block was before this batch, when the same
					// slot held one ('' for a block this batch added).
					'base'       => isset( $before_list[ $index ] ) && count( $before_list ) === count( $after ) ? $before_list[ $index ] : '',
					'afterId'    => $after_id,
					// Not part of the row: how hold_markup() finds the
					// open hold over the same block.
					'replacedId' => $replaced_id,
					'added'      => null === $replaced_id || ! isset( $before_ids[ $replaced_id ] ),
				);
				++$sanitized_count;
			}

			if ( method_exists( $this->storage, 'set_room_meta' ) ) {
				$this->storage->set_room_meta( $room, self::META_WRAPPERS, $wrappers );
			}

			// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
			do_action( 'qm/debug', "wp-sync: yjs-server sanitized {$sanitized_count} block(s) from an author without unfiltered_html in {$room}" );

			// Lowest index first, so the announcements read in document order.
			foreach ( array_reverse( $holds ) as $hold ) {
				$this->hold_markup( $room, $client_id, $hold );
			}

			return array( \Yjs\encodeStateAsUpdateV2( $doc, $state_vector )->toBase64() );
		}

		/**
		 * The room's open security holds, by hold id.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room Room identifier.
		 * @return array<string, array> Open holds.
		 */
		public function get_open_holds( string $room ): array {
			if ( ! method_exists( $this->storage, 'get_room_meta' ) ) {
				return array();
			}
			$held = $this->storage->get_room_meta( $room, self::META_HELD );
			return is_array( $held ) ? $held : array();
		}

		/**
		 * Holds one sanitized block's stripped markup for review: records
		 * it in the room's ledger and announces it as a `held` row every
		 * client lists. ONE hold per author and block: a newer hold by the
		 * same author over the same block supersedes the open one, so an
		 * author who keeps editing a held block raises one review task,
		 * not one per typing burst. The block is followed by its id, not
		 * by its position (see is_hold_over_same_block()).
		 *
		 * A hold whose block did not survive sanitizing (blockId null)
		 * records afterId instead: the id of the block that was before it
		 * ('' at the start of the document), which is where an approval
		 * puts the markup back.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id The authoring client.
		 * @param array  $hold      blockId, index, held, sanitized, base,
		 *                          afterId, and the two fields that find the open
		 *                          hold over the same block: replacedId
		 *                          (the id the block had when the author
		 *                          wrote into it) and added (whether this
		 *                          batch added the block).
		 * @return void
		 */
		private function hold_markup( string $room, int $client_id, array $hold ): void {
			if ( ! method_exists( $this->storage, 'get_room_meta' ) || ! method_exists( $this->storage, 'set_room_meta' ) ) {
				return;
			}
			$author = get_current_user_id();
			$ledger = $this->get_open_holds( $room );

			foreach ( $ledger as $open_id => $open ) {
				if ( ! is_array( $open ) || (int) ( $open['author'] ?? 0 ) !== $author || ! self::is_hold_over_same_block( $open, $hold ) ) {
					continue;
				}
				if ( ( $open['held'] ?? null ) === $hold['held'] ) {
					return; // The same markup is already held.
				}
				// The reviewer compares against what the block was before
				// the author's FIRST held batch: carry that base over.
				$hold['base'] = is_string( $open['base'] ?? null ) ? $open['base'] : $hold['base'];
				// A hold whose closing row was not stored stays open beside
				// the new one; the author's next batch supersedes it again.
				if ( $this->store_hold_closure( $room, (string) $open_id, 'superseded' ) ) {
					unset( $ledger[ $open_id ] );
				}
			}

			$hold_id = 'h-' . substr( md5( $room . '|' . $author . '|' . $hold['index'] . '|' . $hold['held'] . '|' . microtime() ), 0, 12 );
			$entry   = array(
				'holdId'         => $hold_id,
				'blockId'        => $hold['blockId'],
				'index'          => (int) $hold['index'],
				'held'           => (string) $hold['held'],
				'sanitized'      => (string) $hold['sanitized'],
				'base'           => (string) $hold['base'],
				'author'         => $author,
				'authorClientId' => $client_id,
				'at'             => time(),
			);
			if ( null === $hold['blockId'] ) {
				$entry['afterId'] = (string) ( $hold['afterId'] ?? '' );
			}
			if ( $this->add_row( $room, self::GENESIS_CLIENT_ID, self::UPDATE_TYPE_HELD, (string) wp_json_encode( $entry ) ) ) {
				$ledger[ $hold_id ] = $entry;
			}
			$this->storage->set_room_meta( $room, self::META_HELD, $ledger );
		}

		/**
		 * Closes the open holds whose block was just removed from the
		 * document, with the resolution `block-removed`.
		 *
		 * A hold is a request to put markup back into one block. Once
		 * the block is gone there is nothing to approve: without this the
		 * hold would stay open, be announced again after every checkpoint,
		 * and sit in every reviewer's list until someone dismissed it.
		 *
		 * Only blocks the CALLER saw go away are passed in, never "every
		 * hold whose block I cannot find". Writes are not locked, so
		 * another request may have just raised a hold on a block whose
		 * rows this request has not read yet, and that hold must stay.
		 *
		 * A block is the same block for as long as its id is in the
		 * document, at any depth: a block moved into a group keeps its
		 * hold. A block removed and then put back by an undo does not
		 * get its hold back.
		 *
		 * @since n.e.x.t
		 *
		 * @param string              $room        Room identifier.
		 * @param array<string, true> $removed_ids Ids of the removed blocks, as keys.
		 * @param string|null         $except      A hold to leave alone (the
		 *                                         one the caller is closing
		 *                                         itself).
		 * @return void
		 */
		private function close_holds_of_removed_blocks( string $room, array $removed_ids, ?string $except = null ): void {
			if ( array() === $removed_ids || ! method_exists( $this->storage, 'set_room_meta' ) ) {
				return;
			}

			$ledger = $this->get_open_holds( $room );
			$closed = false;
			foreach ( $ledger as $hold_id => $hold ) {
				if (
					(string) $hold_id === $except ||
					! is_array( $hold ) ||
					! is_string( $hold['blockId'] ?? null ) ||
					! isset( $removed_ids[ $hold['blockId'] ] )
				) {
					continue;
				}

				if ( $this->store_hold_closure( $room, (string) $hold_id, 'block-removed' ) ) {
					unset( $ledger[ $hold_id ] );
					$closed = true;
				}
			}

			if ( $closed ) {
				$this->storage->set_room_meta( $room, self::META_HELD, $ledger );
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: yjs-server closed a hold whose block was removed from {$room}" );
			}
		}

		/**
		 * Stores the row that closes a security hold for every client.
		 *
		 * The row first, the ledger second, at every call site: the row is
		 * what tells every client the hold is closed. If it cannot be
		 * stored the ledger must still have the hold, or the server would
		 * take the next decision as "already closed" and do nothing with
		 * it. A caller forgets the hold only when this returns true.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room       Room identifier.
		 * @param string $hold_id    The hold.
		 * @param string $resolution accepted, dismissed, superseded, or
		 *                           block-removed.
		 * @param array  $extra      More fields for the row (resolvedBy).
		 * @return bool Whether the row was stored.
		 */
		private function store_hold_closure( string $room, string $hold_id, string $resolution, array $extra = array() ): bool {
			return $this->add_row(
				$room,
				self::GENESIS_CLIENT_ID,
				self::UPDATE_TYPE_HELD_RESOLVED,
				(string) wp_json_encode(
					array_merge(
						array(
							'holdId'     => $hold_id,
							'resolution' => $resolution,
						),
						$extra,
						array( 'time' => time() )
					)
				)
			);
		}

		/**
		 * Whether a new hold is over the block of an open hold.
		 *
		 * The open hold names its block by id, a sanitized block keeps
		 * its id, and the author's next attempt is written into that
		 * block, so the two match when the ids do. Positions are not
		 * compared: a block inserted or
		 * removed above moves every block below it. Example: a hold is
		 * open on the first block, then the author inserts a new block
		 * with a script above it. The new hold is also on the first
		 * position, but it is about another block, so both stay open.
		 *
		 * An open hold whose block was removed entirely has no id to
		 * follow. It matches a block the author ADDED at the same
		 * position, which is how a second try at the removed block
		 * arrives. It never matches a block that was already in the
		 * document.
		 *
		 * @since n.e.x.t
		 *
		 * @param array $open The open hold, as the ledger has it.
		 * @param array $hold The new hold (see hold_markup()).
		 * @return bool Whether both are over one block.
		 */
		private static function is_hold_over_same_block( array $open, array $hold ): bool {
			if ( is_string( $open['blockId'] ?? null ) ) {
				return ( $hold['replacedId'] ?? null ) === $open['blockId'];
			}

			return ! empty( $hold['added'] ) && (int) ( $open['index'] ?? -1 ) === (int) $hold['index'];
		}

		/**
		 * Decides one security hold, outside the transport (the REST review
		 * lane: decisions are mutations and belong on an authenticated
		 * route). `accepted` lands the reviewer's content in place of the
		 * sanitized block, as a server-authored update every client merges
		 * like any other, and needs the unfiltered_html capability.
		 * `dismissed` keeps the sanitized block. Either closes the hold
		 * for every client. An unknown or closed hold acks without
		 * changing anything.
		 *
		 * An approval replaces the sanitized block wholly, so it must not
		 * land on a block the reviewer never saw (`$seen`; see
		 * refuse_stale_hold()).
		 *
		 * @since n.e.x.t
		 *
		 * @param string      $room       Room identifier.
		 * @param string      $hold_id    Hold id.
		 * @param string      $resolution 'accepted' or 'dismissed'.
		 * @param string|null $content    The replacement for 'accepted', as
		 *                                serialized blocks ('' removes the
		 *                                block). Null lands the held markup.
		 * @param string|null $seen       The sanitized block the reviewer
		 *                                saw, for 'accepted'. Null stands
		 *                                for the hold as it is recorded.
		 * @return array|WP_Error Disposition, or error.
		 */
		public function resolve_hold( string $room, string $hold_id, string $resolution, ?string $content = null, ?string $seen = null ) {
			if ( '' === $hold_id || ! in_array( $resolution, array( 'accepted', 'dismissed' ), true ) ) {
				return new WP_Error(
					'rest_sync_invalid_intent',
					__( 'Malformed hold resolution.', 'gutenberg-sync-engines' ),
					array( 'status' => 400 )
				);
			}
			$disposition = array(
				'intentId' => $hold_id,
				'status'   => 'resolved',
			);
			$ledger      = $this->get_open_holds( $room );
			$hold        = $ledger[ $hold_id ] ?? null;
			if ( ! is_array( $hold ) ) {
				return $disposition;
			}

			if ( 'accepted' === $resolution ) {
				if ( ! current_user_can( 'unfiltered_html' ) ) {
					return new WP_Error(
						'rest_sync_forbidden',
						__( 'Approving this content requires permission to publish unfiltered HTML.', 'gutenberg-sync-engines' ),
						array( 'status' => 403 )
					);
				}
				$applied = $this->apply_held_content( $room, $hold, null === $content ? (string) $hold['held'] : $content, $seen );
				if ( is_wp_error( $applied ) ) {
					return $applied;
				}
				$disposition['applied'] = $applied;
			}

			$stored = $this->store_hold_closure( $room, $hold_id, $resolution, array( 'resolvedBy' => get_current_user_id() ) );
			if ( ! $stored ) {
				return new WP_Error(
					'rest_sync_storage_error',
					__( 'Failed to store sync update.', 'gutenberg' ),
					array( 'status' => 500 )
				);
			}

			// Re-read: the apply may have checkpointed and re-announced.
			$ledger = $this->get_open_holds( $room );
			unset( $ledger[ $hold_id ] );
			$this->storage->set_room_meta( $room, self::META_HELD, $ledger );

			return $disposition;
		}

		/**
		 * Lands a reviewer's content in place of a held block: the block
		 * carrying the hold's id is replaced in the canonical document
		 * (when the hold left no block behind, the content is inserted at
		 * its recorded slot), and the delta broadcasts as a server-authored
		 * row, the way the kses lane's own compensation does. The first
		 * block of the content keeps the held block's id, as a sanitized
		 * block does.
		 *
		 * The block is replaced wholly, so an edit made to it after the
		 * reviewer last saw it would be lost. That case is refused before
		 * anything is written (see refuse_stale_hold()).
		 *
		 * @since n.e.x.t
		 *
		 * @param string      $room    Room identifier.
		 * @param array       $hold    The hold.
		 * @param string      $content Serialized replacement blocks ('' removes).
		 * @param string|null $seen    The sanitized block the reviewer saw;
		 *                             null stands for the hold as recorded.
		 * @return bool|WP_Error Whether the document changed, or an error.
		 */
		private function apply_held_content( string $room, array $hold, string $content, ?string $seen = null ) {
			$this->room_docs[ $room ] = null;
			$state                    = $this->load_room( $room );
			if ( is_wp_error( $state ) ) {
				return $state;
			}
			$doc     = $state['doc'];
			$yblocks = $doc->getMap( 'document' )->get( 'blocks' );
			if ( ! ( $yblocks instanceof \Yjs\Types\YArray ) ) {
				return false;
			}

			// The block is looked for at any depth: someone may have moved
			// it into a group since the hold was raised.
			$siblings = $yblocks;
			$found    = null;
			if ( is_string( $hold['blockId'] ?? null ) ) {
				$place = self::find_yblock( $yblocks, $hold['blockId'] );
				if ( null === $place ) {
					// The sanitized block is gone (someone removed or
					// replaced it): there is nothing to put the markup
					// back into.
					return false;
				}
				list( $siblings, $found ) = $place;
			}
			$index = $found ?? self::held_insertion_index( $yblocks, $hold );

			$wrappers = $this->room_wrappers( $room );
			if ( null !== $found ) {
				$live = self::materialize_yblock( $siblings->get( $found ), $wrappers );
				if ( ( $seen ?? (string) ( $hold['sanitized'] ?? '' ) ) !== $live ) {
					return $this->refuse_stale_hold( $room, $hold, $live );
				}
			}
			$parsed = array();
			if ( '' !== trim( $content ) ) {
				$parsed = self::parse_content_blocks( $content );
			}
			// The first block of the content takes the place of the held
			// block and keeps its id, so another author's open hold over
			// the same block still names it.
			$kept_id = null;
			if ( null !== $found ) {
				$kept_id = $hold['blockId'];
				unset( $wrappers[ $kept_id ] );
			}
			$id_base = 'held-' . substr( md5( $room . '|' . ( $hold['holdId'] ?? '' ) . '|' . $content ), 0, 8 );
			$specs   = self::blocks_to_yblocks( $parsed, $id_base, $wrappers, $kept_id );
			if ( null === $found && array() === $specs ) {
				return false;
			}

			// phpcs:ignore WordPress.NamingConventions.ValidVariableName.UsedPropertyNotSnakeCase -- clientID is the y-php Doc property, mirroring JS Yjs naming.
			$doc->clientID = self::GENESIS_CLIENT_ID;
			$state_vector  = \Yjs\encodeStateVector( $doc );
			$ids_before    = self::all_block_ids( $doc );
			if ( null !== $found ) {
				$siblings->delete( $index, 1 );
			}
			if ( array() !== $specs ) {
				$siblings->insert( $index, $specs );
			}

			$diff = \Yjs\encodeStateAsUpdateV2( $doc, $state_vector )->toBase64();
			if ( ! $this->add_row( $room, self::GENESIS_CLIENT_ID, self::UPDATE_TYPE_UPDATE, $diff ) ) {
				return new WP_Error(
					'rest_sync_storage_error',
					__( 'Failed to store sync update.', 'gutenberg' ),
					array( 'status' => 500 )
				);
			}
			if ( method_exists( $this->storage, 'set_room_meta' ) ) {
				$this->storage->set_room_meta( $room, self::META_WRAPPERS, $wrappers );
			}
			// The approved content may have removed the block (empty
			// content) or blocks inside it. Other holds on those close.
			// The caller closes this one.
			$this->close_holds_of_removed_blocks(
				$room,
				array_diff_key( $ids_before, self::all_block_ids( $doc ) ),
				(string) ( $hold['holdId'] ?? '' )
			);
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- Encodes the canonical document's binary bytes for storage.
			$this->save_canonical( $room, $doc, (int) $state['cursor'], base64_encode( \Yjs\encodeStateAsUpdateV2( $doc )->toBinaryString() ) );
			$this->maybe_checkpoint( $room, self::GENESIS_CLIENT_ID, $doc );
			// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
			do_action( 'qm/debug', "wp-sync: yjs-server landed approved markup for a held block in {$room}" );

			return true;
		}

		/**
		 * Refuses an approval whose block changed after the reviewer saw
		 * it. The hold stays open and now records the block as it reads,
		 * and that hold is announced again so every reviewer's dialog shows
		 * the block an approval would really replace. The refusal carries
		 * the same hold, for the reviewer who was refused.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room Room identifier.
		 * @param array  $hold The hold.
		 * @param string $live The sanitized block as the document has it.
		 * @return WP_Error The 409 `review_stale` refusal.
		 */
		private function refuse_stale_hold( string $room, array $hold, string $live ): WP_Error {
			$hold_id = (string) ( $hold['holdId'] ?? '' );
			if ( ( $hold['sanitized'] ?? null ) !== $live ) {
				$hold['sanitized'] = $live;
				$ledger            = $this->get_open_holds( $room );
				if ( isset( $ledger[ $hold_id ] ) && method_exists( $this->storage, 'set_room_meta' ) ) {
					$ledger[ $hold_id ] = $hold;
					$this->add_row( $room, self::GENESIS_CLIENT_ID, self::UPDATE_TYPE_HELD, (string) wp_json_encode( $hold ) );
					$this->storage->set_room_meta( $room, self::META_HELD, $ledger );
				}
			}

			return new WP_Error(
				'review_stale',
				__( 'This block changed after the decision was made. Review it again.', 'gutenberg-sync-engines' ),
				array(
					'status' => 409,
					'hold'   => $hold,
				)
			);
		}

		/**
		 * Returns rows after the cursor for a catching-up client.
		 *
		 * A client's own `update` rows are filtered out (it already holds its
		 * own changes); `snapshot` rows are always delivered. A cursor below
		 * the compaction floor is clamped to the retained checkpoint row so
		 * the client re-bootstraps from it.
		 *
		 * @since 0.2.0
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Client identifier.
		 * @param int    $cursor    Return rows after this cursor.
		 * @param array  $context   Transport context (unused).
		 * @return array Room response data.
		 */
		public function get_updates_since( string $room, int $client_id, int $cursor, array $context ): array {
			if ( $cursor > 0 && method_exists( $this->storage, 'get_room_meta' ) ) {
				$floor = $this->storage->get_room_meta( $room, self::META_FLOOR );
				if ( is_numeric( $floor ) && $cursor < (int) $floor ) {
					$cursor = (int) $floor - 1;
				}
			}

			$rows = $this->storage->get_updates_after_cursor( $room, $cursor );

			/*
			 * Ensure genesis exists so first pollers receive the snapshot.
			 * The check runs AFTER the read because the storage's update
			 * count is a per-request cache that only that read refreshes: a
			 * cold cache reads 0 for rooms full of rows (making a
			 * before-the-read check trigger a needless O(doc) load on every
			 * request's first poll), and a warm one reads stale non-zero for
			 * a room the transport just reset after an engine switch. Fresh
			 * count of zero = the room truly has no rows: initialize it and
			 * re-read so this response carries the genesis snapshot.
			 */
			if ( 0 === $this->storage->get_update_count( $room ) ) {
				$this->room_docs[ $room ] = null;
				$this->load_room( $room );
				$rows = $this->storage->get_updates_after_cursor( $room, $cursor );
			}
			$typed_updates = array();
			foreach ( $rows as $row ) {
				if ( self::UPDATE_TYPE_UPDATE === $row['type'] && $client_id === $row['client_id'] ) {
					continue;
				}
				$typed_updates[] = array(
					'data' => $row['data'],
					'type' => $row['type'],
				);
			}

			$response = array(
				'end_cursor'     => $this->storage->get_cursor( $room ),
				'room'           => $room,
				'should_compact' => false,
				'total_updates'  => $this->storage->get_update_count( $room ),
				'updates'        => $typed_updates,
			);

			// The debug envelope: engine facts from this request's ingest
			// half (the stash) plus read-side counts. Attached only when
			// the request opted in AND the site allows it (transport gate).
			if ( ! empty( $context['debug'] ) ) {
				$response['_debug'] = array_merge(
					$this->debug_stash[ $room ] ?? array(),
					array(
						'rows_returned' => count( $typed_updates ),
						'total_rows'    => $response['total_updates'],
					)
				);
				unset( $this->debug_stash[ $room ] );
			}

			return $response;
		}

		/**
		 * Fills the per-request debug stash from an ingest's outcome when the
		 * request opted into the debug envelope.
		 *
		 * @since 0.2.0
		 *
		 * @param string $room           Room identifier.
		 * @param array  $context        Transport context.
		 * @param array  $dispositions   Final per-update dispositions.
		 * @param int    $appended_rows  Rows appended to the log.
		 * @param bool   $replayed       Whether ingest repaired from the log.
		 * @param int    $doc_bytes      Canonical document size in bytes.
		 * @param int    $kses_sanitized Blocks the kses lane sanitized.
		 */
		private function stash_ingest_debug( string $room, array $context, array $dispositions, int $appended_rows, bool $replayed, int $doc_bytes, int $kses_sanitized = 0 ): void {
			if ( empty( $context['debug'] ) ) {
				return;
			}
			$counts = array();
			foreach ( $dispositions as $disposition ) {
				$key            = $disposition['status'] . ( isset( $disposition['reason'] ) ? ':' . $disposition['reason'] : '' );
				$counts[ $key ] = ( $counts[ $key ] ?? 0 ) + 1;
			}
			$this->debug_stash[ $room ] = array(
				'doc_bytes'      => $doc_bytes,
				'appended_rows'  => $appended_rows,
				'replayed'       => $replayed,
				'ingest'         => $counts,
				'kses_sanitized' => $kses_sanitized,
			);
		}

		/**
		 * Serializes the room's canonical document back to post content.
		 *
		 * @since 0.2.0
		 *
		 * @param string $room Room identifier.
		 * @return string|null Serialized block content, or null on failure.
		 */
		public function materialize( string $room ): ?string {
			$state = $this->load_room( $room );
			if ( is_wp_error( $state ) ) {
				return null;
			}

			$wrappers = $this->room_wrappers( $room );

			return implode( "\n\n", self::materialize_blocks( $state['doc'], $wrappers ) );
		}

		/**
		 * The room's out-of-band wrapper map (see blocks_to_yblocks).
		 *
		 * @since 0.4.0
		 *
		 * @param string $room Room identifier.
		 * @return array clientId => wrapper map.
		 */
		private function room_wrappers( string $room ): array {
			if ( ! method_exists( $this->storage, 'get_room_meta' ) ) {
				return array();
			}
			$stored = $this->storage->get_room_meta( $room, self::META_WRAPPERS );
			return is_array( $stored ) ? $stored : array();
		}

		/**
		 * Serializes a document's top-level blocks, one string per block.
		 *
		 * The per-index shape (rather than one joined string) is what the
		 * kses lane diffs: an unchanged block serializes byte-identically
		 * before and after a batch, so only blocks the batch touched are
		 * ever judged.
		 *
		 * @since 0.4.0
		 *
		 * @param \Yjs\Utils\Doc $doc      Canonical document.
		 * @param array          $wrappers Wrapper map for materialization.
		 * @return string[] Serialized top-level blocks in order.
		 */
		private static function materialize_blocks( \Yjs\Utils\Doc $doc, array $wrappers ): array {
			$record = $doc->getMap( 'document' );
			$blocks = $record->get( 'blocks' );
			if ( ! ( $blocks instanceof \Yjs\Types\YArray ) ) {
				return array();
			}

			$serialized = array();
			foreach ( $blocks->toJSON() as $block ) {
				$block = self::normalize_json( $block );
				if ( ! is_array( $block ) ) {
					continue;
				}
				$serialized[] = serialize_block( self::to_serializable_block( $block, $wrappers ) );
			}

			return $serialized;
		}

		/**
		 * Serialized content as parsed blocks, without the empty freeform
		 * blocks the parser makes of the whitespace between blocks.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $content Serialized blocks.
		 * @return array Parsed blocks (parse_blocks shape).
		 */
		private static function parse_content_blocks( string $content ): array {
			return array_values(
				array_filter(
					parse_blocks( $content ),
					static function ( $block ) {
						return ! empty( $block['blockName'] ) || '' !== trim( (string) implode( '', $block['innerContent'] ?? array() ) );
					}
				)
			);
		}

		/**
		 * The ids of every block in a document, at any depth, as array
		 * keys.
		 *
		 * @since n.e.x.t
		 *
		 * @param \Yjs\Utils\Doc $doc The document.
		 * @return array<string, true> Block id => true.
		 */
		private static function all_block_ids( \Yjs\Utils\Doc $doc ): array {
			$ids    = array();
			$blocks = $doc->getMap( 'document' )->get( 'blocks' );
			if ( $blocks instanceof \Yjs\Types\YArray ) {
				self::collect_block_ids( $blocks, $ids );
			}

			return $ids;
		}

		/**
		 * Adds the ids of a list of blocks, and of the blocks inside
		 * them, to a set.
		 *
		 * @since n.e.x.t
		 *
		 * @param \Yjs\Types\YArray   $blocks The blocks.
		 * @param array<string, true> $ids    The set (by reference).
		 * @return void
		 */
		private static function collect_block_ids( \Yjs\Types\YArray $blocks, array &$ids ): void {
			foreach ( $blocks->toArray() as $block ) {
				if ( ! ( $block instanceof \Yjs\Types\YMap ) ) {
					continue;
				}
				$id = $block->get( 'clientId' );
				if ( is_string( $id ) ) {
					$ids[ $id ] = true;
				}
				$inner = $block->get( 'innerBlocks' );
				if ( $inner instanceof \Yjs\Types\YArray ) {
					self::collect_block_ids( $inner, $ids );
				}
			}
		}

		/**
		 * Finds a block by its id, at any depth.
		 *
		 * @since n.e.x.t
		 *
		 * @param \Yjs\Types\YArray $blocks The blocks to look through.
		 * @param string            $id     The block's id.
		 * @return array|null The list the block is in and its position
		 *                    there, or null when no block has the id.
		 */
		private static function find_yblock( \Yjs\Types\YArray $blocks, string $id ): ?array {
			foreach ( $blocks->toArray() as $position => $block ) {
				if ( ! ( $block instanceof \Yjs\Types\YMap ) ) {
					continue;
				}
				if ( $block->get( 'clientId' ) === $id ) {
					return array( $blocks, $position );
				}
				$inner = $block->get( 'innerBlocks' );
				if ( $inner instanceof \Yjs\Types\YArray ) {
					$place = self::find_yblock( $inner, $id );
					if ( null !== $place ) {
						return $place;
					}
				}
			}

			return null;
		}

		/**
		 * Where the approved content of a hold with no block goes, among
		 * the top-level blocks.
		 *
		 * The position recorded with the hold goes stale as soon as a
		 * block is added or removed above it. The hold also names the
		 * block that was before it, and that block is followed by its
		 * id: the content goes right after it. Example: the hold was
		 * raised between the first and second paragraphs, then someone
		 * added three blocks at the top. The content still lands after
		 * the paragraph that was first. When that block is gone too, the
		 * content goes to the end of the document. A hold from before
		 * this field existed uses its recorded position.
		 *
		 * @since n.e.x.t
		 *
		 * @param \Yjs\Types\YArray $yblocks The top-level blocks.
		 * @param array             $hold    The hold.
		 * @return int The position to insert at.
		 */
		private static function held_insertion_index( \Yjs\Types\YArray $yblocks, array $hold ): int {
			$length = $yblocks->length;
			if ( ! is_string( $hold['afterId'] ?? null ) ) {
				return min( max( 0, (int) ( $hold['index'] ?? 0 ) ), $length );
			}
			if ( '' === $hold['afterId'] ) {
				return 0;
			}

			foreach ( $yblocks->toArray() as $position => $block ) {
				if ( $block instanceof \Yjs\Types\YMap && $block->get( 'clientId' ) === $hold['afterId'] ) {
					return $position + 1;
				}
			}

			return $length;
		}

		/**
		 * One block of the canonical document as serialized block markup,
		 * written out the way materialize_blocks() writes every block.
		 *
		 * @since n.e.x.t
		 *
		 * @param mixed $yblock   The block's shared type in the document.
		 * @param array $wrappers Wrapper side-table.
		 * @return string The serialized block ('' when it is not a block).
		 */
		private static function materialize_yblock( $yblock, array $wrappers ): string {
			if ( ! ( $yblock instanceof \Yjs\Types\YMap ) ) {
				return '';
			}
			$block = self::normalize_json( $yblock->toJSON() );
			if ( ! is_array( $block ) ) {
				return '';
			}

			return serialize_block( self::to_serializable_block( $block, $wrappers ) );
		}

		/**
		 * Loads (and lazily initializes) the canonical document for a room.
		 *
		 * The canonical snapshot in room meta reflects the log up to its
		 * stamped cursor; rows past that cursor are applied on top, which is
		 * both the catch-up path and the repair path for canonical writes
		 * that lost a save race. Without room-meta support the document
		 * rebuilds from the full log every time.
		 *
		 * @since 0.2.0
		 *
		 * @param string $room Room identifier.
		 * @return array|WP_Error array( 'doc' => \Yjs\Utils\Doc, 'cursor' => int ).
		 */
		private function load_room( string $room ) {
			if ( isset( $this->room_docs[ $room ] ) && null !== $this->room_docs[ $room ] ) {
				return $this->room_docs[ $room ];
			}

			$has_meta = method_exists( $this->storage, 'get_room_meta' );
			$meta     = $has_meta ? $this->storage->get_room_meta( $room, self::META_DOC ) : null;

			$doc         = new \Yjs\Utils\Doc();
			$meta_cursor = 0;
			if ( is_array( $meta ) && is_string( $meta['doc'] ?? null ) ) {
				try {
					\Yjs\applyUpdateV2( $doc, \Yjs\Lib0\Buffer::fromBase64( $meta['doc'] ) );
					$meta_cursor = (int) ( $meta['cursor'] ?? 0 );
				} catch ( \Throwable $e ) {
					// A corrupt canonical snapshot falls back to a full log
					// replay below.
					$doc         = new \Yjs\Utils\Doc();
					$meta_cursor = 0;
					// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
					do_action( 'qm/debug', "wp-sync: yjs-server canonical snapshot corrupt for {$room}; replaying log" );
				}
			}

			$rows = $this->storage->get_updates_after_cursor( $room, $meta_cursor );

			if ( 0 === $meta_cursor && array() === $rows ) {
				$genesis = $this->initialize_room( $room, $doc );
				if ( is_wp_error( $genesis ) ) {
					return $genesis;
				}
				$state                    = array(
					'doc'    => $doc,
					'cursor' => $this->storage->get_cursor( $room ),
				);
				$this->room_docs[ $room ] = $state;
				return $state;
			}

			$clean = self::apply_rows_to_doc( $doc, $rows, $room );

			// A skipped row is above $meta_cursor but below the watermark:
			// the watermark would over-claim it, so fall back to the cursor
			// the document provably reflects.
			$state                    = array(
				'doc'    => $doc,
				'cursor' => $clean ? $this->storage->get_cursor( $room ) : $meta_cursor,
			);
			$this->room_docs[ $room ] = $state;

			return $state;
		}

		/**
		 * Applies stored rows onto a document in log order (snapshot rows
		 * carry `{ doc: <base64 V2> }`; update rows carry the base64 V2
		 * update directly). A row that fails to apply (malformed, or its
		 * dependency row was momentarily invisible to this read) is skipped
		 * rather than wedging the room.
		 *
		 * Returns whether every row applied cleanly. On a skip, callers
		 * MUST NOT stamp a canonical with a cursor covering the skipped
		 * row: rows do not carry their ids, so the safe stamp falls back to
		 * the pre-read cursor (under-claiming is always safe; the skipped
		 * row re-applies on a later load once its dependency is visible).
		 *
		 * @since 0.2.0
		 *
		 * @param \Yjs\Utils\Doc $doc  Document to apply onto.
		 * @param array          $rows Stored rows.
		 * @param string         $room Room identifier (diagnostics only).
		 * @return bool Whether every row applied cleanly.
		 */
		private static function apply_rows_to_doc( \Yjs\Utils\Doc $doc, array $rows, string $room ): bool {
			$clean = true;
			foreach ( $rows as $row ) {
				try {
					if ( self::UPDATE_TYPE_SNAPSHOT === $row['type'] ) {
						$decoded = json_decode( $row['data'], true );
						if ( is_array( $decoded ) && is_string( $decoded['doc'] ?? null ) ) {
							\Yjs\applyUpdateV2( $doc, \Yjs\Lib0\Buffer::fromBase64( $decoded['doc'] ) );
						}
					} elseif ( self::UPDATE_TYPE_UPDATE === $row['type'] ) {
						\Yjs\applyUpdateV2( $doc, \Yjs\Lib0\Buffer::fromBase64( (string) $row['data'] ) );
					}
				} catch ( \Throwable $e ) {
					$clean = false;
					// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
					do_action( 'qm/debug', "wp-sync: yjs-server skipped a stored row that did not apply in {$room}" );
				}
			}
			return $clean;
		}

		/**
		 * Rebuilds the room document from the update log alone, bypassing
		 * the canonical snapshot. This is the ingest-side repair lane for a
		 * canonical that lost content to a save or read-visibility race:
		 * the log retains at least one full compaction interval plus its
		 * checkpoint snapshot, so everything a client update can reference
		 * is here unless the client is genuinely ahead of the room.
		 *
		 * @since 0.2.0
		 *
		 * @param string $room Room identifier.
		 * @return array array( 'doc' => \Yjs\Utils\Doc, 'cursor' => int ).
		 */
		private function replay_room_log( string $room ): array {
			$doc   = new \Yjs\Utils\Doc();
			$rows  = $this->storage->get_updates_after_cursor( $room, 0 );
			$clean = self::apply_rows_to_doc( $doc, $rows, $room );
			return array(
				'doc'    => $doc,
				// A skipped row would be over-claimed by the watermark;
				// cursor 0 forces the next load to replay everything, which
				// retries the skip once its dependency is visible.
				'cursor' => $clean ? $this->storage->get_cursor( $room ) : 0,
			);
		}

		/**
		 * Applies one incoming update and returns the diff row to store:
		 * only what the update added beyond the server's prior state (known
		 * structs stripped; the update's own delete set kept). Returns null
		 * when the update did not integrate cleanly, either because the
		 * apply threw or because y-php parked structs or deletes as pending
		 * (the update references items the document lacks). A null return
		 * leaves the document in a suspect state (partially integrated or
		 * carrying pending state); callers must rebuild it.
		 *
		 * @since 0.2.0
		 *
		 * @param \Yjs\Utils\Doc   $doc    Document to apply onto.
		 * @param \Yjs\Lib0\Buffer $buffer Incoming V2 update.
		 * @return string|null Base64 diff row, or null.
		 */
		private static function apply_update_for_row( \Yjs\Utils\Doc $doc, \Yjs\Lib0\Buffer $buffer ): ?string {
			try {
				$sv_before = \Yjs\encodeStateVector( $doc );
				\Yjs\applyUpdateV2( $doc, $buffer );
				$store = $doc->store;
				if ( null !== $store->pendingStructs || null !== $store->pendingDs ) { // phpcs:ignore WordPress.NamingConventions.ValidVariableName.UsedPropertyNotSnakeCase -- y-php mirrors the JS Yjs API.
					return null;
				}
				return \Yjs\diffUpdateV2( $buffer, $sv_before )->toBase64();
			} catch ( \Throwable $e ) {
				return null;
			}
		}

		/**
		 * Rebuilds a document exactly from encoded state plus accepted diff
		 * rows, shedding any partial mutation or pending state a failed
		 * apply left behind. Rare path, so the O(doc) rebuild is fine.
		 *
		 * @since 0.2.0
		 *
		 * @param string $base_bytes Binary V2 encoding of the baseline.
		 * @param array  $diffs      Accepted base64 diff rows, in order.
		 * @return \Yjs\Utils\Doc Rebuilt document.
		 */
		private static function rebuild_doc( string $base_bytes, array $diffs ): \Yjs\Utils\Doc {
			$doc = new \Yjs\Utils\Doc();
			\Yjs\applyUpdateV2( $doc, \Yjs\Lib0\Buffer::fromBinaryString( $base_bytes ) );
			foreach ( $diffs as $diff ) {
				\Yjs\applyUpdateV2( $doc, \Yjs\Lib0\Buffer::fromBase64( $diff ) );
			}
			return $doc;
		}

		/**
		 * Whether the payload parses as a structurally valid V2 update.
		 * Distinguishes garbage bytes (settled as `invalid-payload`) from a
		 * valid update whose dependencies are missing (the resync lane)
		 * without touching any document, so malformed input never triggers
		 * an O(log) replay.
		 *
		 * @since 0.2.0
		 *
		 * @param \Yjs\Lib0\Buffer $buffer Incoming payload.
		 * @return bool Whether the payload decodes as a V2 update.
		 */
		private static function is_decodable( \Yjs\Lib0\Buffer $buffer ): bool {
			try {
				\Yjs\decodeUpdateV2( $buffer );
				return true;
			} catch ( \Throwable $e ) {
				return false;
			}
		}

		/**
		 * Persists the canonical document snapshot with the cursor it
		 * reflects. Skipped silently when the storage has no room meta, in
		 * which case the log alone remains authoritative.
		 *
		 * The stamped cursor MUST under-claim: every row at or below it is
		 * merged into $doc. Callers pass the LOAD-time watermark, never this
		 * request's own insert id. Concurrent ingests interleave row ids, so
		 * an insert-id stamp claims foreign rows this process never loaded,
		 * and the load-path repair (apply rows past the stamp) would then
		 * skip them forever: the losing writer's merged content vanishes
		 * from the canonical document while its row sits uselessly in the
		 * log, and that client's next update references items the canonical
		 * no longer has. Under-claiming instead re-applies this request's
		 * own rows on the next load, which is safe because Yjs updates are
		 * idempotent.
		 *
		 * @since 0.2.0
		 *
		 * @param string         $room       Room identifier.
		 * @param \Yjs\Utils\Doc $doc        Canonical document.
		 * @param int            $cursor     Load-time cursor $doc reflects.
		 *                                   Rows above it (including this
		 *                                   request's own) re-apply on the
		 *                                   next load.
		 * @param string|null    $doc_base64 Pre-encoded state (base64 V2), to
		 *                                   avoid re-encoding when the caller
		 *                                   already has it.
		 * @return void
		 */
		private function save_canonical( string $room, \Yjs\Utils\Doc $doc, int $cursor, ?string $doc_base64 = null ): void {
			if ( ! method_exists( $this->storage, 'set_room_meta' ) ) {
				return;
			}
			$this->storage->set_room_meta(
				$room,
				self::META_DOC,
				array(
					'doc'    => $doc_base64 ?? \Yjs\encodeStateAsUpdateV2( $doc )->toBase64(),
					'cursor' => $cursor,
				)
			);
			$this->room_docs[ $room ] = array(
				'doc'    => $doc,
				'cursor' => $cursor,
			);
		}

		/**
		 * Appends a compaction checkpoint and trims history behind the
		 * PREVIOUS checkpoint once enough rows accumulate — the intent-log
		 * retention invariant: rows from the previous checkpoint onward are
		 * always kept, so any client within one interval of the head resumes
		 * normally, and older clients re-bootstrap from the retained
		 * checkpoint row.
		 *
		 * Server-driven: no client is nominated, and `should_compact` never
		 * fires. Requires room-meta support; skips silently otherwise.
		 *
		 * @since 0.2.0
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string         $room      Room identifier.
		 * @param int            $client_id Requesting client id (row attribution).
		 * @param \Yjs\Utils\Doc $doc       Canonical document at the head.
		 * @return bool Whether a checkpoint was appended.
		 */
		private function maybe_checkpoint( string $room, int $client_id, \Yjs\Utils\Doc $doc ): bool {
			if ( ! method_exists( $this->storage, 'get_room_meta' ) || ! method_exists( $this->storage, 'set_room_meta' ) ) {
				return false;
			}

			/**
			 * Filters the yjs-server checkpoint interval: a compaction
			 * checkpoint is appended once this many rows accumulate past the
			 * previous one.
			 *
			 * @since 0.2.0
			 *
			 * @param int    $interval Interval in stored rows.
			 * @param string $room     Room identifier.
			 */
			$interval = (int) apply_filters( 'wp_sync_yjs_server_checkpoint_interval', 100, $room );
			if ( $interval < 1 || $this->storage->get_update_count( $room ) < $interval ) {
				return false;
			}

			$previous    = $this->storage->get_room_meta( $room, self::META_CHECKPOINT );
			$prev_cursor = is_array( $previous ) && isset( $previous['cursor'] ) ? (int) $previous['cursor'] : 0;
			$window_rows = $this->storage->get_updates_after_cursor( $room, $prev_cursor );
			if ( count( $window_rows ) < $interval ) {
				return false;
			}

			/*
			 * Fold the whole retained window into the document before
			 * snapshotting it. The document reflects what THIS request
			 * loaded; a row another writer interleaved (or one an earlier
			 * load had to skip) may be missing from it, and the trim below
			 * would otherwise make that loss durable. Re-application is
			 * idempotent, so folding is safe; a window row that still
			 * cannot apply defers the checkpoint to a later commit.
			 */
			if ( ! self::apply_rows_to_doc( $doc, $window_rows, $room ) ) {
				return false;
			}

			$stored = $this->add_row(
				$room,
				$client_id,
				self::UPDATE_TYPE_SNAPSHOT,
				wp_json_encode(
					array(
						'doc'        => \Yjs\encodeStateAsUpdateV2( $doc )->toBase64(),
						'checkpoint' => true,
					)
				)
			);
			if ( ! $stored ) {
				return false; // Non-fatal: the next commit retries.
			}

			global $wpdb;
			$cursor = isset( $wpdb ) ? (int) $wpdb->insert_id : 0;
			if ( $cursor <= 0 ) {
				return true;
			}
			// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
			do_action( 'qm/debug', "wp-sync: yjs-server checkpoint for {$room}" );
			$this->storage->set_room_meta( $room, self::META_CHECKPOINT, array( 'cursor' => $cursor ) );

			if ( $prev_cursor > 0 ) {
				$this->storage->remove_updates_before_cursor( $room, $prev_cursor );
				$this->storage->set_room_meta( $room, self::META_FLOOR, $prev_cursor );
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: yjs-server trimmed history below cursor {$prev_cursor} for {$room}" );

				// The trim may have taken the announcements of holds that
				// are still open: announce them again above the floor, so
				// a client joining from the checkpoint lists them. Clients
				// that know a hold already ignore the repeat.
				foreach ( $this->get_open_holds( $room ) as $hold ) {
					if ( is_array( $hold ) ) {
						$this->add_row( $room, self::GENESIS_CLIENT_ID, self::UPDATE_TYPE_HELD, (string) wp_json_encode( $hold ) );
					}
				}
			}

			return true;
		}

		/**
		 * Builds and stores the room's genesis snapshot from post content.
		 *
		 * The build is DETERMINISTIC: a fixed per-room clientID and a fixed
		 * operation order mean two racing initializers produce byte-identical
		 * CRDT items, so duplicate genesis rows merge idempotently instead of
		 * duplicating content — which is what makes lock-free genesis safe.
		 *
		 * @since 0.2.0
		 *
		 * @param string         $room Room identifier.
		 * @param \Yjs\Utils\Doc $doc  Empty document to populate in place.
		 * @return true|WP_Error True on success.
		 */
		private function initialize_room( string $room, \Yjs\Utils\Doc $doc ) {
			// phpcs:ignore WordPress.NamingConventions.ValidVariableName.UsedPropertyNotSnakeCase -- clientID is the y-php Doc property, mirroring JS Yjs naming.
			$doc->clientID = self::GENESIS_CLIENT_ID;

			$post     = null;
			$parsed   = WP_Sync_Config::parse_room( $room );
			$wrappers = array();
			if ( null !== $parsed && 'postType' === $parsed['entity_kind'] && ! empty( $parsed['object_id'] ) ) {
				$post = get_post( (int) $parsed['object_id'] );
			}

			if ( $post instanceof WP_Post ) {
				/**
				 * Filters the maximum post_content size (bytes) yjs-server
				 * genesis will build a room for. Server-side counterpart of
				 * the framework's client update-size guard: with server
				 * genesis, later joiners never re-author the document, so
				 * only this gate keeps an oversized post from creating (and
				 * every ingest from re-merging) a huge canonical document.
				 * Zero disables the gate. A room that grows past genesis is
				 * capped separately by wp_sync_yjs_server_max_room_bytes;
				 * what neither gate can do is SHRINK a room already over
				 * the limit (epoch compaction, parked as post-v1 work).
				 *
				 * @since 0.4.0
				 *
				 * @param int    $max_bytes Threshold in bytes.
				 * @param string $room      Room identifier.
				 */
				$max_bytes = (int) apply_filters( 'wp_sync_yjs_server_max_genesis_bytes', MB_IN_BYTES, $room );
				if ( $max_bytes > 0 && strlen( $post->post_content ) > $max_bytes ) {
					// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
					do_action( 'qm/debug', "wp-sync: yjs-server refused genesis for {$room} (post_content exceeds the size gate)" );
					return new WP_Error(
						'rest_sync_document_too_large',
						__( 'This document is too large for real-time collaboration.', 'gutenberg' ),
						array( 'status' => 413 )
					);
				}
			}

			$record = $doc->getMap( 'document' );
			$state  = $doc->getMap( 'state' );
			$state->set( 'version', 1 );

			if ( $post instanceof WP_Post ) {
				/*
				 * The shared REST-shaped property seed (title with the
				 * auto-draft placeholder blanked, the scalar whitelist gated
				 * on post-type supports, taxonomies by rest_base, registered
				 * meta) — the same map intent-log and de-rtc genesis seed,
				 * so a joiner sees identical field state under any engine.
				 * Values byte-match the joiner's REST record, so the
				 * client's change detection reports nothing and the post
				 * never opens dirty. Seeded in SORTED order: genesis must
				 * stay deterministic (fixed clientID + fixed op order) so
				 * racing initializers merge idempotently.
				 */
				$props = class_exists( 'WP_Sync_Post_Genesis_Props' )
					? WP_Sync_Post_Genesis_Props::for_post( $post )
					: array( 'title' => $post->post_title );
				ksort( $props );

				$meta_values = array();
				foreach ( $props as $name => $value ) {
					if ( 0 === strpos( $name, 'meta.' ) ) {
						$meta_values[ substr( $name, 5 ) ] = $value;
						continue;
					}
					// The client CRDT schema (core-data crdt.ts): title and
					// excerpt are Y.Text; everything else plain map values.
					if ( 'title' === $name || 'excerpt' === $name ) {
						$record->set( $name, new \Yjs\Types\YText( (string) $value ) );
						continue;
					}
					$record->set( $name, $value );
				}
				if ( array() !== $meta_values ) {
					ksort( $meta_values );
					$ymeta = new \Yjs\Types\YMap();
					$record->set( 'meta', $ymeta );
					foreach ( $meta_values as $meta_key => $meta_value ) {
						$ymeta->set( $meta_key, $meta_value );
					}
				}

				$yblocks = new \Yjs\Types\YArray();
				$record->set( 'blocks', $yblocks );
				if ( '' !== $post->post_content ) {
					$specs = self::blocks_to_yblocks( parse_blocks( $post->post_content ), 'srv', $wrappers );
					if ( array() !== $specs ) {
						$yblocks->push( $specs );
					}
				}
			}

			$stored = $this->add_row(
				$room,
				0,
				self::UPDATE_TYPE_SNAPSHOT,
				wp_json_encode( array( 'doc' => \Yjs\encodeStateAsUpdateV2( $doc )->toBase64() ) )
			);
			if ( ! $stored ) {
				return new WP_Error(
					'rest_sync_storage_error',
					__( 'Failed to store the room genesis snapshot.', 'gutenberg' ),
					array( 'status' => 500 )
				);
			}

			// The genesis row is the room's first stored row: stamp lineage
			// (see the intent-log engine's identical rationale).
			$this->storage->set_room_engine( $room, $this->get_slug() );

			if ( method_exists( $this->storage, 'set_room_meta' ) ) {
				if ( array() !== $wrappers ) {
					$this->storage->set_room_meta( $room, self::META_WRAPPERS, $wrappers );
				}
				global $wpdb;
				$cursor = isset( $wpdb ) ? (int) $wpdb->insert_id : 0;

				/*
				 * The canonical stamp must under-claim (see save_canonical):
				 * with two racing initializers, a client of the faster one
				 * can append an update row with a LOWER id than this genesis
				 * row, and stamping the genesis row id would hide that row
				 * from the load-path repair forever. Cursor 0 re-applies the
				 * genesis row itself on the next load, a no-op against the
				 * identical canonical. The checkpoint stamp keeps the row id;
				 * it only paces compaction windows.
				 */
				$this->storage->set_room_meta(
					$room,
					self::META_DOC,
					array(
						'doc'    => \Yjs\encodeStateAsUpdateV2( $doc )->toBase64(),
						'cursor' => 0,
					)
				);
				$this->storage->set_room_meta( $room, self::META_CHECKPOINT, array( 'cursor' => $cursor ) );
			}

			return true;
		}

		/**
		 * Decomposes a block's inner markup (genesis innerHTML, or a
		 * client-maintained `_save` mirror) into the wrapper record the
		 * materializer rebuilds from, plus the rich-text inner value:
		 * the outer wrapper tags, and — for selector-sourced rich text
		 * (image `caption` ← `figcaption`) — the surrounding pre/post
		 * markup and the sub-element's own tags.
		 *
		 * @since 0.3.0
		 *
		 * @param string $markup     Inner markup (single wrapper element).
		 * @param string $block_name Block name (for the rich-text schema).
		 * @return array|null array{wrapper: array, text: string}, or null
		 *                    when no single wrapper element matches.
		 */
		private static function decompose_inner_markup( string $markup, string $block_name ): ?array {
			if ( ! preg_match( '/^<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>(.*)<\/\1>$/s', $markup, $matches ) ) {
				return null;
			}
			$wrapper = array(
				'open'  => '<' . $matches[1] . ( $matches[2] ?? '' ) . '>',
				'close' => '</' . $matches[1] . '>',
			);
			$text    = $matches[3];

			$selector = self::rich_text_source( $block_name )['selector'] ?? null;
			if (
				is_string( $selector ) &&
				preg_match( '/^[a-zA-Z][a-zA-Z0-9-]*$/', $selector ) &&
				strtolower( $selector ) !== strtolower( $matches[1] )
			) {
				if ( preg_match( '/^(.*)(<' . $selector . '(?:\s[^>]*)?>)(.*)(<\/' . $selector . '>)(.*)$/s', $text, $sub ) ) {
					$wrapper['pre']        = $sub[1];
					$wrapper['text_open']  = $sub[2];
					$wrapper['text_close'] = $sub[4];
					$wrapper['post']       = $sub[5];
					$text                  = $sub[3];
				} else {
					$wrapper['pre'] = $text;
					$text           = '';
				}
			}

			return array(
				'wrapper' => $wrapper,
				'text'    => $text,
			);
		}

		/**
		 * Converts parsed blocks to the Y.Block records genesis seeds,
		 * recording each block's non-rich wrapper markup by client id.
		 *
		 * @since 0.2.0
		 *
		 * @param array       $blocks   Parsed blocks (parse_blocks shape).
		 * @param string      $id_base  Deterministic client-id prefix.
		 * @param array       $wrappers Wrapper markup collector (by reference).
		 * @param string|null $first_id The id for the first block built, in
		 *                              place of the one made from the prefix.
		 *                              A block rebuilt in place keeps its id
		 *                              this way, so whatever names the block
		 *                              by id (an open security hold) still
		 *                              finds it. Its children get new ids.
		 * @return array Y.Block records.
		 */
		private static function blocks_to_yblocks( array $blocks, string $id_base, array &$wrappers, ?string $first_id = null ): array {
			$yblocks = array();
			$index   = 0;
			foreach ( $blocks as $block ) {
				// The children's ids are made from the prefix either way.
				$child_base = $id_base . '-' . $index;
				$client_id  = $child_base;
				if ( 0 === $index && null !== $first_id ) {
					$client_id = $first_id;
				}

				if ( empty( $block['blockName'] ) ) {
					// Classic content: preserved as core/freeform, full inner
					// HTML on the content attribute, no wrapper stripping
					// (mirrors the intent-log genesis).
					$text = trim( $block['innerHTML'] );
					if ( '' === $text ) {
						continue;
					}
					$yblocks[] = self::make_yblock( $client_id, 'core/freeform', array(), $text, array() );
					++$index;
					continue;
				}

				$attrs      = is_array( $block['attrs'] ) ? $block['attrs'] : array();
				$text       = trim( $block['innerHTML'] );
				$decomposed = self::decompose_inner_markup( $text, (string) $block['blockName'] );
				if ( null !== $decomposed ) {
					$wrappers[ $client_id ] = $decomposed['wrapper'];
					$text                   = $decomposed['text'];
				}

				$children  = self::blocks_to_yblocks( $block['innerBlocks'], $child_base, $wrappers );
				$yblocks[] = self::make_yblock( $client_id, $block['blockName'], $attrs, $text, $children );
				++$index;
			}

			return $yblocks;
		}

		/**
		 * Builds one YBlock Y.Map.
		 *
		 * @since 0.2.0
		 *
		 * @param string $client_id Block clientId.
		 * @param string $name      Block name.
		 * @param array  $attrs     Comment-delimiter attributes.
		 * @param string $content   Rich-text content (inner HTML, wrapper stripped).
		 * @param array  $children  Child YBlocks.
		 * @return \Yjs\Types\YMap YBlock.
		 */
		private static function make_yblock( string $client_id, string $name, array $attrs, string $content, array $children ): \Yjs\Types\YMap {
			/*
			 * Fill registered attribute DEFAULTS the comment delimiters omit.
			 * Blocks the editor itself creates always carry them (parse and
			 * createBlock both apply schema defaults), and save() functions
			 * rely on that: core/group renders its wrapper element from the
			 * `tagName` attribute (default "div"), so a joiner that adopts a
			 * genesis block WITHOUT it serializes the group to an EMPTY
			 * string — the block lands in post_content as a void
			 * `<!-- wp:group /-->` with every child silently dropped, and the
			 * next reload shows the invalid-content recovery screen (issue
			 * #38; same family as the isValid line below). Markup-sourced
			 * attributes stay excluded: their live values ride in the wrapper
			 * records and `_save` mirrors, not in the attribute map.
			 * Deterministic (registry defaults + fixed order), so racing
			 * genesis writers still produce byte-identical rows.
			 *
			 * ORDER matters as much as presence: the editor compares block
			 * state as serialized JSON in places (the collaboration e2e
			 * convergence check among them), and parse/createBlock both emit
			 * attributes in schema registration order. A defaults-first
			 * merge made a doc-adopted block report `{dropCap, content}`
			 * while its peer's own parse reported `{content, dropCap}` —
			 * identical values, permanently "unconverged". Build the map in
			 * schema order instead, appending unregistered extras behind —
			 * including the rich-text content value, which must sit at its
			 * schema position (first, for a paragraph), not be appended last.
			 */
			$content_attr = self::rich_text_attribute( $name );
			$attrs        = self::ordered_attributes( $name, $attrs, $content_attr );

			$attributes = new \Yjs\Types\YMap();
			foreach ( $attrs as $key => $value ) {
				if ( $key === $content_attr ) {
					$attributes->set( (string) $key, new \Yjs\Types\YText( $content ) );
					continue;
				}
				$attributes->set( (string) $key, $value );
			}
			if ( null !== $content_attr && ! array_key_exists( $content_attr, $attrs ) ) {
				$attributes->set( $content_attr, new \Yjs\Types\YText( $content ) );
			}

			$inner = new \Yjs\Types\YArray();

			$yblock = new \Yjs\Types\YMap();
			$yblock->set( 'name', $name );
			$yblock->set( 'clientId', $client_id );
			// Editor-authored blocks carry isValid from the parser; without
			// it, the dispatched block renders as "invalid content" in
			// recovery mode and cannot be edited.
			$yblock->set( 'isValid', true );
			$yblock->set( 'attributes', $attributes );
			$yblock->set( 'innerBlocks', $inner );
			if ( array() !== $children ) {
				$inner->push( $children );
			}

			return $yblock;
		}

		/**
		 * The registered default values for a block type's UNSOURCED
		 * attributes (the ones comment delimiters carry). Markup-sourced
		 * attributes are excluded: the doc deliberately keeps their live
		 * values in wrapper records and `_save` mirrors instead of the
		 * attribute map, and injecting defaults there could contradict the
		 * real markup.
		 *
		 * @since 0.4.0
		 *
		 * @param string $name Block name.
		 * @return array Attribute key => default value.
		 */
		private static function attribute_defaults( string $name ): array {
			$block_type = WP_Block_Type_Registry::get_instance()->get_registered( $name );
			if ( null === $block_type || ! is_array( $block_type->attributes ) ) {
				return array();
			}
			$defaults = array();
			foreach ( $block_type->attributes as $key => $schema ) {
				if ( ! is_array( $schema ) || ! array_key_exists( 'default', $schema ) || isset( $schema['source'] ) ) {
					continue;
				}
				$defaults[ (string) $key ] = $schema['default'];
			}
			return $defaults;
		}

		/**
		 * A block's attributes in SCHEMA REGISTRATION ORDER, with registered
		 * defaults woven in for missing unsourced attributes and any
		 * unregistered extras appended behind in their given order.
		 *
		 * This is the order parse and createBlock produce client-side, and
		 * order is observable: the editor (and the collaboration e2e
		 * convergence check) compares block state as serialized JSON, so a
		 * doc-adopted block whose keys sit in a different order than a
		 * peer's own parse never compares equal even with identical values.
		 *
		 * @since 0.4.0
		 *
		 * @param string      $name        Block name.
		 * @param array       $attrs       Comment-delimiter attributes.
		 * @param string|null $reserve_key Rich-text content attribute to hold
		 *                                 a slot for at its schema position
		 *                                 (the caller supplies its value).
		 * @return array Ordered attributes with defaults filled.
		 */
		private static function ordered_attributes( string $name, array $attrs, ?string $reserve_key = null ): array {
			$block_type = WP_Block_Type_Registry::get_instance()->get_registered( $name );
			if ( null === $block_type || ! is_array( $block_type->attributes ) ) {
				return $attrs;
			}
			$ordered = array();
			foreach ( $block_type->attributes as $key => $schema ) {
				$key = (string) $key;
				if ( $key === $reserve_key ) {
					$ordered[ $key ] = null;
					continue;
				}
				if ( array_key_exists( $key, $attrs ) ) {
					$ordered[ $key ] = $attrs[ $key ];
					continue;
				}
				if ( is_array( $schema ) && array_key_exists( 'default', $schema ) && ! isset( $schema['source'] ) ) {
					$ordered[ $key ] = $schema['default'];
				}
			}
			foreach ( $attrs as $key => $value ) {
				if ( ! array_key_exists( (string) $key, $ordered ) ) {
					$ordered[ (string) $key ] = $value;
				}
			}
			return $ordered;
		}

		/**
		 * The markup-sourced rich-text attribute for a block type, per the
		 * server-side block registry (`content` for paragraphs, headings and
		 * most text blocks), or `content` as the fallback for unregistered
		 * blocks and core/freeform.
		 *
		 * @since 0.2.0
		 *
		 * @param string $name Block name.
		 * @return string|null Attribute key, or null when the block has none.
		 */
		private static function rich_text_attribute( string $name ): ?string {
			return self::rich_text_source( $name )['key'] ?? null;
		}

		/**
		 * The markup-sourced rich-text attribute AND its source selector for
		 * a block type. A null selector means the attribute sources from the
		 * block's own wrapper (paragraph/heading `content`); a selector names
		 * the sub-element it sources from (image `caption` ← `figcaption`).
		 *
		 * @since 0.3.0
		 *
		 * @param string $name Block name.
		 * @return array|null array{key: string, selector: ?string}, or null
		 *                    when the block has no rich-text attribute.
		 */
		private static function rich_text_source( string $name ): ?array {
			$block_type = WP_Block_Type_Registry::get_instance()->get_registered( $name );
			if ( null === $block_type || ! is_array( $block_type->attributes ) ) {
				return array(
					'key'      => 'content',
					'selector' => null,
				);
			}
			foreach ( $block_type->attributes as $key => $schema ) {
				$source = is_array( $schema ) ? ( $schema['source'] ?? null ) : null;
				$type   = is_array( $schema ) ? ( $schema['type'] ?? null ) : null;
				if ( 'rich-text' === $source || 'html' === $source || 'rich-text' === $type ) {
					$selector = is_array( $schema ) && is_string( $schema['selector'] ?? null )
						? $schema['selector']
						: null;
					return array(
						'key'      => (string) $key,
						'selector' => $selector,
					);
				}
			}
			return null;
		}

		/**
		 * Maps a YBlock (as JSON) back to a serialize_block()-compatible
		 * array, rebuilding inner HTML from the rich-text content attribute
		 * and the recorded (or default) wrapper.
		 *
		 * @since 0.2.0
		 *
		 * @param array $block    YBlock JSON (name, clientId, attributes, innerBlocks).
		 * @param array $wrappers Genesis wrapper map (clientId => open/close).
		 * @return array WP_Block_Parser_Block-shaped array.
		 */
		private static function to_serializable_block( array $block, array $wrappers ): array {
			$name      = is_string( $block['name'] ?? null ) ? $block['name'] : 'core/freeform';
			$client_id = is_string( $block['clientId'] ?? null ) ? $block['clientId'] : '';
			$attrs     = is_array( $block['attributes'] ?? null ) ? $block['attributes'] : array();

			$content_attr = self::rich_text_attribute( $name );
			$text         = '';
			if ( null !== $content_attr && array_key_exists( $content_attr, $attrs ) ) {
				$text = (string) $attrs[ $content_attr ];
				unset( $attrs[ $content_attr ] );
			}

			// Drop attributes equal to their registered default before
			// serializing, mirroring the client serializer: comment
			// delimiters never carry default values, so the defaults genesis
			// fills (see make_yblock) round-trip out again byte-identically.
			foreach ( self::attribute_defaults( $name ) as $default_key => $default_value ) {
				if ( array_key_exists( $default_key, $attrs ) && $attrs[ $default_key ] == $default_value ) { // phpcs:ignore Universal.Operators.StrictComparisons.LooseEqual -- Mirrors the client serializer's value comparison; JSON round-trips may swap int/float or array key order.
					unset( $attrs[ $default_key ] );
				}
			}

			// Classic content serializes bare (no comment delimiters).
			if ( 'core/freeform' === $name ) {
				return array(
					'blockName'    => null,
					'attrs'        => array(),
					'innerBlocks'  => array(),
					'innerHTML'    => $text,
					'innerContent' => '' === $text ? array() : array( $text ),
				);
			}

			$wrapper = $wrappers[ $client_id ] ?? self::default_wrapper( $name, $attrs );

			/*
			 * Materialization fidelity (B1): a client-maintained `_save`
			 * mirror — the block's registered save() output for its CURRENT
			 * attributes — outranks the genesis wrapper record and the
			 * static defaults. It carries wrapper classes, heading levels,
			 * attribute-derived sub-elements (an image's <img>) as the
			 * editor itself would save them; the rich-text value inside is
			 * ignored (the live shared text below replaces it).
			 */
			if ( isset( $block['_save'] ) && is_string( $block['_save'] ) && '' !== trim( $block['_save'] ) ) {
				$decomposed = self::decompose_inner_markup( trim( $block['_save'] ), $name );
				if ( null !== $decomposed ) {
					$wrapper = $decomposed['wrapper'];
				}
			}

			/*
			 * Selector-sourced rich text (see blocks_to_yblocks): the
			 * attribute held only the sub-element's inner text; the
			 * surrounding markup was recorded on the wrapper. Rebuild the
			 * full inner markup. A sub-element that existed at genesis
			 * always re-emits with its recorded tags (byte parity); a value
			 * added in-session gets the element's conventional tags.
			 */
			if ( is_array( $wrapper ) && ( isset( $wrapper['pre'] ) || isset( $wrapper['post'] ) || isset( $wrapper['text_open'] ) ) ) {
				$sub = '';
				if ( isset( $wrapper['text_open'], $wrapper['text_close'] ) ) {
					$sub = $wrapper['text_open'] . $text . $wrapper['text_close'];
				} elseif ( '' !== $text ) {
					$selector = self::rich_text_source( $name )['selector'] ?? null;
					if ( is_string( $selector ) && '' !== $selector ) {
						$sub = 'figcaption' === $selector
							? '<figcaption class="wp-element-caption">' . $text . '</figcaption>'
							: '<' . $selector . '>' . $text . '</' . $selector . '>';
					} else {
						$sub = $text;
					}
				}
				$text = ( $wrapper['pre'] ?? '' ) . $sub . ( $wrapper['post'] ?? '' );
			}

			$open_fragment  = $text;
			$close_fragment = '';
			if ( is_array( $wrapper ) ) {
				// The surrounding newlines match core's block serializer
				// convention, so genesis content round-trips byte-identically.
				$open_fragment  = "\n" . ( $wrapper['open'] ?? '' ) . $text;
				$close_fragment = ( $wrapper['close'] ?? '' ) . "\n";
			}

			$inner_blocks = array();
			foreach ( ( is_array( $block['innerBlocks'] ?? null ) ? $block['innerBlocks'] : array() ) as $child ) {
				$child = self::normalize_json( $child );
				if ( is_array( $child ) ) {
					$inner_blocks[] = self::to_serializable_block( $child, $wrappers );
				}
			}

			/*
			 * innerContent interleaves HTML fragments with one null per inner
			 * block AT ITS POSITION: a container's wrapper splits into an open
			 * fragment before the child slots and a close fragment after.
			 * Concatenating them into one fragment serialized children OUTSIDE
			 * their wrapper element and the validator rejected the markup on
			 * the next parse (fuzzer: invalid recovery blocks after reload).
			 */
			$inner_content = array();
			if ( count( $inner_blocks ) > 0 ) {
				if ( '' !== $open_fragment ) {
					$inner_content[] = $open_fragment;
				}
				foreach ( $inner_blocks as $unused ) {
					$inner_content[] = null;
				}
				if ( '' !== $close_fragment ) {
					$inner_content[] = $close_fragment;
				}
			} else {
				$whole = $open_fragment . $close_fragment;
				if ( '' !== $whole ) {
					$inner_content[] = $whole;
				}
			}

			return array(
				'blockName'    => $name,
				'attrs'        => $attrs,
				'innerBlocks'  => $inner_blocks,
				'innerHTML'    => $open_fragment . $close_fragment,
				'innerContent' => $inner_content,
			);
		}

		/**
		 * The default wrapper for a block type whose genesis wrapper is
		 * unknown (a block born in-session). Covers the common text blocks;
		 * anything else serializes bare.
		 *
		 * @since 0.2.0
		 *
		 * @param string $name  Block name.
		 * @param array  $attrs Block attributes (for heading levels).
		 * @return array|null Wrapper open/close, or null.
		 */
		private static function default_wrapper( string $name, array $attrs ): ?array {
			switch ( $name ) {
				case 'core/paragraph':
					return array(
						'open'  => '<p>',
						'close' => '</p>',
					);
				case 'core/heading':
					$level = is_numeric( $attrs['level'] ?? null ) ? (int) $attrs['level'] : 2;
					$level = min( 6, max( 1, $level ) );
					return array(
						'open'  => '<h' . $level . '>',
						'close' => '</h' . $level . '>',
					);
				case 'core/list-item':
					return array(
						'open'  => '<li>',
						'close' => '</li>',
					);
				case 'core/quote':
					return array(
						'open'  => '<blockquote class="wp-block-quote">',
						'close' => '</blockquote>',
					);
				default:
					return null;
			}
		}

		/**
		 * Normalizes y-php toJSON() output: YMap serializes to stdClass so
		 * empty maps round-trip as `{}`; PHP-side consumers want arrays.
		 *
		 * @since 0.2.0
		 *
		 * @param mixed $value JSON value.
		 * @return mixed Value with stdClass converted to arrays, recursively.
		 */
		private static function normalize_json( $value ) {
			if ( $value instanceof \stdClass ) {
				$value = (array) $value;
			}
			if ( is_array( $value ) ) {
				foreach ( $value as $key => $item ) {
					$value[ $key ] = self::normalize_json( $item );
				}
			}
			return $value;
		}

		/**
		 * Stores one typed row for a room.
		 *
		 * @since 0.2.0
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Originating client id (0 = server).
		 * @param string $type      Row type.
		 * @param string $data      Row data (base64 update, or snapshot JSON).
		 * @return bool Whether the row was stored.
		 */
		private function add_row( string $room, int $client_id, string $type, string $data ): bool {
			return $this->storage->add_update(
				$room,
				array(
					'client_id' => $client_id,
					'data'      => $data,
					'type'      => $type,
				)
			);
		}
	}
}
