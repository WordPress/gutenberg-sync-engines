/**
 * External dependencies
 */
import * as Y from 'yjs';

/**
 * WordPress dependencies
 */
import { registerBlockType, unregisterBlockType } from '@wordpress/blocks';

/**
 * Internal dependencies
 */
import {
	createStore,
	applyMiddleware,
} from '../../gutenberg/node_modules/redux';
import reducer from '../../gutenberg/packages/block-editor/build/store/reducer.cjs';
import * as actions from '../../gutenberg/packages/block-editor/build/store/actions.cjs';
import * as privateActions from '../../gutenberg/packages/block-editor/build/store/private-actions.cjs';
import * as selectors from '../../gutenberg/packages/block-editor/build/store/selectors.cjs';
import createThunkMiddleware from '../../gutenberg/packages/data/build/redux-store/thunk-middleware.cjs';
import { createActionCapture } from './semantic-capture/capture';
import { applyPlainTextEvent } from './semantic-capture/yjs-text';

function paragraph( clientId, content, id = clientId ) {
	return {
		clientId,
		name: 'core/paragraph',
		isValid: true,
		attributes: { content, metadata: { syncId: id } },
		innerBlocks: [],
	};
}

// These are the real block reducer, action creators, and thunk middleware.
// Only permission answers and the surrounding editor registry are fixtures.
function editor(
	blocks = [ paragraph( 'p', 'Hello' ), paragraph( 'q', 'Other' ) ]
) {
	let context = { entity: 'postType/post:42', source: 'bootstrap' };
	const reads = [];
	const capture = createActionCapture( {
		context: () => context,
		createId: () => `event-${ capture.events.length + 1 }`,
		readBlock: ( state, clientId ) => {
			reads.push( clientId );
			const attributes = selectors.getBlockAttributes( state, clientId );
			if ( ! attributes ) {
				return null;
			}
			return {
				clientId,
				id: attributes.metadata?.syncId,
				name: selectors.getBlockName( state, clientId ),
				attributes: JSON.parse( JSON.stringify( attributes ) ),
				parent: selectors.getBlockRootClientId( state, clientId ),
				index: selectors.getBlockIndex( state, clientId ),
				childCount: selectors.getBlockOrder( state, clientId ).length,
			};
		},
	} );
	const dispatch = ( action ) => store.dispatch( action );
	Object.entries( { ...actions, ...privateActions } ).forEach(
		( [ name, creator ] ) => {
			dispatch[ name ] = ( ...args ) => dispatch( creator( ...args ) );
		}
	);
	const select = {
		canMoveBlocks: () => true,
		canRemoveBlocks: () => true,
		canInsertBlocks: () => true,
		canInsertBlockType: () => true,
		getBlockRootClientId: ( id ) =>
			selectors.getBlockRootClientId( store.getState(), id ),
		getBlockCount: () => selectors.getBlockCount( store.getState() ),
		getSelectedBlockClientId: () =>
			selectors.getSelectedBlockClientId( store.getState() ),
	};
	const store = createStore(
		reducer,
		applyMiddleware(
			createThunkMiddleware( {
				select,
				dispatch,
				registry: { batch: ( fn ) => fn() },
			} ),
			capture.middleware
		)
	);
	dispatch( { type: 'RESET_BLOCKS', blocks } );
	context = { ...context, source: 'local' };
	return {
		...capture,
		store,
		dispatch,
		select,
		reads,
		setContext: ( changes ) => {
			context = { ...context, ...changes };
		},
	};
}

beforeAll( () => {
	registerBlockType( 'core/paragraph', {
		apiVersion: 3,
		title: 'Paragraph',
		category: 'text',
		attributes: {
			content: { type: 'string', default: '' },
			metadata: { type: 'object' },
		},
		save: () => null,
	} );
} );
afterAll( () => unregisterBlockType( 'core/paragraph' ) );

