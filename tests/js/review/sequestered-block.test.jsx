import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
	SequesteredBlockBody,
	sequestrationOf,
} from '../../../src/review/components/sequestered-block';
import { KSES_NEW } from './fixtures';

describe( 'SequesteredBlockBody', () => {
	it( 'shows the message and the held content as inert text, without actions, when the user cannot approve', () => {
		render(
			<SequesteredBlockBody
				sequestration={ KSES_NEW }
				canReview={ false }
				onReview={ () => {} }
			/>
		);

		expect(
			screen.getByText( 'This block requires elevated permissions.' )
		).toBeVisible();
		expect( screen.queryByRole( 'button' ) ).not.toBeInTheDocument();

		// Finding the literal tag as TEXT proves it was not parsed into a
		// live element. An innerHTML'd script would not have a matching
		// text node.
		expect(
			screen.getByText( /<script>alert\(0\);<\/script>/ )
		).toBeVisible();
	} );

	it( 'offers Review changes to a user who can approve', async () => {
		const user = userEvent.setup();
		const onReview = jest.fn();
		render(
			<SequesteredBlockBody
				sequestration={ KSES_NEW }
				canReview
				onReview={ onReview }
			/>
		);

		await user.click(
			screen.getByRole( 'button', { name: 'Review changes' } )
		);
		expect( onReview ).toHaveBeenCalled();
	} );
} );

describe( 'sequestrationOf', () => {
	const hold = ( base ) => ( {
		id: 'c1',
		kind: 'sequestration',
		authorId: 3,
		target: { type: 'blocks', ids: [ 'h1' ], index: 1, count: 1 },
		base,
		proposed: KSES_NEW.proposed,
		current: '',
	} );

	it( 'reads a hold with no base content as a new proposal', () => {
		expect( sequestrationOf( hold( '' ) ).kind ).toBe( 'new' );
		expect( sequestrationOf( hold( null ) ).kind ).toBe( 'new' );
		// An empty block is markup with no content.
		expect(
			sequestrationOf( hold( '<!-- wp:html -->\n\n<!-- /wp:html -->' ) )
				.kind
		).toBe( 'new' );
	} );

	it( 'reads a hold over existing content as an update to it', () => {
		const base = '<!-- wp:html -->\n<p>approved</p>\n<!-- /wp:html -->';
		expect( sequestrationOf( hold( base ) ) ).toEqual( {
			kind: 'update',
			original: base,
			proposed: KSES_NEW.proposed,
		} );
	} );
} );
