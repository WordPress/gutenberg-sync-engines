/**
 * Per-block base honesty: the doc bridge records the TRUE
 * base of blocks kept through colliding incorporations and clears the
 * record once the collision resolves — retiring the silent block-level
 * last-writer-wins.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Y from 'yjs';

import { createDeRtcDocBridge } from '../../../../src/engines/de-rtc/doc-bridge';
import { CRDT_RECORD_MAP_KEY } from '../../../../src/engines/yjs/constants';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncConfig } from '@wordpress/sync';

// Same stand-in as engine.test.ts: content is opaque JSON.
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
const A_LOCAL = {
	name: 'core/paragraph',
	attributes: { content: 'Alpha local' },
};
const A_LOCAL_NEWER = {
	name: 'core/paragraph',
	attributes: { content: 'Alpha local newer' },
};
const A_PEER = {
	name: 'core/paragraph',
	attributes: { content: 'Alpha peer' },
};
const B = { name: 'core/paragraph', attributes: { content: 'Beta' } };
const B_PEER = { name: 'core/paragraph', attributes: { content: 'Beta peer' } };

const contentOf = ( ...blocks: unknown[] ) => JSON.stringify( blocks );

describe( 'de-rtc doc bridge per-block base honesty', () => {
	let doc: Y.Doc;
	let bridge: ReturnType< typeof createDeRtcDocBridge >;

	beforeEach( () => {
		doc = new Y.Doc();
		bridge = createDeRtcDocBridge( doc, makeSyncConfig() );
	} );

	function setLocalBlocks( ...blocks: unknown[] ) {
		doc.getMap( CRDT_RECORD_MAP_KEY ).set( 'blocks', blocks );
	}

	it( 'records the prior version as the base of a kept, collided block', () => {
		bridge.applyCanonical( 'v1', contentOf( A, B ) );
		// The editor typed into Alpha after proposing [A_LOCAL, B].
		setLocalBlocks( A_LOCAL_NEWER, B );

		// A peer's canonical (v2) also changed Alpha: true collision.
		const incorporated = bridge.incorporateCanonicalPreservingLocalEdits(
			'v2',
			contentOf( A_PEER, B ),
			contentOf( A_LOCAL, B )
		);

		expect( incorporated ).toBe( true );
		expect( bridge.lastVersion() ).toBe( 'v2' );
		expect( bridge.blockBaseVersions() ).toEqual( { 0: 'v1' } );
	} );

	it( 'does not record a base for kept blocks the canonical left alone', () => {
		bridge.applyCanonical( 'v1', contentOf( A, B ) );
		setLocalBlocks( A_LOCAL_NEWER, B );

		// Canonical v2 changed only Beta; our kept Alpha is a clean
		// sole-writer change — no collision, no record.
		bridge.incorporateCanonicalPreservingLocalEdits(
			'v2',
			contentOf( A_LOCAL, B_PEER ),
			contentOf( A_LOCAL, B )
		);

		expect( bridge.blockBaseVersions() ).toEqual( {} );
	} );

	it( 'keeps the OLDEST base across repeated collisions', () => {
		bridge.applyCanonical( 'v1', contentOf( A, B ) );
		setLocalBlocks( A_LOCAL_NEWER, B );
		bridge.incorporateCanonicalPreservingLocalEdits(
			'v2',
			contentOf( A_PEER, B ),
			contentOf( A_LOCAL, B )
		);
		// A second colliding canonical arrives while the block stays hot.
		bridge.incorporateCanonicalPreservingLocalEdits(
			'v3',
			contentOf( A_PEER, B_PEER ),
			contentOf( A_LOCAL, B )
		);

		expect( bridge.blockBaseVersions() ).toEqual( { 0: 'v1' } );
	} );

	it( 'clears the record when the block adopts canonical', () => {
		bridge.applyCanonical( 'v1', contentOf( A, B ) );
		setLocalBlocks( A_LOCAL_NEWER, B );
		bridge.incorporateCanonicalPreservingLocalEdits(
			'v2',
			contentOf( A_PEER, B ),
			contentOf( A_LOCAL, B )
		);
		expect( bridge.blockBaseVersions() ).toEqual( { 0: 'v1' } );

		// The conflicted block settles (our salvaged/parked proposal came
		// back; the doc holds exactly what we last proposed), so the next
		// incorporation ADOPTS canonical for it.
		setLocalBlocks( A_LOCAL_NEWER, B );
		bridge.incorporateCanonicalPreservingLocalEdits(
			'v3',
			contentOf( A_PEER, B ),
			contentOf( A_LOCAL_NEWER, B )
		);

		expect( bridge.blockBaseVersions() ).toEqual( {} );
	} );

	it( 'clears every record on wholesale adoption and on version-only advance', () => {
		bridge.applyCanonical( 'v1', contentOf( A, B ) );
		setLocalBlocks( A_LOCAL_NEWER, B );
		bridge.incorporateCanonicalPreservingLocalEdits(
			'v2',
			contentOf( A_PEER, B ),
			contentOf( A_LOCAL, B )
		);
		expect( bridge.blockBaseVersions() ).toEqual( { 0: 'v1' } );

		bridge.applyCanonical( 'v3', contentOf( A_PEER, B ) );
		expect( bridge.blockBaseVersions() ).toEqual( {} );

		setLocalBlocks( A_LOCAL_NEWER, B );
		bridge.incorporateCanonicalPreservingLocalEdits(
			'v4',
			contentOf( A_PEER, B ),
			contentOf( A_LOCAL, B )
		);
		expect( bridge.blockBaseVersions() ).toEqual( { 0: 'v3' } );

		bridge.advanceVersion( 'v5' );
		expect( bridge.blockBaseVersions() ).toEqual( {} );
	} );
} );

/**
 * Durable identity on the client: a canonical application re-keys the
 * freshly parsed blocks onto the clientIds the doc already holds for the
 * same `metadata.syncId`, so the canvas never remounts a block that only
 * kept its identity across the round trip.
 */
