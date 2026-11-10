/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * WordPress dependencies
 */
import { createRegistry } from '@wordpress/data';

/**
 * Internal dependencies
 */
import { store, reviewKey } from '../../../src/review/store';

const item = ( id: string ) => ( {
	id,
	unitId: id,
	isLocal: false,
	actorId: 'a1',
	reason: 'frame-conflict',
	intentType: 'proposal',
} );

describe( 'review store', () => {
	it( 'keeps one open list per entity and a stable empty value', () => {
		const registry = createRegistry();
		registry.register( store );
		const select = registry.select( store );
		const dispatch = registry.dispatch( store );

		const empty = select.getReviewItems( 'postType/post', '1' );
		expect( empty ).toEqual( [] );
		expect( select.getReviewItems( 'postType/post', '2' ) ).toBe( empty );

		dispatch.setReviewItems( 'postType/post', '1', [ item( 'p1' ) ] );
		dispatch.setReviewItems( 'postType/page', '7', [ item( 'p2' ) ] );
		expect( select.getReviewItems( 'postType/post', '1' ) ).toEqual( [
			item( 'p1' ),
		] );
		expect( select.getReviewItems( 'postType/page', '7' ) ).toEqual( [
			item( 'p2' ),
		] );

		// An empty list drops the key and hands back the shared empty value.
		dispatch.setReviewItems( 'postType/post', '1', [] );
		expect( select.getReviewItems( 'postType/post', '1' ) ).toBe( empty );
		expect( select.getReviewItems( 'postType/page', '7' ) ).toHaveLength(
			1
		);

		dispatch.reset();
		expect( select.getReviewItems( 'postType/page', '7' ) ).toBe( empty );
	} );

	it( 'keys an entity by type and id, with collections under an empty id', () => {
		expect( reviewKey( 'postType/post', 1 ) ).toBe( 'postType/post:1' );
		expect( reviewKey( 'postType/post', '1' ) ).toBe( 'postType/post:1' );
		expect( reviewKey( 'postType/post', null ) ).toBe( 'postType/post:' );
	} );
} );
