import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getBlockTypes, unregisterBlockType } from '@wordpress/blocks';
import { registerCoreBlocks } from '@wordpress/block-library';
import { MergeDialogBody } from '../merge-dialog';

const props = {
	baseText: 'paragraph',
	yourText: 'paragraph - adding something new',
	currentText: 'This is my paragraph.',
};

// The merged result is a real paragraph block in the dialog's own block
// editor, and the panes render each version as real blocks, so the block
// types must be registered.
beforeAll( () => {
	registerCoreBlocks();
} );

afterAll( () => {
	getBlockTypes().forEach( ( { name } ) => unregisterBlockType( name ) );
} );

// The pane paragraphs read as "Modified block: Paragraph" (the revisions
// diff labels them by status), so the plain label is the merged editor's.
const mergedParagraph = () =>
	screen.getByRole( 'document', { name: 'Block: Paragraph' } );

describe( 'MergeDialogBody', () => {
	it( 'shows both versions as diffed blocks, with the merged result seeded from the current version', async () => {
		render(
			<MergeDialogBody
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

		// Each pane renders its version as one paragraph block whose text
		// changed against the base, so both read as modified blocks.
		expect(
			screen.getAllByRole( 'document', {
				name: 'Modified block: Paragraph',
			} )
		).toHaveLength( 2 );
		expect( mergedParagraph() ).toHaveTextContent( props.currentText );
	} );

	it( 'diffs each version against the shared base, not against each other', async () => {
		render(
			<MergeDialogBody
				{ ...props }
				onAccept={ () => {} }
				onCancel={ () => {} }
			/>
		);
		// Let the merged editor's toolbar settle its state updates.
		await act( async () => {} );

		// Each pane highlights only its own additions over the base
		// ("paragraph"): " - adding something new" on your side, "This is
		// my " and "." on the current side. The highlights are the
		// revisions diff's rich-text formats, rendered as <ins> inside the
		// pane paragraphs. The diff is whitespace sensitive, so an added
		// space is part of the highlight. Nothing reads as removed.
		const additions = screen
			.getAllByRole( 'insertion' )
			.map( ( node ) => node.textContent );
		expect( additions ).toEqual(
			expect.arrayContaining( [
				expect.stringContaining( ' - adding something new' ),
				expect.stringContaining( 'This is my' ),
			] )
		);
		expect( screen.queryAllByRole( 'deletion' ) ).toHaveLength( 0 );
	} );

	it( 'Restore this version copies that version into the merged editor', async () => {
		const user = userEvent.setup();
		render(
			<MergeDialogBody
				{ ...props }
				onAccept={ () => {} }
				onCancel={ () => {} }
			/>
		);

		// Your version is the left pane, the current version the right.
		const [ restoreYours, restoreCurrent ] = screen.getAllByRole(
			'button',
			{ name: 'Restore this version' }
		);

		await user.click( restoreYours );
		expect( mergedParagraph() ).toHaveTextContent( props.yourText );

		await user.click( restoreCurrent );
		expect( mergedParagraph() ).toHaveTextContent( props.currentText );
	} );

	it( 'Accept hands back the merged result', async () => {
		const user = userEvent.setup();
		const onAccept = vi.fn();
		render(
			<MergeDialogBody
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
		expect( onAccept ).toHaveBeenCalledWith( props.yourText );
	} );

	it( 'Cancel closes without accepting', async () => {
		const user = userEvent.setup();
		const onAccept = vi.fn();
		const onCancel = vi.fn();
		render(
			<MergeDialogBody
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
