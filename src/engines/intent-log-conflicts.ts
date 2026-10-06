/**
 * The intent-log engine's conflict records: every parked proposal of an
 * entity, assembled into the engine-neutral SyncConflict shape
 * (src/review/types.ts) with its three sides reconstructed from the
 * replica's retained log.
 *
 * ONE RECORD PER PARKED UNIT, AND RECORDS NEVER OVERLAP. The engine parks
 * intents. A person reviews edits. Members of one atomic unit (a txn)
 * form one record, and units by the same author that touch the same
 * block (or the same property) fold into one record too: a typing burst
 * parks keystroke by keystroke, and the reviewer must see it as one edit
 * with one decision, not a card per keystroke.
 *
 * A RECORD COVERS ONE RUN OF SIBLING BLOCKS. The blocks the members
 * touch need not be neighbours: one edit can change the first and the
 * third paragraph. An accepted result replaces the record's blocks as
 * one piece, so the record covers everything from its first block to its
 * last, the blocks in between included (see coveringRun()). The reviewer
 * then sees every block an accepted result replaces. A record that left
 * the second paragraph out would put the merged result where the first
 * one was and leave the second paragraph behind it, out of order.
 *
 * THE THREE SIDES, all as serialized block content:
 *
 * - `base`: the run in the document at the EARLIEST member's baseSeq,
 *   the state the author started from. Null when the replica no
 *   longer holds that seq (a proposal older than the session, replayed on
 *   join). The review UI then compares proposed against current.
 * - `proposed`: that base document with the author's edits applied, then
 *   the same blocks. The author's edits are, first, what the author got
 *   ACCEPTED from the same frames (read back out of the retained log),
 *   then every member in authoring order. The accepted ones matter
 *   because a parked edit is expressed against the author's own view,
 *   which held them: custom HTML parks as a format over a placeholder
 *   character whose insertion was accepted, and the keystrokes a typing
 *   burst parks sit behind the ones it got through. Members of one
 *   capture batch are expressed against the base plus the batch's earlier
 *   members, and a later batch at the same frame against the base plus
 *   the earlier batches, so applying them in order rebuilds what the
 *   author saw. An edit that no longer applies is skipped. The blocks
 *   in between, which the author did not touch, read as the current
 *   document has them (see proposedBlocks()): choosing this side must
 *   not undo what a collaborator did to them.
 * - `current`: the run in this client's optimistic document.
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
	 * The retained log entries above a position, oldest first (empty when
	 * the position is not retained).
	 */
	getLogSince?: (
		seq: number
	) => Array< { seq: number; intent: IntentEnvelope } >;
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
	/**
	 * The blocks the record covers in the current document: the run of
	 * siblings an accepted result replaces. Empty for a property record
	 * and for a proposed insertion.
	 */
	spanIds: string[];
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

/** A run of sibling blocks: their ids in order, and where the run starts. */
export interface BlockRun {
	ids: string[];
	/** The blocks' parent (the top level when absent). */
	parentId?: string;
	/** The first block's index among its siblings. */
	index: number;
	/**
	 * The run's blocks that are one of the given ids or hold one. The
	 * others are only in between.
	 */
	holders: Set< string >;
}

/**
 * The smallest run of sibling blocks that covers the ids present in a
 * document: from the first to the last of them, the blocks in between
 * included.
 *
 * Ids under different parents are covered at the level they meet.
 * Example: a top-level paragraph and a paragraph inside a group are
 * covered by the run from the first paragraph to the group.
 *
 * @param ids Candidate ids.
 * @param doc Document.
 * @return The run (no ids when none is present).
 */
