/**
 * The review dialogs when a DIFFERENT record takes the block while one is
 * open: the first record closed (dismissed by a peer, or replaced by the
 * author's next set-aside typing) and a second one opened on the same
 * block in the same update. The dialog starts over for the new record,
 * so the merged result the reviewer built for the old one cannot land
 * on the new one.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRegistry, RegistryProvider } from '@wordpress/data';
import CollaborationMergeDialog from '../../../src/review/components/merge-dialog';
import KsesReviewDialog from '../../../src/review/components/kses-review-dialog';
import { KSES_UPDATE, PARAGRAPH_CONFLICT, paragraph } from './fixtures';

jest.mock( '../../../src/review/components/merged-result-editor', () => ( {
	__esModule: true,
	default: ( { blocks, onChange } ) => {
		const { createBlock: create, serialize: write } =
			jest.requireActual( '@wordpress/blocks' );

		return (
			<div>
				<pre data-testid="merged">{ write( blocks ) }</pre>
				<button
					onClick={ () =>
						onChange( [
							create( 'core/paragraph', {
								content: 'Edited by hand',
							} ),
						] )
					}
				>
					Edit by hand
				</button>
			</div>
		);
	},
} ) );

// The diff panes draw with the block editor, which the child registry
// below does not carry. The merged result is what this test reads.
jest.mock( '../../../src/review/components/block-diff-pane', () => ( {
	__esModule: true,
	default: ( { content } ) => <pre data-testid="pane">{ content }</pre>,
	BlockDiffResources: () => null,
} ) );

import { withCoreBlocks } from './core-blocks';

withCoreBlocks();

// The dialog reads the current user to label the proposed pane. A child
// registry answers that from a stub and leaves every other store to the
// default registry.
const registry = createRegistry(
	{},
	jest.requireActual( '@wordpress/data' ).default
);
registry.registerStore( 'core', {
	reducer: ( state = {} ) => state,
	selectors: { getCurrentUser: () => ( { id: 1 } ) },
} );

const inRegistry = ( element ) => (
	<RegistryProvider value={ registry }>{ element }</RegistryProvider>
);

describe( 'a review dialog when another record takes the block', () => {
	it( 'starts the merge dialog over for the new record', async () => {
		const user = userEvent.setup();
		const dialog = ( conflict ) =>
			inRegistry(
				<CollaborationMergeDialog
					conflict={ conflict }
					isSection={ false }
					onDecide={ () => {} }
					onClose={ () => {} }
				/>
			);
		const { rerender } = render( dialog( PARAGRAPH_CONFLICT ) );

		await user.click(
			screen.getByRole( 'button', { name: 'Edit by hand' } )
		);
		expect( screen.getByTestId( 'merged' ) ).toHaveTextContent(
			'Edited by hand'
		);

		// The same block, a different record.
		const next = {
			...PARAGRAPH_CONFLICT,
			id: 'c2',
			proposed: paragraph( 'A second proposal.' ),
			current: paragraph( 'The block as it reads now.' ),
		};
		rerender( dialog( next ) );

		expect( screen.getByTestId( 'merged' ) ).toHaveTextContent(
			'The block as it reads now.'
		);
		expect( screen.getByTestId( 'merged' ) ).not.toHaveTextContent(
			'Edited by hand'
		);
	} );

	it( 'starts the held-block dialog over for the new hold', async () => {
		const user = userEvent.setup();
		const dialog = ( recordId, sequestration ) =>
			inRegistry(
				<KsesReviewDialog
					recordId={ recordId }
					sequestration={ sequestration }
					onApprove={ () => {} }
					onRemove={ () => {} }
					onClose={ () => {} }
				/>
			);
		const { rerender } = render( dialog( 'k1', KSES_UPDATE ) );

		await user.click( screen.getByRole( 'button', { name: 'Edit' } ) );
		const editor = screen.getByRole( 'textbox', {
			name: 'Proposed block HTML',
		} );
		await user.clear( editor );
		await user.type( editor, '<p>edited by the reviewer</p>' );
		expect( editor ).toHaveValue( '<p>edited by the reviewer</p>' );

		// The same block, a newer hold.
		const next = {
			...KSES_UPDATE,
			proposed:
				'<!-- wp:html -->\n<b>a newer hold</b>\n<!-- /wp:html -->',
		};
		rerender( dialog( 'k2', next ) );

		// The dialog is back at its first view, showing the new hold.
		expect(
			screen.queryByRole( 'textbox', { name: 'Proposed block HTML' } )
		).not.toBeInTheDocument();
		await user.click( screen.getByRole( 'button', { name: 'Edit' } ) );
		expect(
			screen.getByRole( 'textbox', { name: 'Proposed block HTML' } )
		).toHaveValue( next.proposed );
	} );
} );
