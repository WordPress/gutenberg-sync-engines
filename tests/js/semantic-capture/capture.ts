/**
 * Isolated prototype. Install AFTER thunk handling, before the reducer.
 * No production entry point imports this module.
 */
export interface BlockEvidence {
	clientId: string;
	id: string;
	name: string;
	attributes: Record< string, unknown >;
	parent: string;
	index: number;
	childCount: number;
}

export interface CaptureContext {
	entity: string;
	source: 'local' | 'remote' | 'bootstrap';
	command?: { id: string; kind: 'split' };
}

export interface EditingAction {
	type: string;
	clientIds?: string[];
	attributes?: Record< string, unknown >;
	options?: { uniqueByBlock?: boolean };
	blocks?: { clientId: string }[];
}

export interface EditingEvent {
	id: string;
	entity: string;
	commandId?: string;
	kind: 'attributes' | 'move' | 'split' | 'replace';
	fields: Record< string, string[] >;
	before: BlockEvidence[];
	after: BlockEvidence[];
}

interface Options< State > {
	context: () => CaptureContext;
	/** Return detached evidence, not references to mutable editor values. */
	readBlock: ( state: State, clientId: string ) => BlockEvidence | null;
	createId: () => string;
}

const MOVES = new Set( [
	'MOVE_BLOCKS_TO_POSITION',
	'MOVE_BLOCKS_UP',
	'MOVE_BLOCKS_DOWN',
] );

/**
 * Capture only addressed blocks. The reader has no whole-tree operation.
 * @param options Context, targeted reader, and event ID factory.
 */
export function createActionCapture< State >( options: Options< State > ) {
	const events: EditingEvent[] = [];
	const fallbacks: { entity: string; action: string; reason: string }[] = [];

	const middleware =
		( store: { getState: () => State } ) =>
		( next: ( action: EditingAction ) => unknown ) =>
		( action: EditingAction ): unknown => {
			const context = options.context();
			if (
				context.source !== 'local' ||
				action.type.startsWith( '@@' )
			) {
				return next( action );
			}
			// Selection changes are not document changes. Unknown actions are
			// reported rather than guessed; production needs a complete policy.
			if (
				[ 'SELECT_BLOCK', 'SELECTION_CHANGE' ].includes( action.type )
			) {
				return next( action );
			}
			const fallback = ( reason: string ) => {
				fallbacks.push( {
					entity: context.entity,
					action: action.type,
					reason,
				} );
			};
			let kind: EditingEvent[ 'kind' ];
			if ( action.type === 'UPDATE_BLOCK_ATTRIBUTES' ) {
				kind = 'attributes';
			} else if ( MOVES.has( action.type ) ) {
				kind = 'move';
			} else if ( action.type === 'REPLACE_BLOCKS' ) {
				kind = context.command?.kind === 'split' ? 'split' : 'replace';
			} else {
				const result = next( action );
				fallback( 'unsupported-action' );
				return result;
			}

			const ids = [ ...new Set( action.clientIds || [] ) ];
			const afterIds =
				kind === 'replace' || kind === 'split'
					? ( action.blocks || [] ).map( ( block ) => block.clientId )
					: ids;
			const read = ( clientIds: string[] ) =>
				clientIds.map( ( id ) =>
					options.readBlock( store.getState(), id )
				);
			const before = read( ids );
			const result = next( action );
			const after = read( afterIds );
			if (
				! before.length ||
				! after.length ||
				[ ...before, ...after ].some(
					( block ) => ! block || ! block.id || block.childCount > 0
				)
			) {
				fallback( 'missing-identity-or-non-leaf-block' );
				return result;
			}
			const oldBlocks = before as BlockEvidence[];
			const newBlocks = after as BlockEvidence[];
			if (
				new Set( oldBlocks.map( ( block ) => block.id ) ).size !==
					oldBlocks.length ||
				new Set( newBlocks.map( ( block ) => block.id ) ).size !==
					newBlocks.length ||
				( ( kind === 'attributes' || kind === 'move' ) &&
					oldBlocks.some(
						( block, index ) => block.id !== newBlocks[ index ].id
					) )
			) {
				fallback( 'identity-changed-or-duplicated' );
				return result;
			}
			const fields: Record< string, string[] > = {};
			if ( kind === 'attributes' ) {
				oldBlocks.forEach( ( block, index ) => {
					const attributes = action.options?.uniqueByBlock
						? ( action.attributes?.[ block.clientId ] as Record<
								string,
								unknown
						  > )
						: action.attributes;
					fields[ block.id ] = Object.keys( attributes || {} ).filter(
						( field ) =>
							JSON.stringify( block.attributes[ field ] ) !==
							JSON.stringify(
								newBlocks[ index ].attributes[ field ]
							)
					);
				} );
				if (
					Object.values( fields ).every( ( names ) => ! names.length )
				) {
					return result;
				}
			} else if (
				JSON.stringify( oldBlocks ) === JSON.stringify( newBlocks )
			) {
				return result;
			}
			if (
				kind === 'split' &&
				( oldBlocks.length !== 1 ||
					newBlocks.length !== 2 ||
					[ ...oldBlocks, ...newBlocks ].some(
						( block ) => block.name !== 'core/paragraph'
					) ||
					newBlocks.some(
						( block ) =>
							typeof block.attributes.content !== 'string'
					) ||
					newBlocks
						.map( ( block ) => block.attributes.content )
						.join( '' ) !== oldBlocks[ 0 ].attributes.content )
			) {
				fallback( 'split-result-does-not-match-command' );
				return result;
			}
			// A detached record survives later edits, reset, and Yjs GC.
			events.push(
				JSON.parse(
					JSON.stringify( {
						id: options.createId(),
						entity: context.entity,
						commandId: context.command?.id,
						kind,
						fields,
						before: oldBlocks,
						after: newBlocks,
					} )
				)
			);
			return result;
		};

	return { middleware, events, fallbacks };
}
