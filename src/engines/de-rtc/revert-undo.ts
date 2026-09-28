/**
 * External dependencies
 */
import type * as Y from 'yjs';

/**
 * WordPress dependencies
 */
// eslint-disable-next-line @wordpress/no-unsafe-wp-apis -- The exact serializer the doc bridge and core-data use; sharing it keeps revert content byte-consistent.
import { __unstableSerializeAndClean } from '@wordpress/blocks';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncUndoManager } from '@wordpress/sync';

/**
 * Internal dependencies
 */
import {
	changedBlockIndexes,
	flattenByIdentity,
	parseCanonicalBlocks,
	serializeBlock,
	type DeRtcDocBridge,
	type IdentityNode,
} from './doc-bridge';

/*
 * DE-RTC's revert-edit undo.
 *
 * The vision: "Undo and Redo never undo, but rather apply revert edits
 * that return the document to an earlier state by means of adding a new
 * change." This manager implements exactly that, replacing the local
 * Yjs snapshot undo the port had borrowed:
 *
 * - The undo stack is the client's OWN accepted canonical rows (the
 *   collaborative history), not local document snapshots.
 * - undo() derives a REVERT: for each top-level block the popped row
 *   changed against its base, the block reverts to its base form iff
 *   the current document still holds the row's form (untouched since —
 *   clients never merge, they select). The reverted document applies as
 *   an ordinary dirty edit and travels as an ordinary PROPOSAL: the
 *   revert is a new change in the shared history, visible to and
 *   mergeable with everyone, exactly like upstream prescribes.
 * - redo() re-applies the reverted row's base→row delta the same way.
 * - Blocks peers have since edited are left alone (their work is never
 *   collateral), and a revert that the server merges further simply
 *   becomes a new own row like any other edit.
 * - Grain: by block identity, at every depth. A block the row changed
 *   reverts its OWN form (name and attributes; children stay as they
 *   are now) wherever it sits; a block the row inserted is removed if it
 *   is still exactly as inserted; a block the row deleted comes back
 *   next to the sibling it followed. A move is left alone. Documents
 *   whose blocks carry no identity fall back to the positional rule,
 *   where structural divergence makes a row underivable (it is dropped
 *   and the next older row is tried — the intent-log undo's walk-back
 *   rule).
 *
 * The history-slider UI the vision sketches would read the same
 * version-content record this manager keeps; it remains future
 * editor UX work.
 */

/** A canonical row as the session feed reports it. */
export interface DeRtcUndoFeedRow {
	version: string;
	baseVersion: string | null;
	content: string;
	/** Whether this row is the local client's own accepted proposal. */
	own: boolean;
	/** Server-stamped author user id (stamped on announce rows). */
	author?: number;
	/** The authoring transport client id. */
	authorClientId?: number;
}

/** The session→undo feed: sessions publish every canonical row. */
export interface DeRtcUndoFeed {
	noteRow: ( row: DeRtcUndoFeedRow ) => void;
	subscribe: ( listener: ( row: DeRtcUndoFeedRow ) => void ) => () => void;
}

/**
 * Creates the per-entity session→undo row feed.
 *
 * @return The feed.
 */
export function createDeRtcUndoFeed(): DeRtcUndoFeed {
	const listeners = new Set< ( row: DeRtcUndoFeedRow ) => void >();
	return {
		noteRow: ( row ) =>
			listeners.forEach( ( listener ) => listener( row ) ),
		subscribe: ( listener ) => {
			listeners.add( listener );
			return () => listeners.delete( listener );
		},
	};
}

/**
 * The identity-keyed revert (or redo): `from` is the state the row left
 * the document in, `to` the state the step returns it to. Undefined when
 * any side lacks identity (the positional rule applies); null when
 * nothing of the row is still revertable.
 *
 * @param base    The row's base blocks.
 * @param mine    The row's blocks.
 * @param current The document as it stands now.
 * @param forward Redo (base → row) rather than undo (row → base).
 * @return The next block tree, null, or undefined.
 */
