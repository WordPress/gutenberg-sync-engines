/**
 * External dependencies
 */
import { Awareness } from 'y-protocols/awareness';

/**
 * Internal dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type {
	EngineDisposition,
	EngineLocalUpdateListener,
	EngineSessionCodec,
	EngineUpdate,
} from '@wordpress/sync';
import { applyServerAwarenessStates } from '../awareness-sync';
import { announceLocalWrite } from '../../providers/advisory/announce';
import type { TransportSessionExtensions } from '../../providers/session-extensions';
import type { DeRtcCommitAdapter } from './commit';
import { buildDeRtcClientUpdate, hashDeRtcContent } from './descriptor';
import { DE_RTC_REMOTE_ORIGIN, type DeRtcDocBridge } from './doc-bridge';
import type { DeRtcParkedProposal, DeRtcReviewState } from './review';

/**
 * Slug of the de-rtc engine. Must match WP_De_RTC_Engine::SLUG on the PHP
 * side.
 */
export const DE_RTC_ENGINE_SLUG = 'de-rtc';

/**
 * Protocol version of the de-rtc engine. Must match
 * WP_De_RTC_Engine::PROTOCOL_VERSION on the PHP side.
 */
export const DE_RTC_ENGINE_PROTOCOL = 2;

/**
 * Client-sent row type: a whole-content proposal against a named base
 * version. Matches WP_De_RTC_Engine::UPDATE_TYPE_PROPOSAL.
 */
export const DE_RTC_PROPOSAL_TYPE = 'proposal';

/**
 * Server-emitted row type: a canonical version ANNOUNCEMENT — version,
 * base version, content hash, author attribution, merged properties, NO
 * content (the transport carries advisories, not documents).
 * Matches WP_De_RTC_Engine::UPDATE_TYPE_ANNOUNCE. Receive-only.
 */
export const DE_RTC_ANNOUNCE_TYPE = 'announce';

/**
 * Client-sent row type: request the canonical content when behind
 * (payload `haveVersion`); the server answers in the same poll with one
 * synthesized snapshot row. Matches WP_De_RTC_Engine::UPDATE_TYPE_FETCH.
 */
export const DE_RTC_FETCH_TYPE = 'fetch';

/**
 * Server-emitted row type: genesis/checkpoint snapshot. Matches
 * WP_De_RTC_Engine::UPDATE_TYPE_SNAPSHOT. Receive-only.
 */
export const DE_RTC_SNAPSHOT_TYPE = 'snapshot';

/**
 * Server-emitted row type: an escalated proposal parked for review.
 * Matches WP_De_RTC_Engine::UPDATE_TYPE_PARKED. Receive-only.
 */
export const DE_RTC_PARKED_TYPE = 'parked';

/**
 * Server-emitted row type closing a parked proposal (the server stamps
 * one when a resolution POSTs to the REST review route). Matches
 * WP_De_RTC_Engine::UPDATE_TYPE_RESOLVED. Receive-only.
 */
export const DE_RTC_RESOLVED_TYPE = 'resolved';

/**
 * Options for creating a de-rtc session codec.
 */
export interface DeRtcSessionOptions {
	/**
	 * The awareness instance tracking collaborator presence. When omitted, a
	 * standalone instance is created so remote awareness states can still be
	 * applied.
	 */
	awareness?: Awareness;

	/** The shared doc bridge for the entity. */
	bridge: DeRtcDocBridge;

	/**
	 * The revert-edit undo manager's row feed: every canonical
	 * row this session decodes is published into it, own accepted
	 * proposals tagged. Optional: collections and undo-less tests skip it.
	 */
	undoFeed?: import('./revert-undo').DeRtcUndoFeed;

	/**
	 * The entity's review ledger. Parked/resolved rows feed it, and it
	 * emits resolution rows through this session's local-update lane.
	 * Optional: collection codecs and tests without a review surface
	 * simply drop review rows.
	 */
	review?: DeRtcReviewState;