describe( 'Gutenberg semantic capture prototype', () => {
	it( 'reads only the changed paragraph in a 1,000-block document', () => {
		const e = editor(
			Array.from( { length: 1000 }, ( _, i ) =>
				paragraph( `p${ i }`, 'Hello' )
			)
		);
		e.dispatch.updateBlockAttributes( 'p500', { content: 'Hello world' } );
		expect( e.reads ).toEqual( [ 'p500', 'p500' ] );
		expect( e.events ).toHaveLength( 1 );
		expect( e.events[ 0 ] ).toMatchObject( {
			entity: 'postType/post:42',
			kind: 'attributes',
			fields: { p500: [ 'content' ] },
			before: [ { attributes: { content: 'Hello' } } ],
			after: [ { attributes: { content: 'Hello world' } } ],
		} );
	} );

	it( 'records actual movement after the real thunk dispatches', () => {
		const e = editor();
		e.dispatch.moveBlocksToPosition( [ 'p' ], '', '', 1 );
		expect( selectors.getBlockOrder( e.store.getState() ) ).toEqual( [
			'q',
			'p',
		] );
		expect( e.events[ 0 ] ).toMatchObject( {
			kind: 'move',
			before: [ { id: 'p', index: 0 } ],
			after: [ { id: 'p', index: 1 } ],
		} );
		expect( e.reads ).toEqual( [ 'p', 'p' ] );
	} );

	it( 'does not report a move refused by the command permission check', () => {
		const e = editor();
		e.select.canMoveBlocks = () => false;
		e.dispatch.moveBlocksToPosition( [ 'p' ], '', '', 1 );
		expect( e.events ).toEqual( [] );
		expect( e.reads ).toEqual( [] );
	} );

	it( 'keeps a split command attached to the actual replacement', () => {
		const e = editor();
		e.setContext( { command: { id: 'command-1', kind: 'split' } } );
		e.dispatch.replaceBlocks(
			[ 'p' ],
			[ paragraph( 'left', 'He', 'p' ), paragraph( 'right', 'llo' ) ]
		);
		expect( e.events ).toHaveLength( 1 );
		expect( e.events[ 0 ] ).toMatchObject( {
			kind: 'split',
			commandId: 'command-1',
			before: [ { id: 'p', attributes: { content: 'Hello' } } ],
			after: [
				{ id: 'p', attributes: { content: 'He' } },
				{ id: 'right', attributes: { content: 'llo' } },
			],
		} );
		expect( e.reads ).toEqual( [ 'p', 'left', 'right' ] );
	} );

	it( 'does not guess that a generic replacement means split', () => {
		const e = editor();
		e.dispatch.replaceBlocks(
			[ 'p' ],
			[ paragraph( 'left', 'He', 'p' ), paragraph( 'right', 'llo' ) ]
		);
		expect( e.events[ 0 ].kind ).toBe( 'replace' );
	} );

	it( 'reports unsupported split results instead of inventing an explanation', () => {
		const e = editor();
		e.setContext( { command: { id: 'command-1', kind: 'split' } } );
		e.dispatch.replaceBlocks(
			[ 'p' ],
			[ paragraph( 'left', 'Changed' ), paragraph( 'right', 'llo' ) ]
		);
		expect( e.events ).toEqual( [] );
		expect( e.fallbacks ).toContainEqual(
			expect.objectContaining( {
				reason: 'split-result-does-not-match-command',
			} )
		);
	} );

	it.each( [ 'remote', 'bootstrap' ] )(
		'does not recapture %s changes',
		( source ) => {
			const e = editor();
			e.setContext( { source } );
			e.dispatch.updateBlockAttributes( 'p', { content: 'Received' } );
			expect( e.events ).toEqual( [] );
			expect( e.reads ).toEqual( [] );
			expect(
				selectors.getBlockAttributes( e.store.getState(), 'p' ).content
			).toBe( 'Received' );
		}
	);

	it( 'ignores unchanged attributes and retains evidence after a reset', () => {
		const e = editor();
		e.dispatch.updateBlockAttributes( 'p', { content: 'Hello' } );
		expect( e.events ).toEqual( [] );
		e.dispatch.updateBlockAttributes( 'p', { content: 'New' } );
		e.dispatch( { type: 'RESET_BLOCKS', blocks: [] } );
		expect( e.events[ 0 ].before[ 0 ].attributes.content ).toBe( 'Hello' );
		expect( e.events[ 0 ].after[ 0 ].attributes.content ).toBe( 'New' );
		expect( e.fallbacks ).toContainEqual(
			expect.objectContaining( { action: 'RESET_BLOCKS' } )
		);
	} );

	it( 'handles attribute updates with different values for each block', () => {
		const e = editor();
		e.dispatch.updateBlockAttributes(
			[ 'p', 'q' ],
			{ p: { content: 'First' }, q: { content: 'Second' } },
			{ uniqueByBlock: true }
		);
		expect( e.events[ 0 ].fields ).toEqual( {
			p: [ 'content' ],
			q: [ 'content' ],
		} );
	} );

	it( 'requests fallback when a block has no durable identity', () => {
		const e = editor( [ paragraph( 'p', 'Hello', '' ) ] );
		e.dispatch.updateBlockAttributes( 'p', { content: 'New' } );
		expect( e.events ).toEqual( [] );
		expect( e.fallbacks ).toHaveLength( 1 );
	} );

	it( 'does not attribute an identity replacement to the original block', () => {
		const e = editor();
		e.dispatch.updateBlockAttributes( 'p', {
			metadata: { syncId: 'different' },
		} );
		expect( e.events ).toEqual( [] );
		expect( e.fallbacks[ 0 ].reason ).toBe(
			'identity-changed-or-duplicated'
		);
	} );

	it( 'rejects a split that gives both new blocks the same durable ID', () => {
		const e = editor();
		e.setContext( { command: { id: 'command-1', kind: 'split' } } );
		e.dispatch.replaceBlocks(
			[ 'p' ],
			[ paragraph( 'left', 'He', 'p' ), paragraph( 'right', 'llo', 'p' ) ]
		);
		expect( e.events ).toEqual( [] );
		expect( e.fallbacks[ 0 ].reason ).toBe(
			'identity-changed-or-duplicated'
		);
	} );
} );

