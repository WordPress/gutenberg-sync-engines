/**
 * External dependencies
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Y from 'yjs';

/**
 * Internal dependencies
 */
import { hashDeRtcContent } from '../../../../src/engines/de-rtc/descriptor';
import { createDeRtcEngine } from '../../../../src/engines/de-rtc/engine';
import {
	DE_RTC_ANNOUNCE_TYPE,
	DE_RTC_PROPOSAL_TYPE,
	DE_RTC_SNAPSHOT_TYPE,
	DE_RTC_PARKED_TYPE,
} from '../../../../src/engines/de-rtc/session';
import {
	propertyValuesEqual,
	unflattenProperties,
} from '../../../../src/engines/de-rtc/doc-bridge';
import { CRDT_RECORD_MAP_KEY } from '../../../../src/engines/yjs/constants';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncConfig } from '@wordpress/sync';

// Same opaque-JSON block stand-in as the engine tests.
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
				if ( 'meta' === key && value && 'object' === typeof value ) {
					// Merge meta per key, like core-data's real mapping —
					// a partial meta object must not wipe sibling keys.
					const current = map.get( 'meta' );
					map.set( 'meta', {
						...( current && 'object' === typeof current
							? current
							: {} ),
						...( value as object ),
					} );
					return;
				}
				map.set( key, value );
			} );
		} ),
		getChangesFromCRDTDoc: jest.fn( ( doc: Y.Doc ) =>
			doc.getMap( CRDT_RECORD_MAP_KEY ).toJSON()
		),
	} as unknown as jest.MockedObject< SyncConfig >;
}

const BLOCK_A = { name: 'core/paragraph', attributes: { content: 'Alpha' } };
const contentOf = ( ...blocks: unknown[] ) => JSON.stringify( blocks );

const snapshotRow = (
	version: string,
	content: string,
	properties?: Record< string, unknown >
) => ( {
	type: DE_RTC_SNAPSHOT_TYPE,
	data: JSON.stringify( { version, content, properties } ),
} );

