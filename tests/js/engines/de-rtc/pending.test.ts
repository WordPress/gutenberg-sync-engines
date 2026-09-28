/**
 * The contested-only pending-edits behavior layer (v1).
 * Contested blocks raise ONE pending item that merges-not-stacks;
 * Adopt takes the latest canonical form, Reject keeps yours
 * (per-block base honesty intact); parked review tasks fold
 * revisions the same way;
 * editor saves carry base_version while a session lives.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Y from 'yjs';

import { createDeRtcDocBridge } from '../../../../src/engines/de-rtc/doc-bridge';
import { createDeRtcReviewState } from '../../../../src/engines/de-rtc/review';
import { registerSaveBaseVersion } from '../../../../src/engines/de-rtc/save-base-version';
import { CRDT_RECORD_MAP_KEY } from '../../../../src/engines/yjs/constants';
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import type { SyncConfig } from '@wordpress/sync';

jest.mock( '@wordpress/blocks', () => ( {
	parse: ( content: string ) => ( content ? JSON.parse( content ) : [] ),
	__unstableSerializeAndClean: ( blocks: unknown[] ) =>
		JSON.stringify( blocks ),
} ) );

const mockApiFetchUse = jest.fn();
jest.mock( '@wordpress/api-fetch', () => ( {
	__esModule: true,
	default: { use: ( middleware: unknown ) => mockApiFetchUse( middleware ) },
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
const A_NEWER = {
	name: 'core/paragraph',
	attributes: { content: 'Alpha local newer' },
};
const A_PEER = {
	name: 'core/paragraph',
	attributes: { content: 'Alpha peer' },
};
const A_PEER2 = {
	name: 'core/paragraph',
	attributes: { content: 'Alpha peer, revised' },
};
const B = { name: 'core/paragraph', attributes: { content: 'Beta' } };

const contentOf = ( ...blocks: unknown[] ) => JSON.stringify( blocks );

describe( 'contested-block pending lifecycle (bridge)', () => {
	let doc: Y.Doc;
	let bridge: ReturnType< typeof createDeRtcDocBridge >;
	let contests: any[];
	let resolved: Array< number | string >;

	beforeEach( () => {
		doc = new Y.Doc();
		bridge = createDeRtcDocBridge( doc, makeSyncConfig() );
		contests = [];
		resolved = [];
		bridge.onContested( ( event ) => contests.push( event ) );
		bridge.onContestResolved( ( index ) => resolved.push( index ) );
	} );

	function setLocalBlocks( ...blocks: unknown[] ) {
		doc.getMap( CRDT_RECORD_MAP_KEY ).set( 'blocks', blocks );
	}
	function collide( version: string, theirs: unknown ) {
		bridge.incorporateCanonicalPreservingLocalEdits(
			version,
			contentOf( theirs, B ),
			contentOf( A_LOCAL, B )
		);
	}

	it( 'a collision raises one contest; repeats REFRESH it (merge-not-stack)', () => {
		bridge.applyCanonical( 'v1', contentOf( A, B ) );
		setLocalBlocks( A_NEWER, B );

		collide( 'v2', A_PEER );
		expect( contests ).toHaveLength( 1 );
		expect( contests[ 0 ] ).toMatchObject( { index: 0, version: 'v2' } );
		expect( contests[ 0 ].html ).toContain( 'Alpha peer' );

		collide( 'v3', A_PEER2 );
		expect( contests ).toHaveLength( 2 );
		expect( contests[ 1 ] ).toMatchObject( { index: 0, version: 'v3' } );
		expect( contests[ 1 ].html ).toContain( 'revised' );
		expect( resolved ).toHaveLength( 0 );
	} );

	it( 'ADOPT applies the latest canonical form, clears the base, resolves', () => {
		bridge.applyCanonical( 'v1', contentOf( A, B ) );
		setLocalBlocks( A_NEWER, B );
		collide( 'v2', A_PEER );
		collide( 'v3', A_PEER2 );

		expect( bridge.adoptContestedBlock( 0 ) ).toBe( true );
		const blocks: any = doc.getMap( CRDT_RECORD_MAP_KEY ).get( 'blocks' );
		expect( blocks[ 0 ] ).toEqual( A_PEER2 ); // The LATEST, not the first.
		expect( bridge.blockBaseVersions() ).toEqual( {} );
		expect( resolved ).toEqual( [ 0 ] );
		expect( bridge.adoptContestedBlock( 0 ) ).toBe( false );
	} );

	it( 'REJECT keeps the local block AND its true base; a later edit re-contests', () => {
		bridge.applyCanonical( 'v1', contentOf( A, B ) );
		setLocalBlocks( A_NEWER, B );
		collide( 'v2', A_PEER );

		expect( bridge.rejectContestedBlock( 0 ) ).toBe( true );
		const blocks: any = doc.getMap( CRDT_RECORD_MAP_KEY ).get( 'blocks' );
		expect( blocks[ 0 ] ).toEqual( A_NEWER ); // Yours, untouched.
		expect( bridge.blockBaseVersions() ).toEqual( { 0: 'v1' } ); // Honesty kept.
		expect( resolved ).toEqual( [ 0 ] );

		// A later peer edit is new information: a fresh contest.
		collide( 'v3', A_PEER2 );
		expect( contests ).toHaveLength( 2 );
	} );

	it( 'natural resolution: the block adopting canonical resolves the contest', () => {
		bridge.applyCanonical( 'v1', contentOf( A, B ) );
		setLocalBlocks( A_NEWER, B );
		collide( 'v2', A_PEER );

		// The block settles (doc matches what was proposed), so the next
		// incorporation ADOPTS canonical for it.
		setLocalBlocks( A_NEWER, B );
		bridge.incorporateCanonicalPreservingLocalEdits(
			'v3',
			contentOf( A_PEER2, B ),
			contentOf( A_NEWER, B )
		);
		expect( resolved ).toEqual( [ 0 ] );
	} );
} );

describe( 'parked review tasks fold (merge-not-stack)', () => {
	it( 'a revised parked proposal supersedes; one resolution closes the lineage', () => {
		const review = createDeRtcReviewState();
		const sent: any[] = [];
		review.setRestResolver( ( proposalId, resolution ) => {
			sent.push( { proposalId, resolution } );
			return Promise.resolve( {} );
		} );

		review.noteParked( {
			proposalId: 'p-9-1',
			reason: 'manual-conflict-required',
			authorClientId: 9,
			changedBlocks: [ { index: 1, html: contentOf( A_PEER ) } ],
		} );
		review.noteParked( {
			proposalId: 'p-9-2',
			reason: 'manual-conflict-required',
			authorClientId: 9,
			changedBlocks: [ { index: 1, html: contentOf( A_PEER2 ) } ],
		} );

		const openItems = review.getOpen();
		expect( openItems ).toHaveLength( 1 );
		expect( openItems[ 0 ].proposalId ).toBe( 'p-9-2' );
		expect( openItems[ 0 ].revisions ).toBe( 2 );
		expect( openItems[ 0 ].supersededIds ).toEqual( [ 'p-9-1' ] );
		expect( openItems[ 0 ].changedBlocks[ 0 ].html ).toContain( 'revised' );

		// A DIFFERENT author's park over the same block stays separate.
		review.noteParked( {
			proposalId: 'p-7-1',
			reason: 'manual-conflict-required',
			authorClientId: 7,
			changedBlocks: [ { index: 1, html: contentOf( A_PEER ) } ],
		} );
		expect( review.getOpen() ).toHaveLength( 2 );

		review.resolve( 'p-9-2', 'dismissed' );
		expect( sent.map( ( row ) => row.proposalId ).sort() ).toEqual( [
			'p-9-1',
			'p-9-2',
		] );
		expect( review.getOpen() ).toHaveLength( 1 ); // The other author's.
	} );
} );

describe( 'save-through-the-room middleware', () => {
	it( 'injects base_version for live sessions, skips autosaves and foreign posts', async () => {
		mockApiFetchUse.mockClear();
		const unregister = registerSaveBaseVersion( 'postType/post', '7', {
			lastVersion: () => 'v41',
		} );
		expect( mockApiFetchUse ).toHaveBeenCalledTimes( 1 );
		const middleware = mockApiFetchUse.mock.calls[ 0 ][ 0 ] as (
			options: any,
			next: ( options: any ) => any
		) => any;
		const passThrough = ( options: any ) => options;

		expect(
			(
				await middleware(
					{
						path: '/wp/v2/posts/7',
						method: 'PUT',
						data: { title: 'x' },
					},
					passThrough
				)
			).data
		).toEqual( { title: 'x', base_version: 'v41' } );

		// A caller-supplied base_version wins.
		expect(
			(
				await middleware(
					{
						path: '/wp/v2/posts/7',
						method: 'PUT',
						data: { base_version: 'v2' },
					},
					passThrough
				)
			).data.base_version
		).toBe( 'v2' );

		// Autosaves and other posts pass through untouched.
		expect(
			(
				await middleware(
					{
						path: '/wp/v2/posts/7/autosaves',
						method: 'POST',
						data: {},
					},
					passThrough
				)
			).data.base_version
		).toBeUndefined();
		expect(
			(
				await middleware(
					{ path: '/wp/v2/posts/8', method: 'PUT', data: {} },
					passThrough
				)
			).data.base_version
		).toBeUndefined();

		unregister();
		expect(
			(
				await middleware(
					{ path: '/wp/v2/posts/7', method: 'PUT', data: {} },
					passThrough
				)
			).data.base_version
		).toBeUndefined();
	} );
} );
