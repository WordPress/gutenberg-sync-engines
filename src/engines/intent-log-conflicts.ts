/**
 * The intent-log engine's conflict records: every parked proposal of an
 * entity, assembled into the engine-neutral SyncConflict shape
 * (src/review/types.ts) with its three sides reconstructed from the
 * replica's retained log.
 *
 * ONE RECORD PER PARKED UNIT, AND RECORDS NEVER OVERLAP. The engine parks
 * intents; a person reviews edits. Members of one atomic unit (a txn)
 * form one record, and units by the same author that touch the same
 * block (or the same property) fold into one record too: a typing burst
 * parks keystroke by keystroke, and the reviewer must see it as one edit
 * with one decision, not a card per keystroke.
 *
 * THE THREE SIDES, all as serialized block content:
 *
 * - `base`: the target blocks in the document at the EARLIEST member's
 *   baseSeq, the state the author started from. Null when the replica no
 *   longer holds that seq (a proposal older than the session, replayed on
 *   join); the review UI then compares proposed against current.
 * - `proposed`: that base document with every member applied in authoring
 *   order, then the same blocks. Members of one capture batch are
 *   expressed against the base plus the batch's earlier members, and a
 *   later batch at the same frame against the base plus the earlier
 *   batches (the editor's own view of its text), so applying them in
 *   order rebuilds what the author saw. A member that no longer applies
 *   is skipped.
 * - `current`: the target blocks in this client's optimistic document.
 *
 * Pure: the documents and the serializer come in through `deps`, so the
 * module runs without an editor.
 */

/**
 * Internal dependencies
 */
import { applyIntent } from './intent-log/reducer.js';
import type {
	EngineBlock,
	EngineDocument,
	IntentEnvelope,
} from './intent-log/engine-types';
import type { SyncConflict, SyncConflictTarget } from '../review/types';
import type { IntentLogProposal } from './intent-log-session';

export interface ConflictDeps {
	/** This client's optimistic document. */
	getDocument: () => EngineDocument | null;
	/** The document at a log position, or null when it is not retained. */
	getDocumentAt: ( seq: number ) => EngineDocument | null;
	/**
	 * Serializes blocks of a document, by id, in the order given. The ids
	 * are top-most (no id is a descendant of another) and present.
	 */
	serializeBlocks: ( doc: EngineDocument, ids: string[] ) => string;
}

/** One record with the parked proposals it stands for. */
export interface ConflictRecord {
	conflict: SyncConflict;
	/** The record's parked proposals, in arrival order. */
	members: IntentLogProposal[];
	/** Every block id the members touch (present in a document or not). */
	blockIds: string[];
	/** The property the members write, for a property record. */
	property?: string;
}

interface Placement {
	parentId?: string;
	index: number;
	order: number;
	ancestors: string[];
}

/**
 * Every block of a document with its parent, its index among its
 * siblings, its position in document order, and its ancestors.
 *
 * @param doc Document.
 * @return Placement by block id.
 */
function placements( doc: EngineDocument ): Map< string, Placement > {
	const map = new Map< string, Placement >();
	let order = 0;
	const walk = ( blocks: EngineBlock[], ancestors: string[] ) => {
		blocks.forEach( ( block, index ) => {
			map.set( block.syncId, {
				parentId: ancestors.at( -1 ),
				index,
				order: order++,
				ancestors,
			} );
			walk( block.children, [ ...ancestors, block.syncId ] );
		} );
	};
	walk( doc.root, [] );
	return map;
}

/**
 * The ids present in a document, top-most only (an id under another of
 * the ids is covered by it), in document order.
 *
 * @param ids Candidate ids.
 * @param doc Document.
 * @return The ids to serialize.
 */
