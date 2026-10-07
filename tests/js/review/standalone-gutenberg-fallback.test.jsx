import { describe, expect, it, jest } from '@jest/globals';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as revisionsDiff from '../../../src/review/revisions-diff';
import { MergeDialogBody } from '../../../src/review/components/merge-dialog';
import { KsesReviewDialogBody } from '../../../src/review/components/kses-review-dialog';
import {
	KSES_NEW,
	KSES_UPDATE,
	PARAGRAPH_CONFLICT,
	SECTION_CONFLICT,
} from './fixtures';

// A standalone Gutenberg wins over the bundled one, and its editor package
// does not export the revision comparison the dialogs are built on. Stand
// in for that editor: private APIs that hold other names, but none of the
// ones the review UI reads. The object is locked the way the real package
// locks its own, so the plugin's unlock succeeds and finds the names
// missing, exactly as it does on such a site.
jest.mock( '@wordpress/editor', () => {
	const {
		__dangerousOptInToUnstableAPIsOnlyForCoreModules: optIn,
	} = require( '@wordpress/private-apis' );
	const { lock } = optIn(
		'I acknowledge private features are not for use in themes or plugins and doing so will break in the next version of WordPress.',
		'@wordpress/editor'
	);
	const privateApis = {};
	lock( privateApis, { SomethingElse: () => null } );

	return { privateApis };
} );

const noop = () => {};

// The merged result is a real block editor, so the block types must be
// registered.
import { withCoreBlocks } from './core-blocks';

withCoreBlocks();

const texts = ( role ) =>
	screen.getAllByRole( role ).map( ( node ) => node.textContent );

const panes = () =>
	Array.from( document.querySelectorAll( '.gse-review-block-diff' ) );

describe( 'review dialogs on an editor without the revision comparison', () => {
	it( 'reports both comparisons as missing', () => {
		expect( revisionsDiff.hasBlockDiff ).toBe( false );
		expect( revisionsDiff.hasCodeDiff ).toBe( false );
	} );

	describe( 'merge dialog', () => {
		const renderBody = ( conflict, props = {} ) =>
			render(
				<MergeDialogBody
					base={ conflict.base }
					proposed={ conflict.proposed }
					current={ conflict.current }
					onAccept={ noop }
					onCancel={ noop }
					{ ...props }
				/>
			);

		it( 'shows each version as text, with its own changes over the base marked', async () => {
			renderBody( PARAGRAPH_CONFLICT );
			// Let the merged editor's toolbar settle its state updates.
			await act( async () => {} );

			const [ proposedPane, currentPane ] = panes();
			expect( proposedPane ).toHaveTextContent(
				'paragraph - adding something new'
			);
			expect( currentPane ).toHaveTextContent( 'This is my paragraph.' );

			// The panes hold text only: no block is rendered in them.
			expect(
				proposedPane.querySelector( '.block-editor-block-list__layout' )
			).toBeNull();

			expect( texts( 'insertion' ).join( '|' ) ).toContain(
				'adding something new'
			);
			expect( texts( 'insertion' ).join( '|' ) ).toContain(
				'This is my'
			);
		} );

		it( 'keeps one line per block for a section', async () => {
			renderBody( SECTION_CONFLICT );
			await act( async () => {} );

			// This version's own text is everything but the removed words.
			const [ proposedPane ] = panes();
			const shown = proposedPane.querySelector( 'pre' ).cloneNode( true );
			shown
				.querySelectorAll( 'del' )
				.forEach( ( node ) => node.remove() );
			expect( shown.textContent.split( '\n' ) ).toEqual( [
				'Release notes',
				'The new dashboard brings every project into one shared view.',
				'Early access opens in May. Sign up now.',
			] );
			// The date the proposed version replaced reads as removed.
			expect( texts( 'deletion' ).join( '|' ) ).toContain( 'March' );
		} );

		it( 'still restores a version into the merged result and accepts it', async () => {
			const user = userEvent.setup();
			const onAccept = jest.fn();
			renderBody( PARAGRAPH_CONFLICT, { onAccept } );

			const [ restoreProposed ] = screen.getAllByRole( 'button', {
				name: 'Restore this version',
			} );
			await user.click( restoreProposed );
			await user.click(
				screen.getByRole( 'button', { name: 'Accept' } )
			);

			expect( onAccept ).toHaveBeenCalledTimes( 1 );
			expect( onAccept.mock.calls[ 0 ][ 0 ] ).toContain(
				'paragraph - adding something new'
			);
		} );
	} );

	describe( 'security dialog', () => {
		it( 'shows a new block as text with every line added', () => {
			render(
				<KsesReviewDialogBody
					sequestration={ KSES_NEW }
					onApprove={ noop }
					onRemove={ noop }
				/>
			);

			// The markup is text inside the comparison, never live DOM.
			expect( document.querySelector( 'script' ) ).toBeNull();
			expect( texts( 'insertion' ).join( '' ) ).toBe(
				KSES_NEW.proposed + '\n'
			);
			expect( screen.queryAllByRole( 'deletion' ) ).toHaveLength( 0 );
		} );

		it( 'shows an update as the lines removed and added', () => {
			render(
				<KsesReviewDialogBody
					sequestration={ KSES_UPDATE }
					onApprove={ noop }
					onRemove={ noop }
				/>
			);

			expect( texts( 'deletion' ).join( '' ) ).toContain( 'alert(0);' );
			expect( texts( 'deletion' ).join( '' ) ).not.toContain(
				"alert('changed');"
			);
			expect( texts( 'insertion' ).join( '' ) ).toContain(
				"alert('changed');"
			);
		} );

		it( 'still edits and approves the markup', async () => {
			const user = userEvent.setup();
			const onApprove = jest.fn();
			render(
				<KsesReviewDialogBody
					sequestration={ KSES_UPDATE }
					onApprove={ onApprove }
					onRemove={ noop }
				/>
			);

			await user.click( screen.getByRole( 'button', { name: 'Edit' } ) );
			const textarea = screen.getByRole( 'textbox', {
				name: 'Proposed block HTML',
			} );
			await user.clear( textarea );
			await user.type( textarea, '<p>safe</p>' );

			// The comparison follows the edit.
			expect( texts( 'insertion' ).join( '' ) ).toContain(
				'<p>safe</p>'
			);

			await user.click(
				screen.getByRole( 'button', { name: 'Approve' } )
			);
			expect( onApprove ).toHaveBeenCalledWith( '<p>safe</p>' );
		} );
	} );
} );
