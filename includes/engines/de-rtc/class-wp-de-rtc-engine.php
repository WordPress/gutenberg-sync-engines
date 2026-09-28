<?php
/**
 * The DE-RTC sync engine: server-governed three-way merges of content
 * proposals, behind the framework's WP_Sync_Engine SPI.
 *
 * Distributed Editing's model, adapted to the room/update-log substrate:
 * the server owns a canonical document per room; clients submit whole
 * proposals (proposed content + a block-native update descriptor proving
 * the edit against a named base version); the server merges each proposal
 * against the current canonical content with the ported DE-RTC merge core
 * (includes/engines/de-rtc/merge-core.php); most edits merge cleanly, and
 * genuine conflicts are escalated for human decision instead of silently
 * merged. Peers receive the merged canonical content as server-authored
 * rows.
 *
 * The server keeps its working copy in sync-storage room meta, but it
 * also writes the sync metadata back into post_content on every save
 * (the wp:sync-meta pseudo-block — see
 * class-wp-de-rtc-sync-meta-colocation.php), the way the upstream
 * prototype did. That write-back is what lets the server notice when a
 * script edited the post behind the room's back, and what lets
 * resolve_base_from_revisions() recover an old base from post revisions
 * when a client has been offline longer than the room's own snapshot
 * window covers. Genesis adopts (and strips) an existing sync-meta
 * block, so documents written by an upstream DE-RTC install keep their
 * version lineage.
 *
 * @package GutenbergSyncEngines
 */