export function topMostIds( ids: string[], doc: EngineDocument ): string[] {
	const placed = placements( doc );
	const wanted = new Set( ids );
	return ids
		.filter( ( id, position ) => {
			const placement = placed.get( id );
			if ( ! placement || ids.indexOf( id ) !== position ) {
				return false;
			}
			return ! placement.ancestors.some( ( ancestor ) =>
				wanted.has( ancestor )
			);
		} )
		.sort(
			( a, b ) =>
				( placed.get( a )?.order ?? 0 ) -
				( placed.get( b )?.order ?? 0 )
		);
}

/**
 * The WordPress user id inside an actor id (`u<user>c<client>`).
 *
 * @param actorId Actor id.
 * @return The user id, or 0.
 */
function userIdOf( actorId: string ): number {
	return Number( /^u(\d+)/.exec( actorId )?.[ 1 ] ?? 0 );
}

/**
 * The block ids an intent touches.
 *
 * @param intent Intent.
 * @return Block ids (empty for a property write).
 */
function blockIdsOf( intent: IntentEnvelope ): string[] {
	const { payload } = intent;
	if ( 'insert_block' === intent.type ) {
		const block = payload.block as { syncId?: unknown } | undefined;
		return 'string' === typeof block?.syncId ? [ block.syncId ] : [];
	}
	return 'string' === typeof payload.syncId ? [ payload.syncId ] : [];
}

/**
 * A property value as the text the review dialog shows and the accepted
 * decision sends back: strings as they are, anything else as JSON.
 *
 * @param value The value.
 * @return The text.
 */
export function propertyText( value: unknown ): string {
	if ( 'string' === typeof value ) {
		return value;
	}
	if ( undefined === value || null === value ) {
		return '';
	}
	return JSON.stringify( value );
}

interface Draft {
	userId: number;
	kind: SyncConflict[ 'kind' ];
	members: IntentLogProposal[];
	blockIds: string[];
	property?: string;
}

/**
 * Groups parked proposals into records: members of one unit together,
 * then units by the same author and of the same kind that share a block
 * or a property.
 *
 * @param open Open proposals, in arrival order.
 * @return The record drafts, in arrival order of their first member.
 */
function groupProposals( open: IntentLogProposal[] ): Draft[] {
	const units = new Map< string, IntentLogProposal[] >();
	for ( const proposal of open ) {
		const key = proposal.intent.txnId ?? proposal.intent.intentId;
		if ( ! units.has( key ) ) {
			units.set( key, [] );
		}
		units.get( key )?.push( proposal );
	}

	const drafts: Draft[] = [];
	for ( const members of units.values() ) {
		const [ first ] = members;
		const unit: Draft = {
			userId: userIdOf( first.actorId ),
			kind: members.some(
				( member ) => 'requires-approval' === member.reason
			)
				? 'sequestration'
				: 'merge',
			members,
			blockIds: Array.from(
				new Set(
					members.flatMap( ( member ) => blockIdsOf( member.intent ) )
				)
			),
		};
		const propertyNames = new Set(
			members
				.filter( ( member ) => 'set_property' === member.intent.type )
				.map( ( member ) => String( member.intent.payload.name ) )
		);
		if ( 0 === unit.blockIds.length && 1 === propertyNames.size ) {
			unit.property = Array.from( propertyNames )[ 0 ];
		}

		const overlapping = drafts.filter(
			( draft ) =>
				draft.userId === unit.userId &&
				draft.kind === unit.kind &&
				( ( undefined !== unit.property &&
					draft.property === unit.property ) ||
					draft.blockIds.some( ( id ) =>
						unit.blockIds.includes( id )
					) )
		);
		if ( 0 === overlapping.length ) {
			drafts.push( unit );
			continue;
		}
		// Fold into the earliest overlapping record; records this unit
		// bridges fold in with it.
		const [ target, ...bridged ] = overlapping;
		for ( const draft of [ ...bridged, unit ] ) {
			target.members.push( ...draft.members );
			for ( const id of draft.blockIds ) {
				if ( ! target.blockIds.includes( id ) ) {
					target.blockIds.push( id );
				}
			}
			const position = drafts.indexOf( draft );
			if ( position >= 0 ) {
				drafts.splice( position, 1 );
			}
		}
	}
	return drafts;
}