	/**
	 * The commit carrier (Save/Sync inversion): when present, proposals go
	 * through the autosave endpoint instead of transport rows — the
	 * poll lane stays advisory. Absent (collections, unsupported post
	 * types, tests of the transport lane), proposals ride the transport
	 * as before.
	 */
	commit?: DeRtcCommitAdapter;
}

/*
 * How long the doc must be free of LOCAL edits before a canonical
 * snapshot may be applied to it (see the quiet gate inside the session).
 * Module-level so tests can compress the window.
 */
let burstQuietMs = 500;

/**
 * Test-only override for the typing-burst quiet window.
 *
 * @param ms Quiet window in milliseconds (0 disables the deferral).
 */
export function setDeRtcBurstQuietMsForTesting( ms: number ): void {
	burstQuietMs = ms;
}

/**
 * Creates the de-rtc engine's session codec for one entity/room.
 *
 * The wire is DE-RTC's save-centric shape mapped onto the room protocol:
 * the client sends whole-content PROPOSALS against the version it last
 * incorporated, and the server three-way-merges each one and answers
 * with an ANNOUNCE row (version + content hash, no content) plus
 * per-proposal dispositions; a client that is behind FETCHES one
 * canonical snapshot. Two rules keep the client honest without doing
 * any merging of its own:
 *
 * - ONE proposal in flight, coalesced: local edits mark the doc dirty;
 *   a proposal is built from the doc's current content only when none is
 *   pending, so a burst of typing costs one proposal per poll cycle. The
 *   base version is the version last APPLIED to the doc — a stale base is
 *   fine, that is exactly what the server's three-way merge is for.
 * - Canonical snapshots are DEFERRED while local edits are dirty or in
 *   flight: applying the server's content would overwrite edits the
 *   server has not seen yet. The newest deferred snapshot applies once
 *   the local state settles (our own unchanged proposal is confirmed by
 *   hash and needs no content at all). On a genuine conflict the server
 *   escalates: it sets the proposal aside as a parked review row (see
 *   review.ts and the framework review panel), and the canonical state
 *   wins locally once applied — a person then decides what to keep.
 *
 * @param options The doc bridge and optional awareness to wrap.
 * @return The transport-facing session codec.
 */
