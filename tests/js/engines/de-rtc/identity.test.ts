/**
 * Durable block identity on the de-rtc client: when every block carries a
 * `metadata.syncId`, incorporation, contests, true-base records, parked
 * restores, and review anchors all address blocks by identity at any
 * depth instead of by top-level position.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Y from 'yjs';

import {
	createDeRtcDocBridge,
	replaceBlockBySyncId,
} from '../../../../src/engines/de-rtc/doc-bridge';
import { createDeRtcEngine } from '../../../../src/engines/de-rtc/engine';
import {
	DE_RTC_PARKED_TYPE,
	DE_RTC_SNAPSHOT_TYPE,
} from '../../../../src/engines/de-rtc/session';
import { CRDT_RECORD_MAP_KEY } from '../../../../src/engines/yjs/constants';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncConfig } from '@wordpress/sync';

jest.mock( '@wordpress/api-fetch', () => ( {
	__esModule: true,
	default: jest.fn( () => Promise.resolve( {} ) ),
} ) );

// Content is opaque JSON, as in the sibling suites.
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

const p = ( text: string, syncId: string, clientId?: string ) => ( {
	name: 'core/paragraph',
	...( clientId ? { clientId } : {} ),
	attributes: { content: text, metadata: { syncId } },
	innerBlocks: [],
} );
const group = ( inner: unknown[], syncId = 'g', clientId?: string ) => ( {
	name: 'core/group',
	...( clientId ? { clientId } : {} ),
	attributes: { metadata: { syncId } },
	innerBlocks: inner,
} );
const contentOf = ( ...blocks: unknown[] ) => JSON.stringify( blocks );

describe( 'identity-keyed incorporation (bridge)', () => {
	let doc: Y.Doc;
	let bridge: ReturnType< typeof createDeRtcDocBridge >;
	let contests: any[];
	let resolved: Array< string | number >;

	beforeEach( () => {
		doc = new Y.Doc();
		bridge = createDeRtcDocBridge( doc, makeSyncConfig() );
		contests = [];
		resolved = [];
		bridge.onContested( ( event ) => contests.push( event ) );
		bridge.onContestResolved( ( key ) => resolved.push( key ) );
	} );

	const local = () =>
		doc.getMap( CRDT_RECORD_MAP_KEY ).get( 'blocks' ) as any[];
	const setLocal = ( ...blocks: unknown[] ) =>
		doc.getMap( CRDT_RECORD_MAP_KEY ).set( 'blocks', blocks );

	it( 'keeps my nested edit, adopts the peer’s nested edit, and needs no equal block counts', () => {
		bridge.applyCanonical(
			'v1',
			contentOf( group( [ p( 'One', 'a' ), p( 'Two', 'b' ) ] ) )
		);
		// I proposed an edit to Two, then kept typing into it; a peer
		// meanwhile edited One and appended a top-level paragraph.
		const proposed = contentOf(
			group( [ p( 'One', 'a' ), p( 'Two mine', 'b' ) ] )
		);
		setLocal( group( [ p( 'One', 'a' ), p( 'Two mine more', 'b' ) ] ) );

		const ok = bridge.incorporateCanonicalPreservingLocalEdits(
			'v2',
			contentOf(
				group( [ p( 'One peer', 'a' ), p( 'Two mine', 'b' ) ] ),
				p( 'Appended', 'c' )
			),
			proposed
		);

		expect( ok ).toBe( true );
		expect( local() ).toHaveLength( 2 );
		expect( local()[ 0 ].innerBlocks[ 0 ].attributes.content ).toBe(
			'One peer'
		);
		expect( local()[ 0 ].innerBlocks[ 1 ].attributes.content ).toBe(
			'Two mine more'
		);
		expect( local()[ 1 ].attributes.content ).toBe( 'Appended' );
		expect( contests ).toEqual( [] );
		expect( bridge.blockBaseVersions() ).toEqual( {} );
	} );

	it( 'a nested collision records the true base and raises a contest keyed by syncId', () => {
		bridge.applyCanonical(
			'v1',
			contentOf( group( [ p( 'One', 'a' ), p( 'Two', 'b' ) ] ) )
		);
		const proposed = contentOf(
			group( [ p( 'One', 'a' ), p( 'Two mine', 'b' ) ] )
		);
		setLocal( group( [ p( 'One', 'a' ), p( 'Two mine more', 'b' ) ] ) );

		bridge.incorporateCanonicalPreservingLocalEdits(
			'v2',
			contentOf( group( [ p( 'One', 'a' ), p( 'Two peer', 'b' ) ] ) ),
			proposed
		);

		expect( local()[ 0 ].innerBlocks[ 1 ].attributes.content ).toBe(
			'Two mine more'
		);
		expect( bridge.blockBaseVersions() ).toEqual( { b: 'v1' } );
		expect( contests ).toHaveLength( 1 );
		expect( contests[ 0 ] ).toMatchObject( {
			key: 'b',
			syncId: 'b',
			index: 0,
			version: 'v2',
		} );
		expect( contests[ 0 ].html ).toContain( 'Two peer' );

		// ADOPT by identity replaces the nested block in place.
		expect( bridge.adoptContestedBlock( 'b' ) ).toBe( true );
		expect( local()[ 0 ].innerBlocks[ 1 ].attributes.content ).toBe(
			'Two peer'
		);
		expect( bridge.blockBaseVersions() ).toEqual( {} );
		expect( resolved ).toEqual( [ 'b' ] );
	} );

	it( 'places blocks born locally since proposing next to the sibling they followed', () => {
		bridge.applyCanonical(
			'v1',
			contentOf( group( [ p( 'One', 'a' ), p( 'Two', 'b' ) ] ) )
		);
		const proposed = contentOf(
			group( [ p( 'One', 'a' ), p( 'Two', 'b' ) ] )
		);
		// Typed a new paragraph between One and Two after proposing.
		setLocal(
			group( [ p( 'One', 'a' ), p( 'New', 'n' ), p( 'Two', 'b' ) ] )
		);

		bridge.incorporateCanonicalPreservingLocalEdits(
			'v2',
			contentOf( group( [ p( 'One peer', 'a' ), p( 'Two', 'b' ) ] ) ),
			proposed
		);

		expect(
			local()[ 0 ].innerBlocks.map( ( b: any ) => b.attributes.content )
		).toEqual( [ 'One peer', 'New', 'Two' ] );
	} );

	it( 'falls back to the positional rule when a block has no identity', () => {
		bridge.applyCanonical(
			'v1',
			contentOf( p( 'One', 'a' ), {
				name: 'core/paragraph',
				attributes: { content: 'No id' },
				innerBlocks: [],
			} )
		);
		setLocal( p( 'One mine', 'a' ), {
			name: 'core/paragraph',
			attributes: { content: 'No id' },
			innerBlocks: [],
		} );
		// Positional: a structural change since proposing defers.
		const ok = bridge.incorporateCanonicalPreservingLocalEdits(
			'v2',
			contentOf( p( 'One peer', 'a' ), {
				name: 'core/paragraph',
				attributes: { content: 'No id' },
				innerBlocks: [],
			} ),
			contentOf( p( 'One mine', 'a' ) )
		);
		expect( ok ).toBe( false );
	} );
} );

describe( 'replaceBlockBySyncId', () => {
	it( 'replaces at any depth and reports a miss', () => {
		const tree = [ group( [ p( 'One', 'a' ), p( 'Two', 'b' ) ] ) ];
		expect( replaceBlockBySyncId( tree, 'b', p( 'Two!', 'b' ) ) ).toBe(
			true
		);
		expect( ( tree[ 0 ] as any ).innerBlocks[ 1 ].attributes.content ).toBe(
			'Two!'
		);
		expect( replaceBlockBySyncId( tree, 'zz', p( 'x', 'zz' ) ) ).toBe(
			false
		);
	} );
} );

describe( 'identity on the review surface (engine)', () => {
	function makeEntity() {
		const engine = createDeRtcEngine();
		const entity = engine.createEntity( {
			syncConfig: makeSyncConfig(),
			// A type WITHOUT a commit route: pins the transport lane.
			objectType: 'postType/book',
			objectId: '7',
		} as any );
		const session = entity.createSession();
		session.onLocalUpdate( () => {} );
		return { engine, entity, session };
	}

	it( 'anchors a parked nested block by targetId and restores it into its container', () => {
		const { engine, entity, session } = makeEntity();
		session.receiveUpdate( {
			type: DE_RTC_SNAPSHOT_TYPE,
			data: JSON.stringify( {
				version: 'v1',
				content: contentOf(
					group( [ p( 'One', 'a' ), p( 'Two', 'b' ) ] )
				),
			} ),
		} );
		session.receiveUpdate( {
			type: DE_RTC_PARKED_TYPE,
			data: JSON.stringify( {
				proposalId: 'p-9',
				reason: 'manual-conflict-required',
				authorClientId: 4242,
				baseVersion: 'v1',
				changedBlocks: [
					{
						index: 0,
						syncId: 'b',
						path: [ 0, 1 ],
						html: contentOf( p( 'Two by them', 'b' ) ),
					},
				],
			} ),
		} );

		const items = engine.review.getOpenItems( 'postType/book', '7' );
		expect( items ).toHaveLength( 1 );
		expect( items[ 0 ] ).toMatchObject( {
			id: 'p-9',
			targetId: 'b',
			targetIndex: 0,
		} );

		engine.review.restoreProposal( 'postType/book', '7', 'p-9' );
		const blocks = entity.getEditorChanges( { blocks: [] } as any )
			.blocks as any[];
		expect( blocks ).toHaveLength( 1 );
		expect( blocks[ 0 ].innerBlocks[ 1 ].attributes.content ).toBe(
			'Two by them'
		);
	} );
} );

describe( 'authorship by identity (nested)', () => {
	it( 'credits the nested block that changed, not its container, and survives structural rows', async () => {
		const { createDeRtcAuthorship } = await import(
			'../../../../src/engines/de-rtc/authorship'
		);
		const { createDeRtcUndoFeed } = await import(
			'../../../../src/engines/de-rtc/revert-undo'
		);
		const feed = createDeRtcUndoFeed();
		const tracker = createDeRtcAuthorship( feed );

		feed.noteRow( {
			version: 'v1',
			baseVersion: null,
			content: contentOf( group( [ p( 'One', 'a' ), p( 'Two', 'b' ) ] ) ),
			own: false,
		} );
		feed.noteRow( {
			version: 'v2',
			baseVersion: 'v1',
			content: contentOf(
				group( [ p( 'One', 'a' ), p( 'Two by 7', 'b' ) ] )
			),
			own: false,
			author: 7,
			authorClientId: 701,
		} );
		expect( tracker.getBlockAuthorshipById() ).toEqual( {
			b: { author: 7, authorClientId: 701, version: 'v2' },
		} );
		// The container's top-level view carries no credit of its own.
		expect( tracker.getBlockAuthorship() ).toEqual( [ null ] );

		// A structural row (an insert by 8) credits only the new block
		// and keeps the earlier record.
		feed.noteRow( {
			version: 'v3',
			baseVersion: 'v2',
			content: contentOf(
				group( [ p( 'One', 'a' ), p( 'Two by 7', 'b' ) ] ),
				p( 'Added by 8', 'c' )
			),
			own: false,
			author: 8,
			authorClientId: 801,
		} );
		expect( tracker.getBlockAuthorshipById() ).toEqual( {
			b: { author: 7, authorClientId: 701, version: 'v2' },
			c: { author: 8, authorClientId: 801, version: 'v3' },
		} );
		expect( tracker.getBlockAuthorship() ).toEqual( [
			null,
			{ author: 8, authorClientId: 801, version: 'v3' },
		] );
	} );
} );

describe( 'revert-edit undo by identity (nested)', () => {
	async function harness() {
		const { createDeRtcRevertUndoManager, createDeRtcUndoFeed } =
			await import( '../../../../src/engines/de-rtc/revert-undo' );
		const doc = new Y.Doc();
		const bridge = createDeRtcDocBridge( doc, makeSyncConfig() );
		const feed = createDeRtcUndoFeed();
		const manager = createDeRtcRevertUndoManager();
		const applied: unknown[][] = [];
		manager.attachEntity( {
			key: doc.getMap( CRDT_RECORD_MAP_KEY ) as Y.Map< unknown >,
			bridge,
			feed,
			applyRevert: ( blocks ) => {
				applied.push( blocks );
				doc.getMap( CRDT_RECORD_MAP_KEY ).set( 'blocks', blocks );
			},
		} );
		const canonical = ( version: string, content: string, own = false ) => {
			bridge.applyCanonical( version, content );
			feed.noteRow( {
				version,
				baseVersion: own
					? `v${ Number( version.slice( 1 ) ) - 1 }`
					: null,
				content,
				own,
			} );
		};
		return { doc, bridge, manager, applied, canonical };
	}
	const local = ( doc: Y.Doc ) =>
		doc.getMap( CRDT_RECORD_MAP_KEY ).get( 'blocks' ) as any[];

	it( 'reverts a nested own edit in place and leaves a peer-touched sibling alone', async () => {
		const { doc, manager, applied, canonical } = await harness();
		canonical(
			'v1',
			contentOf( group( [ p( 'One', 'a' ), p( 'Two', 'b' ) ] ) )
		);
		// My row edits Two inside the group.
		canonical(
			'v2',
			contentOf( group( [ p( 'One', 'a' ), p( 'Two mine', 'b' ) ] ) ),
			true
		);
		// A peer then edits One (a foreign row), so the document moved on.
		canonical(
			'v3',
			contentOf( group( [ p( 'One peer', 'a' ), p( 'Two mine', 'b' ) ] ) )
		);

		manager.undo();
		expect( applied ).toHaveLength( 1 );
		expect(
			local( doc )[ 0 ].innerBlocks.map(
				( b: any ) => b.attributes.content
			)
		).toEqual( [ 'One peer', 'Two' ] );

		manager.redo();
		expect(
			local( doc )[ 0 ].innerBlocks.map(
				( b: any ) => b.attributes.content
			)
		).toEqual( [ 'One peer', 'Two mine' ] );
	} );

	it( 'undoes a nested insert and a nested delete, re-inserting next to the sibling it followed', async () => {
		const { doc, manager, canonical } = await harness();
		canonical(
			'v1',
			contentOf( group( [ p( 'One', 'a' ), p( 'Two', 'b' ) ] ) )
		);
		// My row inserts New between One and Two, and deletes... nothing yet.
		canonical(
			'v2',
			contentOf(
				group( [ p( 'One', 'a' ), p( 'New', 'n' ), p( 'Two', 'b' ) ] )
			),
			true
		);
		manager.undo();
		expect(
			local( doc )[ 0 ].innerBlocks.map(
				( b: any ) => b.attributes.content
			)
		).toEqual( [ 'One', 'Two' ] );

		// Redo re-inserts it after One.
		manager.redo();
		expect(
			local( doc )[ 0 ].innerBlocks.map(
				( b: any ) => b.attributes.content
			)
		).toEqual( [ 'One', 'New', 'Two' ] );
	} );

	it( 'does not remove an inserted block a peer has since edited', async () => {
		const { doc, manager, applied, canonical } = await harness();
		canonical( 'v1', contentOf( group( [ p( 'One', 'a' ) ] ) ) );
		canonical(
			'v2',
			contentOf( group( [ p( 'One', 'a' ), p( 'New', 'n' ) ] ) ),
			true
		);
		canonical(
			'v3',
			contentOf( group( [ p( 'One', 'a' ), p( 'New, peer', 'n' ) ] ) )
		);

		manager.undo();
		expect( applied ).toHaveLength( 0 );
		expect( local( doc )[ 0 ].innerBlocks ).toHaveLength( 2 );
	} );
} );