/**
 * The document with a record's members applied in authoring order.
 *
 * @param start   The document the members start from.
 * @param members The record's members.
 * @return The author's intended document.
 */
function applyMembers(
	start: EngineDocument,
	members: IntentLogProposal[]
): EngineDocument {
	let doc = start;
	for ( const member of members ) {
		try {
			const result = applyIntent( doc, member.intent );
			if ( 'applied' === result.disposition.status ) {
				doc = result.doc;
			}
		} catch {
			// A member the document cannot take is skipped.
		}
	}
	return doc;
}

/**
 * Where a record's blocks sit in the current document, or, for a
 * proposed insertion, where the block would land.
 *
 * @param draft   Record draft.
 * @param current The current document.
 * @return The target.
 */
function targetOf( draft: Draft, current: EngineDocument ): SyncConflictTarget {
	if ( undefined !== draft.property ) {
		return { type: 'property', name: draft.property };
	}
	const placed = placements( current );
	const present = topMostIds( draft.blockIds, current );
	if ( present.length ) {
		const first = placed.get( present[ 0 ] );
		return {
			type: 'blocks',
			ids: present,
			parentId: first?.parentId,
			index: first?.index ?? 0,
			count: present.length,
		};
	}
	// No block exists yet: the slot after the first insertion's anchor.
	const insertion = draft.members.find(
		( member ) => 'insert_block' === member.intent.type
	);
	const payload = insertion?.intent.payload ?? {};
	const sibling =
		'string' === typeof payload.afterSiblingId
			? placed.get( payload.afterSiblingId )
			: undefined;
	return {
		type: 'blocks',
		parentId:
			'string' === typeof payload.parentId ? payload.parentId : undefined,
		index: sibling ? sibling.index + 1 : 0,
		count: 0,
	};
}

/**
 * Assembles the open conflict records of an entity.
 *
 * @param open Open proposals, in arrival order.
 * @param deps The documents and the serializer.
 * @return The records (empty before the room snapshot arrives).
 */
export function buildConflictRecords(
	open: IntentLogProposal[],
	deps: ConflictDeps
): ConflictRecord[] {
	const current = deps.getDocument();
	if ( ! current || 0 === open.length ) {
		return [];
	}

	return groupProposals( open ).map( ( draft ) => {
		const baseSeq = Math.min(
			...draft.members.map( ( member ) => member.intent.baseSeq )
		);
		const baseDoc = Number.isFinite( baseSeq )
			? deps.getDocumentAt( baseSeq )
			: null;
		// Without the base, the members apply onto the current document:
		// the closest reading of the author's intent still available.
		const proposedDoc = applyMembers( baseDoc ?? current, draft.members );

		let base: string | null = null;
		let proposed = '';
		let currentSide = '';
		if ( undefined !== draft.property ) {
			const name = draft.property;
			const last = draft.members.at( -1 );
			base = baseDoc ? propertyText( baseDoc.props?.[ name ] ) : null;
			proposed = propertyText( last?.intent.payload.value );
			currentSide = propertyText( current.props?.[ name ] );
		} else {
			if ( baseDoc ) {
				base = deps.serializeBlocks(
					baseDoc,
					topMostIds( draft.blockIds, baseDoc )
				);
			}
			proposed = deps.serializeBlocks(
				proposedDoc,
				topMostIds( draft.blockIds, proposedDoc )
			);
			currentSide = deps.serializeBlocks(
				current,
				topMostIds( draft.blockIds, current )
			);
		}

		return {
			conflict: {
				id: draft.members[ 0 ].intent.intentId,
				kind: draft.kind,
				authorId: draft.userId,
				target: targetOf( draft, current ),
				base,
				proposed,
				current: currentSide,
			},
			members: draft.members,
			blockIds: draft.blockIds,
			property: draft.property,
		};
	} );
}