export function createDeRtcSessionCodec(
	options: DeRtcSessionOptions
): EngineSessionCodec &
	Pick< TransportSessionExtensions, 'onRoomRestart' > & {
		prepareForSave: () => Promise< () => void >;
		sendsWhileAlone: true;
	} {
	const { bridge, review } = options;
	const doc = bridge.doc;
	const awareness = options.awareness ?? new Awareness( doc );

	let localUpdateListener: EngineLocalUpdateListener | null = null;
	let isDocListenerAttached = false;
	let dirty = false;
	let inFlight = false;
	let inFlightProposalId: string | null = null;
	let proposalCounter = 0;
	let lastProposedContent: string | null = null;
	let lastProposedProperties: Record< string, unknown > = {};
	let pendingCanonical: {
		version: string;
		content: string;
		properties?: Record< string, unknown >;
	} | null = null;
	// Canonical content BY VERSION, as the server sent it (the doc may
	// hold kept local blocks, so its serialization is not the canonical
	// string). The descriptor builder needs the exact content
	// of the proposal's declared base version. Bounded: old versions can
	// never become a proposal base again.
	const canonicalContents = new Map< string, string >();
	const recordCanonicalContent = ( version: string, content: string ) => {
		canonicalContents.set( version, content );
		while ( canonicalContents.size > 8 ) {
			const oldest = canonicalContents.keys().next().value as string;
			canonicalContents.delete( oldest );
		}
	};

	/*
	 * Announce-model catch-up state: announcements carry no
	 * content, so the session tracks the highest announced version it
	 * has not reflected yet and fetches canonical content EAGERLY — at
	 * most one fetch in flight, so a busy room costs one canonical
	 * download per poll cycle at worst, not one per version. The
	 * existing deferral (pendingCanonical) holds a fetched snapshot
	 * that arrives mid-burst until the local state settles, so eager
	 * fetching never clobbers local edits — it just has the content
	 * READY at settle instead of adding a round trip then.
	 */
	let behindSeq = 0;
	// The behind-seq a sent fetch will cover; 0 when none is in flight.
	// Cleared when any snapshot arrives (the fetch's answer is always a
	// snapshot of the CURRENT canonical, which covers every announced
	// version at fulfillment time).
	let fetchInFlightSeq = 0;
	// An own proposal the server merged with peers' work (announce hash
	// mismatch): the fetched snapshot for it INCORPORATES (keeping
	// locally-edited blocks, raising contests) instead of applying.
	let pendingOwnMergeSeq = 0;

	const versionSeq = ( version: string | null ): number =>
		version ? parseInt( version.slice( 1 ), 10 ) || 0 : 0;
	const currentSeq = () => versionSeq( bridge.lastVersion() );

	function maybeFetch(): void {
		if (
			! localUpdateListener ||
			behindSeq <= currentSeq() ||
			// Single-flight, with a liveness backstop: a lost or unanswered
			// fetch unsticks as soon as a NEWER version is announced (the
			// wire-inspected soak caught a stuck in-flight fetch turning
			// into an unknown-base-version death spiral).
			fetchInFlightSeq >= behindSeq
		) {
			return;
		}
		fetchInFlightSeq = behindSeq;
		const data = JSON.stringify( {
			haveVersion: bridge.lastVersion() ?? '',
		} );
		localUpdateListener( { data, type: DE_RTC_FETCH_TYPE }, data.length );
	}

	function buildProposal(): EngineUpdate {
		proposalCounter += 1;
		lastProposedContent = bridge.buildContent();
		lastProposedProperties = bridge.buildProperties();
		inFlightProposalId = `p-${ doc.clientID }-${ proposalCounter }`;
		// Per-block base honesty: blocks kept through colliding
		// incorporations declare the version their text was really
		// written against, so the server merges them from THEIR base
		// instead of reading a clean sole-writer change.
		const blockBaseVersions = bridge.blockBaseVersions();
		const baseVersion = bridge.lastVersion() ?? '';
		// The block-native descriptor: TAMPER EVIDENCE the
		// server validates against the PLAIN declared base and then
		// drops (merge outcomes are identical either way — the server
		// derives the same update itself). Built only when this session
		// still holds the base version's exact canonical string; omitted
		// otherwise (the server's engine-unaware-writer lane covers
		// descriptor-less proposals).
		const baseContent = canonicalContents.get( baseVersion );
		let clientUpdate = null;
		if ( undefined !== baseContent && null !== lastProposedContent ) {
			try {
				clientUpdate = buildDeRtcClientUpdate(
					baseContent,
					lastProposedContent,
					`client-${ doc.clientID }`
				);
			} catch {
				clientUpdate = null; // Evidence is optional; never block the save.
			}
		}
		const payload = {
			proposalId: inFlightProposalId,
			baseVersion,
			...( Object.keys( blockBaseVersions ).length > 0
				? { blockBaseVersions }
				: {} ),
			proposedContent: lastProposedContent,
			// The FULL property map every time (save-centric, like the
			// content): the server three-way-diffs it against the base, so
			// unchanged properties are no-ops and an abandoned escalation
			// self-heals on the next proposal.
			proposedProperties: lastProposedProperties,
			clientUpdate,
		};
		return { data: JSON.stringify( payload ), type: DE_RTC_PROPOSAL_TYPE };
	}

	// While > 0, commits stay queued (dirty accumulates): the save lane
	// holds commits so an editor save can never race the session's own
	// in-flight commit into a self-conflict (both-changed-same-block
	// parks — found by the fuzzer the moment commits moved to REST).
	let commitsHeld = 0;

	/*
	 * The commit-cadence dial (TODO/B4): minimum spacing between commits,
	 * in milliseconds. 0 (the default) keeps the settle cycle — a commit
	 * whenever local edits settle and the slot is free (pseudo-realtime).
	 * The Distributed Editing vision's operating point is ~10 s: edits
	 * coalesce locally and the room advances at save-and-sync cadence,
	 * cutting request rate and upload bytes on cheap hosts. Read from the
	 * plugin settings the enqueue localizes; the dial changes WHEN a
	 * commit is built, never what it contains — dirty coalescing already
	 * batches everything since the last commit.
	 */
	const commitIntervalMs = ( () => {
		const settings = (
			window as Window & {
				_gutenbergSyncEnginesSettings?: {
					deRtcCommitIntervalMs?: number;
				};
			}
		 )._gutenbergSyncEnginesSettings;
		const value = Number( settings?.deRtcCommitIntervalMs ?? 0 );
		return Number.isFinite( value ) && value > 0 ? value : 0;
	} )();
	let lastCommitBuiltAt = 0;
	let cadenceTimer: ReturnType< typeof setTimeout > | null = null;

	function maybePropose(): void {
		if (
			! dirty ||
			inFlight ||
			commitsHeld > 0 ||
			// The server merged peers' work into our last proposal and the
			// catch-up snapshot has not landed: we know a newer version
			// exists but not what it contains, so bridge.lastVersion() is
			// already stale. Proposing now would declare that dead base,
			// and the server would three-way-merge our OWN just-accepted
			// keystroke as a foreign concurrent change — both sides
			// changed the block, so it parks and canonical wins. The rest
			// of a typing burst evaporated that way (e2e, slow CI hosts:
			// " from two" collapsing to " "). Queue instead: dirty holds
			// the burst until the snapshot settles it against the version
			// it was really written on top of.
			pendingOwnMergeSeq > 0 ||
			! localUpdateListener ||
			! bridge.isBootstrapped()
		) {
			return;
		}
		if ( commitIntervalMs > 0 ) {
			const wait = lastCommitBuiltAt + commitIntervalMs - Date.now();
			if ( wait > 0 ) {
				// Hold the commit to the dial's cadence; dirty keeps
				// coalescing and ONE timer re-enters at the boundary.
				if ( null === cadenceTimer ) {
					cadenceTimer = setTimeout( () => {
						cadenceTimer = null;
						maybePropose();
					}, wait );
				}
				return;
			}
		}
		lastCommitBuiltAt = Date.now();
		const update = buildProposal();
		dirty = false;
		inFlight = true;
		if ( options.commit ) {
			/*
			 * The Save/Sync inversion: the commit rides the autosave
			 * endpoint, not the transport — the poll lane stays advisory
			 * (announces, on-demand snapshots, review rows, presence).
			 * The response returns the rows this commit appended plus the
			 * dispositions, and the ordinary row machinery settles them.
			 */
			void commitThroughSave( update );
			return;
		}
		localUpdateListener( update, update.data.length );
	}

	let commitRetryTimer: ReturnType< typeof setTimeout > | null = null;
	async function commitThroughSave( update: EngineUpdate ): Promise< void > {
		try {
			const response = await options.commit!( update );
			// Rows landed through the autosave lane, which the polling manager
			// never sees: tell the peers on the advisory channel to poll.
			announceLocalWrite();
			for ( const row of response.updates ?? [] ) {
				processRow( row );
			}
			if ( response.dispositions?.length ) {
				handleDispositions( response.dispositions );
			}
		} catch {
			/*
			 * Transport failure or retryable contention (503): the edits
			 * are still in the doc — free the slot and retry shortly. A
			 * commit whose response was LOST after the server applied it
			 * re-proposes idempotently (the server merges a re-send of
			 * already-applied content as a no-op fast-forward).
			 */
			inFlight = false;
			inFlightProposalId = null;
			if ( null === commitRetryTimer ) {
				commitRetryTimer = setTimeout( () => {
					commitRetryTimer = null;
					dirty = true;
					maybePropose();
				}, 2000 );
			}
		}
	}

	function applyOrDeferCanonical(
		version: string,
		content: string,
		properties?: Record< string, unknown >
	): void {
		if ( dirty || inFlight ) {
			pendingCanonical = { version, content, properties };
			return;
		}
		bridge.applyCanonical( version, content, properties );
	}

	/*
	 * Typing-burst quiet gate: applying ANY canonical snapshot to the doc
	 * mid-burst clobbers the canvas — the framework pushes the rewritten
	 * blocks into the editor, the block under the caret remounts, and the
	 * user's REMAINING keystrokes land in a detached node and vanish (the
	 * "Second from two" -> "Second " e2e collapse; the dirty/inFlight
	 * deferral has a hole exactly one inter-keystroke gap wide, where
	 * dirty is momentarily false). Snapshots that arrive while the user
	 * typed within the last BURST_QUIET_MS are stashed (newest wins) and
	 * re-injected through processRow once the burst quiets — the same
	 * reason intent-log defers its capture-driven pushes past the burst.
	 */
	let lastLocalEditAt = 0;
	let deferredSnapshotRow: EngineUpdate | null = null;
	// Set by onRoomRestart: the next snapshot is the NEW room's genesis.
	// If the doc holds content that differs from it, that content is the
	// person's unsaved work and is re-proposed against the new genesis
	// (the server three-way-merges from that base) instead of being
	// overwritten by it.
	let restartPending = false;
	let quietRetryTimer: ReturnType< typeof setTimeout > | null = null;

	function typingQuiet(): boolean {
		return Date.now() - lastLocalEditAt >= burstQuietMs;
	}

	function scheduleQuietRetry(): void {
		if ( null !== quietRetryTimer ) {
			return;
		}
		quietRetryTimer = setTimeout( () => {
			quietRetryTimer = null;
			if ( ! typingQuiet() ) {
				scheduleQuietRetry();
				return;
			}
			const row = deferredSnapshotRow;
			deferredSnapshotRow = null;
			if ( row ) {
				processRow( row );
			}
		}, burstQuietMs );
	}

	function onDocUpdate( _update: Uint8Array, origin: unknown ): void {
		if ( DE_RTC_REMOTE_ORIGIN === origin ) {
			return;
		}
		lastLocalEditAt = Date.now();
		dirty = true;
		maybePropose();
	}

	function processRow( update: EngineUpdate ): void {
		let decoded: any;
		try {
			decoded = JSON.parse( update.data );
		} catch {
			return; // A malformed row cannot be applied; the next one resyncs.
		}

		// Review-lane rows carry no canonical content; they feed the ledger.
		if ( DE_RTC_PARKED_TYPE === update.type ) {
			if (
				'string' === typeof decoded?.proposalId &&
				'' !== decoded.proposalId &&
				'string' === typeof decoded?.reason
			) {
				review?.noteParked( {
					...decoded,
					changedBlocks: Array.isArray( decoded.changedBlocks )
						? decoded.changedBlocks
						: [],
				} as DeRtcParkedProposal );
			}
			return;
		}
		if ( DE_RTC_RESOLVED_TYPE === update.type ) {
			if ( 'string' === typeof decoded?.proposalId ) {
				review?.noteResolved( decoded.proposalId );
			}
			return;
		}

		if (
			'string' !== typeof decoded?.version ||
			( 'string' !== typeof decoded?.content &&
				// Announce rows carry a hash, never content.
				DE_RTC_ANNOUNCE_TYPE !== update.type )
		) {
			return;
		}

		const rowProperties =
			decoded.properties && 'object' === typeof decoded.properties
				? ( decoded.properties as Record< string, unknown > )
				: undefined;

		// The revert-edit undo manager derives from canonical rows: feed
		// it every snapshot (our own accepted proposals are fed from the
		// announce path, where the hash confirms them).
		if ( DE_RTC_SNAPSHOT_TYPE === update.type ) {
			// The descriptor builder's base-content ledger.
			recordCanonicalContent( decoded.version, decoded.content );
			options.undoFeed?.noteRow( {
				version: decoded.version,
				baseVersion:
					'string' === typeof decoded.baseVersion
						? decoded.baseVersion
						: null,
				content: decoded.content,
				own: false,
				...( 'number' === typeof decoded.author
					? { author: decoded.author }
					: {} ),
				...( 'number' === typeof decoded.authorClientId
					? { authorClientId: decoded.authorClientId }
					: {} ),
			} );
		}

		switch ( update.type ) {
			case DE_RTC_ANNOUNCE_TYPE: {
				if ( 'string' !== typeof decoded.version ) {
					return;
				}
				const announcedSeq = versionSeq( decoded.version );
				if (
					decoded.authorClientId === doc.clientID &&
					decoded.proposalId === inFlightProposalId
				) {
					// The announcement for OUR CURRENT proposal: the slot
					// frees either way.
					inFlight = false;
					inFlightProposalId = null;
					if (
						null !== lastProposedContent &&
						'string' === typeof decoded.contentHash &&
						hashDeRtcContent( lastProposedContent ) ===
							decoded.contentHash
					) {
						// Round-tripped unchanged (canonicalized-hash
						// equality — the wire-safe twin of the old byte
						// compare; every server-side comparison
						// canonicalizes the same way): advance without any
						// content download, the announce model's win for
						// the active typist. Properties the server merged
						// from peers still incorporate (they ride the
						// announce).
						pendingCanonical = null;
						recordCanonicalContent(
							decoded.version,
							lastProposedContent
						);
						if ( rowProperties ) {
							bridge.incorporateProperties(
								rowProperties,
								lastProposedProperties
							);
						}
						options.undoFeed?.noteRow( {
							version: decoded.version,
							baseVersion:
								'string' === typeof decoded.baseVersion
									? decoded.baseVersion
									: null,
							content: lastProposedContent,
							own: true,
							...( 'number' === typeof decoded.author
								? { author: decoded.author }
								: {} ),
							authorClientId: doc.clientID,
						} );
						bridge.advanceVersion( decoded.version );
						if ( announcedSeq >= behindSeq ) {
							behindSeq = 0;
						}
						settleQueued();
						return;
					}
					// The server merged peers' work into our proposal: the
					// fetched snapshot for it must INCORPORATE (keep
					// locally-edited blocks, raise contests) rather than
					// apply wholesale.
					pendingOwnMergeSeq = announcedSeq;
				}
				if ( announcedSeq > currentSeq() && announcedSeq > behindSeq ) {
					behindSeq = announcedSeq;
				}
				// Eager: the fetched content defers if we're mid-burst; it
				// must be READY at settle, not a round trip away.
				maybeFetch();
				return;
			}

			case DE_RTC_SNAPSHOT_TYPE: {
				if ( restartPending ) {
					restartPending = false;
					const localContent = bridge.buildContent();
					recordCanonicalContent( decoded.version, decoded.content );
					if (
						hashDeRtcContent( localContent ) ===
						hashDeRtcContent( decoded.content )
					) {
						bridge.applyCanonical(
							decoded.version,
							decoded.content,
							rowProperties
						);
						return;
					}
					bridge.adoptVersion( decoded.version );
					dirty = true;
					maybePropose();
					return;
				}
				if ( ! typingQuiet() ) {
					// Mid-burst: stash (newest wins) and re-inject at quiet
					// (see BURST_QUIET_MS above).
					deferredSnapshotRow = update;
					scheduleQuietRetry();
					return;
				}
				const snapshotSeq = versionSeq( decoded.version );
				// The in-flight fetch is answered; anything announced since
				// re-fetches below (via settleQueued's maybeFetch tail).
				fetchInFlightSeq = 0;
				if ( snapshotSeq >= behindSeq ) {
					behindSeq = 0;
				}
				if (
					pendingOwnMergeSeq > 0 &&
					snapshotSeq >= pendingOwnMergeSeq &&
					null !== lastProposedContent &&
					bridge.incorporateCanonicalPreservingLocalEdits(
						decoded.version,
						decoded.content,
						lastProposedContent
					)
				) {
					// The catch-up for our merged proposal: adopt the
					// blocks we did not touch since proposing, keep the
					// ones we did (contested items raise as usual).
					pendingOwnMergeSeq = 0;
					pendingCanonical = null;
					if ( rowProperties ) {
						bridge.incorporateProperties(
							rowProperties,
							lastProposedProperties
						);
					}
					settleQueued();
					return;
				}
				if ( snapshotSeq >= pendingOwnMergeSeq ) {
					// The snapshot supersedes the pending merge (or the
					// incorporation could not align structurally); the
					// wholesale apply below resolves the room state either
					// way. An OLDER snapshot (a replayed genesis) keeps the
					// marker for the real catch-up.
					pendingOwnMergeSeq = 0;
				}
				applyOrDeferCanonical(
					decoded.version,
					decoded.content,
					rowProperties
				);
				if ( ! inFlight ) {
					settleQueued();
				}
			}
		}
	}

	/**
	 * Settles a disposition batch — shared by the transport lane and the
	 * commit lane (both deliver rows FIRST, dispositions after).
	 *
	 * @param dispositions Disposition batch.
	 */
	function handleDispositions( dispositions: EngineDisposition[] ): void {
		/*
		 * A voided proposal (a base that aged out of the snapshot
		 * window, a rejected descriptor) means our base is no longer
		 * mergeable: catch up NOW. Clear any stuck fetch marker and
		 * mark ourselves behind — a void frequently follows exactly
		 * the starvation that lost a fetch.
		 */
		const voided = dispositions.some(
			( disposition ) => 'voided' === disposition.status
		);
		if ( voided ) {
			fetchInFlightSeq = 0;
			behindSeq = Math.max( behindSeq, currentSeq() + 1 );
		}
		// ONLY the disposition for the CURRENT in-flight proposal
		// settles the slot: a previous proposal's disposition arrives in
		// the response that follows the one whose rows already settled
		// it, after a NEWER proposal may have gone out. Applied
		// proposals have already been (or will be) announced;
		// escalated/voided proposals are abandoned — the canonical state
		// wins locally when it applies.
		const settlesCurrent = dispositions.some(
			( disposition ) => disposition.intentId === inFlightProposalId
		);
		if ( ! settlesCurrent ) {
			if ( voided ) {
				maybeFetch();
			}
			return;
		}
		inFlight = false;
		inFlightProposalId = null;
		settleQueued();
	}

	// Newer local edits take priority when a slot frees: they must reach
	// the server before the deferred canonical applies (their base
	// predates it, and the server merges). Otherwise adopt the newest
	// deferred canonical state.
	function settleQueued(): void {
		if ( dirty ) {
			maybePropose();
			return;
		}
		if ( ! inFlight && pendingCanonical ) {
			const { version, content, properties } = pendingCanonical;
			pendingCanonical = null;
			bridge.applyCanonical( version, content, properties );
		}
		if ( ! inFlight ) {
			// Announce model: settled and still behind an announced
			// version whose content never arrived — fetch it now.
			maybeFetch();
		}
	}

	return {
		applyRemoteAwareness: ( state ) =>
			applyServerAwarenessStates(
				state,
				awareness,
				DE_RTC_REMOTE_ORIGIN
			),
		/*
		 * Exempt from the transport's solo hold: commits ride the autosave
		 * lane and the undo stack is the session's own accepted rows, so
		 * the advisory rows this codec queues (fetches, review decisions)
		 * must flow while alone too.
		 */
		sendsWhileAlone: true,
		clientId: doc.clientID,
		engineSlug: DE_RTC_ENGINE_SLUG,
		engineProtocol: DE_RTC_ENGINE_PROTOCOL,
		// The server compacts by itself (no client-side compaction), and
		// unknown-outcome recovery is answered with an idempotent
		// re-proposal of the doc's current state: if the lost send was
		// applied, the merge settles as a no-op; if it was lost, this
		// carries the same edits.
		//
		// Recovery re-proposal is TRANSPORT-LANE ONLY. A commit-lane
		// session's proposals ride the autosave endpoint, so a failed
		// poll can only have carried advisory rows (fetches, review
		// resolutions) — all idempotent, so the transport's fallback
		// (restoring the exact lost rows) is the right recovery. Offering
		// buildProposal() here instead seized the in-flight slot
		// (inFlightProposalId, lastProposedContent) from a commit riding
		// the OTHER lane: the commit's announce and disposition then
		// settled nothing, inFlight never cleared, and the session froze —
		// no further commits, no canonical applies — quietly diverging
		// from its peers (issue #39, found by the fuzzer's fault
		// injection).
		...( options.commit
			? {}
			: { createRecoveryUpdate: () => buildProposal() } ),
		destroy() {
			if ( isDocListenerAttached ) {
				doc.off( 'update', onDocUpdate );
				isDocListenerAttached = false;
			}
			if ( null !== commitRetryTimer ) {
				clearTimeout( commitRetryTimer );
				commitRetryTimer = null;
			}
			if ( null !== quietRetryTimer ) {
				clearTimeout( quietRetryTimer );
				quietRetryTimer = null;
			}
			if ( null !== cadenceTimer ) {
				clearTimeout( cadenceTimer );
				cadenceTimer = null;
			}
			deferredSnapshotRow = null;
			localUpdateListener = null;
		},
		// The server's snapshot row bootstraps a fresh client; nothing to
		// announce. Un-acked local edits surface through the dirty flag
		// once bootstrap completes.
		getInitialUpdates: () => [],
		getLocalAwareness: () => awareness.getLocalState() ?? {},
		onLocalUpdate( listener ) {
			localUpdateListener = listener;
			if ( ! isDocListenerAttached ) {
				doc.on( 'update', onDocUpdate );
				isDocListenerAttached = true;
			}
			bridge.onBootstrap( () => maybePropose() );
		},
		receiveUpdate: ( update ) => processRow( update ),
		receiveDispositions: ( dispositions: EngineDisposition[] ) =>
			handleDispositions( dispositions ),
		/*
		 * Room restart: every version this session knows is gone. Drop the
		 * lineage and every in-flight or deferred row; the new genesis
		 * that follows either matches the doc (plain apply) or is the base
		 * the doc's content is re-proposed against (see restartPending).
		 */
		onRoomRestart: () => {
			bridge.resetLineage();
			inFlight = false;
			inFlightProposalId = null;
			pendingCanonical = null;
			deferredSnapshotRow = null;
			behindSeq = 0;
			fetchInFlightSeq = 0;
			pendingOwnMergeSeq = 0;
			canonicalContents.clear();
			restartPending = true;
			return 'rebootstrap';
		},
		/**
		 * Prepares an editor SAVE: holds new commits and waits for the
		 * in-flight one to settle, so the save can never self-conflict
		 * with the session's own commit. Returns the release; the save
		 * lane calls it when its request finishes (either way).
		 *
		 * @return Release function.
		 */
		async prepareForSave(): Promise< () => void > {
			// Flush FIRST (holding would block the very settling we wait
			// for), then hold new commits for the save's duration.
			const deadline = Date.now() + 4000;
			while ( ( dirty || inFlight ) && Date.now() < deadline ) {
				maybePropose();
				await new Promise( ( resolve ) => setTimeout( resolve, 100 ) );
			}
			commitsHeld++;
			let released = false;
			const release = () => {
				if ( released ) {
					return;
				}
				released = true;
				commitsHeld--;
				maybePropose();
			};
			// A keystroke may have slipped a commit in between the last
			// check and the hold: wait that one out too.
			while ( inFlight && Date.now() < deadline ) {
				await new Promise( ( resolve ) => setTimeout( resolve, 100 ) );
			}
			return release;
		},
	};
}
