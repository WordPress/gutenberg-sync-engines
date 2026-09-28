import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConflictBlockBody } from '../../../src/review/components/conflict-block';

describe( 'ConflictBlockBody', () => {
	it( 'shows the review action above a preview of the conflict', () => {
		render( <ConflictBlockBody onReview={ () => {} } /> );

		expect(
			screen.getByText( 'This block has conflicting edits.' )
		).toBeVisible();
		expect(
			screen.getByRole( 'button', { name: 'Review conflict' } )
		).toBeVisible();

		// The preview shows the mock conflict's two versions with
		// add/remove highlighting: your version's text marked as added,
		// the current version's as removed.
		expect( screen.getByText( /adding something new/ ) ).toBeVisible();
		expect( screen.getByText( /This is my/ ) ).toBeVisible();
		expect( screen.getAllByRole( 'insertion' ) ).not.toHaveLength( 0 );
		expect( screen.getAllByRole( 'deletion' ) ).not.toHaveLength( 0 );
	} );

	it( 'shows a table message and a table preview for a conflicted table', () => {
		render(
			<ConflictBlockBody blockName="core/table" onReview={ () => {} } />
		);

		expect(
			screen.getByText( 'This table has conflicting edits.' )
		).toBeVisible();
		expect(
			screen.getByRole( 'button', { name: 'Review conflict' } )
		).toBeVisible();

		// The preview is the compact union view of the fabricated pricing
		// scenario: both sides' structural additions highlighted as added,
		// and the contested cell holding the current version's value,
		// marked contested.
		expect( screen.getByText( 'Team' ) ).toHaveClass(
			'gse-review-table-diff__cell--added'
		);
		expect( screen.getByText( 'API access' ) ).toHaveClass(
			'gse-review-table-diff__cell--added'
		);
		expect( screen.getByText( '$7' ) ).toHaveClass(
			'gse-review-table-diff__cell--contested'
		);
	} );

	it( 'shows a section message and preview for a conflict in a group section', () => {
		render( <ConflictBlockBody isSection onReview={ () => {} } /> );

		expect(
			screen.getByText( 'This section has conflicting edits.' )
		).toBeVisible();
		expect(
			screen.getByRole( 'button', { name: 'Review conflict' } )
		).toBeVisible();

		// The preview is the word diff of the whole mock section's text
		// between the two versions: your split's sign-up call reads as
		// added, the current version's date edit as removed.
		expect( screen.getByText( /Sign up now/ ) ).toBeVisible();
		expect( screen.getAllByRole( 'insertion' ) ).not.toHaveLength( 0 );
		expect( screen.getAllByRole( 'deletion' ) ).not.toHaveLength( 0 );
	} );

	it( 'keeps the table presentation for a conflicted table inside a section', () => {
		render(
			<ConflictBlockBody
				blockName="core/table"
				isSection
				onReview={ () => {} }
			/>
		);

		expect(
			screen.getByText( 'This table has conflicting edits.' )
		).toBeVisible();
	} );

	it( 'Review conflict opens the review flow', async () => {
		const user = userEvent.setup();
		const onReview = jest.fn();
		render( <ConflictBlockBody onReview={ onReview } /> );

		await user.click(
			screen.getByRole( 'button', { name: 'Review conflict' } )
		);
		expect( onReview ).toHaveBeenCalled();
	} );
} );
