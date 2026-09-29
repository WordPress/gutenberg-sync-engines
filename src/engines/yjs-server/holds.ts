/**
 * Security holds: markup the server's kses lane stripped from a filtered
 * author's block and kept for a reviewer who may publish unfiltered HTML.
 * The canonical document holds the SANITIZED block; the hold carries what
 * was written. Holds arrive as `held` rows and close with `held-resolved`
 * rows (accepted, dismissed, or superseded by a newer hold over the same
 * block).
 */

/**
 * A hold, as the server's `held` row carries it
 * (WP_Yjs_Server_Engine::hold_markup()).
 */
export interface YjsServerHold {
	holdId: string;
	/**
	 * The sanitized block's id in the document, which every editor adopts
	 * as the block's client id. Null when nothing of the block survived.
	 */
	blockId: string | null;
	/** The block's top-level index when the hold was raised. */
	index: number;
	/** The block as the author wrote it, serialized. */
	held: string;
	/** The block as the canonical document has it, serialized. */
	sanitized: string;
	/** The block before the author's batch ('' for a new block). */
	base: string;
	/** The author's WordPress user id. */
	author: number;
	authorClientId?: number;
	at?: number;
}

export type YjsServerHoldResolution = 'accepted' | 'dismissed';

/**
 * The per-entity ledger of open holds, fed by the session codec and read
 * by the engine's conflict source.
 */
export interface YjsServerHolds {
	noteHeld: ( hold: YjsServerHold ) => void;
	noteResolved: ( holdId: string ) => void;
	getOpen: () => YjsServerHold[];
	/** Returns an unsubscribe function. */
	onChange: ( listener: () => void ) => () => void;
	/**
	 * Registers the REST lane decisions travel over (last one wins). A
	 * decision is a mutation and belongs on an authenticated route; the
	 * transport only carries the announcements.
	 */
	setRestResolver: (
		resolver:
			| ( (
					holdId: string,
					resolution: YjsServerHoldResolution,
					content?: string
			  ) => Promise< unknown > )
			| null
	) => void;
	/** Optimistically closes a hold and POSTs the decision. */
	resolve: (
		holdId: string,
		resolution: YjsServerHoldResolution,
		content?: string
	) => void;
}

/**
 * Creates the per-entity hold ledger.
 *
 * @return The ledger.
 */
export function createYjsServerHolds(): YjsServerHolds {
	const open = new Map< string, YjsServerHold >();
	const resolvedIds = new Set< string >();
	const listeners = new Set< () => void >();
	let restResolver:
		| ( (
				holdId: string,
				resolution: YjsServerHoldResolution,
				content?: string
		  ) => Promise< unknown > )
		| null = null;

	const notify = () => {
		listeners.forEach( ( listener ) => listener() );
	};

	return {
		noteHeld( hold ) {
			// A repeat (the server announces open holds again after it
			// trims its log) or a hold decided before this replica saw it.
			if ( resolvedIds.has( hold.holdId ) || open.has( hold.holdId ) ) {
				return;
			}
			open.set( hold.holdId, hold );
			notify();
		},

		noteResolved( holdId ) {
			if ( resolvedIds.has( holdId ) ) {
				return;
			}
			resolvedIds.add( holdId );
			if ( open.delete( holdId ) ) {
				notify();
			}
		},

		getOpen: () => Array.from( open.values() ),

		onChange( listener ) {
			listeners.add( listener );
			return () => listeners.delete( listener );
		},

		setRestResolver( resolver ) {
			restResolver = resolver;
		},

		resolve( holdId, resolution, content ) {
			const hold = open.get( holdId );
			const resolver = restResolver;
			resolvedIds.add( holdId );
			if ( open.delete( holdId ) ) {
				notify();
			}
			// Without a lane (session torn down) the hold is durable
			// server-side and comes back on the next load.
			resolver?.( holdId, resolution, content ).catch( () => {
				// A failed decision must not strand the hold (the server
				// refuses an approval from a user who may not give it):
				// reopen it so the reviewer can decide again.
				resolvedIds.delete( holdId );
				if ( hold ) {
					open.set( holdId, hold );
				}
				notify();
			} );
		},
	};
}
