import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getBlockTypes, unregisterBlockType } from '@wordpress/blocks';
import { registerCoreBlocks } from '@wordpress/block-library';
import { SectionMergeDialogBody } from '../../../src/review/components/section-merge-dialog';
import { MOCK_SECTION_CONFLICT } from '../../../src/review/components/mock-section-conflict';

// The demo scenario itself: a heading plus one two-sentence paragraph as
// the base; your version split the paragraph, moved the date to May, and
// extended the new second half, while the current version changed the
// same date to April in place.
const props = MOCK_SECTION_CONFLICT;

// The panes and the merged result render real blocks, so the block types
// must be registered.
beforeAll( () => {
	registerCoreBlocks();
} );

afterAll( () => {
	getBlockTypes().forEach( ( { name } ) => unregisterBlockType( name ) );
} );

// The pane blocks read by their diff status ("Modified block: Paragraph",
// "Added block: Paragraph"); plain labels are the merged editor's.
const mergedParagraphs = () =>
	screen.getAllByRole( 'document', { name: 'Block: Paragraph' } );

describe( 'SectionMergeDialogBody', () => {
	it( 'renders the split as a modified plus an added paragraph, and the edit as a modified paragraph', async () => {
		render(
			<SectionMergeDialogBody
				{ ...props }
				onAccept={ () => {} }
				onCancel={ () => {} }
			/>
		);
		// Let the merged editor's toolbar settle its state updates.
		await act( async () => {} );

		expect( screen.getByText( 'Your version' ) ).toBeVisible();
		expect( screen.getByText( 'Current version' ) ).toBeVisible();
		expect(
			screen.getAllByRole( 'button', { name: 'Restore this version' } )
		).toHaveLength( 2 );

		// The unchanged heading reads as a plain block in both panes (and
		// a third time in the merged editor, seeded from the current
		// version).
		expect(
			screen.getAllByRole( 'document', { name: 'Block: Heading 2' } )
		).toHaveLength( 3 );

		// One modified paragraph per pane: your version's first split
		// half (its second sentence moved away), the current version's
		// edited paragraph.
		expect(
			screen.getAllByRole( 'document', {
				name: 'Modified block: Paragraph',
			} )
		).toHaveLength( 2 );

		// The split's new second half is an ADDED block in your pane, and
		// nothing reads as a removed block: the differ pairs the base
		// paragraph with the longer split half instead of dropping it.
		expect(
			screen.getByRole( 'document', { name: 'Added block: Paragraph' } )
		).toHaveTextContent( 'Early access opens in May. Sign up now.' );
		expect(
			screen.queryAllByRole( 'document', {
				name: 'Removed block: Paragraph',
			} )
		).toHaveLength( 0 );
	} );

	it( 'highlights each version against the shared base at the text grain', async () => {
		render(
			<SectionMergeDialogBody
				{ ...props }
				onAccept={ () => {} }
				onCancel={ () => {} }
			/>
		);
		// Let the merged editor's toolbar settle its state updates.
		await act( async () => {} );

		// Your pane marks the moved second sentence as removed from the
		// first half; the current pane marks the March-to-April edit.
		const deletions = screen
			.getAllByRole( 'deletion' )
			.map( ( node ) => node.textContent );
		expect( deletions ).toEqual(
			expect.arrayContaining( [
				expect.stringContaining( 'Early access opens in March.' ),
				expect.stringContaining( 'March' ),
			] )
		);

		// The only inline insertion is the current pane's "April": an
		// added BLOCK carries no inline marks.
		expect(
			screen.getAllByRole( 'insertion' ).map( ( n ) => n.textContent )
		).toEqual( [ expect.stringContaining( 'April' ) ] );
	} );

	it( 'seeds the merged result from the current version and restores whole versions', async () => {
		const user = userEvent.setup();
		render(
			<SectionMergeDialogBody
				{ ...props }
				onAccept={ () => {} }
				onCancel={ () => {} }
			/>
		);

		// Seeded from the current version: one paragraph, April edit in.
		expect( mergedParagraphs() ).toHaveLength( 1 );
		expect( mergedParagraphs()[ 0 ] ).toHaveTextContent(
			'Early access opens in April.'
		);

		// Your version is the left pane, the current version the right.
		const [ restoreYours, restoreCurrent ] = screen.getAllByRole(
			'button',
			{ name: 'Restore this version' }
		);

		// Restoring your version brings the split structure in whole.
		await user.click( restoreYours );
		expect( mergedParagraphs() ).toHaveLength( 2 );
		expect( mergedParagraphs()[ 1 ] ).toHaveTextContent(
			'Early access opens in May. Sign up now.'
		);

		await user.click( restoreCurrent );
		expect( mergedParagraphs() ).toHaveLength( 1 );
		expect( mergedParagraphs()[ 0 ] ).toHaveTextContent(
			'Early access opens in April.'
		);
	} );

	it( 'Accept hands back the merged result as serialized blocks', async () => {
		const user = userEvent.setup();
		const onAccept = jest.fn();
		render(
			<SectionMergeDialogBody
				{ ...props }
				onAccept={ onAccept }
				onCancel={ () => {} }
			/>
		);

		const [ restoreYours ] = screen.getAllByRole( 'button', {
			name: 'Restore this version',
		} );
		await user.click( restoreYours );
		await user.click( screen.getByRole( 'button', { name: 'Accept' } ) );

		expect( onAccept ).toHaveBeenCalledTimes( 1 );
		const mergedContent = onAccept.mock.calls[ 0 ][ 0 ];
		expect( mergedContent ).toContain( 'wp:heading' );
		// The split structure survives serialization: the first sentence
		// ends its own paragraph, and the extended second half follows.
		expect( mergedContent ).toContain( 'shared view.</p>' );
		expect( mergedContent ).toContain(
			'Early access opens in May. Sign up now.'
		);
	} );

	it( 'Cancel closes without accepting', async () => {
		const user = userEvent.setup();
		const onAccept = jest.fn();
		const onCancel = jest.fn();
		render(
			<SectionMergeDialogBody
				{ ...props }
				onAccept={ onAccept }
				onCancel={ onCancel }
			/>
		);

		await user.click( screen.getByRole( 'button', { name: 'Cancel' } ) );
		expect( onCancel ).toHaveBeenCalled();
		expect( onAccept ).not.toHaveBeenCalled();
	} );
} );
