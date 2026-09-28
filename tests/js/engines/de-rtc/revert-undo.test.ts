/**
 * DE-RTC revert-edit undo: undo never undoes — it derives a
 * revert from the client's own accepted canonical rows and applies it
 * as an ordinary dirty edit; redo re-applies the reverted delta; peer
 * work is never collateral.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Y from 'yjs';

import { createDeRtcDocBridge } from '../../../../src/engines/de-rtc/doc-bridge';
import {
	createDeRtcRevertUndoManager,
	createDeRtcUndoFeed,
} from '../../../../src/engines/de-rtc/revert-undo';
import { createDeRtcSessionCodec } from '../../../../src/engines/de-rtc/session';
import { CRDT_RECORD_MAP_KEY } from '../../../../src/engines/yjs/constants';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncConfig } from '@wordpress/sync';

jest.mock( '@wordpress/blocks', () => ( {
	parse: ( content: string ) => ( content ? JSON.parse( content ) : [] ),
	__unstableSerializeAndClean: ( blocks: unknown[] ) =>
		JSON.stringify( blocks ),
} ) );

function makeSyncConfig(): jest.MockedObject< SyncConfig > {
	return {
		applyChangesToCRDTDoc: jest.fn( ( doc: Y.Doc, changes: any ) => {
			const map = doc.getMap( CRDT_RECORD_MAP_KEY );
			Object.entries( changes ).forEach( ( [ key, value ] ) => {
				map.set( key, value );
			} );
		} ),
		getChangesFromCRDTDoc: jest.fn( ( doc: Y.Doc ) =>
			doc.getMap( CRDT_RECORD_MAP_KEY ).toJSON()
		),
	} as unknown as jest.MockedObject< SyncConfig >;
}

const A = { name: 'core/paragraph', attributes: { content: 'Alpha' } };
const A_MINE = {
	name: 'core/paragraph',
	attributes: { content: 'Alpha, edited by me' },
};
const A_PEER = {
	name: 'core/paragraph',
	attributes: { content: 'Alpha, rewritten by a peer' },
};
const B = { name: 'core/paragraph', attributes: { content: 'Beta' } };

const contentOf = ( ...blocks: unknown[] ) => JSON.stringify( blocks );

describe( 'de-rtc revert-edit undo', () => {
	let doc: Y.Doc;
	let bridge: ReturnType< typeof createDeRtcDocBridge >;
	let feed: ReturnType< typeof createDeRtcUndoFeed >;
	let manager: ReturnType< typeof createDeRtcRevertUndoManager >;
	let applied: unknown[][];

	beforeEach( () => {
		doc = new Y.Doc();
		const syncConfig = makeSyncConfig();
		bridge = createDeRtcDocBridge( doc, syncConfig );
		feed = createDeRtcUndoFeed();
		manager = createDeRtcRevertUndoManager();
		applied = [];
		manager.attachEntity( {
			key: doc.getMap( CRDT_RECORD_MAP_KEY ) as Y.Map< unknown >,
			bridge,
			feed,
			applyRevert: ( blocks ) => {
				applied.push( blocks );
				doc.getMap( CRDT_RECORD_MAP_KEY ).set( 'blocks', blocks );
			},
		} );
	} );

	function canonical( version: string, content: string ) {
		bridge.applyCanonical( version, content );
		feed.noteRow( { version, baseVersion: null, content, own: false } );
	}

	function ownRow( version: string, baseVersion: string, content: string ) {
		bridge.applyCanonical( version, content );
		feed.noteRow( { version, baseVersion, content, own: true } );
	}

	it( 'undo derives a revert from the own accepted row; redo re-applies it', () => {
		canonical( 'v1', contentOf( A, B ) );
		expect( manager.hasUndo() ).toBe( false );

		ownRow( 'v2', 'v1', contentOf( A_MINE, B ) );
		expect( manager.hasUndo() ).toBe( true );

		manager.undo();
		expect( applied ).toHaveLength( 1 );
		expect( applied[ 0 ] ).toEqual( [ A, B ] );
		expect( manager.hasUndo() ).toBe( false );
		expect( manager.hasRedo() ).toBe( true );

		// The server accepts the revert as our own row: predicted, so it
		// is undo/redo choreography — not a new undoable edit.
		feed.noteRow( {
			version: 'v3',
			baseVersion: 'v2',
			content: contentOf( A, B ),
			own: true,
		} );
		expect( manager.hasUndo() ).toBe( false );

		manager.redo();
		expect( applied ).toHaveLength( 2 );
		expect( applied[ 1 ] ).toEqual( [ A_MINE, B ] );
		expect( manager.hasRedo() ).toBe( false );
		expect( manager.hasUndo() ).toBe( true );
	} );

	it( 'a peer-touched block is never collateral', () => {
		canonical( 'v1', contentOf( A, B ) );
		ownRow( 'v2', 'v1', contentOf( A_MINE, B ) );
		// A peer rewrites the SAME block after my edit.
		canonical( 'v3', contentOf( A_PEER, B ) );

		manager.undo();
		// My only changed block was touched since: nothing to revert.
		expect( applied ).toHaveLength( 0 );
	} );

	it( 'a new own edit forks history: redo becomes unreachable', () => {
		canonical( 'v1', contentOf( A, B ) );
		ownRow( 'v2', 'v1', contentOf( A_MINE, B ) );
		manager.undo();
		expect( manager.hasRedo() ).toBe( true );

		ownRow(
			'v4',
			'v3',
			contentOf( A, { ...B, attributes: { content: 'Beta anew' } } )
		);
		expect( manager.hasRedo() ).toBe( false );
	} );

	it( 'the session codec feeds canonical snapshots to the undo feed as peer rows', () => {
		const rows: any[] = [];
		feed.subscribe( ( row ) => rows.push( row ) );
		const codec = createDeRtcSessionCodec( {
			bridge,
			undoFeed: feed,
		} );

		codec.receiveUpdate( {
			type: 'snapshot',
			data: JSON.stringify( {
				version: 'v1',
				content: contentOf( A, B ),
			} ),
		} );
		// A peer's version, delivered as the fetch answer (own accepted
		// proposals reach the feed from the announce path instead).
		codec.receiveUpdate( {
			type: 'snapshot',
			data: JSON.stringify( {
				version: 'v2',
				content: contentOf( A_PEER, B ),
				ephemeral: true,
			} ),
		} );

		expect( rows ).toHaveLength( 2 );
		expect( rows[ 0 ] ).toMatchObject( { version: 'v1', own: false } );
		expect( rows[ 1 ] ).toMatchObject( {
			version: 'v2',
			baseVersion: null,
			own: false,
		} );
	} );
} );