export function coveringRun( ids: string[], doc: EngineDocument ): BlockRun {
	const present = topMostIds( ids, doc );
	if ( 0 === present.length ) {
		return { ids: [], index: 0, holders: new Set() };
	}

	const placed = placements( doc );
	// The ancestors every present id shares: the run is among the
	// children of the last of them.
	const lineages = present.map( ( id ) => placed.get( id )?.ancestors ?? [] );
	let shared = lineages[ 0 ].length;
	for ( const lineage of lineages ) {
		let depth = 0;
		while (
			depth < shared &&
			depth < lineage.length &&
			lineage[ depth ] === lineages[ 0 ][ depth ]
		) {
			depth++;
		}
		shared = depth;
	}
	const parentId = shared > 0 ? lineages[ 0 ][ shared - 1 ] : undefined;

	// Each id stands in the run as itself, or as its ancestor at that
	// level.
	const holders = new Set(
		present.map( ( id, position ) => lineages[ position ][ shared ] ?? id )
	);
	const indexes = Array.from( holders ).map(
		( id ) => placed.get( id )?.index ?? 0
	);
	const first = Math.min( ...indexes );
	const last = Math.max( ...indexes );

	const run: string[] = [];
	for ( const [ id, placement ] of placed ) {
		if (
			placement.parentId === parentId &&
			placement.index >= first &&
			placement.index <= last
		) {
			run[ placement.index - first ] = id;
		}
	}

	return { ids: run, parentId, index: first, holders };
}

/**
 * Every block of a document, at any depth, by id.
 *
 * @param doc Document.
 * @return The blocks.
 */
function blocksById( doc: EngineDocument ): Map< string, EngineBlock > {
	const map = new Map< string, EngineBlock >();
	const walk = ( blocks: EngineBlock[] ) => {
		for ( const block of blocks ) {
			map.set( block.syncId, block );
			walk( block.children );
		}
	};
	walk( doc.root );
	return map;
}

/**
 * The blocks of a record's `proposed` side.
 *
 * The author's own blocks come from the document with the author's edits
 * applied. The blocks in between, which the author did not touch, come
 * from the current document: the author proposed nothing about them, so
 * this side must agree with the current one there. Example: the author
 * changed the first and the third paragraph from an older state, and a
 * collaborator has since rewritten the second. This side shows the
 * author's first and third paragraphs around the collaborator's second
 * one. A reviewer who takes this side whole keeps the collaborator's
 * work.
 *
 * A block in between that the current document no longer has in the
 * run (removed or moved away) is left out. A block the current run
 * gained since goes in after the block it follows there.
 *
 * @param ids         The ids the record's members touch.
 * @param proposedDoc The document with the author's edits applied.
 * @param current     The current document.
 * @return The blocks, in order.
 */
