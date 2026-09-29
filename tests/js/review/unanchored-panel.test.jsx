import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
	isAnchored,
	UnanchoredConflictsBody,
} from '../../../src/review/components/unanchored-panel';

const TITLE_CONFLICT = {
	id: 'c-title',
	kind: 'merge',
	authorId: 7,
	target: { type: 'property', name: 'title' },
	base: 'Contested',
	proposed: 'Title B',
	current: 'Title A',
};

const HELD_INSERTION = {
	id: 'c-insert',
	kind: 'sequestration',
	authorId: 3,
	target: { type: 'blocks', index: 1, count: 0 },
	base: '',
	proposed: '<!-- wp:html -->\n<script>alert(0);</script>\n<!-- /wp:html -->',
	current: '',
};

describe( 'UnanchoredConflictsBody', () => {
	it( 'lists a property conflict with both values and both decisions', async () => {
		const user = userEvent.setup();
		const onDecide = jest.fn();
		render(
			<UnanchoredConflictsBody
				conflicts={ [ TITLE_CONFLICT ] }
				canApprove
				onDecide={ onDecide }
			/>
		);

		expect(
			screen.getByText( 'A change to the title was set aside.' )
		).toBeVisible();
		expect( screen.getByText( 'Title B' ) ).toBeVisible();
		expect( screen.getByText( 'Title A' ) ).toBeVisible();

		await user.click(
			screen.getByRole( 'button', { name: 'Use proposed' } )
		);
		expect( onDecide ).toHaveBeenLastCalledWith( 'c-title', {
			action: 'accept',
			content: 'Title B',
		} );

		await user.click(
			screen.getByRole( 'button', { name: 'Keep current' } )
		);
		expect( onDecide ).toHaveBeenLastCalledWith( 'c-title', {
			action: 'dismiss',
		} );
	} );

	it( 'shows a held block as inert text and hands back its markup on approval', async () => {
		const user = userEvent.setup();
		const onDecide = jest.fn();
		render(
			<UnanchoredConflictsBody
				conflicts={ [ HELD_INSERTION ] }
				canApprove
				onDecide={ onDecide }
			/>
		);

		expect(
			screen.getByText( 'A proposed block needs approval.' )
		).toBeVisible();
		// Text, never a live element.
		expect( screen.getByText( /alert\(0\);/ ) ).toBeVisible();
		expect( document.querySelector( 'script' ) ).toBeNull();

		await user.click(
			screen.getByRole( 'button', { name: 'Use proposed' } )
		);
		expect( onDecide ).toHaveBeenCalledWith( 'c-insert', {
			action: 'accept',
			content: HELD_INSERTION.proposed,
		} );
	} );

	it( 'reserves approval of held content for users who may give it', () => {
		render(
			<UnanchoredConflictsBody
				conflicts={ [ HELD_INSERTION ] }
				canApprove={ false }
				onDecide={ () => {} }
			/>
		);

		expect(
			screen.queryByRole( 'button', { name: 'Use proposed' } )
		).not.toBeInTheDocument();
		expect(
			screen.getByRole( 'button', { name: 'Keep current' } )
		).toBeVisible();
		expect(
			screen.getByText( /Only someone allowed to publish unfiltered/ )
		).toBeVisible();
	} );
} );

describe( 'isAnchored', () => {
	const select = () => ( {
		getBlockAttributes: ( clientId ) =>
			( {
				c1: { metadata: { syncId: 's1' } },
				c2: { metadata: { syncId: 's2' } },
				c3: {},
			} )[ clientId ],
		getBlockOrder: ( clientId ) => {
			if ( 'c2' === clientId ) {
				return [ 'c3' ];
			}
			return [ 'c1', 'c2' ];
		},
		getClientIdsWithDescendants: () => [ 'c1', 'c2', 'c3' ],
	} );
	const blocks = ( target ) => ( {
		id: 'c',
		kind: 'merge',
		target: { type: 'blocks', ...target },
	} );

	it( 'is false for a property and for a proposed insertion', () => {
		expect( isAnchored( select, TITLE_CONFLICT ) ).toBe( false );
		expect( isAnchored( select, HELD_INSERTION ) ).toBe( false );
	} );

	it( 'finds a block by its durable id or its client id', () => {
		expect(
			isAnchored(
				select,
				blocks( { ids: [ 's2' ], index: 1, count: 1 } )
			)
		).toBe( true );
		expect(
			isAnchored(
				select,
				blocks( { ids: [ 'c3' ], index: 0, count: 1 } )
			)
		).toBe( true );
		expect(
			isAnchored(
				select,
				blocks( { ids: [ 'gone' ], index: 0, count: 1 } )
			)
		).toBe( false );
	} );

	it( 'finds a block by its position', () => {
		expect( isAnchored( select, blocks( { index: 1, count: 1 } ) ) ).toBe(
			true
		);
		expect( isAnchored( select, blocks( { index: 2, count: 1 } ) ) ).toBe(
			false
		);
		expect(
			isAnchored(
				select,
				blocks( { parentId: 's2', index: 0, count: 1 } )
			)
		).toBe( true );
	} );
} );