describe( 'de-rtc doc bridge clientId stability by syncId', () => {
	const withId = ( block: any, syncId: string, clientId?: string ) => ( {
		...block,
		...( clientId ? { clientId } : {} ),
		attributes: { ...block.attributes, metadata: { syncId } },
	} );

	let doc: Y.Doc;
	let bridge: ReturnType< typeof createDeRtcDocBridge >;

	beforeEach( () => {
		doc = new Y.Doc();
		bridge = createDeRtcDocBridge( doc, makeSyncConfig() );
	} );

	function localBlocks(): any[] {
		return doc.getMap( CRDT_RECORD_MAP_KEY ).get( 'blocks' ) as any[];
	}

	it( 'keeps the clientId of every block whose identity survived, at every depth', () => {
		bridge.applyCanonical(
			'v1',
			contentOf( withId( A, 'id-a' ), withId( B, 'id-b' ) )
		);
		// The editor assigned clientIds to what it rendered.
		doc.getMap( CRDT_RECORD_MAP_KEY ).set( 'blocks', [
			{
				name: 'core/group',
				clientId: 'c-group',
				attributes: { metadata: { syncId: 'id-group' } },
				innerBlocks: [ withId( A, 'id-a', 'c-a' ) ],
			},
			withId( B, 'id-b', 'c-b' ),
		] );

		bridge.applyCanonical(
			'v2',
			contentOf(
				{
					name: 'core/group',
					clientId: 'fresh-group',
					attributes: { metadata: { syncId: 'id-group' } },
					innerBlocks: [ withId( A_PEER, 'id-a', 'fresh-a' ) ],
				},
				withId( B, 'id-b', 'fresh-b' ),
				withId(
					{ name: 'core/paragraph', attributes: { content: 'New' } },
					'id-new',
					'fresh-new'
				)
			)
		);

		const blocks = localBlocks();
		expect( blocks[ 0 ].clientId ).toBe( 'c-group' );
		expect( blocks[ 0 ].innerBlocks[ 0 ].clientId ).toBe( 'c-a' );
		expect( blocks[ 0 ].innerBlocks[ 0 ].attributes.content ).toBe(
			'Alpha peer'
		);
		expect( blocks[ 1 ].clientId ).toBe( 'c-b' );
		expect( blocks[ 2 ].clientId ).toBe( 'fresh-new' );
	} );

	it( 'maps a duplicated identity once so clientIds stay unique', () => {
		doc.getMap( CRDT_RECORD_MAP_KEY ).set( 'blocks', [
			withId( A, 'id-a', 'c-a' ),
		] );
		bridge.applyCanonical(
			'v1',
			contentOf(
				withId( A, 'id-a', 'fresh-1' ),
				withId( B, 'id-a', 'fresh-2' )
			)
		);
		expect( localBlocks().map( ( block ) => block.clientId ) ).toEqual( [
			'c-a',
			'fresh-2',
		] );
	} );

	it( 'stabilizes the adopted blocks of an incorporation too', () => {
		bridge.applyCanonical(
			'v1',
			contentOf( withId( A, 'id-a' ), withId( B, 'id-b' ) )
		);
		doc.getMap( CRDT_RECORD_MAP_KEY ).set( 'blocks', [
			withId( A_LOCAL_NEWER, 'id-a', 'c-a' ),
			withId( B, 'id-b', 'c-b' ),
		] );

		bridge.incorporateCanonicalPreservingLocalEdits(
			'v2',
			contentOf(
				withId( A, 'id-a', 'fresh-a' ),
				withId( B_PEER, 'id-b', 'fresh-b' )
			),
			contentOf(
				withId( A_LOCAL, 'id-a', 'c-a' ),
				withId( B, 'id-b', 'c-b' )
			)
		);

		const blocks = localBlocks();
		expect( blocks[ 0 ].clientId ).toBe( 'c-a' ); // Kept local block.
		expect( blocks[ 1 ].clientId ).toBe( 'c-b' ); // Adopted canonical block.
		expect( blocks[ 1 ].attributes.content ).toBe( 'Beta peer' );
	} );
} );
