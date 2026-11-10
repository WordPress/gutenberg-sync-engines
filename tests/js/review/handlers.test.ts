/**
 * External dependencies
 */
import { describe, expect, it, jest } from '@jest/globals';

/**
 * Internal dependencies
 */
import { createReviewHandlers } from '../../../src/review/handlers';
import {
	registerReviewResolver,
	type ReviewResolver,
} from '../../../src/review/resolver';
import { store as reviewStore } from '../../../src/review/store';

const makeItem = ( id: string ) => ( {
	id,
	unitId: id,
	isLocal: true,
	actorId: 'actor',
	reason: 'frame-conflict',
	intentType: 'insert_text',
	summary: 'text',
} );

function setup() {
	const review = { setReviewItems: jest.fn() };
	const notices = {
		createNotice: jest.fn(),
		removeNotice: jest.fn(),
	};
	const dispatch = jest.fn( ( store: unknown ) =>
		store === reviewStore ? review : notices
	) as unknown as Parameters< typeof createReviewHandlers >[ 2 ];
	const handlers = createReviewHandlers( 'postType/post', '1', dispatch );
	return { review, notices, handlers };
}

describe( 'createReviewHandlers', () => {
	it( 'mirrors review items and aggregates notices past the threshold', () => {
		const { review, notices, handlers } = setup();

		// Below the threshold: the list is mirrored and the per-item
		// escalation notice is created.
		handlers.onProposalsChange( [ makeItem( 'p1' ) ] );
		handlers.onEscalation( {
			reason: 'frame-conflict',
			isLocal: true,
			proposalId: 'p1',
			summary: 'text',
		} );
		expect( review.setReviewItems ).toHaveBeenCalledWith(
			'postType/post',
			'1',
			[ makeItem( 'p1' ) ]
		);
		expect( notices.createNotice ).toHaveBeenCalledTimes( 1 );

		// A burst past the threshold sweeps per-item notices, creates one
		// aggregate notice, and suppresses further per-item notices.
		const burst = [ 'p1', 'p2', 'p3', 'p4' ].map( makeItem );
		handlers.onProposalsChange( burst );
		burst.forEach( ( item ) =>
			handlers.onEscalation( {
				reason: 'frame-conflict',
				isLocal: true,
				proposalId: item.id,
				summary: 'text',
			} )
		);
		expect( notices.removeNotice ).toHaveBeenCalledWith(
			'gutenberg-sync-engines-escalation-postType/post-1-p1'
		);
		expect( notices.createNotice ).toHaveBeenCalledWith(
			'warning',
			expect.stringContaining( '4' ),
			expect.objectContaining( {
				id: 'gutenberg-sync-engines-review-aggregate-postType/post-1',
			} )
		);
		expect( notices.createNotice ).toHaveBeenCalledTimes( 2 );

		// Emptying the list clears the aggregate notice and the store key.
		handlers.onProposalsChange( [] );
		expect( notices.removeNotice ).toHaveBeenCalledWith(
			'gutenberg-sync-engines-review-aggregate-postType/post-1'
		);
		expect( review.setReviewItems ).toHaveBeenLastCalledWith(
			'postType/post',
			'1',
			[]
		);
	} );

	it( 'resolves a proposal through the registered resolver from the notice actions', () => {
		const { notices, handlers } = setup();
		const resolver: ReviewResolver = {
			resolveProposal: jest.fn(),
			restoreProposal: jest.fn(),
		};
		const unregister = registerReviewResolver( resolver );
		try {
			handlers.onProposalsChange( [ makeItem( 'p1' ) ] );
			handlers.onEscalation( {
				reason: 'frame-conflict',
				isLocal: false,
				proposalId: 'p1',
			} );
			const [ , content, options ] = notices.createNotice.mock
				.calls[ 0 ] as [
				string,
				string,
				{
					id: string;
					actions: { label: string; onClick: () => void }[];
				},
			];
			expect( content ).toContain( "A collaborator's edit" );
			expect( options.actions.map( ( a ) => a.label ) ).toEqual( [
				'Restore',
				'Discard',
			] );

			options.actions[ 0 ].onClick();
			expect( resolver.restoreProposal ).toHaveBeenCalledWith(
				'postType/post',
				'1',
				'p1'
			);
			expect( notices.removeNotice ).toHaveBeenCalledWith( options.id );

			options.actions[ 1 ].onClick();
			expect( resolver.resolveProposal ).toHaveBeenCalledWith(
				'postType/post',
				'1',
				'p1',
				'dismissed'
			);
		} finally {
			unregister();
		}
	} );

	it( 'drops the notice of a proposal resolved elsewhere', () => {
		const { notices, handlers } = setup();
		handlers.onProposalsChange( [ makeItem( 'p1' ), makeItem( 'p2' ) ] );
		handlers.onProposalsChange( [ makeItem( 'p2' ) ] );
		expect( notices.removeNotice ).toHaveBeenCalledWith(
			'gutenberg-sync-engines-escalation-postType/post-1-p1'
		);
		expect( notices.removeNotice ).not.toHaveBeenCalledWith(
			'gutenberg-sync-engines-escalation-postType/post-1-p2'
		);
	} );
} );
