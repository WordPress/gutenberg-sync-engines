/**
 * Security holds: markup the server's kses lane stripped from a filtered
 * author's block and kept for a reviewer who may publish unfiltered HTML.
 * The canonical document holds the SANITIZED block. The hold carries what
 * was written. Holds arrive as `held` rows and close with `held-resolved`
 * rows (accepted, dismissed, superseded by a newer hold over the same
 * block, or block-removed when the block was taken out of the document).
 */

/**
 * Internal dependencies
 */
import { restErrorParts } from '../../shared/rest-error';

/**
 * A hold, as the server's `held` row carries it
 * (WP_Yjs_Server_Engine::hold_markup()).
 */
export interface YjsServerHold {
	holdId: string;
	/**
	 * The block's id in the document, which is its client id in every
	 * editor. The sanitized form keeps the id the block had. Null when
	 * nothing of the block survived.
	 */
	blockId: string | null;
	/** The block's top-level index when the hold was raised. */
	index: number;
	/**
	 * For a hold with no block: the id of the block that was before it
	 * ('' at the start of the document). The server puts approved
	 * content right after that block.
	 */
	afterId?: string;
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
 * What became of a decision: the server took it (`resolved`), the server
 * refused an approval because the block had changed since the reviewer
 * saw it (`stale`), or the request failed (`failed`). The hold is open
 * again after the last two.
 */
export type YjsServerHoldOutcome = 'resolved' | 'stale' | 'failed';

/** The error code the review route answers a stale approval with. */
export const YJS_SERVER_REVIEW_STALE_CODE = 'review_stale';

/**
 * A hold read out of the server's JSON (a `held` row, or the fresh hold a
 * refused approval answers with), or null when it is not one.
 *
 * @param decoded The decoded JSON.
 * @return The hold.
 */
export function holdFromJson( decoded: unknown ): YjsServerHold | null {
	if ( ! decoded || 'object' !== typeof decoded ) {
		return null;
	}

	const fields: Record< string, unknown > = { ...decoded };
	if (
		'string' !== typeof fields.holdId ||
		'' === fields.holdId ||
		'string' !== typeof fields.held
	) {
		return null;
	}

	let blockId: string | null = null;
	if ( 'string' === typeof fields.blockId ) {
		blockId = fields.blockId;
	}

	return {
		...fields,
		holdId: fields.holdId,
		held: fields.held,
		blockId,
		index: Number( fields.index ) || 0,
		sanitized: String( fields.sanitized ?? '' ),
		base: String( fields.base ?? '' ),
		author: Number( fields.author ) || 0,
	};
}

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
	 * decision is a mutation and belongs on an authenticated route. The
	 * transport only carries the announcements.
	 */
	setRestResolver: ( resolver: YjsServerHoldResolver | null ) => void;
	/**
	 * Optimistically closes a hold and POSTs the decision. An approval
	 * names the sanitized block the reviewer saw (`seen`). The server
	 * refuses it when the block no longer reads that way. Settles with
	 * what became of the decision, and never rejects.
	 */
	resolve: (
		holdId: string,
		resolution: YjsServerHoldResolution,
		content?: string,
		seen?: string
	) => Promise< YjsServerHoldOutcome >;
}

type YjsServerHoldResolver = (
	holdId: string,
	resolution: YjsServerHoldResolution,
	content?: string,
	seen?: string
) => Promise< unknown >;

/**
 * Creates the per-entity hold ledger.
 *
 * @return The ledger.
 */
export function createYjsServerHolds(): YjsServerHolds {
	const open = new Map< string, YjsServerHold >();
	const resolvedIds = new Set< string >();
	const listeners = new Set< () => void >();
	let restResolver: YjsServerHoldResolver | null = null;

	const notify = () => {
		listeners.forEach( ( listener ) => listener() );
	};

	return {
		noteHeld( hold ) {
			// A hold decided before this replica saw it.
			if ( resolvedIds.has( hold.holdId ) ) {
				return;
			}
			// A repeat (the server announces open holds again after it
			// trims its log) changes nothing. The server also announces a
			// hold again when the block it sanitized has changed since:
			// that one replaces the open hold.
			const existing = open.get( hold.holdId );
			if (
				existing &&
				existing.sanitized === hold.sanitized &&
				existing.held === hold.held
			) {
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

		resolve( holdId, resolution, content, seen ) {
			const close = () => {
				resolvedIds.add( holdId );
				if ( open.delete( holdId ) ) {
					notify();
				}
			};
			// Without a lane (session torn down) the hold is durable
			// server-side and comes back on the next load.
			const resolver = restResolver;
			if ( ! resolver ) {
				close();
				return Promise.resolve( 'resolved' );
			}

			const hold = open.get( holdId );
			close();

			return resolver( holdId, resolution, content, seen ).then(
				(): YjsServerHoldOutcome => 'resolved',
				( error: unknown ): YjsServerHoldOutcome => {
					// A failed decision must not strand the hold (the server
					// refuses an approval from a user who may not give it):
					// reopen it so the reviewer can decide again.
					const refusal = restErrorParts( error );
					const isStale =
						YJS_SERVER_REVIEW_STALE_CODE === refusal.code;
					// A stale approval answers with the hold as the
					// document has it now, so the reviewer sees the block
					// they would replace.
					let reopened = hold;
					if ( isStale ) {
						reopened = holdFromJson( refusal.data.hold ) ?? hold;
					}
					resolvedIds.delete( holdId );
					if ( reopened ) {
						open.set( holdId, reopened );
					}
					notify();

					if ( isStale ) {
						return 'stale';
					}

					return 'failed';
				}
			);
		},
	};
}
