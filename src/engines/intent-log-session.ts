/**
 * Internal dependencies
 */
import {
	authorIntent,
	clientReceive,
	createClient,
	predictedDisposition,
	replanClient,
} from './intent-log/client.js';
import { serverDocAt } from './intent-log/rebase.js';
import { createIntent } from './intent-log/intents.js';
import type {
	EngineDocument,
	IntentDisposition,
	IntentEnvelope,
} from './intent-log/engine-types';
import { applyServerAwarenessStates } from './awareness-sync';
import type {
	AwarenessState,
	EngineDisposition,
	EngineSessionCodec,
	EngineLocalUpdateListener,
	EngineUpdate,
	LocalAwarenessState,
} from '@wordpress/sync';

/*
 * The intent-log engine's client half behind the transport-facing
 * EngineSessionCodec seam — the counterpart of WP_Intent_Log_Engine on the
 * server. This file lives OUTSIDE the tsc-excluded engine-core directory so
 * it is fully type-checked; the core's surface is typed by hand-written
 * declaration files (engine-types.d.ts and siblings).
 *
 * Wire protocol (see the server class for authority):
 * - receive `snapshot` → bootstrap the local replica from the genesis doc;
 * - receive `intent`   → append the server's authoritative (transformed)
 *   form to the replica's log copy, replanning pending work over it;
 * - receive `parked`   → record an escalated intent for the review lane;
 * - receive `voided`   → informational marker (the ack path settles ours);
 * - send `intent` rows authored locally, optimistically applied;
 * - `dispositions` in the poll response are the ack, delivered AFTER the
 *   same response's rows (the transport guarantees this ordering): rows
 *   already settle what they supersede — an accepted intent's
 *   authoritative form, an escalation's proposal — so the ack covers the
 *   remainder and the document never regresses mid-response.
 *
 * Sessions surface documents/dispositions/proposals through callbacks; the
 * entity bridge (Phase 2c) subscribes to them. Until then the extended
 * surface doubles as the dev/test API.
 */

/**
 * Slug of the intent-log engine. Must match WP_Intent_Log_Engine::SLUG on the
 * PHP side. Defined here (rather than in engines.ts, which re-exports it) so
 * the codec can stamp its own identity without an import cycle.
 */
export const INTENT_LOG_ENGINE_SLUG = 'intent-log';

/**
 * Protocol version of the intent-log engine. Must match
 * WP_Intent_Log_Engine::PROTOCOL_VERSION on the PHP side.
 */
export const INTENT_LOG_ENGINE_PROTOCOL = 1;

/**
 * Wire kinds, matching WP_Intent_Log_Engine::UPDATE_TYPE_*.
 */
export const INTENT_LOG_UPDATE_TYPES = {
	INTENT: 'intent',
	PARKED: 'parked',
	RESOLVED: 'resolved',
	SNAPSHOT: 'snapshot',
	VOIDED: 'voided',
	// Client-sent only, never stored: cancels still-queued intents
	// (the pre-settle undo lane).
	CANCEL: 'cancel',
} as const;

/**
 * An escalated intent parked in the proposal lane, as received. The engine
 * enriches rows with the settlement seq, a server timestamp, and a short
 * excerpt of the target field at escalation time (context for review).
 */
export interface IntentLogProposal {
	intent: IntentEnvelope;
	actorId: string;
	reason: string;
	at?: number;
	time?: number;
	context?: { excerpt?: string };
}

/** A proposal's terminal state, as received. */
export interface IntentLogResolution {
	proposalId: string;
	resolution: 'restored' | 'dismissed';
	resolvedBy?: string;
	time?: number;
}

/**
 * A settled outcome surfaced to disposition listeners, joined with the
 * planner's local prediction when one existed.
 */
export interface SettledDisposition extends EngineDisposition {
	predicted?: IntentDisposition | null;
}

export interface IntentLogSessionOptions {
	/** WordPress user id (the authenticated half of the actor id). */
	userId: number;

	/** Per-tab client id; minted when omitted. */
	clientId?: number;