describe( 'targeted Yjs text application', () => {
	it( 'merges concurrent captured edits and preserves audit evidence after GC', () => {
		const a = new Y.Doc();
		const b = new Y.Doc();
		a.getText( 'p' ).insert( 0, 'Hello' );
		Y.applyUpdate( b, Y.encodeStateAsUpdate( a ) );
		const alice = editor();
		const bob = editor();
		alice.dispatch.updateBlockAttributes( 'p', { content: 'Hello A' } );
		bob.dispatch.updateBlockAttributes( 'p', { content: 'B Hello' } );
		const updatesA = [];
		const updatesB = [];
		a.on( 'update', ( update ) => updatesA.push( update ) );
		b.on( 'update', ( update ) => updatesB.push( update ) );
		expect(
			applyPlainTextEvent( a, alice.events[ 0 ], ( id ) =>
				a.getText( id )
			)
		).toBe( true );
		expect(
			applyPlainTextEvent( b, bob.events[ 0 ], ( id ) => b.getText( id ) )
		).toBe( true );
		const fromA = updatesA[ 0 ];
		const fromB = updatesB[ 0 ];
		Y.applyUpdate( a, fromB );
		Y.applyUpdate( b, fromA );
		Y.applyUpdate( b, fromA ); // Duplicate delivery must not duplicate text.
		expect( a.getText( 'p' ).toString() ).toBe( 'B Hello A' );
		expect( b.getText( 'p' ).toString() ).toBe( 'B Hello A' );
		a.getText( 'p' ).delete( 0, a.getText( 'p' ).length );
		const checkpoint = Y.encodeStateAsUpdate( a );
		updatesA.length = updatesB.length = 0;
		a.destroy();
		b.destroy();
		const restored = new Y.Doc();
		Y.applyUpdate( restored, checkpoint );
		expect( restored.getText( 'p' ).toString() ).toBe( '' );
		expect( alice.events[ 0 ].after[ 0 ].attributes.content ).toBe(
			'Hello A'
		);
		expect( bob.events[ 0 ].after[ 0 ].attributes.content ).toBe(
			'B Hello'
		);
		restored.destroy();
	} );

	it.each( [
		[ 'Hello', 'Hi' ],
		[ 'Hello', '' ],
		[ 'a😀z', 'a😁z' ],
	] )( 'applies a field edit from %s to %s', ( before, after ) => {
		const e = editor( [ paragraph( 'p', before ) ] );
		e.dispatch.updateBlockAttributes( 'p', { content: after } );
		const doc = new Y.Doc();
		doc.getText( 'p' ).insert( 0, before );
		expect(
			applyPlainTextEvent( doc, e.events[ 0 ], ( id ) =>
				doc.getText( id )
			)
		).toBe( true );
		expect( doc.getText( 'p' ).toString() ).toBe( after );
		doc.destroy();
	} );

	it.each( [
		[ 'Stale', 'Hello world' ],
		[ 'Hello', '<b>Hello</b>' ],
	] )( 'refuses stale text or rich HTML (%s, %s)', ( current, after ) => {
		const e = editor();
		e.dispatch.updateBlockAttributes( 'p', { content: after } );
		const doc = new Y.Doc();
		doc.getText( 'p' ).insert( 0, current );
		expect(
			applyPlainTextEvent( doc, e.events[ 0 ], ( id ) =>
				doc.getText( id )
			)
		).toBe( false );
		expect( doc.getText( 'p' ).toString() ).toBe( current );
		doc.destroy();
	} );
} );
