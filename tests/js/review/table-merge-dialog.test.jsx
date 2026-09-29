import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getBlockTypes, unregisterBlockType } from '@wordpress/blocks';
import { registerCoreBlocks } from '@wordpress/block-library';
import {
	TableMergeDialogBody,
	tableGridsOf,
} from '../../../src/review/components/table-merge-dialog';
import { TABLE_CONFLICT, TABLE_GRIDS } from './fixtures';

const props = TABLE_GRIDS;

// The merged result is a real table block in the dialog's own block
// editor, so the block types must be registered.
beforeAll( () => {
	registerCoreBlocks();
} );

afterAll( () => {
	getBlockTypes().forEach( ( { name } ) => unregisterBlockType( name ) );
} );

// The last Accept payload as plain strings: the header labels and the
// body's cell contents (cell contents may be strings or rich-text
// values; both stringify).
const acceptedGrid = ( onAccept ) => {
	const { head, body } = onAccept.mock.calls.at( -1 )[ 0 ];

	return {
		head: head[ 0 ].cells.map( ( cell ) => String( cell.content ) ),
		rows: body.map( ( row ) =>
			row.cells.map( ( cell ) => String( cell.content ) )
		),
	};
};

const SUGGESTED_MERGE = {
	head: [ 'Plan', 'Free', 'Basic', 'Pro', 'Team' ],
	rows: [
		[ 'Price', '$0', '$7', '$12', '$9' ],
		[ 'Storage', '1 GB', '50 GB', '1 TB', '250 GB' ],
		[ 'Support', 'Email', 'Email', 'Priority', 'Priority' ],
		[ 'API access', 'No', 'Yes', 'Yes', '' ],
	],
};

describe( 'TableMergeDialogBody', () => {
	it( 'shows each version as a table highlighting only its own changes', async () => {
		render(
			<TableMergeDialogBody
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

		// The same cell values can appear in the other pane and in the
		// merged table, so cell assertions scope to one pane's table via
		// its accessible name.
		const yourTable = screen.getByRole( 'table', {
			name: 'Your version',
		} );
		const currentTable = screen.getByRole( 'table', {
			name: 'Current version',
		} );

		// Your pane: the added Team column and the changed Basic price.
		expect( within( yourTable ).getByText( 'Team' ) ).toHaveClass(
			'gse-review-table-diff__cell--added'
		);
		expect( within( yourTable ).getByText( '$9' ) ).toHaveClass(
			'gse-review-table-diff__cell--added'
		);
		expect( within( yourTable ).getByText( '$6' ) ).toHaveClass(
			'gse-review-table-diff__cell--changed'
		);
		expect( within( yourTable ).getByText( '$0' ) ).not.toHaveClass(
			'gse-review-table-diff__cell--changed'
		);
		expect(
			within( yourTable ).queryByText( 'API access' )
		).not.toBeInTheDocument();

		// Current pane: the added API access row and the changed price.
		expect( within( currentTable ).getByText( 'API access' ) ).toHaveClass(
			'gse-review-table-diff__cell--added'
		);
		expect( within( currentTable ).getByText( '$7' ) ).toHaveClass(
			'gse-review-table-diff__cell--changed'
		);
		expect(
			within( currentTable ).queryByText( 'Team' )
		).not.toBeInTheDocument();

		// The merged result renders as a real table block.
		expect(
			screen.getByRole( 'document', { name: 'Block: Table' } )
		).toBeVisible();
	} );

	it( 'offers no contested-cell controls: conflicts are settled by editing the merged result', async () => {
		render(
			<TableMergeDialogBody
				{ ...props }
				onAccept={ () => {} }
				onCancel={ () => {} }
			/>
		);
		// Let the merged editor's toolbar settle its state updates.
		await act( async () => {} );

		expect(
			screen.queryByText( 'Conflicting cells' )
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole( 'button', { name: 'Keep yours ($6)' } )
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole( 'button', { name: 'Keep current ($7)' } )
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole( 'button', { name: 'Restore suggested merge' } )
		).not.toBeInTheDocument();
	} );

	it( 'Accept returns the suggested merge by default', async () => {
		const user = userEvent.setup();
		const onAccept = jest.fn();
		render(
			<TableMergeDialogBody
				{ ...props }
				onAccept={ onAccept }
				onCancel={ () => {} }
			/>
		);

		await user.click( screen.getByRole( 'button', { name: 'Accept' } ) );

		expect( acceptedGrid( onAccept ) ).toEqual( SUGGESTED_MERGE );
		// The attribute shape: one th header row, td body rows.
		const { head, body } = onAccept.mock.calls.at( -1 )[ 0 ];
		expect( head[ 0 ].cells[ 0 ].tag ).toBe( 'th' );
		expect( body[ 0 ].cells[ 0 ].tag ).toBe( 'td' );
	} );

	it( 'Restore this version reseeds the merged table wholly from that side', async () => {
		const user = userEvent.setup();
		const onAccept = jest.fn();
		render(
			<TableMergeDialogBody
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
		expect( acceptedGrid( onAccept ) ).toEqual( {
			head: props.yours.head,
			rows: props.yours.rows,
		} );
	} );

	it( 'Cancel closes without accepting', async () => {
		const user = userEvent.setup();
		const onAccept = jest.fn();
		const onCancel = jest.fn();
		render(
			<TableMergeDialogBody
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

describe( 'tableGridsOf', () => {
	it( "reads the three grids out of a record's serialized sides", () => {
		expect( tableGridsOf( TABLE_CONFLICT ) ).toEqual( TABLE_GRIDS );
	} );

	it( 'stands the current version in for a missing base', () => {
		const grids = tableGridsOf( { ...TABLE_CONFLICT, base: null } );
		expect( grids.base ).toEqual( TABLE_GRIDS.current );
		expect( grids.yours ).toEqual( TABLE_GRIDS.yours );
	} );
} );