	/**
	 * Presence surface (a y-protocols Awareness instance, constructed over a
	 * stub doc — see createAwarenessDoc). When provided, local awareness is
	 * read from it and server states are applied onto it, so the editor's
	 * collaborator UI works; when omitted, awareness passes through plain
	 * objects (tests, headless use).
	 */
	awareness?: import('y-protocols/awareness').Awareness;
}

/** Origin tag for awareness removals applied by this session. */
const INTENT_LOG_SESSION_ORIGIN = 'intent-log-session';

/**
 * The intent-log session: EngineSessionCodec toward the transport, plus the
 * document/intent surface the entity bridge consumes.
 */
export interface IntentLogSession extends EngineSessionCodec {
	/** The server-verifiable actor id this session authors as. */
	actorId: string;

	/**
	 * Transport capability: flush queued updates even with no collaborator
	 * present. Intent ingest is idempotent by intentId and rows are tiny,
	 * so sending while solo is safe — and it shrinks the window in which a
	 * terminal transport error can destroy unsent local work from the whole
	 * solo session down to one poll interval.
	 */

	/**
	 * Authors one intent against the optimistic document, applies it
	 * locally, and queues it for the transport. Throws before the snapshot
	 * arrives (there is no document to author against).
	 */
	author: (
		type: string,
		payload: Record< string, unknown >,
		options?: { txnId?: string }
	) => IntentEnvelope;

	/**
	 * Authors a batch of intents that were all derived against ONE document
	 * state — by default the OBSERVED state (see setObservedSeq), not the
	 * optimistic head. Every intent is stamped with that state's seq, so the
	 * planner (here and on the server) rebases it over everything that
	 * landed since; the optimistic document is recomputed once, from the
	 * plan, rather than by applying stale coordinates to the head.
	 */
	authorBatch: (
		intents: Array< { type: string; payload: Record< string, unknown > } >,
		options?: { txnId?: string; baseSeq?: number; observe?: boolean }
	) => IntentEnvelope[];

	/**
	 * Records the engine log position the consumer's own view (the editor
	 * tree) is expressed against — the seq authorBatch stamps and the floor
	 * below which the replica may not trim its log copy.
	 *
	 * The value is clamped into [firstSeq, cursor] and advanced over any
	 * contiguous run of entries this session authored itself: those are
	 * already part of the consumer's view (it is where they came from), and
	 * the one-sided transform skips same-actor priors anyway.
	 */
	setObservedSeq: ( seq: number ) => void;

	/**
	 * Pins the replica's log retention at (or below) a seq the undo stack
	 * may still derive inverses from, independent of the observed seq.
	 * `null` releases the pin. The effective retention floor is the MINIMUM
	 * of the observed seq and this pin.
	 */
	setUndoRetainSeq: ( seq: number | null ) => void;

	/**
	 * The document at an absolute log position within the retained window —
	 * the "state before/after row N" an inverse-intent derivation reads.
	 * Read-only. Null pre-snapshot or below the retained floor.
	 */
	getDocumentAt: ( seq: number ) => EngineDocument | null;

	/** The lowest absolute seq the replica's log copy is sliceable from. */
	getRetainedFloor: () => number;

	/**
	 * Subscribes to accepted rows being absorbed into the replica's log
	 * copy, with each row's absolute landing seq — the material an
	 * inverse-intent undo stack settles its units from. Fires for EVERY
	 * accepted row (own and peers').
	 */
	onAcceptedRows: (
		listener: (
			rows: Array< { seq: number; entry: IntentEnvelope } >
		) => void
	) => void;

	/** The engine log position captures are currently authored against. */
	getObservedSeq: () => number;

	/** The optimistic document (acked + pending), or null pre-snapshot. */
	getDocument: () => EngineDocument | null;

	/** Escalated intents received for this room, in arrival order. */
	getProposals: () => IntentLogProposal[];

	/**
	 * Escalated intents not yet resolved (arrival order): the review list.
	 * Reconstructs entirely from retained rows — no client persistence.
	 */
	getOpenProposals: () => IntentLogProposal[];