describe( 'de-rtc property sync (client)', () => {
	let syncConfig: jest.MockedObject< SyncConfig >;
	let engine: ReturnType< typeof createDeRtcEngine >;

	beforeEach( () => {
		syncConfig = makeSyncConfig();
		engine = createDeRtcEngine();
	} );

	function makeEntity() {
		const entity = engine.createEntity( {
			syncConfig,
			// A type WITHOUT a commit route: these suites pin the transport
			// proposal lane (collections/unsupported types still use it).
			objectType: 'postType/book',
			objectId: '1',
		} as any );
		const session = entity.createSession();
		const sent: any[] = [];
		session.onLocalUpdate( ( update: any ) => sent.push( update ) );
		return { entity, session, sent };
	}

	it( "proposals carry the doc's full property map, flattened and canonicalized", () => {
		const { entity, session, sent } = makeEntity();
		session.receiveUpdate(
			snapshotRow( 'v1', contentOf( BLOCK_A ), {
				title: 'Seeded',
				tags: [ 1, 3 ],
				'meta.note': 'a',
			} )
		);

		entity.applyLocalChanges(
			{
				title: 'Edited title',
				tags: [ 3, 1 ],
				meta: { note: 'b' },
			} as any,
			'editor',
			{}
		);

		const proposals = sent.filter(
			( update ) => DE_RTC_PROPOSAL_TYPE === update.type
		);
		expect( proposals ).toHaveLength( 1 );
		const payload = JSON.parse( proposals[ 0 ].data );
		expect( payload.proposedProperties.title ).toBe( 'Edited title' );
		// Term arrays canonicalize to numeric order.
		expect( payload.proposedProperties.tags ).toEqual( [ 1, 3 ] );
		// Meta flattens to per-key registers.
		expect( payload.proposedProperties[ 'meta.note' ] ).toBe( 'b' );
		expect( payload.proposedProperties.blocks ).toBeUndefined();
	} );

	it( 'canonical snapshots apply properties into the doc and reach the editor', () => {
		const { entity, session } = makeEntity();
		session.receiveUpdate(
			snapshotRow( 'v1', contentOf( BLOCK_A ), { title: 'Seeded' } )
		);

		// A peer's accepted version, delivered as the fetch answer.
		session.receiveUpdate(
			snapshotRow( 'v2', contentOf( BLOCK_A ), {
				title: 'Peer title',
				'meta.note': 'peer',
			} )
		);

		const changes = entity.getEditorChanges( {} as any ) as any;
		expect( changes.title ).toBe( 'Peer title' );
		expect( changes.meta ).toEqual( { note: 'peer' } );
	} );

	it( 'a property-only edit round-trips without touching newer local keystrokes', () => {
		const { entity, session, sent } = makeEntity();
		session.receiveUpdate(
			snapshotRow( 'v1', contentOf( BLOCK_A ), { title: 'Seeded' } )
		);

		entity.applyLocalChanges( { title: 'Mine' } as any, 'editor', {} );
		const payload = JSON.parse( sent[ 0 ].data );

		// More typing AFTER the proposal went out.
		entity.applyLocalChanges( { title: 'Mine plus' } as any, 'editor', {} );

		// The server accepted our proposal (content unchanged) and echoed
		// our proposed title back in the announce.
		session.receiveUpdate( {
			type: DE_RTC_ANNOUNCE_TYPE,
			data: JSON.stringify( {
				version: 'v2',
				baseVersion: 'v1',
				contentHash: hashDeRtcContent( payload.proposedContent ),
				properties: { title: 'Mine' },
				authorClientId: session.clientId,
				proposalId: payload.proposalId,
			} ),
		} );

		// The newer keystrokes survive (the row's stale echo must not
		// clobber them); the follow-up proposal reconciles.
		const changes = entity.getEditorChanges( {} as any ) as any;
		expect( changes.title ).toBe( 'Mine plus' );
	} );

	it( 'a peer property change merged into our own accepted version is adopted when locally untouched', () => {
		const { entity, session, sent } = makeEntity();
		session.receiveUpdate(
			snapshotRow( 'v1', contentOf( BLOCK_A ), {
				title: 'Seeded',
				'meta.note': 'orig',
			} )
		);

		entity.applyLocalChanges( { title: 'Mine' } as any, 'editor', {} );
		const payload = JSON.parse( sent[ 0 ].data );

		// The server merged a PEER's meta change into our accepted
		// version; the merged properties ride the announce.
		session.receiveUpdate( {
			type: DE_RTC_ANNOUNCE_TYPE,
			data: JSON.stringify( {
				version: 'v2',
				baseVersion: 'v1',
				contentHash: hashDeRtcContent( payload.proposedContent ),
				properties: { title: 'Mine', 'meta.note': 'peer-updated' },
				authorClientId: session.clientId,
				proposalId: payload.proposalId,
			} ),
		} );

		const changes = entity.getEditorChanges( {} as any ) as any;
		expect( changes.title ).toBe( 'Mine' );
		expect( changes.meta ).toEqual( { note: 'peer-updated' } );
	} );

	it( 'restores a parked property register as a local edit that re-proposes', () => {
		const { entity, session, sent } = makeEntity();
		session.receiveUpdate(
			snapshotRow( 'v1', contentOf( BLOCK_A ), { title: 'Canonical' } )
		);

		session.receiveUpdate( {
			type: DE_RTC_PARKED_TYPE,
			data: JSON.stringify( {
				proposalId: 'p-9-1:title',
				reason: 'property-conflict',
				authorClientId: 9,
				property: { name: 'title', value: 'The losing title' },
				changedBlocks: [],
				excerpt: 'title: The losing title',
			} ),
		} );

		engine.review.restoreProposal( 'postType/book', '1', 'p-9-1:title' );

		const changes = entity.getEditorChanges( {} as any ) as any;
		expect( changes.title ).toBe( 'The losing title' );
		const proposals = sent.filter(
			( update ) => DE_RTC_PROPOSAL_TYPE === update.type
		);
		expect(
			JSON.parse( proposals[ proposals.length - 1 ].data )
				.proposedProperties.title
		).toBe( 'The losing title' );
		expect(
			engine.review.getOpenItems( 'postType/book', '1' )
		).toHaveLength( 0 );
	} );

	it( 'helpers: order-insensitive term arrays and meta unflattening', () => {
		expect( propertyValuesEqual( [ 3, 1 ], [ 1, 3 ] ) ).toBe( true );
		expect( propertyValuesEqual( [ 3, 1 ], [ 1, 2 ] ) ).toBe( false );
		expect( propertyValuesEqual( 'a', 'a' ) ).toBe( true );
		expect( propertyValuesEqual( { a: 1 }, { a: 1 } ) ).toBe( true );
		expect(
			unflattenProperties( {
				title: 'T',
				'meta.a': 1,
				'meta.b': 2,
			} )
		).toEqual( { title: 'T', meta: { a: 1, b: 2 } } );
	} );
} );
