/**
 * Internal dependencies
 */
import {
	changedBlockIndexes,
	flattenByIdentity,
	parseCanonicalBlocks,
	syncIdOf,
} from './doc-bridge';
import type { DeRtcUndoFeed, DeRtcUndoFeedRow } from './revert-undo';

/*
 * Per-edit authorship: "Edits retain authorship and it's possible to
 * hover over a user's avatar and highlight the changes they applied."
 *
 * This is the DATA surface: every accepted canonical row carries its
 * author (user id + client id, server-stamped), and diffing each row
 * against its base yields which blocks that edit touched — so the last
 * author of every block is derivable client-side with no extra wire
 * cost. The hover-highlight overlay itself is future editor UX;
 * range-grain attribution (which characters) needs the descriptor lane.
 *
 * Grain: by block identity, at every depth. A row is attributed to the
 * blocks whose OWN form (name and attributes, children excluded) it
 * changed or introduced, keyed by `metadata.syncId` — so an edit to a
 * paragraph inside a Group credits the paragraph, not the Group, and a
 * structural change (an insert, a move) does not disturb the record of
 * blocks it did not touch. Documents whose blocks carry no identity
 * fall back to the positional rule: top-level index, reset to unknown
 * across a structural change (a lying attribution is worse than none).
 */

/** The last-known author of one block. */
export interface DeRtcBlockAuthorship {
	author: number;
	authorClientId: number;
	version: string;
}

export interface DeRtcAuthorshipTracker {
	/**
	 * The last author of each top-level block, by current index. `null`
	 * entries are unknown (untouched since genesis, or — for documents
	 * without identity — reset by a structural change).
	 */
	getBlockAuthorship: () => Array< DeRtcBlockAuthorship | null >;
	/**
	 * The last author of every identified block, at any depth, keyed by
	 * syncId. Empty for documents whose blocks carry no identity.
	 */
	getBlockAuthorshipById: () => Record< string, DeRtcBlockAuthorship >;
}

/**
 * Creates the per-entity authorship tracker over the canonical row feed.
 *
 * @param feed The session's canonical-row feed.
 * @return The tracker.
 */
export function createDeRtcAuthorship(
	feed: DeRtcUndoFeed
): DeRtcAuthorshipTracker {
	const versionContents = new Map< string, string >();
	// The positional record (documents without identity).
	let positional: Array< DeRtcBlockAuthorship | null > = [];
	// The identity record, and the latest row's top-level ids (so the
	// positional view can be read off it).
	const byId = new Map< string, DeRtcBlockAuthorship >();
	let topLevelIds: Array< string | undefined > = [];
	let identified = false;

	feed.subscribe( ( row: DeRtcUndoFeedRow ) => {
		versionContents.set( row.version, row.content );
		while ( versionContents.size > 60 ) {
			const oldest = versionContents.keys().next().value;
			if ( undefined === oldest ) {
				break;
			}
			versionContents.delete( oldest );
		}

		const blocks = parseCanonicalBlocks( row.content );
		const rowById = flattenByIdentity( blocks );
		identified = null !== rowById;
		topLevelIds = blocks.map( syncIdOf );
		if ( positional.length !== blocks.length ) {
			// Structural change (or first sight): re-anchor the positional
			// record to unknown rather than attribute across a shift.
			positional = blocks.map( () => null );
		}

		const baseContent =
			null !== row.baseVersion
				? versionContents.get( row.baseVersion )
				: undefined;
		if (
			undefined === baseContent ||
			undefined === row.author ||
			undefined === row.authorClientId
		) {
			return; // Unattributable row (genesis, aged-out base).
		}
		const credit: DeRtcBlockAuthorship = {
			author: row.author,
			authorClientId: row.authorClientId,
			version: row.version,
		};
		const baseBlocks = parseCanonicalBlocks( baseContent );

		if ( rowById ) {
			const baseById = flattenByIdentity( baseBlocks );
			for ( const [ id, node ] of rowById.nodes ) {
				const before = baseById?.nodes.get( id );
				if ( ! before || before.own !== node.own ) {
					byId.set( id, credit ); // Changed, or introduced.
				}
			}
			for ( const id of Array.from( byId.keys() ) ) {
				if ( ! rowById.nodes.has( id ) ) {
					byId.delete( id ); // Gone from the document.
				}
			}
		}

		const changed = changedBlockIndexes( baseBlocks, blocks );
		if ( null === changed ) {
			return; // Structural row: the positional reset already applied.
		}
		for ( const index of changed ) {
			positional[ index ] = credit;
		}
	} );

	return {
		getBlockAuthorship: () =>
			identified
				? topLevelIds.map( ( id ) =>
						id ? byId.get( id ) ?? null : null
				  )
				: positional.slice(),
		getBlockAuthorshipById: () => Object.fromEntries( byId ),
	};
}