	/**
	 * Sends a resolution for a parked proposal. `restored` callers author
	 * the recovered content as ordinary intents FIRST — restoration is a
	 * normal edit; this only closes the proposal. Idempotent server-side.
	 */
	resolveProposal: (
		proposalId: string,
		resolution: 'restored' | 'dismissed'
	) => void;

	/** Subscribes to review-list changes (proposal arrived or resolved). */
	onProposalsChange: ( listener: () => void ) => void;

	/** Number of authored intents not yet settled by the server. */
	getPendingCount: () => number;

	/**
	 * Cancels a set of authored intents that are ALL still unacked —
	 * all-or-nothing (canceling half a unit would strand half an edit).
	 * The intents leave the outbox, the optimistic document replans (the
	 * canvas reverts through the normal change pipeline), and a `cancel`
	 * row chases any copies already queued on the wire: the server drops
	 * intents canceled within the same batch, and acks
	 * `cancel-too-late` when an intent was already ingested — in which
	 * case its accepted row resurrects the effect (nothing is ever
	 * half-lost). The pre-settle undo lane is the caller.
	 *
	 * @return Whether the cancellation was accepted locally (every id
	 *         was still pending).
	 */
	cancelPendingIntents: ( intentIds: string[] ) => boolean;

	/** The engine log position this session has observed (intent rows). */
	getSeq: () => number;

	/**
	 * Whether a horizon-reset snapshot is deferred behind un-settled
	 * local work (see deferredResetBuffer in the factory). The manager's
	 * stale-void recovery skips re-capturing while true: the reset's own
	 * recapture will re-derive everything at the new frame.
	 */
	hasDeferredReset: () => boolean;

	/** Whether the genesis snapshot has arrived. */
	isInitialized: () => boolean;

	/**
	 * The seq of the snapshot this replica (re-)bootstrapped from, or null
	 * pre-snapshot. 0 identifies the room GENESIS — a document derived from
	 * the saved post content every client parsed and rendered on load. A
	 * positive value is a compaction checkpoint, which may carry blocks a
	 * late joiner's editor has never displayed.
	 */
	getBootstrapSeq: () => number | null;

	/** Latest remote awareness states, keyed by client id. */
	getPeers: () => AwarenessState;

	/** Sets the local awareness state sent with each poll. */
	setLocalAwareness: ( state: LocalAwarenessState ) => void;

	/** Subscribes to document changes (local or remote). */
	onChange: ( listener: () => void ) => void;

	/** Subscribes to settled dispositions (the server's acks). */
	onDisposition: (
		listener: ( settled: SettledDisposition ) => void
	) => void;

	/** Subscribes to arriving proposals (escalations, any author). */
	onProposal: ( listener: ( proposal: IntentLogProposal ) => void ) => void;

	/**
	 * Subscribes to horizon resets: the server compacted history this
	 * replica never observed and re-bootstrapped it from a checkpoint.
	 * Pending unacked intents are dropped (their offsets reference trimmed
	 * history); the bridge re-derives them from the editor tree on the next
	 * capture.
	 */
	onReset: ( listener: () => void ) => void;

	/**
	 * Transport teardown hook: the transport calls this when it discards
	 * unsent updates at room unregistration (a terminal error dropped the
	 * room). The updates will never reach the server; listeners registered
	 * via onDiscard surface the loss to the user.
	 */
	onUpdatesDiscarded: ( updates: EngineUpdate[] ) => void;

	/** Subscribes to unsent-update discards (see onUpdatesDiscarded). */
	onDiscard: ( listener: ( updates: EngineUpdate[] ) => void ) => void;

	/**
	 * Transport hook: the server restarted the room (its generation
	 * changed), so every row this replica holds is gone. The replica is
	 * dropped and the reset listeners fire exactly as for a horizon reset;
	 * the fresh genesis that follows re-bootstraps it and the manager
	 * recaptures the editor's own tree against it. Always re-bootstraps:
	 * the editor tree is the durable local state, and capture re-derives
	 * unsaved work from it against any baseline.
	 */
	onRoomRestart: () => 'rebootstrap';
}

