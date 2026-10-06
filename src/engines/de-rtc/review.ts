/**
 * A parked (escalated) proposal as the server's `parked` row
 * carries it. `changedBlocks` are the proposal's blocks that differed
 * from its base — identified by syncId (and path) when the server merged
 * by identity, always with a top-level index — so a restore can overlay
 * them at sensible anchors.
 */
export interface DeRtcParkedProposal {
	proposalId: string;
	reason: string;
	authorClientId: number;
	/** The escalating user's id (server-stamped). */
	author?: number;
	/** Server time at escalation. */
	at?: number;
	baseVersion?: string;
	changedBlocks: Array< {
		index: number;
		html: string;
		/**
		 * The block as the proposal's base version had it ('' for a
		 * proposed insertion; absent on rows older than this field).
		 */
		baseHtml?: string;
		/** The block's durable identity (identity-merged parks). */
		syncId?: string;
		/** The block's path in the proposal (child indices from the root). */
		path?: number[];
		/**
		 * True when the proposal's merge left the block out of the
		 * document (a held new block, a block one side deleted): the
		 * server inserts an accepted result instead of replacing a block.
		 */
		notInDocument?: boolean;
	} >;
	/** A conflicting entity-property register (property-conflict rows). */
	property?: { name: string; value: unknown };
	excerpt?: string;
	/**
	 * Merge-not-stack: how many parked revisions this ONE
	 * review task has folded (the fields above always show the latest).
	 */
	revisions?: number;
	/** proposalIds of superseded revisions — resolved with this task. */
	supersededIds?: string[];
}

/**
 * A parked proposal's terminal states: `restored` (the caller re-applied
 * the parked content as ordinary local edits first), `dismissed`, and
 * `accepted` (the server lands the reviewer's replacement content as an
 * ordinary proposal and closes the record in the same request).
 */
export type DeRtcResolution = 'restored' | 'dismissed' | 'accepted';

/**
 * The per-entity open-proposal ledger the session codec feeds (parked and
 * resolved rows) and the engine's review source reads.
 */
export interface DeRtcReviewState {
	noteParked: ( parked: DeRtcParkedProposal ) => void;
	noteResolved: ( proposalId: string ) => void;
	getOpen: () => DeRtcParkedProposal[];
	/** Returns an unsubscribe function. */
	onChange: ( listener: () => void ) => () => void;
	/**
	 * Registers the REST resolution lane (B5, last one wins).
	 * Resolutions POST here — resolutions are MUTATIONS and belong on an
	 * authenticated REST route, not the advisory transport. This is the
	 * only outbound lane; the server rejects client-sent resolution rows.
	 */
	setRestResolver: (
		resolver:
			| ( (
					proposalId: string,
					resolution: DeRtcResolution,
					content?: string
			  ) => Promise< unknown > )
			| null
	) => void;
	/**
	 * Optimistically closes a parked proposal and POSTs the resolution.
	 * The `restored` resolution is sent AFTER the caller re-applied the
	 * parked content as ordinary local edits; `accepted` carries the
	 * reviewer's replacement content for the server to apply.
	 */
	resolve: (
		proposalId: string,
		resolution: DeRtcResolution,
		content?: string
	) => void;
}

/**
 * Creates the per-entity review ledger.
 *
 * @return The review state.
 */
export function createDeRtcReviewState(): DeRtcReviewState {
	const open = new Map< string, DeRtcParkedProposal >();
	const resolvedIds = new Set< string >();
	const listeners = new Set< () => void >();
	let restResolver:
		| ( (
				proposalId: string,
				resolution: DeRtcResolution,
				content?: string
		  ) => Promise< unknown > )
		| null = null;

	const notify = () => {
		listeners.forEach( ( listener ) => listener() );
	};

	/**
	 * Merge-not-stack key: one review task per author per
	 * target — a property register, or a block set (by identity when
	 * the blocks carry one, else by index). A revised parked proposal
	 * from the same author over the same target FOLDS into the open
	 * task instead of raising a second one.
	 *
	 * @param parked Parked proposal.
	 * @return Fold key.
	 */
	const foldKey = ( parked: DeRtcParkedProposal ): string =>
		parked.property?.name
			? `prop:${ parked.authorClientId }:${ parked.property.name }`
			: `blocks:${ parked.authorClientId }:${ (
					parked.changedBlocks ?? []
			  )
					.map( ( block ) =>
						'string' === typeof block.syncId
							? block.syncId
							: String( Number( block.index ) )
					)
					.sort()
					.join( ',' ) }`;

	return {
		noteParked( parked ) {
			if (
				resolvedIds.has( parked.proposalId ) ||
				open.has( parked.proposalId )
			) {
				return; // Redelivery (or resolved before this replica saw it).
			}
			const key = foldKey( parked );
			for ( const [ openId, existing ] of open ) {
				if ( foldKey( existing ) !== key ) {
					continue;
				}
				// Supersede: the SAME task, refreshed to the latest
				// revision; earlier revisions resolve with it.
				open.delete( openId );
				open.set( parked.proposalId, {
					...parked,
					revisions: ( existing.revisions ?? 1 ) + 1,
					supersededIds: [
						...( existing.supersededIds ?? [] ),
						existing.proposalId,
					],
				} );
				notify();
				return;
			}
			open.set( parked.proposalId, { ...parked, revisions: 1 } );
			notify();
		},

		noteResolved( proposalId ) {
			if ( resolvedIds.has( proposalId ) ) {
				return;
			}
			resolvedIds.add( proposalId );
			if ( open.delete( proposalId ) ) {
				notify();
			}
		},

		getOpen: () => Array.from( open.values() ),

		onChange( listener ) {
			listeners.add( listener );
			return () => listeners.delete( listener );
		},

		setRestResolver( nextResolver ) {
			restResolver = nextResolver;
		},

		resolve( proposalId, resolution, content ) {
			// Optimistic: the server acks idempotently, so an unknown id
			// still resolves server-side. A folded task resolves EVERY
			// revision it superseded with it (merge-not-stack: one
			// decision closes the whole lineage). An accepted replacement
			// applies ONCE, on the task's latest revision; the superseded
			// revisions close as dismissed.
			// Revisions the server already closed (it closes the rows a
			// newer row of the same author and blocks replaces) need no
			// request of their own.
			const item = open.get( proposalId );
			const ids = [
				proposalId,
				...( item?.supersededIds ?? [] ).filter(
					( id ) => ! resolvedIds.has( id )
				),
			];
			ids.forEach( ( id ) => resolvedIds.add( id ) );
			if ( open.delete( proposalId ) ) {
				notify();
			}
			const resolver = restResolver;
			if ( ! resolver ) {
				// No lane (session torn down): the parked row is durable
				// server-side, so the task resurfaces on the next load.
				return;
			}
			Promise.all(
				ids.map( ( id ) => {
					if ( id === proposalId ) {
						return resolver( id, resolution, content );
					}
					return resolver(
						id,
						'accepted' === resolution ? 'dismissed' : resolution
					);
				} )
			).catch( () => {
				// A failed POST must not strand the decision: reopen the
				// task so the reviewer can decide again. Ids whose POST
				// did land re-ack idempotently on the retry.
				ids.forEach( ( id ) => resolvedIds.delete( id ) );
				if ( item ) {
					open.set( proposalId, item );
				}
				notify();
			} );
		},
	};
}
