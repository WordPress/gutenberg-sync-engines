import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
	ConflictBlockBody,
	plainText,
} from '../../../src/review/components/conflict-block';
import '../../../src/review/register-views';
import {
	PARAGRAPH_CONFLICT,
	SECTION_CONFLICT,
	TABLE_CONFLICT,
} from './fixtures';

// The table preview parses the record's sides into table blocks, so the
// block types must be registered.
import { withCoreBlocks } from './core-blocks';

withCoreBlocks();

describe( 'ConflictBlockBody', () => {
	it( 'shows the review action above a preview of the conflict', () => {
		render(
			<ConflictBlockBody
				conflict={ PARAGRAPH_CONFLICT }
				blockName="core/paragraph"
				onReview={ () => {} }
			/>
		);

		expect(
			screen.getByText( 'This block has conflicting edits.' )
		).toBeVisible();
		expect(
			screen.getByRole( 'button', { name: 'Review conflict' } )
		).toBeVisible();

		// The preview shows the record's two versions with add/remove
		// highlighting: the proposed version's text marked as added, the
		// current version's as removed.
		expect( screen.getByText( /adding something new/ ) ).toBeVisible();
		expect( screen.getByText( /This is my/ ) ).toBeVisible();
		expect( screen.getAllByRole( 'insertion' ) ).not.toHaveLength( 0 );
		expect( screen.getAllByRole( 'deletion' ) ).not.toHaveLength( 0 );
	} );

	it( 'shows a table message and the registered table preview for a conflicted table', () => {
		render(
			<ConflictBlockBody
				conflict={ TABLE_CONFLICT }
				blockName="core/table"
				onReview={ () => {} }
			/>
		);

		expect(
			screen.getByText( 'This table has conflicting edits.' )
		).toBeVisible();
		expect(
			screen.getByRole( 'button', { name: 'Review conflict' } )
		).toBeVisible();

		// The preview is the compact union view of the record's grids:
		// both sides' structural additions highlighted as added, and the
		// contested cell holding the current version's value, marked
		// contested.
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

	it( 'shows a section message and preview for a record covering a section', () => {
		render(
			<ConflictBlockBody
				conflict={ SECTION_CONFLICT }
				blockName="core/group"
				isSection
				onReview={ () => {} }
			/>
		);

		expect(
			screen.getByText( 'This section has conflicting edits.' )
		).toBeVisible();

		// The preview is the word diff of the whole section's text between
		// the two versions: the split's sign-up call reads as added, the
		// current version's date edit as removed.
		expect( screen.getByText( /Sign up now/ ) ).toBeVisible();
		expect( screen.getAllByRole( 'insertion' ) ).not.toHaveLength( 0 );
		expect( screen.getAllByRole( 'deletion' ) ).not.toHaveLength( 0 );
	} );

	it( 'presents a table inside a section as the section', () => {
		render(
			<ConflictBlockBody
				conflict={ SECTION_CONFLICT }
				blockName="core/table"
				isSection
				onReview={ () => {} }
			/>
		);

		expect(
			screen.getByText( 'This section has conflicting edits.' )
		).toBeVisible();
	} );

	it( 'Review conflict opens the review flow', async () => {
		const user = userEvent.setup();
		const onReview = jest.fn();
		render(
			<ConflictBlockBody
				conflict={ PARAGRAPH_CONFLICT }
				blockName="core/paragraph"
				onReview={ onReview }
			/>
		);

		await user.click(
			screen.getByRole( 'button', { name: 'Review conflict' } )
		);
		expect( onReview ).toHaveBeenCalled();
	} );
} );

describe( 'plainText', () => {
	it( 'strips block delimiters and tags and collapses whitespace', () => {
		expect( plainText( SECTION_CONFLICT.current ) ).toBe(
			'Release notes The new dashboard brings every project into one shared view. Early access opens in April.'
		);
		expect( plainText( null ) ).toBe( '' );
	} );
} );