/**
 * Mints a session clientId in [1, 2^31 - 1], a positive signed 32-bit
 * integer like a Yjs clientID, drawn from crypto randomness so that tabs
 * sharing a site never share an id in practice.
 *
 * @return A fresh clientId.
 */
export function randomClientId(): number {
	const [ word ] = globalThis.crypto.getRandomValues( new Uint32Array( 1 ) );
	return ( word % ( 2 ** 31 - 1 ) ) + 1;
}

/**
 * Creates an intent-log session codec.
 *
 * @param options Session options.
 * @return The session.
 */
export function createIntentLogSession(
	options: IntentLogSessionOptions
): IntentLogSession {
	const clientId = options.clientId ?? randomClientId();
	const actorId = `u${ options.userId }c${ clientId }`;

	let replica: ReturnType< typeof createClient > | null = null;
	let bootstrapSeq: number | null = null;
	/*
	 * The log position the consumer's view is expressed against (see
	 * setObservedSeq). It equals the cursor whenever the consumer is caught
	 * up; it lags while updates have reached this replica but not the view
	 * that authors against it.
	 */
	let observedSeq = 0;
	/*
	 * Log rows this replica has absorbed, by intentId. The replica's log is
	 * positional — clientReceive() appends every entry at the cursor — so a
	 * transport that redelivers a row (e.g. overlapping delivery windows)
	 * would have it counted as a NEW log entry, pushing the local head past
	 * the server's and voiding every later local intent as invalid-payload.
	 * IntentIds are unique per log entry (the server settles duplicates),
	 * so they identify rows exactly.
	 */
	let appliedIntentIds = new Set< string >();
	let localUpdateListener: EngineLocalUpdateListener | null = null;
	let localAwareness: LocalAwarenessState = {};
	let peers: AwarenessState = {};
	const proposals: IntentLogProposal[] = [];
	const resolvedIds = new Set< string >();
	const proposalsChangeListeners = new Set< () => void >();
	const notifyProposalsChange = () => {
		proposalsChangeListeners.forEach( ( listener ) => listener() );
	};
	const changeListeners = new Set< () => void >();
	const dispositionListeners = new Set<
		( settled: SettledDisposition ) => void
	>();
	const proposalListeners = new Set<
		( proposal: IntentLogProposal ) => void
	>();
	const resetListeners = new Set< () => void >();
	const discardListeners = new Set< ( updates: EngineUpdate[] ) => void >();
	const acceptedRowListeners = new Set<
		( rows: Array< { seq: number; entry: IntentEnvelope } > ) => void
	>();
	/*
	 * The undo stack's retention pin (see setUndoRetainSeq). Kept separate
	 * from observedSeq so the two consumers — the capture lane's observed
	 * frame and the undo stack's oldest invertible row — cannot starve each
	 * other's retention.
	 */
	let undoRetainSeq: number | null = null;

	const notifyChange = () => {
		changeListeners.forEach( ( listener ) => listener() );
	};

	/**
	 * Clamps an observed seq into the replica's authorable range and skips
	 * the contiguous run of own entries above it (see setObservedSeq).
	 *
	 * @param seq Candidate observed seq.
	 * @return The seq to record.
	 */
	const resolveObservedSeq = ( seq: number ): number => {
		if ( ! replica ) {
			return seq;
		}
		let resolved = Math.min(
			Math.max( seq, replica.firstSeq ),
			replica.cursor
		);
		while (
			resolved < replica.cursor &&
			replica.log[ resolved - replica.firstSeq ]?.actorId === actorId
		) {
			resolved++;
		}
		return resolved;
	};

	/**
	 * Recomputes the replica's retention floor: the log must stay sliceable
	 * from BOTH the observed frame (the next capture authors at it) and the
	 * undo pin (inverse derivation reads documents at retained seqs).
	 */
	const applyRetention = (): void => {
		if ( replica ) {
			replica.retainFrom =
				null === undoRetainSeq
					? observedSeq
					: Math.min( observedSeq, undoRetainSeq );
		}
	};

	/**
	 * Records the observed seq and keeps the replica's log sliceable from
	 * there (the next capture authors at it, and the planner needs the
	 * slice (observedSeq, head] to rebase).
	 *
	 * @param seq Candidate observed seq.
	 * @return The recorded seq.
	 */
	const applyObservedSeq = ( seq: number ): number => {
		observedSeq = resolveObservedSeq( seq );
		applyRetention();
		return observedSeq;
	};

	/**
	 * Emits one authored intent to the transport.
	 *
	 * @param intent Intent envelope.
	 */
	const emitIntent = ( intent: IntentEnvelope ): void => {
		const data = JSON.stringify( intent );
		if ( localUpdateListener ) {
			localUpdateListener(
				{ data, type: INTENT_LOG_UPDATE_TYPES.INTENT },
				new TextEncoder().encode( data ).length
			);
		}
	};

	/**
	 * Removes a settled intent from the pending outbox. The replica's
	 * predictions rebuild on the next replan; removal just stops the intent
	 * from being replanned as pending.
	 *
	 * @param intentId Intent id to settle.
	 * @return Whether the intent was pending.
	 */
	const settlePending = ( intentId: string ): boolean => {
		if ( ! replica ) {
			return false;
		}
		const before = replica.outbox.length;
		replica.outbox = replica.outbox.filter(
			( intent ) => intent.intentId !== intentId
		);
		return replica.outbox.length !== before;
	};

	/*
	 * A horizon-reset snapshot that arrives while LOCAL WORK is still
	 * un-settled (outbox non-empty: authored intents, sent or not) is
	 * DEFERRED, along with every row behind it, until the outbox drains.
	 * Applying the reset mid-burst mixes authoring frames inside one
	 * transport batch: the pre-reset intents void as stale while the
	 * SAME burst's later keystrokes land at the new frame with offsets
	 * that assumed the voided prefix — a torn, spliced document on the
	 * server (A2/A12's e2e finding). Deferring means every intent the
	 * server sees stays in ONE coherent frame; once the burst settles
	 * (all dispositions in), the reset applies and the manager's
	 * onReset recapture re-derives the whole local delta cleanly.
	 */
	let deferredResetBuffer: EngineUpdate[] | null = null;

	const maybeReleaseDeferredReset = (): void => {
		if (
			null === deferredResetBuffer ||
			! replica ||
			replica.outbox.length > 0
		) {
			return;
		}
		const buffered = deferredResetBuffer;
		deferredResetBuffer = null;
		for ( const update of buffered ) {
			session.receiveUpdate( update );
		}
	};

	const session: IntentLogSession = {
		actorId,
		clientId,
		engineSlug: INTENT_LOG_ENGINE_SLUG,
		engineProtocol: INTENT_LOG_ENGINE_PROTOCOL,

		// ---- EngineSessionCodec (transport-facing) ----

		getInitialUpdates: () => {
			// Nothing to announce: the server pushes the snapshot row.
			return [];
		},

		receiveUpdate: ( update: EngineUpdate ): void => {
			// Everything behind a deferred reset stays ordered behind it.
			if ( null !== deferredResetBuffer ) {
				deferredResetBuffer.push( update );
				return;
			}
			const decoded = JSON.parse( update.data );
			switch ( update.type ) {
				case INTENT_LOG_UPDATE_TYPES.SNAPSHOT: {
					const snapshotSeq = ( decoded.seq as number ) ?? 0;
					if ( ! replica ) {
						// First snapshot wins; genesis carries seq 0 and a
						// compaction checkpoint carries its engine seq.
						bootstrapSeq = snapshotSeq;
						replica = createClient(
							actorId,
							decoded.doc as EngineDocument,
							snapshotSeq
						);
						observedSeq = snapshotSeq;
						notifyChange();
						return;
					}
					if (
						snapshotSeq > replica.cursor &&
						replica.outbox.length > 0
					) {
						// Local work is still un-settled: defer (see
						// deferredResetBuffer above).
						deferredResetBuffer = [ update ];
						return;
					}
					if ( snapshotSeq > replica.cursor ) {
						/*
						 * Horizon reset: the server trimmed history between
						 * our cursor and this checkpoint — one-sided
						 * transforms over the gap are impossible, so the
						 * replica re-bootstraps. Pending intents are
						 * dropped; the manager re-captures the editor tree
						 * against the reset document, re-deriving any
						 * unacked local work.
						 */
						bootstrapSeq = snapshotSeq;
						replica = createClient(
							actorId,
							decoded.doc as EngineDocument,
							snapshotSeq
						);
						observedSeq = snapshotSeq;
						// New epoch: rows after the checkpoint are new to
						// this replica even if their ids were seen before.
						appliedIntentIds = new Set();
						resetListeners.forEach( ( listener ) => listener() );
						notifyChange();
					}
					// Stale/duplicate snapshots (seq <= cursor) are ignored
					// (mirrors the server's first-snapshot-wins genesis).
					return;
				}
				case INTENT_LOG_UPDATE_TYPES.INTENT: {
					if ( ! replica ) {
						throw new Error(
							'Received an intent before the room snapshot.'
						);
					}
					const intent = decoded as IntentEnvelope;
					// Redelivered row (see appliedIntentIds): already
					// absorbed at its true log position; skip.
					if ( appliedIntentIds.has( intent.intentId ) ) {
						return;
					}
					/*
					 * Normally our own accepted intents were settled by the
					 * dispositions ack in the same response. If that ack was
					 * lost (reconnect), settle here so the pending original
					 * and its authoritative form never coexist.
					 */
					settlePending( intent.intentId );
					const landingSeq = replica.cursor;
					clientReceive( replica, [ intent ], replica.cursor );
					appliedIntentIds.add( intent.intentId );
					acceptedRowListeners.forEach( ( listener ) =>
						listener( [ { seq: landingSeq, entry: intent } ] )
					);
					notifyChange();
					return;
				}
				case INTENT_LOG_UPDATE_TYPES.PARKED: {
					const proposal = decoded as IntentLogProposal;
					// Same redelivery guard as intents: a duplicate row
					// would double-list the proposal for review.
					if (
						proposals.some(
							( existing ) =>
								existing.intent.intentId ===
								proposal.intent.intentId
						)
					) {
						return;
					}
					/*
					 * An escalated intent leaves the outbox here WITHOUT
					 * passing through clientReceive, so the optimistic
					 * document must be replanned explicitly: the last
					 * replan ran while this intent was still pending, and
					 * its predicted-applied effect would otherwise sit on
					 * the canvas until the next accepted row — which may
					 * never come. (The fuzzer's one-keystroke divergence:
					 * concurrent same-paragraph typing left the loser's
					 * first escalated keystroke on their canvas forever.)
					 */
					if (
						settlePending( proposal.intent.intentId ) &&
						replica
					) {
						replanClient( replica );
					}
					proposals.push( proposal );
					proposalListeners.forEach( ( listener ) =>
						listener( proposal )
					);
					notifyProposalsChange();
					notifyChange();
					return;
				}
				case INTENT_LOG_UPDATE_TYPES.RESOLVED: {
					const resolution = decoded as IntentLogResolution;
					if ( ! resolvedIds.has( resolution.proposalId ) ) {
						resolvedIds.add( resolution.proposalId );
						notifyProposalsChange();
					}
					return;
				}
				case INTENT_LOG_UPDATE_TYPES.VOIDED: {
					// Another client's voided marker (ours settle through
					// the ack); relevant only on ack loss. Same replan
					// contract as the proposal path: a settle that
					// bypasses clientReceive must not leave a stale
					// optimistic effect behind.
					if ( settlePending( decoded.intentId ) && replica ) {
						replanClient( replica );
						notifyChange();
					}
					return;
				}
				default:
					throw new Error(
						`Unknown intent-log update type: ${ update.type }`
					);
			}
		},

		receiveDispositions: ( dispositions: EngineDisposition[] ) => {
			let settled = false;
			for ( const disposition of dispositions ) {
				/*
				 * Best-effort: the row-processing that precedes this ack
				 * usually settled the intent already (predicted is then
				 * null). Prediction parity as an INVARIANT only holds for
				 * caught-up clients and is asserted by the engine's
				 * simulator, not here — a client that authored while behind
				 * the log can mispredict legitimately.
				 */
				const predicted = replica
					? predictedDisposition( replica, disposition.intentId )
					: null;
				settled = settlePending( disposition.intentId ) || settled;
				dispositionListeners.forEach( ( listener ) =>
					listener( { ...disposition, predicted } )
				);
			}
			/*
			 * Any intent settled HERE (escalated/voided without a proposal
			 * row, or an ack that outran its accepted row) left the outbox
			 * without a clientReceive replan — recompute the optimistic
			 * document so a mispredicted effect cannot linger on the canvas.
			 */
			if ( settled && replica ) {
				replanClient( replica );
			}
			notifyChange();
			// A drained outbox releases any deferred horizon reset.
			maybeReleaseDeferredReset();
		},

		getLocalAwareness: () =>
			options.awareness
				? options.awareness.getLocalState() ?? {}
				: localAwareness,

		applyRemoteAwareness: ( state: AwarenessState ) => {
			peers = state;
			if ( options.awareness ) {
				applyServerAwarenessStates(
					state,
					options.awareness,
					INTENT_LOG_SESSION_ORIGIN
				);
			}
		},

		// No client-side compaction: snapshotting is a server concern for
		// this engine, so the codec omits the optional compaction members.

		onLocalUpdate: ( listener: EngineLocalUpdateListener ) => {
			localUpdateListener = listener;
		},

		destroy: () => {
			localUpdateListener = null;
			changeListeners.clear();
			dispositionListeners.clear();
			proposalListeners.clear();
			resetListeners.clear();
			discardListeners.clear();
			proposalsChangeListeners.clear();
			acceptedRowListeners.clear();
		},

		onUpdatesDiscarded: ( updates ) => {
			discardListeners.forEach( ( listener ) => listener( updates ) );
		},

		onRoomRestart: () => {
			replica = null;
			bootstrapSeq = null;
			observedSeq = 0;
			appliedIntentIds = new Set();
			deferredResetBuffer = null;
			resetListeners.forEach( ( listener ) => listener() );
			notifyChange();
			return 'rebootstrap';
		},

		// ---- Bridge/dev surface ----

		author: ( type, payload, authorOptions = {} ) => {
			if ( ! replica ) {
				throw new Error(
					'Cannot author intents before the room snapshot arrives.'
				);
			}
			const intent = createIntent( type, payload, {
				actorId,
				baseSeq: replica.cursor,
				txnId: authorOptions.txnId,
			} );
			authorIntent( replica, intent );
			emitIntent( intent );
			notifyChange();
			return intent;
		},

		authorBatch: ( intents, batchOptions = {} ) => {
			if ( ! replica ) {
				throw new Error(
					'Cannot author intents before the room snapshot arrives.'
				);
			}
			/*
			 * `observe: false` authors at an explicit frame WITHOUT moving
			 * the observed seq — the undo lane's contract: an inverse batch
			 * is authored at the frame right after the unit it inverts,
			 * while the editor's own observed frame stays wherever the
			 * capture lane left it.
			 */
			const baseSeq =
				false === batchOptions.observe
					? Math.min(
							Math.max(
								batchOptions.baseSeq ?? replica.cursor,
								replica.firstSeq
							),
							replica.cursor
					  )
					: applyObservedSeq( batchOptions.baseSeq ?? observedSeq );
			const authored = intents.map( ( entry ) => {
				const intent = createIntent( entry.type, entry.payload, {
					actorId,
					baseSeq,
					txnId: batchOptions.txnId,
				} );
				authorIntent( replica!, intent );
				emitIntent( intent );
				return intent;
			} );
			if ( 0 === authored.length ) {
				return authored;
			}
			if ( baseSeq < replica.cursor ) {
				/*
				 * The payloads are expressed in the observed frame, not the
				 * head's: only a replan (the planner the server also runs)
				 * turns them into the correct optimistic document — rebased
				 * over everything that landed since baseSeq, with the
				 * dispositions the server will report predicted.
				 */
				replanClient( replica );
			}
			notifyChange();
			return authored;
		},

		setObservedSeq: ( seq ) => {
			applyObservedSeq( seq );
		},

		getObservedSeq: () => observedSeq,

		setUndoRetainSeq: ( seq ) => {
			undoRetainSeq = seq;
			applyRetention();
		},

		getDocumentAt: ( seq ) => {
			if ( ! replica || seq < replica.firstSeq || seq > replica.cursor ) {
				return null;
			}
			// serverDocAt reads only { firstSeq, log, docCache }, a shape the
			// client replica shares with the server by design (client.js
			// docblock); the declared parameter type is just narrower.
			return serverDocAt(
				replica as never,
				seq
			) as EngineDocument | null;
		},

		getRetainedFloor: () => replica?.firstSeq ?? 0,

		onAcceptedRows: ( listener ) => {
			acceptedRowListeners.add( listener );
		},

		getDocument: () => replica?.doc ?? null,
		getProposals: () => [ ...proposals ],
		getOpenProposals: () =>
			proposals.filter(
				( proposal ) => ! resolvedIds.has( proposal.intent.intentId )
			),
		resolveProposal: ( proposalId, resolution ) => {
			const data = JSON.stringify( { proposalId, resolution } );
			if ( localUpdateListener ) {
				localUpdateListener(
					{ data, type: INTENT_LOG_UPDATE_TYPES.RESOLVED },
					new TextEncoder().encode( data ).length
				);
			}
			// Optimistic: the list shrinks immediately; the relayed row (or
			// the idempotent ack) confirms.
			if ( ! resolvedIds.has( proposalId ) ) {
				resolvedIds.add( proposalId );
				notifyProposalsChange();
			}
		},
		onProposalsChange: ( listener ) => {
			proposalsChangeListeners.add( listener );
		},
		getPendingCount: () => replica?.outbox.length ?? 0,

		cancelPendingIntents: ( intentIds: string[] ) => {
			if ( ! replica || 0 === intentIds.length ) {
				return false;
			}
			const pending = new Set(
				replica.outbox.map(
					( intent: IntentEnvelope ) => intent.intentId
				)
			);
			if ( ! intentIds.every( ( id ) => pending.has( id ) ) ) {
				return false; // Partially acked: not cancelable, arm at settle.
			}
			const ids = new Set( intentIds );
			replica.outbox = replica.outbox.filter(
				( intent: IntentEnvelope ) => ! ids.has( intent.intentId )
			);
			replanClient( replica );
			if ( localUpdateListener ) {
				const data = JSON.stringify( {
					cancelId: `cancel-${ intentIds[ 0 ] }`,
					intentIds,
				} );
				localUpdateListener(
					{ type: INTENT_LOG_UPDATE_TYPES.CANCEL, data },
					data.length
				);
			}
			notifyChange();
			return true;
		},
		getSeq: () => replica?.cursor ?? 0,
		isInitialized: () => null !== replica,
		getBootstrapSeq: () => bootstrapSeq,
		getPeers: () => peers,
		setLocalAwareness: ( state: LocalAwarenessState ) => {
			localAwareness = state;
		},
		onChange: ( listener ) => {
			changeListeners.add( listener );
		},
		onDisposition: ( listener ) => {
			dispositionListeners.add( listener );
		},
		onProposal: ( listener ) => {
			proposalListeners.add( listener );
		},
		onReset: ( listener ) => {
			resetListeners.add( listener );
		},
		onDiscard: ( listener ) => {
			discardListeners.add( listener );
		},

		hasDeferredReset: () => null !== deferredResetBuffer,
	};

	return session;
}
