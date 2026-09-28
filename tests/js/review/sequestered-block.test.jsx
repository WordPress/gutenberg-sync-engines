import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SequesteredBlockBody } from '../../../src/review/components/sequestered-block';
import { MOCK_KSES_NEW } from '../../../src/review/components/mock-kses';

describe( 'SequesteredBlockBody', () => {
	it( 'shows the message and the held content as inert text, without actions, when the user cannot approve', () => {
		render(
			<SequesteredBlockBody
				sequestration={ MOCK_KSES_NEW }
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
				sequestration={ MOCK_KSES_NEW }
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
