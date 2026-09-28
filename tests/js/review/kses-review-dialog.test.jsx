import { describe, expect, it, jest } from '@jest/globals';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KsesReviewDialogBody } from '../../../src/review/components/kses-review-dialog';
import {
	MOCK_KSES_NEW,
	MOCK_KSES_UPDATE,
} from '../../../src/review/components/mock-kses';

const noop = () => {};

// The held markup shows as the revisions code diff: a line-numbered table
// inside a region labelled "Code changes", every line rendered as inert
// text. Each row carries a visually hidden "Added"/"Removed" status.
const codeDiff = () => screen.getByRole( 'region', { name: 'Code changes' } );

describe( 'KsesReviewDialogBody', () => {
	describe( 'new-block proposal', () => {
		it( 'shows the proposed markup as a code diff with every line added', () => {
			render(
				<KsesReviewDialogBody
					sequestration={ MOCK_KSES_NEW }
					onApprove={ noop }
					onRemove={ noop }
				/>
			);

			expect( screen.getByText( 'Proposed block' ) ).toBeVisible();
			expect( screen.queryByText( 'Original' ) ).not.toBeInTheDocument();

			// There is no original to compare, so the whole markup reads as
			// added, line by line (the mock is three lines).
			const diff = codeDiff();
			expect(
				within( diff ).getByText( /<script>alert\(0\);<\/script>/ )
			).toBeVisible();
			expect( within( diff ).getAllByText( 'Added' ) ).toHaveLength( 3 );
			expect(
				within( diff ).queryByText( 'Removed' )
			).not.toBeInTheDocument();
		} );

		it( 'Approve hands back the proposed markup', async () => {
			const user = userEvent.setup();
			const onApprove = jest.fn();
			render(
				<KsesReviewDialogBody
					sequestration={ MOCK_KSES_NEW }
					onApprove={ onApprove }
					onRemove={ noop }
				/>
			);

			await user.click(
				screen.getByRole( 'button', { name: 'Approve' } )
			);
			expect( onApprove ).toHaveBeenCalledWith( MOCK_KSES_NEW.proposed );
		} );

		it( 'Edit opens the markup as plain text, and Approve hands back the edited markup', async () => {
			const user = userEvent.setup();
			const onApprove = jest.fn();
			render(
				<KsesReviewDialogBody
					sequestration={ MOCK_KSES_NEW }
					onApprove={ onApprove }
					onRemove={ noop }
				/>
			);

			await user.click( screen.getByRole( 'button', { name: 'Edit' } ) );

			const textarea = screen.getByRole( 'textbox', {
				name: 'Proposed block HTML',
			} );
			expect( textarea ).toHaveValue( MOCK_KSES_NEW.proposed );

			await user.clear( textarea );
			await user.type( textarea, '<p>safe</p>' );
			await user.click(
				screen.getByRole( 'button', { name: 'Approve' } )
			);
			expect( onApprove ).toHaveBeenCalledWith( '<p>safe</p>' );
		} );

		it( 'Remove block asks for the block to be removed', async () => {
			const user = userEvent.setup();
			const onRemove = jest.fn();
			render(
				<KsesReviewDialogBody
					sequestration={ MOCK_KSES_NEW }
					onApprove={ noop }
					onRemove={ onRemove }
				/>
			);

			await user.click(
				screen.getByRole( 'button', { name: 'Remove block' } )
			);
			expect( onRemove ).toHaveBeenCalled();
		} );
	} );

	describe( 'update proposal', () => {
		it( 'shows one unified line diff from the original to the proposal', () => {
			render(
				<KsesReviewDialogBody
					sequestration={ MOCK_KSES_UPDATE }
					onApprove={ noop }
					onRemove={ noop }
				/>
			);

			expect( screen.getByText( 'Proposed changes' ) ).toBeVisible();
			expect( screen.queryByText( 'Original' ) ).not.toBeInTheDocument();

			// The scenario's only change is alert(0) becoming
			// alert('changed'): the old line reads as removed, the new line
			// as added, and both appear in the one view.
			const diff = codeDiff();
			expect( within( diff ).getByText( 'alert(0);' ) ).toBeVisible();
			expect(
				within( diff ).getByText( "alert('changed');" )
			).toBeVisible();
			expect( within( diff ).getAllByText( 'Removed' ) ).toHaveLength(
				1
			);
			expect( within( diff ).getAllByText( 'Added' ) ).toHaveLength( 1 );
		} );

		it( 're-diffs live while editing', async () => {
			const user = userEvent.setup();
			render(
				<KsesReviewDialogBody
					sequestration={ MOCK_KSES_UPDATE }
					onApprove={ noop }
					onRemove={ noop }
				/>
			);

			await user.click( screen.getByRole( 'button', { name: 'Edit' } ) );

			const textarea = screen.getByRole( 'textbox', {
				name: 'Proposed block HTML',
			} );
			await user.clear( textarea );
			await user.type( textarea, '<p>safe</p>' );

			// The replacement markup reads as an added line, and every
			// original line now reads as removed.
			const diff = codeDiff();
			expect( within( diff ).getByText( '<p>safe</p>' ) ).toBeVisible();
			expect(
				within( diff ).getAllByText( 'Removed' ).length
			).toBeGreaterThan( 0 );
		} );

		it( 'Approve hands back the proposed markup', async () => {
			const user = userEvent.setup();
			const onApprove = jest.fn();
			render(
				<KsesReviewDialogBody
					sequestration={ MOCK_KSES_UPDATE }
					onApprove={ onApprove }
					onRemove={ noop }
				/>
			);

			await user.click(
				screen.getByRole( 'button', { name: 'Approve' } )
			);
			expect( onApprove ).toHaveBeenCalledWith(
				MOCK_KSES_UPDATE.proposed
			);
		} );
	} );
} );