if ( ! class_exists( 'WP_De_RTC_Engine' ) && interface_exists( 'WP_Sync_Engine' ) ) {

	/**
	 * Server-authoritative DE-RTC merge engine.
	 *
	 * @since 0.3.0
	 */
	class WP_De_RTC_Engine implements WP_Sync_Engine {

		/**
		 * Engine slug (must byte-match the client adapter).
		 *
		 * @since 0.3.0
		 * @var string
		 */
		const SLUG = 'de-rtc';

		/**
		 * Engine protocol version (bump on breaking payload changes).
		 * Version 2: accepted proposals broadcast ANNOUNCE rows (version +
		 * content hash, no content); clients fetch canonical content on
		 * demand.
		 *
		 * @since 0.3.0
		 * @var int
		 */
		const PROTOCOL_VERSION = 2;

		/**
		 * Client-sent update type: a content proposal against a base version.
		 *
		 * @since 0.3.0
		 * @var string
		 */
		const UPDATE_TYPE_PROPOSAL = 'proposal';

		/**
		 * Server-emitted update type: a canonical version ANNOUNCEMENT —
		 * version, base version, content hash, author attribution, and the
		 * merged property registers, but NO content. The transport carries
		 * advisories, not documents (the DE-RTC vision's Sync channel):
		 * canonical content lives once in room meta (plus checkpoint
		 * snapshots and the post/revision write-through), and a client that
		 * needs it sends a `fetch` row. Row bytes stop scaling with document
		 * size — the pre-announce row-size cliff.
		 *
		 * @since 0.6.0
		 * @var string
		 */
		const UPDATE_TYPE_ANNOUNCE = 'announce';

		/**
		 * Client-sent update type: request the canonical content when the
		 * client's version is behind. Payload: `haveVersion`. Answered in
		 * the same poll's read half with ONE synthesized (never stored)
		 * snapshot row of the CURRENT canonical state.
		 *
		 * @since 0.6.0
		 * @var string
		 */
		const UPDATE_TYPE_FETCH = 'fetch';

		/**
		 * Server-emitted update type: genesis/checkpoint snapshot.
		 *
		 * @since 0.3.0
		 * @var string
		 */
		const UPDATE_TYPE_SNAPSHOT = 'snapshot';

		/**
		 * Server-emitted update type: an escalated proposal parked for
		 * review. Durable — unresolved parked rows survive compaction (the
		 * intent-log retention rule), so the escalated content exists in
		 * room storage, not just the escalating client's memory.
		 *
		 * @since 0.4.0
		 * @var string
		 */
		const UPDATE_TYPE_PARKED = 'parked';

		/**
		 * Client-sent update type: closes a parked proposal
		 * (restored/dismissed). Idempotent by proposalId; the server stamps
		 * the resolving user and time.
		 *
		 * @since 0.4.0
		 * @var string
		 */
		const UPDATE_TYPE_RESOLVED = 'resolved';

		/**
		 * Attribution client id for server-authored rows. Outside the
		 * transport's client id range, mirroring the yjs-server genesis id
		 * convention (which uses 2000000000).
		 *
		 * @since 0.3.0
		 * @var int
		 */
		const SERVER_CLIENT_ID = 2000000001;

		/**
		 * Room meta key: last checkpoint cursor.
		 *
		 * @since 0.3.0
		 * @var string
		 */
		const META_CHECKPOINT = 'de_rtc_checkpoint';

		/**
		 * Room meta key: compaction floor cursor.
		 *
		 * @since 0.3.0
		 * @var string
		 */
		const META_FLOOR = 'de_rtc_floor';

		/**
		 * Room meta key: pinned fingerprints of restored (approved)
		 * unfiltered-html blocks.
		 *
		 * @since 0.0.1
		 * @var string
		 */
		const META_APPROVED_BLOCKS = 'de_rtc_approved_blocks';

		/**
		 * Sync storage backend.
		 *
		 * @since 0.3.0
		 * @var WP_Sync_Storage
		 */
		private $storage;

		/**
		 * Per-request room state cache.
		 *
		 * @since 0.3.0
		 * @var array<string, array|null>
		 */
		private $room_states = array();

		/**
		 * Per-request debug info stash, keyed by room (ingest fills it,
		 * get_updates_since attaches it as the `_debug` envelope when the
		 * request opted in). Mirrors the intent-log engine's stash.
		 *
		 * @since 0.3.0
		 * @var array<string, array>
		 */
		private $debug_stash = array();

		/**
		 * Version-claim retries performed during the current request
		 * (optimistic-concurrency losses; surfaced in the debug envelope).
		 *
		 * @since 0.5.0
		 *
		 * @var int
		 */
		private $claim_retries = 0;

		/**
		 * Per-request cache of revision-mined base lookups, keyed
		 * "room|version" (null = looked, not found).
		 *
		 * @since 0.5.0
		 *
		 * @var array<string, string|null>
		 */
		private $revision_base_cache = array();

		/**
		 * Pending content fetches for this request, room => client_id =>
		 * haveVersion. Written by the ingest half (a `fetch` row), consumed
		 * by the read half (one synthesized snapshot when the client is
		 * behind). Per-request state, like the debug stash.
		 *
		 * @since 0.6.0
		 * @var array
		 */
		private $content_requests = array();

		/**
		 * Constructor.
		 *
		 * @since 0.3.0
		 *
		 * @param WP_Sync_Storage $storage Storage backend.
		 */
		public function __construct( WP_Sync_Storage $storage ) {
			$this->storage = $storage;
			if ( ! function_exists( 'wp_de_rtc_get_reason_codes' ) ) {
				require_once __DIR__ . '/merge-core.php';
			}
		}

		/**
		 * Engine slug.
		 *
		 * @since 0.3.0
		 *
		 * @return string Engine slug.
		 */
		public function get_slug(): string {
			return self::SLUG;
		}

		/**
		 * Engine protocol version.
		 *
		 * @since 0.3.0
		 *
		 * @return int Protocol version.
		 */
		public function get_protocol_version(): int {
			return self::PROTOCOL_VERSION;
		}

		/**
		 * Drops the per-room state cache. A web request constructs a fresh
		 * engine, so the cache is naturally request-scoped there; a
		 * LONG-LIVED consumer (the websocket daemon, whose engine registry
		 * holds one instance for the process lifetime) must call this at
		 * its message boundary, or it keeps serving canonical state that
		 * other processes have long since advanced. Found by the
		 * post-inversion websocket fuzz: fetch answers synthesized from a
		 * stale cached canonical concluded the client was current and
		 * never returned the committed content.
		 *
		 * @since 0.3.0
		 */
		public function flush_room_state_cache(): void {
			$this->room_states = array();
		}

		/**
		 * Update types this engine reads or writes.
		 *
		 * @since 0.3.0
		 *
		 * @return string[] Update type identifiers.
		 */
		public function get_update_types(): array {
			return array(
				self::UPDATE_TYPE_PROPOSAL,
				self::UPDATE_TYPE_ANNOUNCE,
				self::UPDATE_TYPE_FETCH,
				self::UPDATE_TYPE_SNAPSHOT,
				self::UPDATE_TYPE_PARKED,
				self::UPDATE_TYPE_RESOLVED,
			);
		}

		/**
		 * Ingests a batch of proposals from one client.
		 *
		 * Lock-free, optimistic — upstream DE-RTC's own concurrency model
		 * (validate the base, merge, retry when the world moved): an
		 * accepted proposal atomically CLAIMS its version advancement
		 * (see claim_version()); a lost claim reloads canonical and
		 * re-merges. Rejection paths (escalations, voids) never advance
		 * the version, and every other row type is idempotent, so no
		 * exclusion is needed anywhere else. Accepted proposals append a
		 * server-authored `content` row; conflicts and invalid proposals
		 * settle per-proposal as dispositions.
		 *
		 * @since 0.3.0
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Client identifier.
		 * @param int    $cursor    Client transport cursor (unused).
		 * @param array  $updates   Typed updates.
		 * @param array  $context   Transport context.
		 * @return array|WP_Error array( 'dispositions' => array|null ) or error.
		 */
		public function handle_updates( string $room, int $client_id, int $cursor, array $updates, array $context ) { // phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- $cursor is part of the WP_Sync_Engine contract.
			if ( array() === $updates ) {
				return array( 'dispositions' => null );
			}

			foreach ( $updates as $update ) {
				// Review resolutions are NOT accepted here: they are
				// mutations and travel only over the REST review lane
				// (WP_De_RTC_Review_Controller).
				if ( ! in_array( $update['type'], array( self::UPDATE_TYPE_PROPOSAL, self::UPDATE_TYPE_FETCH ), true ) ) {
					return new WP_Error(
						'rest_invalid_update_type',
						__( 'Clients may only send proposal or fetch updates to a de-rtc room.', 'gutenberg' ),
						array( 'status' => 400 )
					);
				}
			}

			$this->claim_retries = 0;

			return $this->process_updates( $room, $client_id, $updates, $context );
		}

		/**
		 * The body of handle_updates().
		 *
		 * @since 0.3.0
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Client identifier.
		 * @param array  $updates   Proposal updates.
		 * @param array  $context   Transport context.
		 * @return array|WP_Error array( 'dispositions' => array ) or error.
		 */
		private function process_updates( string $room, int $client_id, array $updates, array $context ) {
			$state = $this->load_room( $room );
			if ( is_wp_error( $state ) ) {
				return $state;
			}

			$proposals = array();
			foreach ( $updates as $update ) {
				if ( self::UPDATE_TYPE_FETCH === $update['type'] ) {
					/*
					 * A content fetch (the announce model's on-demand lane):
					 * note the client's version; the read half of this same
					 * request answers with ONE synthesized snapshot of the
					 * current canonical when the client is behind. No
					 * disposition — fetches are advisory, idempotent, and
					 * carry nothing to accept or reject.
					 */
					$decoded                                       = json_decode( (string) $update['data'], true );
					$this->content_requests[ $room ][ $client_id ] = is_array( $decoded ) && is_string( $decoded['haveVersion'] ?? null )
						? $decoded['haveVersion']
						: '';
					continue;
				}
				$proposals[] = $update;
			}

			// The open/resolved review ledger, derived lazily from retained
			// rows only when this request escalates something.
			$review = null;

			$dispositions = array();
			foreach ( $proposals as $update ) {
				$proposal    = json_decode( (string) $update['data'], true );
				$proposal_id = is_array( $proposal ) && is_string( $proposal['proposalId'] ?? null ) && '' !== $proposal['proposalId']
					? $proposal['proposalId']
					: null;

				/*
				 * Malformed proposals settle per-proposal as voids instead of
				 * failing the request (the intent-log rationale: one bad row
				 * must not starve the batch). Rows without a proposalId are
				 * dropped — nothing could correlate their disposition.
				 */
				if (
					null === $proposal_id ||
					! is_string( $proposal['baseVersion'] ?? null ) || '' === $proposal['baseVersion'] ||
					! is_string( $proposal['proposedContent'] ?? null ) ||
					( null !== ( $proposal['clientUpdate'] ?? null ) && ! is_array( $proposal['clientUpdate'] ) )
				) {
					if ( null !== $proposal_id ) {
						$dispositions[] = array(
							'intentId' => $proposal_id,
							'status'   => 'voided',
							'reason'   => 'invalid-payload',
						);
					}
					continue;
				}

				/*
				 * The proposal content is the document alone. A client whose
				 * editor parsed a saved post carries the co-located sync-meta
				 * pseudo-block (see class-wp-de-rtc-sync-meta-colocation.php)
				 * as a stray block; it is bookkeeping, never content, and is
				 * stripped here exactly as the save preflight strips it.
				 */
				if ( function_exists( 'wp_de_rtc_count_post_content_sync_meta_scripts' ) && wp_de_rtc_count_post_content_sync_meta_scripts( $proposal['proposedContent'] ) > 0 ) {
					$parsed = wp_de_rtc_parse_post_content_sync_meta( $proposal['proposedContent'], array( 'allow_script_stripped_sync_meta' => true ) );
					if ( is_array( $parsed ) && is_string( $parsed['content'] ?? null ) ) {
						$proposal['proposedContent'] = $parsed['content'];
					}
				}

				$disposition = $this->ingest_proposal( $room, $client_id, $state, $proposal, $review );
				if ( is_wp_error( $disposition ) ) {
					// Claim attempts exhausted under heavy contention: the
					// whole request retries (503), the old lock-timeout
					// contract — a re-sent proposal merges idempotently.
					return $disposition;
				}
				$disposition    = array_merge( array( 'intentId' => $proposal_id ), $disposition );
				$dispositions[] = $disposition;
			}

			$counts = array();
			foreach ( $dispositions as $disposition ) {
				$key            = $disposition['status'] . ( isset( $disposition['reason'] ) ? ':' . $disposition['reason'] : '' );
				$counts[ $key ] = ( $counts[ $key ] ?? 0 ) + 1;
			}
			$escalated = ( $counts['escalated:manual-conflict-required'] ?? 0 ) + ( $counts['escalated:requires-unfiltered-html'] ?? 0 );
			if ( $escalated > 0 ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: de-rtc escalated {$escalated} proposal(s) in {$room}" );
			}

			$checkpointed = $this->maybe_checkpoint( $room, $state );

			if ( ! empty( $context['debug'] ) ) {
				$this->debug_stash[ $room ] = array(
					'claim_retries' => $this->claim_retries,
					'version'       => $state['version'],
					'content_bytes' => strlen( (string) $state['content'] ),
					'ingest'        => $counts,
					'checkpoint'    => $checkpointed,
				);
			}

			return array( 'dispositions' => $dispositions );
		}

		/**
		 * Merges one proposal into the canonical document.
		 *
		 * @since 0.3.0
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Client identifier.
		 * @param array  $state     Room state (by reference via room cache).
		 * @param array  $proposal  Decoded proposal payload.
		 * @param array  $review    Review ledger (lazily loaded, by reference).
		 * @return array|WP_Error Disposition fields (status, reason?,
		 *                        version?), or a retryable 503 when claim
		 *                        attempts are exhausted under contention.
		 */
		private function ingest_proposal( string $room, int $client_id, array &$state, array $proposal, &$review ) {
			$base_content = $this->resolve_effective_base( $room, $state, $proposal );
			if ( null === $base_content ) {
				return array(
					'status' => 'voided',
					'reason' => 'unknown-base-version',
				);
			}

			/*
			 * Descriptor tamper evidence, enforced: a proposal carrying a
			 * block-native clientUpdate has it validated ONCE against the
			 * PLAIN declared base — the state the client actually built it
			 * from, never the blockBaseVersions composite — and then
			 * DROPPED. Dropping matters twice over: kses laundering and
			 * per-block salvage rewrite the proposed content server-side,
			 * so a retained descriptor would false-positive the merge
			 * core's own tamper check; and the drop is what lets
			 * descriptor-carrying proposals use those partial-acceptance
			 * lanes at all.
			 */
			$engine_aware = ! empty( $proposal['clientUpdate'] );
			$rejection    = $this->validate_and_drop_client_update( $room, $state, $proposal );
			if ( null !== $rejection ) {
				return $rejection;
			}

			$proposed_content = $proposal['proposedContent'];

			/*
			 * Durable block identity, adopted: a proposal that round-tripped
			 * post_content without ids (an engine-unaware writer, or a copy
			 * read before the first aware save) lines up with the identified
			 * base by path, so its untouched blocks compare equal to the base
			 * instead of reading as a rewrite of every block. Runs after the
			 * descriptor drop (validate once, then rewrite freely).
			 */
			if ( class_exists( 'WP_De_RTC_Block_Identity' ) ) {
				$proposed_content = WP_De_RTC_Block_Identity::adopt( $proposed_content, $base_content );
			}

			/*
			 * The capability lane, at ingest: an author without
			 * unfiltered_html cannot land content that kses would rewrite.
			 * Upstream DE-RTC's model, restored here: SEQUESTER exactly the
			 * risky blocks — revert them to their base form in the proposal,
			 * merge the safe remainder normally, and park the risky blocks
			 * for a privileged reviewer (restore re-proposes them under the
			 * RESTORER's capability, so restore IS the approval). The whole
			 * proposal escalates only when per-block extraction is
			 * unavailable (freeform boundaries). Descriptors were validated
			 * and dropped above, so this lane's rewrite cannot invalidate
			 * one.
			 */
			if ( ! current_user_can( 'unfiltered_html' ) ) {
				$sanitized = wp_kses_post( $proposed_content );
				if ( $sanitized !== $proposed_content ) {
					$laundered = $this->sequester_unfiltered_blocks( $room, $client_id, $proposal, $base_content, $review );
					if ( null === $laundered ) {
						$this->park_proposal( $room, $client_id, $proposal, 'requires-unfiltered-html', $base_content, $review );
						return array(
							'status' => 'escalated',
							'reason' => 'requires-unfiltered-html',
						);
					}
					$proposed_content = $laundered;
				}
			}

			/*
			 * Merge, claim, commit — optimistically. The claim is the commit
			 * point: an atomic version-advancement swap (upstream DE-RTC's
			 * validate-and-retry model, not a lock). Losing the claim means
			 * another request advanced canonical between our load and our
			 * commit: reload, re-merge against the fresh state, try again.
			 * Rejection outcomes never advance the version, so they need no
			 * claim.
			 */
			$salvage_parked = 0;
			for ( $attempt = 0; $attempt < 10; $attempt++ ) {
				if ( $attempt > 0 ) {
					/*
					 * Lost the optimistic race. Jittered backoff first —
					 * under a thundering herd, immediate re-claims lose
					 * repeatedly to whichever rival is mid-commit — THEN
					 * reload, so the state we merge against is as fresh as
					 * possible when we claim.
					 */
					usleep( 1000 * wp_rand( 2, 6 * $attempt ) );
					unset( $this->room_states[ $room ] );
					$reloaded = $this->load_room( $room );
					if ( is_wp_error( $reloaded ) ) {
						return array(
							'status' => 'voided',
							'reason' => 'storage-error',
						);
					}
					$state        = $reloaded;
					$base_content = $this->resolve_effective_base( $room, $state, $proposal );
					if ( null === $base_content ) {
						// The base aged out of the snapshot window mid-retry.
						return array(
							'status' => 'voided',
							'reason' => 'unknown-base-version',
						);
					}
				}

				/*
				 * Identity first: with every block carrying a durable id,
				 * the proposal merges block-for-block at every depth
				 * (nested edits land, only true conflicts park). The
				 * identity merge declines whenever it cannot be sure, and
				 * the positional core below decides exactly as before.
				 */
				$result = $this->merge_by_identity( $room, $client_id, $proposal, $base_content, (string) $state['content'], $proposed_content, $review, $salvage_parked );
				if ( null === $result ) {
					$result = wp_de_rtc_get_automerge_retry_save_result(
						$base_content,
						$state['content'],
						$proposed_content,
						$proposal['clientUpdate'] ?? null
					);
				}

				if ( is_wp_error( $result ) ) {
					if ( 'de_rtc_rebase_failed' === $result->get_error_code() ) {
						/*
						 * A genuine conflict. Before parking the WHOLE
						 * proposal, try per-block salvage (upstream's
						 * partial-acceptance model, the same grain the kses
						 * sequestration lane already uses): land the blocks
						 * that merge, park exactly the conflicted ones.
						 * Descriptors were validated and dropped at ingest,
						 * so salvage's rewrite cannot invalidate one.
						 */
						$salvaged = $this->salvage_conflicting_blocks( $room, $client_id, $proposal, $base_content, (string) $state['content'], $proposed_content, $review, $salvage_parked );
						if ( null !== $salvaged && $salvaged !== $proposed_content ) {
							$proposed_content = $salvaged;
							continue; // Re-merge the salvaged content.
						}
						// Per-block extraction unavailable (structural
						// divergence, freeform boundaries): DE-RTC policy is
						// a human decision, not a silent merge. The proposal
						// parks for review; the canonical state wins locally
						// once it applies, and a human restores or dismisses
						// the parked work.
						$this->park_proposal( $room, $client_id, $proposal, 'manual-conflict-required', $base_content, $review );
						return array(
							'status' => 'escalated',
							'reason' => 'manual-conflict-required',
						);
					}

					$data = $result->get_error_data();
					return array(
						'status' => 'voided',
						'reason' => is_array( $data ) && is_string( $data['detail'] ?? null )
							? $data['detail']
							: $result->get_error_code(),
					);
				}

				if ( ! $this->claim_version( $room, (int) $state['version_seq'] ) ) {
					// Lost the optimistic race: back off, reload, re-merge
					// (the loop-top retry block).
					++$this->claim_retries;
					continue;
				}

				// Claimed: this request owns the advancement to the next
				// version. A crash between here and add_row() leaves an
				// orphaned claim; claim_version() heals that by TTL
				// takeover.
				$next_seq     = (int) $state['version_seq'] + 1;
				$next_version = 'v' . $next_seq;
				$merged       = (string) $result['merged_content'];

				/*
				 * Durable block identity for engine-unaware writers: a
				 * proposal without a descriptor came from a script or a
				 * plain save, which never stamps ids — its new blocks get
				 * random creation ids as they become canonical. Sessions
				 * (descriptor-carrying) stamp in the editor, and the server
				 * deliberately does NOT second-guess them: an id stamped
				 * here would collide with the one the editor assigns a
				 * moment later, and the two "changes" to the same block
				 * would park it.
				 */
				if ( ! $engine_aware && class_exists( 'WP_De_RTC_Block_Identity' ) ) {
					$merged = WP_De_RTC_Block_Identity::stamp_creations( $merged );
				}

				// Entity-property registers ride the proposal beside the
				// content: a per-property three-way merge against the same base
				// version. Runs only on the accepted path — an escalated
				// proposal parks whole, and the client re-carries its full
				// property map on the next proposal, so nothing is lost.
				$this->merge_proposed_properties( $room, $client_id, $state, $proposal, $review );

				$state['sync_meta'] = wp_de_rtc_update_automerge_version_snapshots(
					is_array( $state['sync_meta'] ) ? $state['sync_meta'] : array(),
					$state['version'],
					$state['content'],
					$next_version,
					$merged
				);

				/*
				 * Announce model: canonical truth writes FIRST
				 * (room meta), the row second — the row is an ADVISORY
				 * notification, not the document. A lost row is benign
				 * (the next fetch/poll converges from meta); the reverse
				 * order could strand an announced version whose content
				 * nothing holds.
				 */
				$prev_version         = $state['version'];
				$state['version']     = $next_version;
				$state['version_seq'] = $next_seq;
				$state['content']     = $merged;
				$this->record_properties_snapshot( $state, $next_version );
				if ( ! $this->save_canonical( $room, $state, true ) ) {
					// The chained canonical write could not land (a crashed
					// predecessor, healed by the claim TTL). Retryable, and
					// nothing was announced or acked for this version.
					return new WP_Error(
						'rest_sync_room_busy',
						__( 'The room is busy processing another request. Retry shortly.', 'gutenberg' ),
						array( 'status' => 503 )
					);
				}

				$stored = $this->add_row(
					$room,
					self::SERVER_CLIENT_ID,
					self::UPDATE_TYPE_ANNOUNCE,
					wp_json_encode(
						array(
							'version'        => $next_version,
							'baseVersion'    => $prev_version,
							'contentHash'    => wp_de_rtc_hash_content( $merged ),
							'properties'     => $state['properties'] ?? array(),
							'authorClientId' => $client_id,
							'author'         => get_current_user_id(),
							'proposalId'     => $proposal['proposalId'],
						)
					)
				);
				if ( ! $stored ) {
					// Canonical already advanced; peers converge via fetch.
					// The proposer still needs its disposition — report the
					// applied version, not a void.
					// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
					do_action( 'qm/debug', "wp-sync: de-rtc announce row write failed in {$room} (canonical advanced; clients converge via fetch)" );
				}

				$disposition = array(
					'status'  => 'applied',
					'version' => $next_version,
				);
				if ( $salvage_parked > 0 ) {
					// Partial acceptance: the clean remainder landed and
					// this many conflicted blocks parked for review.
					$disposition['parkedBlocks'] = $salvage_parked;
				}

				return $disposition;
			}

			// Claim attempts exhausted: heavy contention. Same retryable
			// contract as the old lock timeout — the client re-sends on its
			// normal cadence and the re-proposal merges idempotently.
			return new WP_Error(
				'rest_sync_room_busy',
				__( 'The room is busy processing another request. Retry shortly.', 'gutenberg' ),
				array( 'status' => 503 )
			);
		}

		/**
		 * Validates a proposal's block-native descriptor and drops it.
		 *
		 * Descriptor tamper evidence, full enforcement: when a
		 * proposal carries `clientUpdate`, the frozen merge core re-derives
		 * the expected update from (plain declared base, proposed content)
		 * and compares fingerprints — a mismatch is tamper evidence and
		 * VOIDS the proposal. On success the descriptor is dropped from
		 * the proposal (validate-once): the server's own rewrites (kses
		 * sequestration, per-block salvage) must not re-trip the check,
		 * and the descriptor-less lanes derive an identical update anyway.
		 *
		 * The validation base is deliberately the PLAIN base of the
		 * declared `baseVersion` — never the `blockBaseVersions`
		 * composite — because that is the exact state the client built
		 * its evidence from, so descriptors and `blockBaseVersions`
		 * compose.
		 *
		 * One deliberate acceptance: a client that could not split blocks
		 * (its parser twin refused where ours did not — e.g. PHP-authored
		 * float attrs re-encode differently across languages) sends the
		 * single `document.replace_unsupported` fallback op. When both
		 * top-level hashes verified, that is legitimate DIGEST-ONLY
		 * evidence, not tamper; rejecting it would turn a serializer
		 * parity edge into a blocked save.
		 *
		 * @since 0.6.0
		 *
		 * @param string $room     Room identifier.
		 * @param array  $state    Room state.
		 * @param array  $proposal Decoded proposal payload (by reference:
		 *                         the descriptor is dropped on success).
		 * @return array|null A voided disposition on rejection, null to
		 *                    proceed.
		 */
		private function validate_and_drop_client_update( string $room, array $state, array &$proposal ): ?array {
			$client_update = $proposal['clientUpdate'] ?? null;
			if ( null === $client_update ) {
				return null;
			}

			$plain_base = $this->resolve_base_content( $state, (string) $proposal['baseVersion'] );
			if ( null === $plain_base ) {
				$plain_base = $this->resolve_base_from_revisions( $room, (string) $proposal['baseVersion'] );
			}
			if ( null === $plain_base ) {
				return array(
					'status' => 'voided',
					'reason' => 'unknown-base-version',
				);
			}

			$normalized = wp_de_rtc_normalize_automerge_client_update( $client_update );
			if ( is_wp_error( $normalized ) ) {
				return $this->reject_client_update( $room, $normalized );
			}

			$valid = wp_de_rtc_validate_automerge_block_native_update_matches_content(
				$plain_base,
				(string) $proposal['proposedContent'],
				$normalized
			);
			if ( is_wp_error( $valid ) && $this->is_hash_pinned_unsupported_fallback( $valid, $normalized ) ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', 'wp-sync: de-rtc accepted digest-only descriptor evidence in ' . $room . ' (client sent the unsupported-fallback op; hashes verified)' );
				$valid = true;
			}
			if ( is_wp_error( $valid ) ) {
				return $this->reject_client_update( $room, $valid );
			}

			$proposal['clientUpdate'] = null;
			return null;
		}

		/**
		 * Returns whether a fingerprint mismatch is the acceptable
		 * hash-pinned unsupported-fallback shape (see
		 * validate_and_drop_client_update()).
		 *
		 * The merge core checks the top-level content hashes with
		 * hash_equals() BEFORE comparing fingerprints, so reaching the
		 * fingerprint mismatch with both hashes PRESENT means both
		 * matched.
		 *
		 * @since 0.6.0
		 *
		 * @param WP_Error $error      Validation error.
		 * @param array    $normalized Normalized client update.
		 * @return bool Whether to accept as digest-only evidence.
		 */
		private function is_hash_pinned_unsupported_fallback( WP_Error $error, array $normalized ): bool {
			$data = $error->get_error_data();
			if ( ! is_array( $data ) || 'automerge_client_update_materialization_mismatch' !== ( $data['detail'] ?? null ) ) {
				return false;
			}
			$operations = $normalized['operations'];
			if ( 1 !== count( $operations ) || 'document.replace_unsupported' !== ( $operations[0]['type'] ?? null ) ) {
				return false;
			}
			return is_string( $normalized['baseContentHash'] ?? null )
				&& is_string( $normalized['proposedContentHash'] ?? null );
		}

		/**
		 * Builds the voided disposition for a rejected descriptor.
		 *
		 * @since 0.6.0
		 *
		 * @param string   $room  Room identifier.
		 * @param WP_Error $error Normalization/validation error.
		 * @return array Voided disposition.
		 */
		private function reject_client_update( string $room, WP_Error $error ): array {
			$data   = $error->get_error_data();
			$reason = is_array( $data ) && is_string( $data['detail'] ?? null )
				? $data['detail']
				: $error->get_error_code();
			// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
			do_action( 'qm/debug', 'wp-sync: de-rtc rejected a client descriptor in ' . $room . ' — ' . $reason );
			return array(
				'status' => 'voided',
				'reason' => $reason,
			);
		}

		/**
		 * Merges a proposal's entity-property registers into canonical.
		 *
		 * Per-property three-way rule against the proposal's base version:
		 * an unchanged property (proposed == base) is a no-op; a property
		 * only the client changed applies; a property changed BOTH by the
		 * client and concurrently in canonical is a genuine conflict and
		 * parks for review (`property-conflict`) — the canonical value
		 * wins on the wire, the parked row carries the losing value.
		 * Markup-bearing string values from an author without
		 * unfiltered_html park as `requires-unfiltered-html` instead of
		 * applying (the property twin of the content kses gate).
		 *
		 * @since 0.4.0
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Proposing client id.
		 * @param array  $state     Room state (by reference).
		 * @param array  $proposal  Decoded proposal payload.
		 * @param array  $review    Review ledger (lazily loaded, by reference).
		 * @return void
		 */
		private function merge_proposed_properties( string $room, int $client_id, array &$state, array $proposal, &$review ): void {
			$proposed_props = $proposal['proposedProperties'] ?? null;
			if ( ! is_array( $proposed_props ) ) {
				return;
			}

			/*
			 * One representation: content travels as content (the proposal
			 * body / canonical state), never as a property register. A
			 * `content` register would re-carry the ENTIRE document on
			 * every announce (the double-carry trap), so the client never
			 * sends one and the server strips it regardless.
			 */
			unset( $proposed_props['content'] );

			$base_props      = $this->resolve_base_properties( $state, (string) $proposal['baseVersion'] );
			$canonical_props = is_array( $state['properties'] ?? null ) ? $state['properties'] : array();
			$can_unfiltered  = current_user_can( 'unfiltered_html' );

			foreach ( $proposed_props as $name => $proposed_value ) {
				if ( ! is_string( $name ) || '' === $name ) {
					continue;
				}
				$base_value      = $base_props[ $name ] ?? null;
				$canonical_value = $canonical_props[ $name ] ?? null;

				if ( self::property_values_equal( $proposed_value, $base_value ) ) {
					continue; // The client did not change this property.
				}

				if ( ! $can_unfiltered && is_string( $proposed_value ) && wp_kses_post( $proposed_value ) !== $proposed_value ) {
					$this->park_property_conflict( $room, $client_id, (string) $proposal['proposalId'], $name, $proposed_value, 'requires-unfiltered-html', $review );
					continue;
				}

				if (
					self::property_values_equal( $canonical_value, $base_value ) ||
					self::property_values_equal( $proposed_value, $canonical_value )
				) {
					$canonical_props[ $name ] = $proposed_value;
					continue;
				}

				// Both sides changed it to different values: a human decides.
				$this->park_property_conflict( $room, $client_id, (string) $proposal['proposalId'], $name, $proposed_value, 'property-conflict', $review );
			}

			$state['properties'] = $canonical_props;
		}

		/**
		 * Parks a conflicting property register for review.
		 *
		 * The parked id suffixes the property name onto the proposalId so
		 * each conflicting property resolves independently.
		 *
		 * @since 0.4.0
		 *
		 * @param string $room        Room identifier.
		 * @param int    $client_id   Proposing client id.
		 * @param string $proposal_id Proposal correlation id.
		 * @param string $name        Property name.
		 * @param mixed  $value       The losing proposed value.
		 * @param string $reason      Escalation reason.
		 * @param array  $review      Review ledger (lazily loaded, by reference).
		 * @return void
		 */
		private function park_property_conflict( string $room, int $client_id, string $proposal_id, string $name, $value, string $reason, &$review ): void {
			$parked_id = $proposal_id . ':' . $name;
			if ( null === $review ) {
				$review = $this->load_review_ledger( $room );
			}
			if ( isset( $review['open'][ $parked_id ] ) || isset( $review['resolved'][ $parked_id ] ) ) {
				return;
			}

			$excerpt = is_string( $value ) ? $value : (string) wp_json_encode( $value );
			$excerpt = trim( preg_replace( '/\s+/', ' ', wp_strip_all_tags( $excerpt ) ) );
			if ( function_exists( 'mb_substr' ) ) {
				$excerpt = mb_substr( $excerpt, 0, 80 );
			} else {
				$excerpt = substr( $excerpt, 0, 80 );
			}

			$stored = $this->add_row(
				$room,
				$client_id,
				self::UPDATE_TYPE_PARKED,
				wp_json_encode(
					array(
						'proposalId'     => $parked_id,
						'reason'         => $reason,
						'authorClientId' => $client_id,
						'author'         => get_current_user_id(),
						'at'             => time(),
						'property'       => array(
							'name'  => $name,
							'value' => $value,
						),
						'changedBlocks'  => array(),
						'excerpt'        => $name . ': ' . $excerpt,
					)
				)
			);
			if ( $stored ) {
				$review['open'][ $parked_id ] = true;
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: de-rtc parked property conflict '{$name}' ({$reason}) in {$room}" );
			}
		}

		/**
		 * Resolves the property map a proposal was authored against.
		 *
		 * Falls back to the canonical map when the base version's property
		 * snapshot is unknown (a base older than the retained per-version
		 * window) — the fallback treats concurrent property changes as
		 * absent, which degrades to last-writer-wins for exactly that case.
		 *
		 * @since 0.4.0
		 *
		 * @param array  $state        Room state.
		 * @param string $base_version Proposal base version label.
		 * @return array Property map at the base version.
		 */
		private function resolve_base_properties( array $state, string $base_version ): array {
			$by_version = is_array( $state['properties_by_version'] ?? null ) ? $state['properties_by_version'] : array();
			if ( is_array( $by_version[ $base_version ] ?? null ) ) {
				return $by_version[ $base_version ];
			}

			return is_array( $state['properties'] ?? null ) ? $state['properties'] : array();
		}

		/**
		 * Records the canonical property map for a version and prunes the
		 * per-version window to the frozen core's snapshot window (the base
		 * versions resolve_base_content can still serve).
		 *
		 * @since 0.4.0
		 *
		 * @param array  $state   Room state (by reference).
		 * @param string $version Version label.
		 * @return void
		 */
		private function record_properties_snapshot( array &$state, string $version ): void {
			$by_version             = is_array( $state['properties_by_version'] ?? null ) ? $state['properties_by_version'] : array();
			$by_version[ $version ] = is_array( $state['properties'] ?? null ) ? $state['properties'] : array();

			$snapshots = $state['sync_meta']['version_snapshots'] ?? null;
			if ( is_array( $snapshots ) ) {
				$by_version = array_intersect_key( $by_version, $snapshots + array( $version => true ) );
			}

			$state['properties_by_version'] = $by_version;
		}

		/**
		 * Order-tolerant value equality for property registers.
		 *
		 * Term-ID arrays are sets (the editor appends in click order while
		 * REST serializes name order), so numeric lists compare sorted;
		 * everything else compares by JSON encoding.
		 *
		 * @since 0.4.0
		 *
		 * @param mixed $a One value.
		 * @param mixed $b Other value.
		 * @return bool Whether the values are equal.
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
		 * Resolves the content a proposal was authored against.
		 *
		 * @since 0.3.0
		 *
		 * @param array  $state        Room state.
		 * @param string $base_version Proposal base version label.
		 * @return string|null Base content, or null when unknown.
		 */
		private function resolve_base_content( array $state, string $base_version ) {
			if ( $base_version === $state['version'] ) {
				return $state['content'];
			}

			$snapshots = isset( $state['sync_meta']['version_snapshots'] ) && is_array( $state['sync_meta']['version_snapshots'] )
				? $state['sync_meta']['version_snapshots']
				: array();
			$snapshot  = $snapshots[ $base_version ] ?? null;
			if ( is_array( $snapshot ) && is_string( $snapshot['content_base64'] ?? null ) ) {
				// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- Decodes a stored version snapshot's content.
				$decoded = base64_decode( $snapshot['content_base64'], true );
				if ( false !== $decoded ) {
					return $decoded;
				}
			}

			return null;
		}

		/**
		 * Parks an escalated proposal as a durable review row.
		 *
		 * The row carries the CHANGED top-level blocks (proposed blocks whose
		 * serialized form differs from the base at the same index, plus
		 * appended blocks) with their indices, so a reviewer's restore can
		 * overlay them at sensible anchors — and a plain-text excerpt for
		 * display after offsets go stale. Idempotent by proposalId: a
		 * redelivered escalation never double-parks.
		 *
		 * @since 0.4.0
		 *
		 * @param string $room         Room identifier.
		 * @param int    $client_id    Escalating client id.
		 * @param array  $proposal     Decoded proposal payload.
		 * @param string $reason       Escalation reason.
		 * @param string $base_content Content of the proposal's base version.
		 * @param array  $review       Review ledger (lazily loaded, by reference).
		 * @return void
		 */
		private function park_proposal( string $room, int $client_id, array $proposal, string $reason, string $base_content, &$review ): void {
			$changed_blocks = $this->changed_blocks( $base_content, (string) $proposal['proposedContent'] );
			$this->park_changed_blocks( $room, $client_id, (string) $proposal['proposalId'], $reason, (string) $proposal['baseVersion'], $changed_blocks, $review, false );
		}

		/**
		 * Parks a set of changed blocks as one durable review row.
		 *
		 * Idempotent by parked id (a redelivered escalation never
		 * double-parks). With $dedupe_by_content, an OPEN row from the same
		 * author with the same reason and byte-identical changed blocks
		 * also suppresses the park — the sequestration lane's guard against
		 * an author re-proposing the same risky content every poll cycle.
		 *
		 * @since 0.4.0
		 *
		 * @param string $room              Room identifier.
		 * @param int    $client_id         Escalating client id.
		 * @param string $parked_id         Parked row id.
		 * @param string $reason            Escalation reason.
		 * @param string $base_version      Proposal base version label.
		 * @param array  $changed_blocks    Blocks to park ({index, html}).
		 * @param array  $review            Review ledger (lazily loaded, by reference).
		 * @param bool   $dedupe_by_content Whether to suppress same-content re-parks.
		 * @return void
		 */
		private function park_changed_blocks( string $room, int $client_id, string $parked_id, string $reason, string $base_version, array $changed_blocks, &$review, bool $dedupe_by_content ): void {
			if ( null === $review ) {
				$review = $this->load_review_ledger( $room );
			}
			if ( isset( $review['open'][ $parked_id ] ) || isset( $review['resolved'][ $parked_id ] ) ) {
				return; // Redelivery: already parked (or already resolved).
			}
			if ( $dedupe_by_content ) {
				foreach ( $review['open'] as $open_row ) {
					if (
						is_array( $open_row ) &&
						( $open_row['reason'] ?? null ) === $reason &&
						(int) ( $open_row['authorClientId'] ?? -1 ) === $client_id &&
						wp_json_encode( $open_row['changedBlocks'] ?? null ) === wp_json_encode( $changed_blocks )
					) {
						return;
					}
				}
			}

			$changed_text = '';
			foreach ( $changed_blocks as $block ) {
				$changed_text .= ' ' . wp_strip_all_tags( $block['html'] );
			}
			$excerpt = trim( preg_replace( '/\s+/', ' ', $changed_text ) );
			if ( function_exists( 'mb_substr' ) ) {
				$excerpt = mb_substr( $excerpt, 0, 80 );
			} else {
				$excerpt = substr( $excerpt, 0, 80 );
			}

			$payload = array(
				'proposalId'     => $parked_id,
				'reason'         => $reason,
				'authorClientId' => $client_id,
				'author'         => get_current_user_id(),
				'at'             => time(),
				'baseVersion'    => $base_version,
				'changedBlocks'  => $changed_blocks,
				'excerpt'        => $excerpt,
			);

			$stored = $this->add_row(
				$room,
				$client_id,
				self::UPDATE_TYPE_PARKED,
				wp_json_encode( $payload )
			);
			if ( $stored ) {
				$review['open'][ $parked_id ] = $payload;
			}
		}

		/**
		 * Loads the room's pinned block-approval fingerprints.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room Room identifier.
		 * @return array<string, array{by: int, at: int}> Fingerprint hash
		 *                                                 (see wp_de_rtc_hash_content())
		 *                                                 to approval record; empty
		 *                                                 when the storage backend has
		 *                                                 no room-meta support.
		 */
		private function get_approved_blocks( string $room ): array {
			if ( ! method_exists( $this->storage, 'get_room_meta' ) ) {
				return array();
			}
			$approved = $this->storage->get_room_meta( $room, self::META_APPROVED_BLOCKS );
			return is_array( $approved ) ? $approved : array();
		}

		/**
		 * Pins a fingerprint of each given block's exact bytes as approved,
		 * so a later proposal carrying the same bytes — from any author —
		 * passes the unfiltered_html gate in sequester_unfiltered_blocks()
		 * without re-parking. Called only when a `requires-unfiltered-html`
		 * park is RESTORED (see apply_resolution()); restoring is the
		 * approval act. An edited approved block has new bytes and no pin
		 * match, so it re-parks — that boundary is deliberate policy (#41).
		 *
		 * @since 0.0.1
		 *
		 * @param string $room           Room identifier.
		 * @param array  $changed_blocks The parked row's changedBlocks ({index, html}).
		 * @return void
		 */
		private function record_approved_blocks( string $room, array $changed_blocks ): void {
			if ( ! method_exists( $this->storage, 'get_room_meta' ) || ! method_exists( $this->storage, 'set_room_meta' ) ) {
				return;
			}
			$approved = $this->get_approved_blocks( $room );
			$by       = get_current_user_id();
			$at       = time();
			foreach ( $changed_blocks as $block ) {
				if ( ! is_array( $block ) || ! is_string( $block['html'] ?? null ) || '' === $block['html'] ) {
					continue;
				}
				$approved[ wp_de_rtc_hash_content( $block['html'] ) ] = array(
					'by' => $by,
					'at' => $at,
				);
			}
			$this->storage->set_room_meta( $room, self::META_APPROVED_BLOCKS, $approved );
		}

		/**
		 * Sequesters the kses-risky blocks out of a filtered author's
		 * proposal: each risky changed block reverts to its base-version
		 * form (a risky NEW block drops), the reverted blocks park for
		 * review, and the laundered content merges normally — the safe
		 * remainder of the edit lands instead of parking with the risky
		 * part.
		 *
		 * Returns null when per-block extraction is unavailable (freeform
		 * boundaries) or nothing block-attributable was found; the caller
		 * falls back to whole-proposal escalation.
		 *
		 * @since 0.4.0
		 *
		 * @param string $room         Room identifier.
		 * @param int    $client_id    Proposing client id.
		 * @param array  $proposal     Decoded proposal payload.
		 * @param string $base_content Content of the proposal's base version.
		 * @param array  $review       Review ledger (lazily loaded, by reference).
		 * @return string|null Laundered proposed content, or null.
		 */
		private function sequester_unfiltered_blocks( string $room, int $client_id, array $proposal, string $base_content, &$review ): ?string {
			/*
			 * By identity first, at every depth: only the risky block itself
			 * reverts or drops (a risky paragraph inside a Group no longer
			 * takes the whole Group with it), and it is matched to its base
			 * form by id, not by position. Declines to the positional lane
			 * below whenever identity cannot model either side.
			 */
			if ( class_exists( 'WP_De_RTC_Identity_Merge' ) ) {
				$by_identity = WP_De_RTC_Identity_Merge::sequester( $base_content, (string) $proposal['proposedContent'], $this->get_approved_blocks( $room ) );
				if ( is_array( $by_identity ) ) {
					if ( array() !== $by_identity['risky'] ) {
						$this->park_changed_blocks( $room, $client_id, (string) $proposal['proposalId'], 'requires-unfiltered-html', (string) $proposal['baseVersion'], $by_identity['risky'], $review, true );
						// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
						do_action( 'qm/debug', 'wp-sync: de-rtc sequestered ' . count( $by_identity['risky'] ) . " risky block(s) by identity from a filtered author in {$room}" );
					}
					return $by_identity['laundered'];
				}
			}

			$base_records     = wp_de_rtc_get_top_level_serialized_block_records( $base_content );
			$proposed_records = wp_de_rtc_get_top_level_serialized_block_records( (string) $proposal['proposedContent'] );
			if ( is_wp_error( $base_records ) || is_wp_error( $proposed_records ) ) {
				return null;
			}

			$base_set  = array_fill_keys( $base_records, true );
			$approved  = $this->get_approved_blocks( $room );
			$laundered = array();
			$risky     = array();
			foreach ( $proposed_records as $index => $serialized ) {
				// A block byte-identical to a base block was not written by
				// this author here; a changed block that kses round-trips is
				// safe; a block whose exact bytes were previously RESTORED
				// (approved) by someone with unfiltered_html is vetted even
				// though it is neither base-identical here nor kses-clean on
				// its own — an author re-carrying it in a later proposal, or
				// re-inserting it after a deletion, should not re-park it.
				// All three pass through.
				if (
					isset( $base_set[ $serialized ] ) ||
					wp_kses_post( $serialized ) === $serialized ||
					isset( $approved[ wp_de_rtc_hash_content( $serialized ) ] )
				) {
					$laundered[] = $serialized;
					continue;
				}
				$risky[] = array(
					'index' => (int) $index,
					'html'  => $serialized,
				);
				// An EDITED risky block reverts to its base form (same
				// position, same block type); a risky NEW block has no base
				// counterpart and drops from the laundered content.
				$base_at = $base_records[ $index ] ?? null;
				if ( is_string( $base_at ) && self::block_name_of( $base_at ) === self::block_name_of( $serialized ) ) {
					$laundered[] = $base_at;
				}
			}

			if ( array() === $risky ) {
				/*
				 * The whole-document kses check (the caller) flagged
				 * something the per-block pass above cannot see: every
				 * block here parsed cleanly and passed on its own
				 * (base-identical, kses-clean, or pinned). Nothing in this
				 * proposal is actually risky, so the laundered content is
				 * the proposal verbatim — treating "nothing to attribute"
				 * as "cannot attribute" escalated the whole document over a
				 * false alarm.
				 */
				return implode( "\n\n", $laundered );
			}

			$this->park_changed_blocks( $room, $client_id, (string) $proposal['proposalId'], 'requires-unfiltered-html', (string) $proposal['baseVersion'], $risky, $review, true );

			// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
			do_action( 'qm/debug', 'wp-sync: de-rtc sequestered ' . count( $risky ) . " risky block(s) from a filtered author in {$room}" );

			// The standard serializer convention joins blocks with blank
			// lines; matching it keeps the laundered canonical byte-stable
			// against the client's next serialization of the same blocks.
			return implode( "\n\n", $laundered );
		}

		/**
		 * Per-block salvage of a proposal whose whole-document three-way
		 * merge failed: the partial-acceptance grain, mirroring the kses
		 * sequestration lane. Blocks only the client changed pass through;
		 * blocks only canonical changed adopt canonical; blocks BOTH
		 * changed get their own three-way merge — and when that conflicts
		 * too, canonical wins the position while the client's block parks
		 * for review.
		 *
		 * Sound only when the block structure aligns positionally on all
		 * three sides (equal top-level record counts): structural
		 * divergence is exactly where positional alignment lies, so it
		 * returns null and the caller keeps the whole-proposal fallback.
		 *
		 * @since 0.5.0
		 *
		 * @param string $room             Room identifier.
		 * @param int    $client_id        Proposing client id.
		 * @param array  $proposal         Decoded proposal payload.
		 * @param string $base_content     Content of the proposal's base version.
		 * @param string $current_content  Current canonical content.
		 * @param string $proposed_content Proposed content (post-kses lane).
		 * @param array  $review           Review ledger (lazily loaded, by reference).
		 * @param int    $parked_count     Accumulates how many blocks parked (by reference).
		 * @return string|null Salvaged proposed content, or null when
		 *                     per-block extraction cannot apply.
		 */
		private function salvage_conflicting_blocks( string $room, int $client_id, array $proposal, string $base_content, string $current_content, string $proposed_content, &$review, &$parked_count ): ?string {
			$base_records     = wp_de_rtc_get_top_level_serialized_block_records( $base_content );
			$current_records  = wp_de_rtc_get_top_level_serialized_block_records( $current_content );
			$proposed_records = wp_de_rtc_get_top_level_serialized_block_records( $proposed_content );
			if ( is_wp_error( $base_records ) || is_wp_error( $current_records ) || is_wp_error( $proposed_records ) ) {
				return null; // Freeform boundaries defeat per-block extraction.
			}
			if ( count( $base_records ) !== count( $proposed_records ) || count( $base_records ) !== count( $current_records ) ) {
				return null; // Structural divergence: positional alignment lies.
			}

			$salvaged   = array();
			$conflicted = array();
			foreach ( $proposed_records as $index => $proposed_block ) {
				$base_block    = (string) $base_records[ $index ];
				$current_block = (string) $current_records[ $index ];

				if ( $proposed_block === $base_block ) {
					$salvaged[] = $current_block; // Client untouched: adopt canonical.
					continue;
				}
				if ( $current_block === $base_block || $current_block === $proposed_block ) {
					$salvaged[] = $proposed_block; // Sole writer (or agreement).
					continue;
				}

				// Both sides changed this block: its own three-way merge.
				$merged = wp_de_rtc_get_automerge_retry_save_result( $base_block, $current_block, $proposed_block, null );
				if ( ! is_wp_error( $merged ) ) {
					$salvaged[] = (string) $merged['merged_content'];
					continue;
				}
				if ( 'de_rtc_rebase_failed' !== $merged->get_error_code() ) {
					return null; // Unexpected failure: keep the whole-proposal path.
				}
				// True conflict: canonical wins the position, the client's
				// block parks for review.
				$conflicted[] = array(
					'index' => (int) $index,
					'html'  => $proposed_block,
				);
				$salvaged[]   = $current_block;
			}

			if ( array() === $conflicted ) {
				// The whole-document merge failed for a reason per-block
				// analysis cannot see; nothing to salvage differently.
				return null;
			}

			$this->park_changed_blocks( $room, $client_id, (string) $proposal['proposalId'], 'manual-conflict-required', (string) $proposal['baseVersion'], $conflicted, $review, false );
			$parked_count += count( $conflicted );

			// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
			do_action( 'qm/debug', 'wp-sync: de-rtc salvaged a conflicting proposal in ' . $room . ' — ' . count( $conflicted ) . ' block(s) parked, the remainder lands' );

			return implode( "\n\n", $salvaged );
		}

		/**
		 * Merges a proposal by block identity at every depth, parking only
		 * the blocks that truly conflict (see WP_De_RTC_Identity_Merge).
		 * Null when identity cannot decide, in which case the caller runs
		 * the positional merge core exactly as before.
		 *
		 * @since 0.0.1
		 *
		 * @param string $room             Room identifier.
		 * @param int    $client_id        Proposing client id.
		 * @param array  $proposal         Decoded proposal payload.
		 * @param string $base_content     Content of the proposal's base version.
		 * @param string $current_content  Current canonical content.
		 * @param string $proposed_content Proposed content (post-kses lane).
		 * @param array  $review           Review ledger (lazily loaded, by reference).
		 * @param int    $parked_count     Accumulates how many blocks parked (by reference).
		 * @return array|null array{merged_content: string} or null.
		 */
		private function merge_by_identity( string $room, int $client_id, array $proposal, string $base_content, string $current_content, string $proposed_content, &$review, &$parked_count ): ?array {
			if ( ! class_exists( 'WP_De_RTC_Identity_Merge' ) || hash_equals( wp_de_rtc_hash_content( $base_content ), wp_de_rtc_hash_content( $current_content ) ) ) {
				return null; // A current-base proposal needs no merge at all.
			}
			$identity = WP_De_RTC_Identity_Merge::merge( $base_content, $current_content, $proposed_content );
			if ( ! is_array( $identity ) ) {
				return null;
			}
			if ( array() !== $identity['conflicts'] ) {
				if ( null === $review ) {
					$review = $this->load_review_ledger( $room );
				}
				$parked_id = (string) $proposal['proposalId'];
				$was_open  = isset( $review['open'][ $parked_id ] ) || isset( $review['resolved'][ $parked_id ] );
				$this->park_changed_blocks( $room, $client_id, $parked_id, 'manual-conflict-required', (string) $proposal['baseVersion'], $identity['conflicts'], $review, false );
				if ( ! $was_open ) {
					$parked_count += count( $identity['conflicts'] );
				}
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', 'wp-sync: de-rtc identity merge in ' . $room . ' — ' . count( $identity['conflicts'] ) . ' block(s) parked, the remainder lands' );
			}
			return array(
				'merged_content' => $identity['merged_content'],
				'merge_strategy' => $identity['merge_strategy'],
			);
		}

		/**
		 * The block name of a serialized top-level block.
		 *
		 * @since 0.4.0
		 *
		 * @param string $serialized Serialized block.
		 * @return string|null Block name, or null when unparsable.
		 */
		private static function block_name_of( string $serialized ): ?string {
			return preg_match( '/^<!--\s+wp:([a-z0-9\/_-]+)/i', $serialized, $matches ) ? $matches[1] : null;
		}

		/**
		 * The changed top-level blocks of a proposal against its base.
		 *
		 * @since 0.4.0
		 *
		 * @param string $base_content     Base version content.
		 * @param string $proposed_content Proposed content.
		 * @return array<int, array{index: int, html: string}> Changed blocks.
		 */
		private function changed_blocks( string $base_content, string $proposed_content ): array {
			$base_records     = wp_de_rtc_get_top_level_serialized_block_records( $base_content );
			$proposed_records = wp_de_rtc_get_top_level_serialized_block_records( $proposed_content );
			if ( is_wp_error( $base_records ) || is_wp_error( $proposed_records ) ) {
				// Freeform boundaries defeat per-block extraction; park the
				// whole proposed content as one restorable unit.
				return array(
					array(
						'index' => 0,
						'html'  => $proposed_content,
					),
				);
			}

			$changed = array();
			foreach ( $proposed_records as $index => $serialized ) {
				if ( ( $base_records[ $index ] ?? null ) === $serialized ) {
					continue;
				}
				$changed[] = array(
					'index' => (int) $index,
					'html'  => $serialized,
				);
			}

			return $changed;
		}

		/**
		 * Applies one proposal resolution against the room's review ledger:
		 * an OPEN, un-resolved proposal gets a stamped `resolved` row (the
		 * broadcastable advisory peers and late joiners replay); anything
		 * else acks idempotently. Reached only through resolve_proposal()
		 * (the REST review lane).
		 *
		 * @since 0.3.0
		 *
		 * @param string $room       Room identifier.
		 * @param array  $resolution array{proposalId: string, resolution: string}.
		 * @param int    $client_id  Resolving client id (0 = none declared).
		 * @param array  $review     Review ledger (by reference; `resolved` updated).
		 * @return array|WP_Error Disposition, or error on storage failure.
		 */
		private function apply_resolution( string $room, array $resolution, int $client_id, array &$review ) {
			$proposal_id = $resolution['proposalId'];
			if ( isset( $review['open'][ $proposal_id ] ) && ! isset( $review['resolved'][ $proposal_id ] ) ) {
				$parked = $review['open'][ $proposal_id ];
				$stored = $this->add_row(
					$room,
					$client_id,
					self::UPDATE_TYPE_RESOLVED,
					wp_json_encode(
						array(
							'proposalId' => $proposal_id,
							'resolution' => $resolution['resolution'],
							'resolvedBy' => get_current_user_id(),
							'time'       => time(),
						)
					)
				);
				if ( ! $stored ) {
					return new WP_Error(
						'rest_sync_storage_error',
						__( 'Failed to store sync update.', 'gutenberg' ),
						array( 'status' => 500 )
					);
				}
				$review['resolved'][ $proposal_id ] = true;

				/*
				 * Restoring a block parked for `requires-unfiltered-html` is
				 * the approval act: pin its exact bytes so a later proposal
				 * carrying the same content — from ANY author — passes the
				 * capability gate instead of re-parking every time it rides
				 * along in someone else's edit. See sequester_unfiltered_blocks().
				 */
				if (
					'restored' === $resolution['resolution'] &&
					'requires-unfiltered-html' === ( $parked['reason'] ?? null )
				) {
					$this->record_approved_blocks(
						$room,
						is_array( $parked['changedBlocks'] ?? null ) ? $parked['changedBlocks'] : array()
					);
				}
			}
			return array(
				'intentId' => $proposal_id,
				'status'   => 'resolved',
			);
		}

		/**
		 * Resolves one parked proposal outside the transport — the REST
		 * review lane (B5): resolutions are MUTATIONS and belong on an
		 * authenticated REST route; the transport stays advisory (the
		 * stamped `resolved` row this appends still broadcasts through it).
		 * This is the ONLY way clients resolve — handle_updates() rejects
		 * client-sent resolution rows.
		 *
		 * @since 0.3.0
		 *
		 * @param string $room        Room identifier.
		 * @param string $proposal_id Parked proposal id.
		 * @param string $resolution  'restored' or 'dismissed'.
		 * @param int    $client_id   Resolving client id (0 = none declared).
		 * @return array|WP_Error Disposition, or error.
		 */
		public function resolve_proposal( string $room, string $proposal_id, string $resolution, int $client_id = 0 ) {
			if ( '' === $proposal_id || ! in_array( $resolution, array( 'restored', 'dismissed' ), true ) ) {
				return new WP_Error(
					'rest_sync_invalid_intent',
					__( 'Malformed proposal resolution.', 'gutenberg' ),
					array( 'status' => 400 )
				);
			}
			$review = $this->load_review_ledger( $room );
			return $this->apply_resolution(
				$room,
				array(
					'proposalId' => $proposal_id,
					'resolution' => $resolution,
				),
				$client_id,
				$review
			);
		}

		/**
		 * Derives the open/resolved review ledger from retained rows.
		 *
		 * Parked rows are always retained while unresolved (the compaction
		 * rule re-appends them above the trim floor), so the retained window
		 * is authoritative for what is open.
		 *
		 * @since 0.4.0
		 *
		 * @param string $room Room identifier.
		 * @return array{open: array<string, array>, resolved: array<string, bool>} Ledger.
		 */
		private function load_review_ledger( string $room ): array {
			$ledger = array(
				'open'     => array(),
				'resolved' => array(),
			);
			$rows   = $this->storage->get_updates_after_cursor( $room, 0 );
			foreach ( $rows as $row ) {
				$decoded = json_decode( (string) $row['data'], true );
				if ( ! is_array( $decoded ) || ! is_string( $decoded['proposalId'] ?? null ) ) {
					continue;
				}
				if ( self::UPDATE_TYPE_PARKED === $row['type'] ) {
					$ledger['open'][ $decoded['proposalId'] ] = $decoded;
				} elseif ( self::UPDATE_TYPE_RESOLVED === $row['type'] ) {
					$ledger['resolved'][ $decoded['proposalId'] ] = true;
				}
			}

			return $ledger;
		}

		/**
		 * Returns stored rows after a cursor, lazily initializing genesis.
		 *
		 * @since 0.3.0
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Client identifier.
		 * @param int    $cursor    Client cursor.
		 * @param array  $context   Transport context.
		 * @return array Response envelope.
		 */
		public function get_updates_since( string $room, int $client_id, int $cursor, array $context ): array {
			if ( $cursor > 0 && method_exists( $this->storage, 'get_room_meta' ) ) {
				$floor = $this->storage->get_room_meta( $room, self::META_FLOOR );
				if ( is_numeric( $floor ) && $cursor < (int) $floor ) {
					$cursor = (int) $floor - 1;
				}
			}

			$rows = $this->storage->get_updates_after_cursor( $room, $cursor );

			// See the yjs-server engine for why this check must run AFTER the
			// read (the storage's update count is a per-request cache that
			// only the read refreshes).
			if ( 0 === $this->storage->get_update_count( $room ) ) {
				$this->room_states[ $room ] = null;
				$this->load_room( $room );
				$rows = $this->storage->get_updates_after_cursor( $room, $cursor );
			}

			$typed_updates = array();
			foreach ( $rows as $row ) {
				// All stored rows are server-authored (announce/snapshot) and
				// relevant to every client, including the proposal's author —
				// an accepted announce row is the authoritative confirmation.
				$typed_updates[] = array(
					'data' => $row['data'],
					'type' => $row['type'],
				);
			}

			/*
			 * Content-on-demand (the announce model): a `fetch` row
			 * in this request's ingest half asked for canonical content. When
			 * the client is behind, append ONE synthesized snapshot of the
			 * CURRENT canonical state — never stored, never counted in
			 * cursors, always the latest (a fetch for an announced version
			 * that has since advanced gets the newer state; strictly better).
			 */
			$have_version = $this->content_requests[ $room ][ $client_id ] ?? null;
			if ( null !== $have_version ) {
				unset( $this->content_requests[ $room ][ $client_id ] );
				$state = $this->load_room( $room );
				if ( ! is_wp_error( $state ) ) {
					$have_seq = '' === $have_version ? -1 : (int) ltrim( (string) $have_version, 'v' );
					if ( (int) $state['version_seq'] > $have_seq ) {
						$typed_updates[] = array(
							'data' => wp_json_encode(
								array(
									'version'    => $state['version'],
									'content'    => $state['content'],
									'properties' => $state['properties'] ?? array(),
									'ephemeral'  => true,
								)
							),
							'type' => self::UPDATE_TYPE_SNAPSHOT,
						);
					}
				}
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
		 * Returns the canonical post content for a room.
		 *
		 * Convention shared with the other engines (used by tests and the
		 * benchmark's convergence oracle; not part of the SPI).
		 *
		 * @since 0.3.0
		 *
		 * @param string $room Room identifier.
		 * @return string|null Canonical content, or null on failure.
		 */
		public function materialize( string $room ): ?string {
			$state = $this->load_room( $room );
			if ( is_wp_error( $state ) ) {
				return null;
			}

			return (string) $state['content'];
		}

		/**
		 * Loads (and lazily initializes) the canonical state for a room.
		 *
		 * Canonical truth is the chained options row (the announce model's
		 * single content store). Stored rows never carry content except
		 * snapshots (genesis and checkpoints), so when the chain row is
		 * missing the state rebuilds from the retained snapshot rows.
		 *
		 * @since 0.3.0
		 *
		 * @param string $room Room identifier.
		 * @return array|WP_Error Room state or error.
		 */
		private function load_room( string $room ) {
			if ( isset( $this->room_states[ $room ] ) && null !== $this->room_states[ $room ] ) {
				return $this->room_states[ $room ];
			}

			$meta = self::decode_canonical(
				WP_Sync_Atomic_Option::read( $this->canonical_option_name( $room ) )
			);

			$state       = null;
			$meta_cursor = 0;
			if ( is_array( $meta ) && is_string( $meta['version'] ?? null ) && is_string( $meta['content'] ?? null ) ) {
				$state       = array(
					'version'               => $meta['version'],
					'version_seq'           => (int) ( $meta['version_seq'] ?? 0 ),
					'content'               => $meta['content'],
					'sync_meta'             => is_array( $meta['sync_meta'] ?? null ) ? $meta['sync_meta'] : array(),
					'properties'            => is_array( $meta['properties'] ?? null ) ? $meta['properties'] : array(),
					'properties_by_version' => is_array( $meta['properties_by_version'] ?? null ) ? $meta['properties_by_version'] : array(),
					'healed_hash'           => is_string( $meta['healed_hash'] ?? null ) ? $meta['healed_hash'] : null,
				);
				$meta_cursor = (int) ( $meta['cursor'] ?? 0 );
			}

			$rows = $this->storage->get_updates_after_cursor( $room, $meta_cursor );

			if ( null === $state && array() === $rows ) {
				return $this->initialize_room( $room );
			}

			if ( null === $state ) {
				$state = array(
					'version'               => 'v0',
					'version_seq'           => 0,
					'content'               => '',
					'sync_meta'             => array(),
					'properties'            => array(),
					'properties_by_version' => array(),
					'healed_hash'           => null,
				);
			}

			foreach ( $rows as $row ) {
				if ( self::UPDATE_TYPE_SNAPSHOT !== $row['type'] ) {
					continue; // Only snapshot rows carry canonical content.
				}
				$decoded = json_decode( (string) $row['data'], true );
				if ( ! is_array( $decoded ) || ! is_string( $decoded['version'] ?? null ) || ! is_string( $decoded['content'] ?? null ) ) {
					continue;
				}
				$row_seq = (int) ltrim( $decoded['version'], 'v' );
				if ( $row_seq <= (int) $state['version_seq'] && 'v0' !== $state['version'] ) {
					continue; // Already reflected in the canonical snapshot.
				}
				$state['sync_meta']   = wp_de_rtc_update_automerge_version_snapshots(
					$state['sync_meta'],
					$state['version'],
					$state['content'],
					$decoded['version'],
					$decoded['content']
				);
				$state['version']     = $decoded['version'];
				$state['version_seq'] = $row_seq;
				$state['content']     = $decoded['content'];
				if ( is_array( $decoded['properties'] ?? null ) ) {
					$state['properties'] = $decoded['properties'];
				}
				$this->record_properties_snapshot( $state, $decoded['version'] );
			}

			// Self-healing: fold in an out-of-band post_content write before
			// anyone reads or merges against this state.
			$state = $this->maybe_heal_external_save( $room, $state );

			$this->room_states[ $room ] = $state;

			return $state;
		}

		/**
		 * Detects and heals an out-of-band write to the post's content.
		 *
		 * The vision's self-healing rule: unaware plugins, direct database
		 * writes, and legacy flows will change post_content without telling
		 * the room; the server notices, merges the external state in as an
		 * ordinary collaborative update, and connected editors simply see
		 * the change. Detection uses the co-location stamp
		 * (WP_De_RTC_Sync_Meta_Colocation writes `content_hash` on every
		 * aware save): a save whose stamp matches its own content came
		 * through the filter; anything else is out-of-band.
		 *
		 * Healing policy, in order:
		 * - Content matching canonical or ANY known version snapshot is a
		 *   stale copy, not new work — stamped as seen, never merged (this
		 *   is the guard against rolling the room back to an old copy).
		 * - An embedded base version that resolves (room snapshots first,
		 *   then the embed's own snapshots) gets a genuine three-way merge:
		 *   concurrent session work is preserved, overlapping edits park
		 *   for review like any conflicting proposal.
		 * - Otherwise the external content is WordPress's accepted post
		 *   state and the room converges TO it (fast-forward from
		 *   canonical): "operations which would otherwise wipe-out a post
		 *   appear as any other collaborative update" — prior canonical
		 *   content stays in the row history.
		 *
		 * Idempotent via the persisted `healed_hash` stamp (each external
		 * content is attempted once), and claim-guarded like every other
		 * version advancement.
		 *
		 * @since 0.5.0
		 *
		 * @param string $room  Room identifier.
		 * @param array  $state Loaded room state.
		 * @return array Possibly-healed room state.
		 */
		private function maybe_heal_external_save( string $room, array $state ): array {
			$parsed_room = class_exists( 'WP_Sync_Config' ) ? WP_Sync_Config::parse_room( $room ) : null;
			if ( null === $parsed_room || 'postType' !== $parsed_room['entity_kind'] || empty( $parsed_room['object_id'] ) ) {
				return $state;
			}
			$post = get_post( (int) $parsed_room['object_id'] );
			if ( ! $post instanceof WP_Post || '' === (string) $post->post_content ) {
				return $state;
			}

			$raw           = (string) $post->post_content;
			$embedded_meta = array();
			$stripped      = null;
			$parsed        = wp_de_rtc_parse_post_content_sync_meta( $raw, array( 'allow_script_stripped_sync_meta' => true ) );
			if ( is_array( $parsed ) && is_string( $parsed['content'] ?? null ) ) {
				$stripped = $parsed['content'];
				if ( is_array( $parsed['sync_meta'] ?? null ) ) {
					$embedded_meta = $parsed['sync_meta'];
				}
			}
			if ( null === $stripped ) {
				$stripped = wp_de_rtc_canonicalize_post_content_core_block_names( $raw );
			}

			$external_hash = wp_de_rtc_hash_content( $stripped );

			// An aware save (the co-location stamp matches its content), or
			// an external content already attempted: nothing to do.
			if ( ( $embedded_meta['content_hash'] ?? null ) === $external_hash || ( $state['healed_hash'] ?? null ) === $external_hash ) {
				return $state;
			}

			// In sync, or a stale copy of a version the room knows: stamp
			// as seen so the check stays cheap, but never merge (rollback
			// guard).
			$known = wp_de_rtc_hash_content( (string) $state['content'] ) === $external_hash;
			if ( ! $known && is_array( $state['sync_meta']['version_snapshots'] ?? null ) ) {
				foreach ( $state['sync_meta']['version_snapshots'] as $snapshot ) {
					if ( is_array( $snapshot ) && ( $snapshot['content_hash'] ?? null ) === $external_hash ) {
						$known = true;
						break;
					}
				}
			}
			if ( $known ) {
				$state['healed_hash'] = $external_hash;
				$this->save_canonical( $room, $state );
				return $state;
			}

			// Genuinely new out-of-band content. Resolve the best base.
			$base         = null;
			$base_version = is_string( $embedded_meta['room_version'] ?? null ) ? $embedded_meta['room_version'] : null;
			if ( null !== $base_version ) {
				$base = $this->resolve_base_content( $state, $base_version );
				if ( null === $base && is_array( $embedded_meta['version_snapshots'][ $base_version ] ?? null ) ) {
					// The room aged the base out, but the writer carried a
					// copy of it (co-location pays off): use theirs.
					$carried = $embedded_meta['version_snapshots'][ $base_version ];
					if ( 'base64' === ( $carried['encoding'] ?? null ) && is_string( $carried['content_base64'] ?? null ) ) {
						// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- Strict-mode decode of a hash-verified content snapshot carried in sync meta.
						$decoded = base64_decode( $carried['content_base64'], true );
						if ( is_string( $decoded ) && wp_de_rtc_hash_content( $decoded ) === ( $carried['content_hash'] ?? null ) ) {
							$base = $decoded;
						}
					}
				}
			}
			if ( null === $base && null !== $base_version ) {
				// Last resort before replacement semantics: mine revisions
				// (they carry embedded sync-meta since co-location).
				$base = $this->resolve_base_from_revisions( $room, $base_version );
			}
			$replacement = null === $base;
			if ( $replacement ) {
				// No usable lineage: WordPress accepted this as post state,
				// so the room converges to it (fast-forward).
				$base = (string) $state['content'];
			}

			// The external copy carries no identity: line it up with the
			// base by path so untouched blocks compare equal (see ingest).
			if ( class_exists( 'WP_De_RTC_Block_Identity' ) ) {
				$stripped = WP_De_RTC_Block_Identity::adopt( $stripped, $base );
			}

			$external_proposal = array(
				'proposalId'      => 'external-' . substr( $external_hash, 0, 12 ),
				'baseVersion'     => null !== $base_version ? $base_version : $state['version'],
				'proposedContent' => $stripped,
				'clientUpdate'    => null,
			);
			$review            = null;

			for ( $attempt = 0; $attempt < 3; $attempt++ ) {
				// Identity first (nested edits land block-for-block), the
				// positional core when identity declines — as at ingest.
				$heal_identity_parked = 0;
				$result               = $this->merge_by_identity( $room, self::SERVER_CLIENT_ID, $external_proposal, $base, (string) $state['content'], $stripped, $review, $heal_identity_parked );
				if ( null === $result ) {
					$result = wp_de_rtc_get_automerge_retry_save_result( $base, (string) $state['content'], $stripped, null );
				}

				if ( is_wp_error( $result ) ) {
					if ( 'de_rtc_rebase_failed' === $result->get_error_code() ) {
						// The external edit collides with concurrent session
						// work. Try per-block salvage first (the clean part
						// of the external edit lands; only the collision
						// parks) — then fall back to parking it whole.
						if ( null === $review ) {
							$review = $this->load_review_ledger( $room );
						}
						$heal_salvage_parked = 0;
						$salvaged            = $this->salvage_conflicting_blocks( $room, self::SERVER_CLIENT_ID, $external_proposal, $base, (string) $state['content'], $stripped, $review, $heal_salvage_parked );
						if ( null !== $salvaged && $salvaged !== $stripped ) {
							$stripped = $salvaged;
							continue; // Re-merge the salvaged external content.
						}
						$this->park_proposal(
							$room,
							self::SERVER_CLIENT_ID,
							$external_proposal,
							'manual-conflict-required',
							$base,
							$review
						);
						// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
						do_action( 'qm/debug', "wp-sync: de-rtc parked a conflicting external save for {$room}" );
					}
					$state['healed_hash'] = $external_hash;
					$this->save_canonical( $room, $state );
					return $state;
				}

				if ( ! $this->claim_version( $room, (int) $state['version_seq'] ) ) {
					// Lost to a concurrent commit; a later request retries
					// the healing (healed_hash is deliberately NOT stamped).
					++$this->claim_retries;
					continue;
				}

				$next_seq     = (int) $state['version_seq'] + 1;
				$next_version = 'v' . $next_seq;
				$merged       = (string) $result['merged_content'];
				// An out-of-band writer never carries identity: stamp the
				// blocks it introduced as they become canonical.
				if ( class_exists( 'WP_De_RTC_Block_Identity' ) ) {
					$merged = WP_De_RTC_Block_Identity::stamp_creations( $merged );
				}

				$state['sync_meta'] = wp_de_rtc_update_automerge_version_snapshots(
					is_array( $state['sync_meta'] ) ? $state['sync_meta'] : array(),
					$state['version'],
					$state['content'],
					$next_version,
					$merged
				);

				// Meta first, row second (the announce model's write order;
				// see ingest_proposal).
				$pre_heal             = $state;
				$prev_version         = $state['version'];
				$state['version']     = $next_version;
				$state['version_seq'] = $next_seq;
				$state['content']     = $merged;
				$state['healed_hash'] = $external_hash;
				$this->record_properties_snapshot( $state, $next_version );
				if ( ! $this->save_canonical( $room, $state, true ) ) {
					// The chained write could not land: skip healing this
					// pass (idempotent — healed_hash was not stamped, so a
					// later room load retries from clean state).
					return $pre_heal;
				}

				$this->add_row(
					$room,
					self::SERVER_CLIENT_ID,
					self::UPDATE_TYPE_ANNOUNCE,
					wp_json_encode(
						array(
							'version'        => $next_version,
							'baseVersion'    => $prev_version,
							'contentHash'    => wp_de_rtc_hash_content( $merged ),
							'properties'     => $state['properties'] ?? array(),
							'authorClientId' => self::SERVER_CLIENT_ID,
							'author'         => get_current_user_id(),
							'proposalId'     => 'external-' . substr( $external_hash, 0, 12 ),
							'healedFrom'     => $replacement ? 'external-save' : 'external-save-merged',
						)
					)
				);

				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: de-rtc healed an external save into {$room} as {$next_version}" );

				return $state;
			}

			return $state;
		}

		/**
		 * Resolves a proposal's EFFECTIVE base: the whole-document base
		 * (room snapshots, then revision mining), with per-block base
		 * substitutions when the proposal declares them.
		 *
		 * Per-block base honesty: a client that kept a locally-edited block
		 * through a colliding incorporation re-proposes from an ADVANCED
		 * whole-document base — which used to present the kept block as a
		 * clean sole-writer change and silently overwrite the peer
		 * (block-level LWW). The `blockBaseVersions` map declares each kept
		 * block's TRUE base; substituting that version's record into the
		 * base hands the three-way merge real concurrency to resolve:
		 * non-overlapping same-block edits merge, true overlaps park via
		 * salvage. A substitution that cannot be made soundly (unknown
		 * version, structural drift between the versions) is skipped —
		 * degrading to exactly the plain whole-document-base behavior,
		 * never worse.
		 *
		 * @since 0.5.0
		 *
		 * @param string $room     Room identifier.
		 * @param array  $state    Room state.
		 * @param array  $proposal Decoded proposal payload.
		 * @return string|null Effective base content, or null when the
		 *                     whole-document base is unresolvable.
		 */
		private function resolve_effective_base( string $room, array $state, array $proposal ): ?string {
			$base_content = $this->resolve_base_content( $state, $proposal['baseVersion'] );
			if ( null === $base_content ) {
				$base_content = $this->resolve_base_from_revisions( $room, (string) $proposal['baseVersion'] );
			}
			if ( null === $base_content ) {
				return null;
			}

			$block_bases = $proposal['blockBaseVersions'] ?? null;
			if ( ! is_array( $block_bases ) || array() === $block_bases ) {
				return $base_content;
			}

			/*
			 * By identity first: a key is either a top-level index of the
			 * proposal (the block's id is read off the proposed content) or
			 * a syncId outright, and the block's true-base form replaces it
			 * in the base wherever the block sits — so a kept block inside
			 * a container declares its base as honestly as a top-level one.
			 * Entries identity cannot place fall through to the positional
			 * rule below.
			 */
			$positional = array();
			foreach ( $block_bases as $key => $block_version ) {
				if ( ! is_string( $block_version ) || '' === $block_version ) {
					continue;
				}
				$sync_id = null;
				if ( class_exists( 'WP_De_RTC_Identity_Merge' ) ) {
					$sync_id = is_numeric( $key )
						? WP_De_RTC_Identity_Merge::top_level_id_at( (string) $proposal['proposedContent'], (int) $key )
						: (string) $key;
				}
				$block_base = $this->resolve_base_content( $state, $block_version );
				if ( null === $block_base ) {
					$block_base = $this->resolve_base_from_revisions( $room, $block_version );
				}
				if ( null === $block_base ) {
					continue;
				}
				$substituted = null !== $sync_id ? WP_De_RTC_Identity_Merge::substitute( $base_content, $sync_id, $block_base ) : null;
				if ( is_string( $substituted ) ) {
					$base_content = $substituted;
					continue;
				}
				if ( is_numeric( $key ) ) {
					$positional[ (int) $key ] = $block_base;
				}
			}
			if ( array() === $positional ) {
				return $base_content;
			}

			$records = wp_de_rtc_get_top_level_serialized_block_records( $base_content );
			if ( is_wp_error( $records ) ) {
				return $base_content;
			}

			$changed = false;
			foreach ( $positional as $index => $block_base ) {
				if ( ! isset( $records[ $index ] ) ) {
					continue;
				}
				$block_records = wp_de_rtc_get_top_level_serialized_block_records( $block_base );
				if ( is_wp_error( $block_records ) || count( $block_records ) !== count( $records ) || ! isset( $block_records[ $index ] ) ) {
					continue; // Structural drift: positional substitution would lie.
				}
				if ( $block_records[ $index ] !== $records[ $index ] ) {
					$records[ $index ] = $block_records[ $index ];
					$changed           = true;
				}
			}

			return $changed ? implode( "\n\n", $records ) : $base_content;
		}

		/**
		 * Resolves an aged-out base version from the post's revisions.
		 *
		 * Revisions carry the embedded sync-meta every aware save writes
		 * (WP_De_RTC_Sync_Meta_Colocation), and each embed holds its own
		 * bounded snapshot window — so a base the ROOM trimmed is often
		 * still recoverable from the revision written closest to it. This
		 * is the vision's "look for recent copies … in post revisions"
		 * lane, and what lets arbitrarily long offline editing recombine
		 * instead of voiding `unknown-base-version`.
		 *
		 * Two sources per revision, newest first: a snapshot of the wanted
		 * version inside the embed (hash-verified), or the revision's own
		 * stripped content when the embed says that IS the wanted version.
		 *
		 * @since 0.5.0
		 *
		 * @param string $room         Room identifier.
		 * @param string $base_version Wanted version label.
		 * @return string|null Base content, or null when no revision holds it.
		 */
		private function resolve_base_from_revisions( string $room, string $base_version ): ?string {
			if ( '' === $base_version ) {
				return null;
			}
			if ( array_key_exists( $room . '|' . $base_version, $this->revision_base_cache ) ) {
				return $this->revision_base_cache[ $room . '|' . $base_version ];
			}

			$resolved    = null;
			$parsed_room = class_exists( 'WP_Sync_Config' ) ? WP_Sync_Config::parse_room( $room ) : null;
			if ( null !== $parsed_room && 'postType' === $parsed_room['entity_kind'] && ! empty( $parsed_room['object_id'] ) ) {
				$revisions = wp_get_post_revisions(
					(int) $parsed_room['object_id'],
					array(
						'posts_per_page' => 30,
						'fields'         => 'ids',
					)
				);
				foreach ( $revisions as $revision_id ) {
					$revision = get_post( $revision_id );
					if ( ! $revision instanceof WP_Post || false === strpos( (string) $revision->post_content, 'data-wp-sync-meta' ) ) {
						continue;
					}
					$parsed = wp_de_rtc_parse_post_content_sync_meta( (string) $revision->post_content, array( 'allow_script_stripped_sync_meta' => true ) );
					if ( ! is_array( $parsed ) || ! is_array( $parsed['sync_meta'] ?? null ) ) {
						continue;
					}
					$meta = $parsed['sync_meta'];

					$snapshot = $meta['version_snapshots'][ $base_version ] ?? null;
					if ( is_array( $snapshot ) && 'base64' === ( $snapshot['encoding'] ?? null ) && is_string( $snapshot['content_base64'] ?? null ) ) {
						// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- Strict-mode decode of a hash-verified content snapshot carried in a revision's sync meta.
						$decoded = base64_decode( $snapshot['content_base64'], true );
						if ( is_string( $decoded ) && wp_de_rtc_hash_content( $decoded ) === ( $snapshot['content_hash'] ?? null ) ) {
							$resolved = $decoded;
							break;
						}
					}

					if (
						( $meta['room_version'] ?? null ) === $base_version &&
						is_string( $parsed['content'] ?? null ) &&
						wp_de_rtc_hash_content( $parsed['content'] ) === ( $meta['content_hash'] ?? null )
					) {
						$resolved = $parsed['content'];
						break;
					}
				}
			}

			$this->revision_base_cache[ $room . '|' . $base_version ] = $resolved;

			if ( null !== $resolved ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: de-rtc resolved aged-out base {$base_version} for {$room} from a revision" );
			}

			return $resolved;
		}

		/**
		 * Builds and stores the room's genesis snapshot from post content.
		 *
		 * Deterministic: derived purely from the saved post, so racing
		 * initializers append byte-identical rows that replay idempotently.
		 * A sync-meta block left in post_content by an upstream DE-RTC
		 * install is adopted (version lineage continues) and stripped from
		 * the canonical content.
		 *
		 * @since 0.3.0
		 *
		 * @param string $room Room identifier.
		 * @return array|WP_Error Room state or error.
		 */
		private function initialize_room( string $room ) {
			$content    = '';
			$sync_meta  = array();
			$properties = array();
			$post_id    = 0;
			$parsed     = class_exists( 'WP_Sync_Config' ) ? WP_Sync_Config::parse_room( $room ) : null;
			if ( null !== $parsed && 'postType' === $parsed['entity_kind'] && ! empty( $parsed['object_id'] ) ) {
				$post = get_post( (int) $parsed['object_id'] );
				if ( $post instanceof WP_Post ) {
					$post_id = (int) $post->ID;
					$content = (string) $post->post_content;
					// The shared REST-shaped seed every field-syncing engine
					// uses (scalars, taxonomies by rest_base, meta.<key>) —
					// deterministic, so racing initializers stay idempotent.
					if ( class_exists( 'WP_Sync_Post_Genesis_Props' ) ) {
						$properties = WP_Sync_Post_Genesis_Props::for_post( $post );
					}
				}
			}

			if ( '' !== $content ) {
				$stripped = wp_de_rtc_parse_post_content_sync_meta( $content, array( 'allow_script_stripped_sync_meta' => true ) );
				if ( is_array( $stripped ) && is_string( $stripped['content'] ?? null ) ) {
					$content = $stripped['content'];
					if ( is_array( $stripped['sync_meta'] ?? null ) ) {
						$sync_meta = $stripped['sync_meta'];
					}
				} else {
					$content = wp_de_rtc_canonicalize_post_content_core_block_names( $content );
				}
			}

			/*
			 * Resume the version lineage when the adopted sync-meta carries
			 * it (the co-location lane stamps room_version/room_version_seq
			 * into every saved post — see WP_De_RTC_Sync_Meta_Colocation).
			 * A room rebuilt after a reset then continues at the version its
			 * clients and revisions already reference instead of restarting
			 * at v1 with colliding labels.
			 */
			$version     = 'v1';
			$version_seq = 1;
			$adopted_seq = isset( $sync_meta['room_version_seq'] ) ? (int) $sync_meta['room_version_seq'] : 0;
			if ( $adopted_seq >= 1 && ( 'v' . $adopted_seq ) === ( $sync_meta['room_version'] ?? null ) ) {
				$version     = 'v' . $adopted_seq;
				$version_seq = $adopted_seq;
			}

			/*
			 * Remember the content used to create the room. This prevents
			 * the external-save check from treating an unchanged post as a
			 * new change after older snapshots expire. Hashed BEFORE identity
			 * stamping: the check compares against the post_content WordPress
			 * holds, which is the unstamped form until the first aware save.
			 */
			$healed_hash = wp_de_rtc_hash_content( $content );

			/*
			 * Durable block identity: every block of the saved post gets its
			 * deterministic genesis syncId (postId, 0, path) — the same ids
			 * the editor-side stamper derives for a pristine load, so a tab
			 * that stamped before the snapshot arrived already agrees with
			 * the room. Deterministic, so racing initializers stay
			 * idempotent (see WP_De_RTC_Block_Identity).
			 */
			if ( class_exists( 'WP_De_RTC_Block_Identity' ) ) {
				$content = WP_De_RTC_Block_Identity::stamp_genesis( $content, $post_id );
			}

			$state = array(
				'version'               => $version,
				'version_seq'           => $version_seq,
				'content'               => $content,
				'sync_meta'             => wp_de_rtc_update_automerge_version_snapshots( $sync_meta, $version, $content ),
				'properties'            => $properties,
				'properties_by_version' => array( $version => $properties ),
				'healed_hash'           => $healed_hash,
			);

			$stored = $this->add_row(
				$room,
				self::SERVER_CLIENT_ID,
				self::UPDATE_TYPE_SNAPSHOT,
				wp_json_encode(
					array(
						'version'    => $version,
						'content'    => $content,
						'properties' => $properties,
					)
				)
			);
			if ( ! $stored ) {
				return new WP_Error(
					'rest_sync_storage_error',
					__( 'Failed to store the room genesis snapshot.', 'gutenberg' ),
					array( 'status' => 500 )
				);
			}

			// The genesis row is the room's first stored row: stamp lineage.
			$this->storage->set_room_engine( $room, $this->get_slug() );

			/*
			 * Re-seed the version claim to genesis. Genesis only runs when
			 * the room is empty, which is exactly when a leftover claim row
			 * (from a room reset / engine flip) must not outlive the state
			 * it described. Racing initializers write the same seq —
			 * idempotent, like the genesis row itself.
			 */
			WP_Sync_Atomic_Option::reset( $this->version_claim_name( $room ), $version_seq . ':' . sprintf( '%.6F', microtime( true ) ) );

			// Genesis re-seeds the canonical chain unconditionally, like the
			// claim: a stale chain row must not outlive a room reset.
			$this->canonical_reset( $room, $state );

			return $state;
		}

		/**
		 * Persists the canonical state with the cursor it reflects.
		 *
		 * @since 0.3.0
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room    Room identifier.
		 * @param array  $state   Room state.
		 * @param bool   $advance Whether this write extends the canonical
		 *                        chain to a newly claimed version (chained
		 *                        CAS) rather than overwriting in place.
		 * @return bool Whether the store now reflects at least this state.
		 */
		private function save_canonical( string $room, array $state, bool $advance = false ): bool {
			$seq   = (int) $state['version_seq'];
			$value = $seq . '|' . wp_json_encode( $this->canonical_payload( $room, $state ) );

			if ( ! $advance ) {
				/*
				 * Maintenance write (checkpoint cursor bump, healed-hash
				 * stamp): same-sequence overwrite. A newer canonical having
				 * landed makes this write obsolete, not failed.
				 */
				if ( WP_Sync_Atomic_Option::swap_prefixed( $this->canonical_option_name( $room ), $seq . '|', $value ) ) {
					$this->room_states[ $room ] = $state;
					return true;
				}
				$current = self::canonical_seq_of( WP_Sync_Atomic_Option::read( $this->canonical_option_name( $room ) ) );
				return null !== $current && $current > $seq;
			}

			/*
			 * Advance write: the CHAINED CAS that makes canonical
			 * persistence ordered. The version claim allocates
			 * sequence numbers, but claims cannot order the persistence
			 * itself — writer N's meta landing AFTER writer N+1's would
			 * silently regress canonical, and under the announce model rows
			 * carry no content to repair from (the wire-inspected soak
			 * caught exactly this as unknown-base-version death spirals).
			 * Each writer expects its PREDECESSOR's sequence prefix, so a
			 * write can only ever extend the chain; a writer whose
			 * predecessor has not persisted yet spins briefly (that write
			 * is another request's in-flight UPDATE, milliseconds away) and
			 * gives up retryably if it never lands (a crashed predecessor —
			 * the claim TTL then heals the room, and this writer's version
			 * was never announced or acked).
			 */
			$expected = ( $seq - 1 ) . '|';
			for ( $attempt = 0; $attempt < 40; $attempt++ ) {
				if ( WP_Sync_Atomic_Option::swap_prefixed( $this->canonical_option_name( $room ), $expected, $value ) ) {
					$this->room_states[ $room ] = $state;
					return true;
				}
				$current = self::canonical_seq_of( WP_Sync_Atomic_Option::read( $this->canonical_option_name( $room ) ) );
				if ( null !== $current && $current >= $seq ) {
					// The chain moved past us without us: impossible unless
					// state was rebuilt (reset) — never overwrite forward.
					return false;
				}
				usleep( 25000 );
			}

			return false;
		}

		/**
		 * The canonical payload persisted per room (the announce model's
		 * single content store).
		 *
		 * @since 0.6.0
		 *
		 * @param string $room  Room identifier.
		 * @param array  $state Room state.
		 * @return array Payload.
		 */
		private function canonical_payload( string $room, array $state ): array {
			global $wpdb;
			$cursor = isset( $wpdb ) ? (int) $wpdb->insert_id : 0;
			if ( $cursor <= 0 ) {
				$cursor = $this->storage->get_cursor( $room );
			}
			return array(
				'version'               => $state['version'],
				'version_seq'           => (int) $state['version_seq'],
				'content'               => $state['content'],
				'sync_meta'             => $state['sync_meta'],
				'properties'            => $state['properties'] ?? array(),
				'properties_by_version' => $state['properties_by_version'] ?? array(),
				'healed_hash'           => is_string( $state['healed_hash'] ?? null ) ? $state['healed_hash'] : null,
				'cursor'                => $cursor,
			);
		}

		/**
		 * Unconditionally re-seeds the canonical row (room genesis after a
		 * reset — the claim-reset counterpart).
		 *
		 * @since 0.6.0
		 *
		 * @param string $room  Room identifier.
		 * @param array  $state Genesis state.
		 * @return void
		 */
		private function canonical_reset( string $room, array $state ): void {
			$this->room_states[ $room ] = $state;
			WP_Sync_Atomic_Option::reset(
				$this->canonical_option_name( $room ),
				(int) $state['version_seq'] . '|' . wp_json_encode( $this->canonical_payload( $room, $state ) )
			);
		}

		/**
		 * The canonical-state option row for a room.
		 *
		 * @since 0.6.0
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room Room identifier.
		 * @return string Option name.
		 */
		/**
		 * Forgets a room's out-of-row state — the canonical chain and the
		 * version-claim options rows — after the room's rows were reset.
		 *
		 * The storage's `reset_room()` wipes rows, lineage and room meta, but
		 * this engine keeps its canonical document in an options row and
		 * `load_room()` treats that row as "the room exists": without this,
		 * a reset room resumed from its stale canonical and never ran genesis
		 * again (a reloading tab was served nothing). Hooked to the presence
		 * lane's `gutenberg_sync_engines_room_reset` action.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room Room identifier.
		 * @return void
		 */
		public static function forget_room_state( string $room ): void {
			global $wpdb;
			delete_option( $wpdb->prefix . 'sync_de_rtc_canonical_' . md5( $room ) );
			delete_option( $wpdb->prefix . 'sync_de_rtc_claim_' . md5( $room ) );
		}

		/**
		 * The options row holding a room's canonical chain.
		 *
		 * @since 0.0.1
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room Room identifier.
		 * @return string Option name.
		 */
		private function canonical_option_name( string $room ): string {
			global $wpdb;

			return $wpdb->prefix . 'sync_de_rtc_canonical_' . md5( $room );
		}

		/**
		 * Parses the sequence prefix of a stored canonical value.
		 *
		 * @since 0.6.0
		 *
		 * @param string|null $value Stored `<seq>|<json>` value.
		 * @return int|null Sequence, or null when unparseable.
		 */
		private static function canonical_seq_of( ?string $value ): ?int {
			if ( ! is_string( $value ) ) {
				return null;
			}
			$separator = strpos( $value, '|' );
			if ( false === $separator ) {
				return null;
			}
			return (int) substr( $value, 0, $separator );
		}

		/**
		 * Decodes a stored canonical value into room state (+ cursor).
		 *
		 * @since 0.6.0
		 *
		 * @param string|null $value Stored `<seq>|<json>` value.
		 * @return array|null array( state..., 'cursor' ) or null.
		 */
		private static function decode_canonical( ?string $value ): ?array {
			if ( ! is_string( $value ) ) {
				return null;
			}
			$separator = strpos( $value, '|' );
			if ( false === $separator ) {
				return null;
			}
			$decoded = json_decode( substr( $value, $separator + 1 ), true );
			return is_array( $decoded ) ? $decoded : null;
		}

		/**
		 * Appends a compaction checkpoint and trims history behind the
		 * previous one (the shared retention invariant: rows from the
		 * previous checkpoint onward are always kept).
		 *
		 * @since 0.3.0
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room  Room identifier.
		 * @param array  $state Room state at the head.
		 * @return bool Whether a checkpoint was appended.
		 */
		private function maybe_checkpoint( string $room, array $state ): bool {
			if ( ! method_exists( $this->storage, 'get_room_meta' ) || ! method_exists( $this->storage, 'set_room_meta' ) ) {
				return false;
			}

			/**
			 * Filters the de-rtc checkpoint interval: a compaction checkpoint
			 * is appended once this many rows accumulate past the previous one.
			 *
			 * @since 0.3.0
			 *
			 * @param int    $interval Interval in stored rows.
			 * @param string $room     Room identifier.
			 */
			$interval = (int) apply_filters( 'wp_sync_de_rtc_checkpoint_interval', 100, $room );
			if ( $interval < 1 || $this->storage->get_update_count( $room ) < $interval ) {
				return false;
			}

			$previous    = $this->storage->get_room_meta( $room, self::META_CHECKPOINT );
			$prev_cursor = is_array( $previous ) && isset( $previous['cursor'] ) ? (int) $previous['cursor'] : 0;
			$window      = count( $this->storage->get_updates_after_cursor( $room, $prev_cursor ) );
			if ( $window < $interval ) {
				return false;
			}

			/*
			 * Without an ingest lock, concurrent requests can both reach
			 * here; a zero-wait try-lock elects one checkpointer and the
			 * rest skip (best-effort — the next request past the interval
			 * re-triggers).
			 */
			$lock_name  = $this->version_claim_name( $room ) . '_ckpt';
			$lock_token = WP_Sync_Room_Lock::acquire( $lock_name, 0.0 );
			if ( is_wp_error( $lock_token ) ) {
				return false;
			}
			$checkpointed = $this->perform_checkpoint( $room, $state, $previous, $prev_cursor );
			WP_Sync_Room_Lock::release( $lock_name, $lock_token );

			return $checkpointed;
		}

		/**
		 * The body of maybe_checkpoint(), run by the elected checkpointer.
		 *
		 * @since 0.5.0
		 *
		 * @param string $room        Room identifier.
		 * @param array  $state       Room state at the head.
		 * @param mixed  $previous    Previous checkpoint meta.
		 * @param int    $prev_cursor Previous checkpoint cursor.
		 * @return bool Whether a checkpoint was appended.
		 */
		private function perform_checkpoint( string $room, array $state, $previous, int $prev_cursor ): bool {
			/*
			 * UNRESOLVED parked proposals below the future trim floor survive
			 * by re-appending them above the previous checkpoint; resolved
			 * pairs age out with the trim (the intent-log retention rule —
			 * escalated work parked for review must survive compaction).
			 * Rows do not expose their cursor, so the previous checkpoint row
			 * is identified by the checkpointId it was stamped with.
			 */
			$prev_checkpoint_id = is_array( $previous ) ? (int) ( $previous['id'] ?? 0 ) : 0;
			if ( $prev_cursor > 0 ) {
				$rows           = $this->storage->get_updates_after_cursor( $room, 0 );
				$resolved_ids   = array();
				$below          = array();
				$found_previous = false;
				foreach ( $rows as $row ) {
					if ( self::UPDATE_TYPE_RESOLVED !== $row['type'] ) {
						continue;
					}
					$decoded = json_decode( (string) $row['data'], true );
					if ( is_array( $decoded ) && isset( $decoded['proposalId'] ) ) {
						$resolved_ids[ $decoded['proposalId'] ] = true;
					}
				}
				foreach ( $rows as $row ) {
					$decoded = json_decode( (string) $row['data'], true );
					if ( ! is_array( $decoded ) ) {
						continue;
					}
					if (
						self::UPDATE_TYPE_SNAPSHOT === $row['type'] &&
						! empty( $decoded['checkpoint'] ) &&
						(int) ( $decoded['checkpointId'] ?? -1 ) === $prev_checkpoint_id
					) {
						$found_previous = true;
						break;
					}
					if (
						self::UPDATE_TYPE_PARKED === $row['type'] &&
						is_string( $decoded['proposalId'] ?? null ) &&
						! isset( $resolved_ids[ $decoded['proposalId'] ] )
					) {
						$below[] = array(
							'client_id' => (int) ( $row['client_id'] ?? 0 ),
							'decoded'   => $decoded,
						);
					}
				}
				if ( $found_previous ) {
					foreach ( $below as $parked ) {
						$this->add_row( $room, $parked['client_id'], self::UPDATE_TYPE_PARKED, wp_json_encode( $parked['decoded'] ) );
					}
				}
			}

			$checkpoint_id = $prev_checkpoint_id + 1;
			$stored        = $this->add_row(
				$room,
				self::SERVER_CLIENT_ID,
				self::UPDATE_TYPE_SNAPSHOT,
				wp_json_encode(
					array(
						'version'      => $state['version'],
						'content'      => $state['content'],
						'properties'   => $state['properties'] ?? array(),
						'checkpoint'   => true,
						'checkpointId' => $checkpoint_id,
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
			$this->storage->set_room_meta(
				$room,
				self::META_CHECKPOINT,
				array(
					'cursor' => $cursor,
					'id'     => $checkpoint_id,
				)
			);
			// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
			do_action( 'qm/debug', "wp-sync: de-rtc checkpoint at {$state['version']} for {$room}" );

			if ( $prev_cursor > 0 ) {
				$this->storage->remove_updates_before_cursor( $room, $prev_cursor );
				$this->storage->set_room_meta( $room, self::META_FLOOR, $prev_cursor );
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: de-rtc trimmed history below cursor {$prev_cursor} for {$room}" );
			}

			return true;
		}

		/**
		 * Seconds after which an uncommitted version claim is treated as
		 * orphaned (its writer died between claim and row append).
		 */
		const CLAIM_TTL_SECONDS = 15;

		/**
		 * Atomically claims advancement of the canonical version.
		 *
		 * The claim row (an options-table compare-and-swap; see
		 * WP_Sync_Atomic_Option) holds `<seq>:<time>`. A successful swap
		 * from the seq this request merged against to seq+1 makes this
		 * request the sole writer of version v(seq+1) — upstream DE-RTC's
		 * optimistic validate-and-retry model, not a lock.
		 *
		 * Healing, both directions: a claim row BEHIND storage (restored
		 * backup, lost row) is swapped forward from whatever it holds; a
		 * claim row one AHEAD of storage whose writer never committed is
		 * taken over once it is older than CLAIM_TTL_SECONDS. Both repairs
		 * are CAS-guarded, so two rescuers cannot both win.
		 *
		 * @since 0.5.0
		 *
		 * @param string $room        Room identifier.
		 * @param int    $current_seq Version seq this request merged against.
		 * @return bool Whether this request now owns v(current_seq + 1).
		 */
		private function claim_version( string $room, int $current_seq ): bool {
			$name = $this->version_claim_name( $room );
			$next = ( $current_seq + 1 ) . ':' . sprintf( '%.6F', microtime( true ) );

			$existing = WP_Sync_Atomic_Option::read( $name );
			if ( null === $existing ) {
				// No claim row (removed out of band): swap() seeds it at
				// the current seq atomically, then performs the swap.
				return WP_Sync_Atomic_Option::swap( $name, $current_seq . ':0', $next );
			}

			$parts        = explode( ':', $existing, 2 );
			$claimed_seq  = (int) $parts[0];
			$claimed_time = isset( $parts[1] ) ? (float) $parts[1] : 0.0;

			if ( $claimed_seq <= $current_seq ) {
				// Normal claim (equal), or a claim row behind storage (heal
				// forward from whatever it holds).
				return WP_Sync_Atomic_Option::swap( $name, $existing, $next );
			}

			if ( $claimed_seq === $current_seq + 1 && microtime( true ) - $claimed_time > self::CLAIM_TTL_SECONDS ) {
				// Orphaned claim: claimed, never committed a row, expired.
				return WP_Sync_Atomic_Option::swap( $name, $existing, $next );
			}

			return false;
		}

		/**
		 * The claim option name for a room, table-prefixed for isolation
		 * and hashed to a bounded length.
		 *
		 * @since 0.5.0
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room Room identifier.
		 * @return string Option name.
		 */
		private function version_claim_name( string $room ): string {
			global $wpdb;

			return $wpdb->prefix . 'sync_de_rtc_claim_' . md5( $room );
		}

		/**
		 * Stores one typed row.
		 *
		 * @since 0.3.0
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Attributed client id.
		 * @param string $type      Update type.
		 * @param string $data      Update payload.
		 * @return bool Whether the row was stored.
		 */
		private function add_row( string $room, int $client_id, string $type, string $data ): bool {
			return (bool) $this->storage->add_update(
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
