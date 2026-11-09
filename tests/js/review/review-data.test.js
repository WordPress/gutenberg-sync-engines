import { afterEach, describe, expect, it } from '@jest/globals';
import {
	canApproveUnfilteredHtml,
	conflictContinuingOnBlock,
	conflictsTargetingBlock,
} from '../../../src/review/components/review-data';

/*
 * A two-level document: a paragraph, then a group holding two paragraphs.
 * Only what the matcher reads is modelled.
 */
const BLOCKS = {
	c1: { syncId: 's1', root: '', index: 0 },
	c2: { syncId: 's2', root: '', index: 1 },
	c3: { syncId: 's3', root: 'c2', index: 0 },
	c4: { syncId: undefined, root: 'c2', index: 1 },
};

const select = () => ( {
	getBlockAttributes: ( clientId ) => ( {
		metadata: { syncId: BLOCKS[ clientId ]?.syncId },
	} ),
	getBlockRootClientId: ( clientId ) => BLOCKS[ clientId ]?.root,
	getBlockIndex: ( clientId ) => BLOCKS[ clientId ]?.index,
	getClientIdsWithDescendants: () => Object.keys( BLOCKS ),
} );

const record = ( id, target ) => ( { id, kind: 'merge', target } );
const matches = ( conflicts, clientId ) =>
	conflictsTargetingBlock( select, conflicts, clientId ).map(
		( conflict ) => conflict.id
	);

describe( 'conflictContinuingOnBlock', () => {
	const span = record( 'a', {
		type: 'blocks',
		ids: [ 's1', 's2' ],
		index: 0,
		count: 2,
	} );

	it( 'names the record and the card block for a block after the first of a span', () => {
		expect( conflictContinuingOnBlock( select, [ span ], 'c2' ) ).toEqual( {
			conflict: span,
			firstClientId: 'c1',
		} );
	} );

	it( 'is null for the first block, which carries the card, and for blocks outside the span', () => {
		expect(
			conflictContinuingOnBlock( select, [ span ], 'c1' )
		).toBeNull();
		expect(
			conflictContinuingOnBlock( select, [ span ], 'c3' )
		).toBeNull();
	} );

	it( 'is null when the first block is no longer in the document', () => {
		const orphan = record( 'a', {
			type: 'blocks',
			ids: [ 'gone', 's2' ],
			index: 0,
			count: 2,
		} );
		expect(
			conflictContinuingOnBlock( select, [ orphan ], 'c2' )
		).toBeNull();
	} );

	it( 'matches the span by client id, for documents that carry the editor ids', () => {
		const byClientId = record( 'a', {
			type: 'blocks',
			ids: [ 'c3', 'c4' ],
			index: 0,
			count: 2,
		} );
		expect(
			conflictContinuingOnBlock( select, [ byClientId ], 'c4' )
		).toEqual( { conflict: byClientId, firstClientId: 'c3' } );
	} );

	it( 'ignores positional targets and proposed insertions', () => {
		const conflicts = [
			record( 'p', { type: 'blocks', index: 0, count: 2 } ),
			record( 'i', {
				type: 'blocks',
				ids: [ 's1', 's2' ],
				index: 0,
				count: 0,
			} ),
		];
		expect(
			conflictContinuingOnBlock( select, conflicts, 'c2' )
		).toBeNull();
	} );
} );

describe( 'conflictsTargetingBlock', () => {
	it( 'matches a block by its durable id', () => {
		const conflicts = [
			record( 'a', {
				type: 'blocks',
				ids: [ 's1' ],
				index: 5,
				count: 1,
			} ),
		];
		expect( matches( conflicts, 'c1' ) ).toEqual( [ 'a' ] );
		expect( matches( conflicts, 'c2' ) ).toEqual( [] );
	} );

	it( 'matches a block by its client id, for documents that carry the editor ids', () => {
		const conflicts = [
			record( 'a', {
				type: 'blocks',
				ids: [ 'c4' ],
				index: 0,
				count: 1,
			} ),
		];
		expect( matches( conflicts, 'c4' ) ).toEqual( [ 'a' ] );
		expect( matches( conflicts, 'c3' ) ).toEqual( [] );
	} );

	it( 'presents a span on its first block only', () => {
		const conflicts = [
			record( 'a', {
				type: 'blocks',
				ids: [ 's1', 's2' ],
				index: 0,
				count: 2,
			} ),
		];
		expect( matches( conflicts, 'c1' ) ).toEqual( [ 'a' ] );
		expect( matches( conflicts, 'c2' ) ).toEqual( [] );
	} );

	it( 'matches a positional target at the top level, or under the named parent', () => {
		const topLevel = [
			record( 'a', { type: 'blocks', index: 1, count: 1 } ),
		];
		expect( matches( topLevel, 'c2' ) ).toEqual( [ 'a' ] );
		// Index 1 inside the group is not index 1 at the top level.
		expect( matches( topLevel, 'c4' ) ).toEqual( [] );

		const nested = [
			record( 'b', {
				type: 'blocks',
				parentId: 's2',
				index: 1,
				count: 1,
			} ),
		];
		expect( matches( nested, 'c4' ) ).toEqual( [ 'b' ] );
		expect( matches( nested, 'c2' ) ).toEqual( [] );
	} );

	it( 'never matches a proposed insertion or a property', () => {
		const conflicts = [
			record( 'a', { type: 'blocks', index: 0, count: 0 } ),
			record( 'b', { type: 'property', name: 'title' } ),
		];
		expect( matches( conflicts, 'c1' ) ).toEqual( [] );
	} );
} );

describe( 'canApproveUnfilteredHtml', () => {
	afterEach( () => {
		delete window._gutenbergSyncEnginesSettings;
	} );

	it( 'is not allowed when the plugin settings are missing', () => {
		expect( canApproveUnfilteredHtml() ).toBe( false );
	} );

	it( 'is not allowed when the settings carry no flag', () => {
		window._gutenbergSyncEnginesSettings = {};
		expect( canApproveUnfilteredHtml() ).toBe( false );
	} );

	it( 'is not allowed when the server says no', () => {
		window._gutenbergSyncEnginesSettings = { canUnfilteredHtml: false };
		expect( canApproveUnfilteredHtml() ).toBe( false );
	} );

	it( 'is not allowed for a value that is not exactly true', () => {
		window._gutenbergSyncEnginesSettings = { canUnfilteredHtml: '1' };
		expect( canApproveUnfilteredHtml() ).toBe( false );
	} );

	it( 'is allowed when the server says yes', () => {
		window._gutenbergSyncEnginesSettings = { canUnfilteredHtml: true };
		expect( canApproveUnfilteredHtml() ).toBe( true );
	} );
} );
