/**
 * External dependencies
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/jest-globals';
import userEvent from '@testing-library/user-event';

/**
 * Internal dependencies
 */
import {
	BlockCardBody,
	InsertionCardBody,
} from '../../../src/review/ui/markers';

// The cards' module also carries the in-canvas wiring (the block popover
// and the BlockEdit filter); the bodies under test need neither, so the
// editor packages are stubbed.
jest.mock(
	'@wordpress/block-editor',
	() => ( { store: 'core/block-editor', privateApis: {} } ),
	{ virtual: true }
);
jest.mock( '@wordpress/editor', () => ( { store: 'core/editor' } ), {
	virtual: true,
} );
jest.mock( '../../../src/lock-unlock', () => ( {
	unlock: () => ( {} ),
} ) );

const item = ( overrides = {} ) => ( {
	id: 'i1',
	unitId: 'u1',
	isLocal: false,
	actorId: 'a1',
	reason: 'frame-conflict',
	intentType: 'proposal',
	summary: 'lost words',
	...overrides,
} );

describe( 'BlockCardBody', () => {
	afterEach( () => {
		delete window._wpCollaborationCanUnfilteredHtml;
	} );

	it( 'renders ONE merged task with the two verbs and no count chip', () => {
		render(
			<BlockCardBody
				groups={ [
					[ item() ],
					[ item( { id: 'i2', unitId: 'u2', summary: 'more' } ) ],
				] }
				onResolve={ () => {} }
			/>
		);
		// One card: one Adopt, one Reject — never per-group verb pairs.
		expect(
			screen.getAllByRole( 'button', { name: 'Adopt' } )
		).toHaveLength( 1 );
		expect(
			screen.getAllByRole( 'button', { name: 'Reject' } )
		).toHaveLength( 1 );
		// The merged summary carries both groups' content; no numeric badge.
		expect( screen.getByText( /lost words more/ ) ).toBeVisible();
		expect( screen.queryByText( '2' ) ).not.toBeInTheDocument();
	} );

	it( 'Adopt resolves every item on the block as restored', async () => {
		const user = userEvent.setup();
		const onResolve = jest.fn();
		const items = [ item(), item( { id: 'i2', unitId: 'u2' } ) ];
		render(
			<BlockCardBody
				groups={ [ [ items[ 0 ] ], [ items[ 1 ] ] ] }
				onResolve={ onResolve }
			/>
		);
		await user.click( screen.getByRole( 'button', { name: 'Adopt' } ) );
		expect( onResolve ).toHaveBeenCalledWith( items, 'restored' );
	} );

	it( 'Reject resolves every item on the block as dismissed', async () => {
		const user = userEvent.setup();
		const onResolve = jest.fn();
		const items = [ item(), item( { id: 'i2', unitId: 'u2' } ) ];
		render(
			<BlockCardBody
				groups={ [ [ items[ 0 ] ], [ items[ 1 ] ] ] }
				onResolve={ onResolve }
			/>
		);
		await user.click( screen.getByRole( 'button', { name: 'Reject' } ) );
		expect( onResolve ).toHaveBeenCalledWith( items, 'dismissed' );
	} );

	it( 'attributes local pending edits as yours', () => {
		render(
			<BlockCardBody
				groups={ [ [ item( { isLocal: true } ) ] ] }
				onResolve={ () => {} }
			/>
		);
		expect(
			screen.getByText( /Your edit on this block is pending/ )
		).toBeVisible();
	} );

	it( 'reserves Adopt for unfiltered_html holders when any item requires approval', () => {
		window._wpCollaborationCanUnfilteredHtml = false;
		render(
			<BlockCardBody
				groups={ [
					[ item() ],
					[
						item( {
							id: 'i2',
							unitId: 'u2',
							reason: 'requires-approval',
						} ),
					],
				] }
				onResolve={ () => {} }
			/>
		);
		expect(
			screen.queryByRole( 'button', { name: 'Adopt' } )
		).not.toBeInTheDocument();
		expect(
			screen.getByText( /Only someone allowed to publish unfiltered/ )
		).toBeVisible();
		expect(
			screen.getByRole( 'button', { name: 'Reject' } )
		).toBeVisible();
	} );
} );

const insertionItem = () => ( {
	id: 'ins-1',
	unitId: 'ins-1',
	isLocal: false,
	actorId: 'a1',
	reason: 'requires-approval',
	intentType: 'insert_block',
	proposedInsertion: {
		blockType: 'core/html',
		html: '<script>alert(1)</script>',
		afterSiblingId: 'p1',
	},
} );

describe( 'InsertionCardBody', () => {
	afterEach( () => {
		delete window._wpCollaborationCanUnfilteredHtml;
	} );

	it( 'previews the proposed markup as inert text, never live DOM', () => {
		render(
			<InsertionCardBody
				item={ insertionItem() }
				onResolve={ () => {} }
			/>
		);
		// Finding the literal tag as TEXT proves it was not parsed into a
		// live element — an innerHTML'd script would not have a matching
		// text node.
		expect( screen.getByText( '<script>alert(1)</script>' ) ).toBeVisible();
	} );

	it( 'gates Approve on the unfiltered_html capability; Discard is universal', () => {
		window._wpCollaborationCanUnfilteredHtml = false;
		const { rerender } = render(
			<InsertionCardBody
				item={ insertionItem() }
				onResolve={ () => {} }
			/>
		);
		expect(
			screen.queryByRole( 'button', { name: 'Approve' } )
		).not.toBeInTheDocument();
		expect(
			screen.getByRole( 'button', { name: 'Discard' } )
		).toBeVisible();

		window._wpCollaborationCanUnfilteredHtml = true;
		rerender(
			<InsertionCardBody
				item={ insertionItem() }
				onResolve={ () => {} }
			/>
		);
		expect(
			screen.getByRole( 'button', { name: 'Approve' } )
		).toBeVisible();
	} );
} );