function proposedBlocks(
	ids: string[],
	proposedDoc: EngineDocument,
	current: EngineDocument
): EngineBlock[] {
	const proposedRun = coveringRun( ids, proposedDoc );
	const currentRun = coveringRun( ids, current );
	const fromProposed = blocksById( proposedDoc );
	const fromCurrent = blocksById( current );

	const blocks: EngineBlock[] = [];
	const push = ( block: EngineBlock | undefined, at = blocks.length ) => {
		if ( block ) {
			blocks.splice( at, 0, block );
		}
	};
	for ( const id of proposedRun.ids ) {
		if ( proposedRun.holders.has( id ) ) {
			push( fromProposed.get( id ) );
		} else if ( currentRun.ids.includes( id ) ) {
			push( fromCurrent.get( id ) );
		}
	}

	// What the current run gained in between since the author's state.
	let after = 0;
	for ( const id of currentRun.ids ) {
		const position = blocks.findIndex( ( block ) => block.syncId === id );
		if ( position >= 0 ) {
			after = position + 1;
			continue;
		}
		if ( currentRun.holders.has( id ) ) {
			// One of the author's own blocks: their side removes it or
			// moves it away.
			continue;
		}
		push( fromCurrent.get( id ), after );
		after++;
	}

	return blocks;
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
		// Fold into the earliest overlapping record. Records this unit
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
 * A document with intents applied in order.
 *
 * @param start   The document the intents start from.
 * @param intents The intents.
 * @return The resulting document.
 */
function applyIntents(
	start: EngineDocument,
	intents: IntentEnvelope[]
): EngineDocument {
	let doc = start;
	for ( const intent of intents ) {
		try {
			const result = applyIntent( doc, intent );
			if ( 'applied' === result.disposition.status ) {
				doc = result.doc;
			}
		} catch {
			// An intent the document cannot take is skipped.
		}
	}
	return doc;
}

/**
 * The edits the record's author got accepted from the frames the members
 * were authored at, touching the record's blocks: the part of the
 * author's own view the parked members are expressed against.
 *
 * @param draft The record draft.
 * @param deps  The documents and the log.
 * @return The accepted intents, oldest first.
 */
function acceptedSiblings(
	draft: Draft,
	deps: ConflictDeps
): IntentEnvelope[] {
	if ( ! deps.getLogSince ) {
		return [];
	}
	const baseSeqs = draft.members.map( ( member ) => member.intent.baseSeq );
	const from = Math.min( ...baseSeqs );
	if ( ! Number.isFinite( from ) ) {
		return [];
	}
	const until = Math.max( ...baseSeqs );
	const actorId = draft.members[ 0 ].actorId;
	const memberIds = new Set(
		draft.members.map( ( member ) => member.intent.intentId )
	);
	return deps
		.getLogSince( from )
		.map( ( entry ) => entry.intent )
		.filter(
			( intent ) =>
				intent.actorId === actorId &&
				! memberIds.has( intent.intentId ) &&
				intent.baseSeq >= from &&
				intent.baseSeq <= until &&
				blockIdsOf( intent ).some( ( id ) =>
					draft.blockIds.includes( id )
				)
		);
}

/**
 * The run of blocks a record covers in the current document, or, for a
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
	const run = coveringRun( draft.blockIds, current );
	if ( run.ids.length ) {
		return {
			type: 'blocks',
			ids: run.ids,
			parentId: run.parentId,
			index: run.index,
			count: run.ids.length,
		};
	}
	// No block exists yet: the slot after the first insertion's anchor.
	const placed = placements( current );
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
		// Without the base, the members apply onto the current document
		// (which holds the author's accepted edits already): the closest
		// reading of the author's intent still available.
		const proposedDoc = baseDoc
			? applyIntents( baseDoc, [
					...acceptedSiblings( draft, deps ),
					...draft.members.map( ( member ) => member.intent ),
			  ] )
			: applyIntents(
					current,
					draft.members.map( ( member ) => member.intent )
			  );

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
					coveringRun( draft.blockIds, baseDoc ).ids
				);
			}
			const proposedSide = proposedBlocks(
				draft.blockIds,
				proposedDoc,
				current
			);
			proposed = deps.serializeBlocks(
				{ root: proposedSide },
				proposedSide.map( ( block ) => block.syncId )
			);
			currentSide = deps.serializeBlocks(
				current,
				coveringRun( draft.blockIds, current ).ids
			);
		}

		const target = targetOf( draft, current );

		return {
			conflict: {
				id: draft.members[ 0 ].intent.intentId,
				kind: draft.kind,
				authorId: draft.userId,
				target,
				base,
				proposed,
				current: currentSide,
				/*
				 * The server remembers an author's set-aside edits to a
				 * block across requests and sets their later typing there
				 * aside as dependents (rule 6 seeded from the parked rows),
				 * and those fold into this record. A property write has no
				 * text frame for that. The card then waits for a typing
				 * pause so the record carries the whole sentence.
				 */
				...( 'merge' === draft.kind && undefined === draft.property
					? { followsTyping: true }
					: {} ),
			},
			members: draft.members,
			blockIds: draft.blockIds,
			spanIds: 'blocks' === target.type ? target.ids ?? [] : [],
			property: draft.property,
		};
	} );
}
