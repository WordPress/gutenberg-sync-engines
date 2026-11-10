/**
 * External dependencies
 */
import { afterEach, describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	canRestoreItems,
	groupByUnit,
	itemAnchorClientId,
	selectBlockMarkers,
} from '../../../src/review/ui/items';
import type { SyncReviewItem } from '../../../src/sync';

const item = (
	overrides: Partial< SyncReviewItem > = {}
): SyncReviewItem => ( {
	id: 'i1',
	unitId: 'u1',
	isLocal: false,
	actorId: 'a1',
	reason: 'frame-conflict',
	intentType: 'proposal',
	...overrides,
} );

describe( 'review data helpers', () => {
	afterEach( () => {
		delete window._wpCollaborationCanUnfilteredHtml;
	} );

	it( 'groups items by unit, keeping first-seen order', () => {
		const groups = groupByUnit( [
			item( { id: 'a', unitId: 'u1' } ),
			item( { id: 'b', unitId: 'u2' } ),
			item( { id: 'c', unitId: 'u1' } ),
		] );
		expect( groups.map( ( g ) => g.map( ( i ) => i.id ) ) ).toEqual( [
			[ 'a', 'c' ],
			[ 'b' ],
		] );
	} );

	it( 'anchors an item through its target block identity', () => {
		const maps = { clientIdByTarget: { s1: 'c1' } };
		expect( itemAnchorClientId( item( { targetId: 's1' } ), maps ) ).toBe(
			'c1'
		);
		expect(
			itemAnchorClientId( item( { targetId: 'gone' } ), maps )
		).toBeUndefined();
		expect( itemAnchorClientId( item(), maps ) ).toBeUndefined();
	} );

	it( 'reserves restore of requires-approval items for unfiltered_html holders', () => {
		window._wpCollaborationCanUnfilteredHtml = false;
		expect( canRestoreItems( [ item() ] ) ).toBe( true );
		expect(
			canRestoreItems( [
				item(),
				item( { reason: 'requires-approval' } ),
			] )
		).toBe( false );
		window._wpCollaborationCanUnfilteredHtml = true;
		expect(
			canRestoreItems( [ item( { reason: 'requires-approval' } ) ] )
		).toBe( true );
		// Unknown (an older server): not withheld.
		delete window._wpCollaborationCanUnfilteredHtml;
		expect(
			canRestoreItems( [ item( { reason: 'requires-approval' } ) ] )
		).toBe( true );
	} );
} );

describe( 'selectBlockMarkers', () => {
	const clientIdByTarget = { s1: 'c1', s2: 'c2' };

	it( 'returns the shared empty value for a block without markers', () => {
		const none = selectBlockMarkers( [], clientIdByTarget, 'c1', true );
		expect(
			selectBlockMarkers(
				[ item( { targetId: 's2' } ) ],
				clientIdByTarget,
				'c1',
				false
			)
		).toBe( none );
	} );

	it( 'collects the conflict groups targeting the block', () => {
		const items = [
			item( { id: 'a', unitId: 'u1', targetId: 's1' } ),
			item( { id: 'b', unitId: 'u2', targetId: 's1' } ),
			item( { id: 'c', unitId: 'u3', targetId: 's2' } ),
			item( { id: 'd', unitId: 'u4' } ),
		];
		const markers = selectBlockMarkers(
			items,
			clientIdByTarget,
			'c1',
			false
		);
		expect( markers.groups.map( ( g ) => g.map( ( i ) => i.id ) ) ).toEqual(
			[ [ 'a' ], [ 'b' ] ]
		);
		expect( markers.insertions ).toEqual( [] );
	} );

	it( 'anchors a parked insertion below its sibling, or above the first root block', () => {
		const afterSibling = item( {
			id: 'ins-1',
			unitId: 'ins-1',
			proposedInsertion: { html: '<p>x</p>', afterSiblingId: 's1' },
		} );
		const atTop = item( {
			id: 'ins-2',
			unitId: 'ins-2',
			proposedInsertion: { html: '<p>y</p>' },
		} );
		const orphan = item( {
			id: 'ins-3',
			unitId: 'ins-3',
			proposedInsertion: { html: '<p>z</p>', afterSiblingId: 'gone' },
		} );
		const items = [ afterSibling, atTop, orphan ];

		expect(
			selectBlockMarkers( items, clientIdByTarget, 'c1', false )
				.insertions
		).toEqual( [ { placement: 'bottom-start', item: afterSibling } ] );
		expect(
			selectBlockMarkers( items, clientIdByTarget, 'c2', true ).insertions
		).toEqual( [ { placement: 'top-start', item: atTop } ] );
		// The orphan has no card anywhere: the sidebar panel covers it.
		expect(
			selectBlockMarkers( items, clientIdByTarget, 'c2', false )
				.insertions
		).toEqual( [] );
	} );
} );