function deriveByIdentity(
	base: unknown[],
	mine: unknown[],
	current: unknown[],
	forward: boolean
): unknown[] | null | undefined {
	const B = flattenByIdentity( base );
	const M = flattenByIdentity( mine );
	const C = flattenByIdentity( current );
	if ( ! B || ! M || ! C ) {
		return undefined;
	}
	const from = forward ? B : M;
	const to = forward ? M : B;
	let reverted = false;

	// Blocks the step re-inserts: present in `to`, absent from `from`,
	// and not in the document now. Grouped by the parent they had.
	const reinsert = new Map< string | null, string[] >();
	for ( const [ id, node ] of to.nodes ) {
		if ( ! from.nodes.has( id ) && ! C.nodes.has( id ) ) {
			const list = reinsert.get( node.parent ) ?? [];
			list.push( id );
			reinsert.set( node.parent, list );
		}
	}

	const rebuild = ( node: IdentityNode ): unknown => {
		const id = node.block.attributes.metadata.syncId as string;
		const fromNode = from.nodes.get( id );
		const toNode = to.nodes.get( id );
		let own: any = node.block;
		if (
			fromNode &&
			toNode &&
			fromNode.own !== toNode.own &&
			node.own === fromNode.own
		) {
			own = toNode.block; // Untouched since: the row's own change reverts.
			reverted = true;
		}
		return { ...own, innerBlocks: children( id, node.childIds ) };
	};

	const children = ( parent: string | null, ids: string[] ): unknown[] => {
		const result: unknown[] = [];
		const place = ( id: string ) => {
			const node = C.nodes.get( id );
			if ( ! node ) {
				return;
			}
			const fromNode = from.nodes.get( id );
			if (
				fromNode &&
				! to.nodes.has( id ) &&
				serializeBlock( node.block ) ===
					serializeBlock( fromNode.block )
			) {
				reverted = true; // The row inserted it; still as inserted: remove.
				return;
			}
			result.push( rebuild( node ) );
		};
		// Re-inserted blocks land after the sibling they followed in `to`.
		const revived = reinsert.get( parent ) ?? [];
		const siblingsInTo =
			null === parent ? to.roots : to.nodes.get( parent )?.childIds ?? [];
		const revivedAfter = new Map< string | null, string[] >();
		for ( const id of revived ) {
			let anchor: string | null = null;
			for (
				let back = siblingsInTo.indexOf( id ) - 1;
				back >= 0;
				back--
			) {
				if ( ids.includes( siblingsInTo[ back ] ) ) {
					anchor = siblingsInTo[ back ];
					break;
				}
			}
			const list = revivedAfter.get( anchor ) ?? [];
			list.push( id );
			revivedAfter.set( anchor, list );
		}
		const revive = ( id: string ) => {
			const node = to.nodes.get( id )!;
			result.push( {
				...node.block,
				innerBlocks: node.childIds.map(
					( childId ) => to.nodes.get( childId )!.block
				),
			} );
			reverted = true;
		};
		( revivedAfter.get( null ) ?? [] ).forEach( revive );
		for ( const id of ids ) {
			place( id );
			( revivedAfter.get( id ) ?? [] ).forEach( revive );
		}
		return result;
	};

	const next = children( null, C.roots );
	return reverted ? next : null;
}

/** Retained version contents per entity (the derivation window). */
const VERSION_WINDOW = 60;

interface EntityUndoState {
	bridge: DeRtcDocBridge;
	applyRevert: ( blocks: unknown[] ) => void;
	handlers: {
		onUndoStackChange?: ( state: {
			hasUndo: boolean;
			hasRedo: boolean;
		} ) => void;
	};
	versionContents: Map< string, string >;
	undoStack: Array< { version: string; baseVersion: string } >;
	redoStack: Array< { version: string; baseVersion: string } >;
	/** Serialized contents this manager's own reverts predicted. */
	predictedReverts: Set< string >;
	/** Monotonic recency for cross-entity undo ordering. */
	lastOwnRowAt: number;
}

export type DeRtcRevertUndoManager = SyncUndoManager & {
	attachEntity: ( context: {
		key: Y.Map< unknown >;
		bridge: DeRtcDocBridge;
		feed: DeRtcUndoFeed;
		applyRevert: ( blocks: unknown[] ) => void;
	} ) => void;
};

/**
 * Creates the engine-level revert-edit undo manager.
 *
 * @return The manager.
 */
