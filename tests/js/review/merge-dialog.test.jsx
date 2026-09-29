import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getBlockTypes, unregisterBlockType } from '@wordpress/blocks';
import { registerCoreBlocks } from '@wordpress/block-library';
import { MergeDialogBody } from '../../../src/review/components/merge-dialog';
import { PARAGRAPH_CONFLICT, SECTION_CONFLICT } from './fixtures';

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

const renderBody = ( conflict, props = {} ) =>
	render(
		<MergeDialogBody
			base={ conflict.base }
			proposed={ conflict.proposed }
			current={ conflict.current }
			onAccept={ () => {} }
			onCancel={ () => {} }
			{ ...props }
		/>
	);

describe( 'MergeDialogBody, one block', () => {
	const conflict = PARAGRAPH_CONFLICT;

	it( 'shows both versions as diffed blocks, with the merged result seeded from the current version', async () => {
		renderBody( conflict, { templateLock: 'all' } );
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
		expect( mergedParagraphs()[ 0 ] ).toHaveTextContent(
			'This is my paragraph.'
		);
	} );

	it( 'names the proposed pane as it is told to', async () => {
		renderBody( conflict, { proposedLabel: 'Proposed version' } );
		await act( async () => {} );
		expect( screen.getByText( 'Proposed version' ) ).toBeVisible();
		expect( screen.queryByText( 'Your version' ) ).not.toBeInTheDocument();
	} );

	it( 'diffs each version against the shared base, not against each other', async () => {
		renderBody( conflict );
		await act( async () => {} );

		// Each pane highlights only its own additions over the base
		// ("paragraph"): " - adding something new" on the proposed side,
		// "This is my " and "." on the current side. The highlights are
		// the revisions diff's rich-text formats, rendered as <ins> inside
		// the pane paragraphs. Nothing reads as removed.
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

	it( 'compares the proposed version against the current one when the base is unknown', async () => {
		renderBody( { ...conflict, base: null } );
		await act( async () => {} );

		// Only the proposed pane has changes to show.
		expect(
			screen.getAllByRole( 'document', {
				name: 'Modified block: Paragraph',
			} )
		).toHaveLength( 1 );
		// The reviewer is told why the current pane shows nothing. The
		// notice is also spoken, so the text appears twice in the page.
		expect(
			document.querySelector( '.gse-review-merge-dialog__notice' )
		).toHaveTextContent( /started from is no longer available/ );
	} );

	it( 'shows no missing-base notice when the record has a base', async () => {
		renderBody( conflict );
		await act( async () => {} );

		expect(
			document.querySelector( '.gse-review-merge-dialog__notice' )
		).toBeNull();
	} );

	it( 'Restore this version copies that version into the merged editor', async () => {
		const user = userEvent.setup();
		renderBody( conflict );

		// The proposed version is the left pane, the current the right.
		const [ restoreProposed, restoreCurrent ] = screen.getAllByRole(
			'button',
			{ name: 'Restore this version' }
		);

		await user.click( restoreProposed );
		expect( mergedParagraphs()[ 0 ] ).toHaveTextContent(
			'paragraph - adding something new'
		);

		await user.click( restoreCurrent );
		expect( mergedParagraphs()[ 0 ] ).toHaveTextContent(
			'This is my paragraph.'
		);
	} );

	it( 'Accept hands back the merged result as serialized blocks', async () => {
		const user = userEvent.setup();
		const onAccept = jest.fn();
		renderBody( conflict, { onAccept } );

		const [ restoreProposed ] = screen.getAllByRole( 'button', {
			name: 'Restore this version',
		} );
		await user.click( restoreProposed );
		await user.click( screen.getByRole( 'button', { name: 'Accept' } ) );

		expect( onAccept ).toHaveBeenCalledTimes( 1 );
		const content = onAccept.mock.calls[ 0 ][ 0 ];
		expect( content ).toContain( 'wp:paragraph' );
		expect( content ).toContain( 'paragraph - adding something new' );
	} );

	it( 'Cancel closes without accepting', async () => {
		const user = userEvent.setup();
		const onAccept = jest.fn();
		const onCancel = jest.fn();
		renderBody( conflict, { onAccept, onCancel } );

		await user.click( screen.getByRole( 'button', { name: 'Cancel' } ) );
		expect( onCancel ).toHaveBeenCalled();
		expect( onAccept ).not.toHaveBeenCalled();
	} );
} );

describe( 'MergeDialogBody, a section', () => {
	const conflict = SECTION_CONFLICT;

	it( 'renders the split as a modified plus an added paragraph, and the edit as a modified paragraph', async () => {
		renderBody( conflict );
		// Let the merged editor's toolbar settle its state updates.
		await act( async () => {} );

		// The unchanged heading reads as a plain block in both panes (and
		// a third time in the merged editor, seeded from the current
		// version).
		expect(
			screen.getAllByRole( 'document', { name: 'Block: Heading 2' } )
		).toHaveLength( 3 );

		// One modified paragraph per pane: the proposed version's first
		// split half (its second sentence moved away), the current
		// version's edited paragraph.
		expect(
			screen.getAllByRole( 'document', {
				name: 'Modified block: Paragraph',
			} )
		).toHaveLength( 2 );

		// The split's new second half is an ADDED block in the proposed
		// pane, and nothing reads as a removed block: the differ pairs the
		// base paragraph with the longer split half instead of dropping it.
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
		renderBody( conflict );
		await act( async () => {} );

		// The proposed pane marks the moved second sentence as removed
		// from the first half; the current pane marks the March-to-April
		// edit.
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
		renderBody( conflict );

		// Seeded from the current version: one paragraph, April edit in.
		expect( mergedParagraphs() ).toHaveLength( 1 );
		expect( mergedParagraphs()[ 0 ] ).toHaveTextContent(
			'Early access opens in April.'
		);

		const [ restoreProposed, restoreCurrent ] = screen.getAllByRole(
			'button',
			{ name: 'Restore this version' }
		);

		// Restoring the proposed version brings the split structure in
		// whole.
		await user.click( restoreProposed );
		expect( mergedParagraphs() ).toHaveLength( 2 );
		expect( mergedParagraphs()[ 1 ] ).toHaveTextContent(
			'Early access opens in May. Sign up now.'
		);

		await user.click( restoreCurrent );
		expect( mergedParagraphs() ).toHaveLength( 1 );
	} );

	it( 'Accept hands back the merged section as serialized blocks', async () => {
		const user = userEvent.setup();
		const onAccept = jest.fn();
		renderBody( conflict, { onAccept } );

		const [ restoreProposed ] = screen.getAllByRole( 'button', {
			name: 'Restore this version',
		} );
		await user.click( restoreProposed );
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
} );

describe( 'MergeDialogBody, a Custom HTML block inside a container', () => {
	const side = ( markup ) =>
		'<!-- wp:group {"metadata":{"syncId":"g1"}} -->\n' +
		'<div class="wp-block-group"><!-- wp:html {"metadata":{"syncId":"h1"}} -->\n' +
		markup +
		'\n<!-- /wp:html --></div>\n' +
		'<!-- /wp:group -->';
	const conflict = {
		base: side( '<b>Base markup</b>' ),
		proposed: side( '<b>Proposed markup</b>' ),
		current: side( '<b>Current markup</b>' ),
	};

	it( 'shows the nested markup in both panes and hands it back on accept', async () => {
		const user = userEvent.setup();
		const onAccept = jest.fn();
		const { container } = renderBody( conflict, { onAccept } );
		await act( async () => {} );

		const [ proposedPane, currentPane ] = container.querySelectorAll(
			'.gse-review-merge-dialog__pane-content'
		);
		expect( proposedPane ).toHaveTextContent( 'Proposed markup' );
		expect( currentPane ).toHaveTextContent( 'Current markup' );

		await user.click( screen.getByRole( 'button', { name: 'Accept' } ) );
		expect( onAccept.mock.calls[ 0 ][ 0 ] ).toContain(
			'<b>Current markup</b>'
		);
	} );
} );