export function createDeRtcRevertUndoManager(): DeRtcRevertUndoManager {
	const entities = new Map< Y.Map< unknown >, EntityUndoState >();
	let recency = 0;

	const notify = ( state: EntityUndoState ) => {
		state.handlers.onUndoStackChange?.( {
			hasUndo: 0 < state.undoStack.length,
			hasRedo: 0 < state.redoStack.length,
		} );
	};

	const onRow = ( state: EntityUndoState, row: DeRtcUndoFeedRow ) => {
		state.versionContents.set( row.version, row.content );
		while ( state.versionContents.size > VERSION_WINDOW ) {
			const oldest = state.versionContents.keys().next().value;
			if ( undefined === oldest ) {
				break;
			}
			state.versionContents.delete( oldest );
		}
		if ( ! row.own || null === row.baseVersion ) {
			return;
		}
		if ( state.predictedReverts.has( row.content ) ) {
			// The accepted form of a revert this manager authored: part of
			// the undo/redo choreography, not a new undoable edit.
			state.predictedReverts.delete( row.content );
			notify( state );
			return;
		}
		state.undoStack.push( {
			version: row.version,
			baseVersion: row.baseVersion,
		} );
		state.lastOwnRowAt = ++recency;
		// A new real edit forks history: redo becomes unreachable.
		state.redoStack.length = 0;
		notify( state );
	};

	/**
	 * The revert (or redo) document for a row, or null when underivable.
	 * With `forward` false the revert derives (row → base); true
	 * re-applies the row's delta (base → row).
	 *
	 * @param state           Entity state.
	 * @param row             The own row to revert or re-apply.
	 * @param row.version     The row's version label.
	 * @param row.baseVersion The row's base version label.
	 * @param forward         Direction (see above).
	 * @return The next block list, or null.
	 */
	const derive = (
		state: EntityUndoState,
		row: { version: string; baseVersion: string },
		forward: boolean
	): unknown[] | null => {
		const baseContent = state.versionContents.get( row.baseVersion );
		const rowContent = state.versionContents.get( row.version );
		if ( undefined === baseContent || undefined === rowContent ) {
			return null; // Aged out of the derivation window.
		}
		const base = parseCanonicalBlocks( baseContent );
		const mine = parseCanonicalBlocks( rowContent );
		const current = parseCanonicalBlocks( state.bridge.buildContent() );
		const byIdentity = deriveByIdentity( base, mine, current, forward );
		if ( undefined !== byIdentity ) {
			return byIdentity;
		}
		const changed = changedBlockIndexes( base, mine );
		if ( null === changed || current.length !== mine.length ) {
			return null; // Structural divergence: positional selection lies.
		}

		const from = forward ? base : mine;
		const to = forward ? mine : base;
		const next = current.slice();
		let reverted = false;
		for ( const index of changed ) {
			if (
				serializeBlock( current[ index ] ) !==
				serializeBlock( from[ index ] )
			) {
				continue; // Touched since: a peer's work is never collateral.
			}
			next[ index ] = to[ index ];
			reverted = true;
		}

		return reverted ? next : null;
	};

	const step = ( direction: 'undo' | 'redo' ) => {
		// Cross-entity ordering: act on the entity with the most recent
		// own activity that has something to do.
		const candidates = Array.from( entities.values() )
			.filter( ( state ) =>
				'undo' === direction
					? 0 < state.undoStack.length
					: 0 < state.redoStack.length
			)
			.sort( ( a, b ) => b.lastOwnRowAt - a.lastOwnRowAt );
		for ( const state of candidates ) {
			const stack =
				'undo' === direction ? state.undoStack : state.redoStack;
			while ( 0 < stack.length ) {
				const row = stack.pop()!;
				const next = derive( state, row, 'redo' === direction );
				if ( null === next ) {
					continue; // Underivable: walk further back.
				}
				const serialized = __unstableSerializeAndClean(
					next as any[]
				).trim();
				state.predictedReverts.add( serialized );
				state.applyRevert( next );
				if ( 'undo' === direction ) {
					state.redoStack.push( row );
				} else {
					state.undoStack.push( row );
				}
				notify( state );
				return;
			}
			notify( state );
		}
	};

	return {
		attachEntity( { key, bridge, feed, applyRevert } ) {
			const state: EntityUndoState = {
				bridge,
				applyRevert,
				handlers: {},
				versionContents: new Map(),
				undoStack: [],
				redoStack: [],
				predictedReverts: new Set(),
				lastOwnRowAt: 0,
			};
			entities.set( key, state );
			feed.subscribe( ( row ) => onRow( state, row ) );
		},

		addToScope( ymap, handlers ) {
			const state = entities.get( ymap as Y.Map< unknown > );
			if ( state ) {
				state.handlers = handlers;
				notify( state );
			}
		},

		addRecord() {
			// Revert edits derive from accepted canonical rows, not from
			// editor history records.
		},

		stopCapturing() {
			// Units are accepted rows; there is no capture chain to split.
		},

		undo() {
			step( 'undo' );
			return [];
		},

		redo() {
			step( 'redo' );
			return [];
		},

		hasUndo: () =>
			Array.from( entities.values() ).some(
				( state ) => 0 < state.undoStack.length
			),

		hasRedo: () =>
			Array.from( entities.values() ).some(
				( state ) => 0 < state.redoStack.length
			),
	} as DeRtcRevertUndoManager;
}
