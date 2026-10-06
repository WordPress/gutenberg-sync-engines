/**
 * The review dialogs when the record changes while they are open: a
 * collaborator edits the content, or the author types on. The merged
 * result follows only while it is a plain copy of the version that
 * changed, and a notice says what the dialog did.
 *
 * The merged editor is replaced by a stand-in here, so "the reviewer
 * edited the merged result by hand" is one click. The real editor's side
 * of this is covered in merge-dialog.test.jsx.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
	createBlock,
	getBlockTypes,
	serialize,
	unregisterBlockType,
} from '@wordpress/blocks';
import { registerCoreBlocks } from '@wordpress/block-library';
import { MergeDialogBody } from '../../../src/review/components/merge-dialog';
import { TableMergeDialogBody } from '../../../src/review/components/table-merge-dialog';
import { PARAGRAPH_CONFLICT, TABLE_GRIDS, paragraph } from './fixtures';

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

beforeAll( () => {
	registerCoreBlocks();
} );

afterAll( () => {
	getBlockTypes().forEach( ( { name } ) => unregisterBlockType( name ) );
} );

const merged = () => screen.getByTestId( 'merged' );

// A notice also announces its text to screen readers, in a second
// element, so the queries name the visible one.
const NOTICE = { selector: '.components-notice__content' };
const UPDATED_NOTICE = /The merged result now starts from the newer version/;
const KEPT_NOTICE = /The merged result was not changed/;

describe( 'MergeDialogBody, when the record changes while it is open', () => {
	const conflict = PARAGRAPH_CONFLICT;
	const peerEdit = paragraph( 'This is my paragraph, edited by a peer.' );

	const body = ( props = {} ) => (
		<MergeDialogBody
			base={ conflict.base }
			proposed={ conflict.proposed }
			current={ conflict.current }
			onAccept={ () => {} }
			onCancel={ () => {} }
			{ ...props }
		/>
	);

	it( 'shows no notice while nothing has changed', () => {
		const { rerender } = render( body() );
		// The record is published again with the same sides.
		rerender( body() );

		expect(
			screen.queryByText( UPDATED_NOTICE, NOTICE )
		).not.toBeInTheDocument();
		expect(
			screen.queryByText( KEPT_NOTICE, NOTICE )
		).not.toBeInTheDocument();
	} );

	it( 'follows a changed current version while the merged result is still a copy of it', async () => {
		const user = userEvent.setup();
		const onAccept = jest.fn();
		const { rerender } = render( body( { onAccept } ) );
		expect( merged() ).toHaveTextContent( 'This is my paragraph.' );

		rerender( body( { onAccept, current: peerEdit } ) );

		expect( merged() ).toHaveTextContent( 'edited by a peer' );
		expect( screen.getByText( UPDATED_NOTICE, NOTICE ) ).toBeVisible();

		// Accept hands back the peer's edit, not the version the dialog
		// opened with.
		await user.click( screen.getByRole( 'button', { name: 'Accept' } ) );
		expect( onAccept.mock.calls[ 0 ][ 0 ] ).toContain( 'edited by a peer' );
	} );

	it( 'keeps a merged result the reviewer edited by hand, and says so', async () => {
		const user = userEvent.setup();
		const { rerender } = render( body() );

		await user.click(
			screen.getByRole( 'button', { name: 'Edit by hand' } )
		);
		rerender( body( { current: peerEdit } ) );

		expect( merged() ).toHaveTextContent( 'Edited by hand' );
		expect( screen.getByText( KEPT_NOTICE, NOTICE ) ).toBeVisible();
		expect(
			screen.queryByText( UPDATED_NOTICE, NOTICE )
		).not.toBeInTheDocument();
	} );

	it( 'keeps a restored proposed version when the current version changes', async () => {
		const user = userEvent.setup();
		const { rerender } = render( body() );

		const [ restoreProposed ] = screen.getAllByRole( 'button', {
			name: 'Restore this version',
		} );
		await user.click( restoreProposed );
		rerender( body( { current: peerEdit } ) );

		expect( merged() ).toHaveTextContent( 'adding something new' );
		expect( screen.getByText( KEPT_NOTICE, NOTICE ) ).toBeVisible();
	} );

	it( 'follows a restored proposed version when the author types on', async () => {
		const user = userEvent.setup();
		const { rerender } = render( body() );

		const [ restoreProposed ] = screen.getAllByRole( 'button', {
			name: 'Restore this version',
		} );
		await user.click( restoreProposed );
		rerender(
			body( {
				proposed: paragraph(
					'paragraph - adding something new, and more'
				),
			} )
		);

		expect( merged() ).toHaveTextContent( 'and more' );
		expect( screen.getByText( UPDATED_NOTICE, NOTICE ) ).toBeVisible();
	} );

	it( 'follows the current version again once the reviewer restores it', async () => {
		const user = userEvent.setup();
		const { rerender } = render( body() );

		await user.click(
			screen.getByRole( 'button', { name: 'Edit by hand' } )
		);
		const [ , restoreCurrent ] = screen.getAllByRole( 'button', {
			name: 'Restore this version',
		} );
		await user.click( restoreCurrent );
		rerender( body( { current: peerEdit } ) );

		expect( merged() ).toHaveTextContent( 'edited by a peer' );
	} );

	it( 'lets the reviewer dismiss the notice', async () => {
		const user = userEvent.setup();
		const { rerender } = render( body() );
		rerender( body( { current: peerEdit } ) );

		await user.click( screen.getByRole( 'button', { name: 'Close' } ) );

		expect(
			screen.queryByText( UPDATED_NOTICE, NOTICE )
		).not.toBeInTheDocument();
	} );
} );

describe( 'TableMergeDialogBody, when the record changes while it is open', () => {
	// A peer changes one more cell of the current version.
	const peerEdit = {
		...TABLE_GRIDS.current,
		rows: TABLE_GRIDS.current.rows.map( ( row ) => {
			if ( 'Support' !== row[ 0 ] ) {
				return row;
			}

			return [ ...row.slice( 0, -1 ), 'Phone' ];
		} ),
	};

	const body = ( props = {} ) => (
		<TableMergeDialogBody
			{ ...TABLE_GRIDS }
			onAccept={ () => {} }
			onCancel={ () => {} }
			{ ...props }
		/>
	);

	it( 'builds the suggested merge again from a changed current version', () => {
		const { rerender } = render( body() );
		expect( merged() ).not.toHaveTextContent( 'Phone' );

		rerender( body( { current: peerEdit } ) );

		expect( merged() ).toHaveTextContent( 'Phone' );
		expect( screen.getByText( UPDATED_NOTICE, NOTICE ) ).toBeVisible();
	} );

	it( 'keeps a merged table the reviewer edited by hand, and says so', async () => {
		const user = userEvent.setup();
		const { rerender } = render( body() );

		await user.click(
			screen.getByRole( 'button', { name: 'Edit by hand' } )
		);
		rerender( body( { current: peerEdit } ) );

		expect( merged() ).toHaveTextContent( 'Edited by hand' );
		expect( merged() ).not.toHaveTextContent( 'Phone' );
		expect( screen.getByText( KEPT_NOTICE, NOTICE ) ).toBeVisible();
	} );

	it( 'keeps a restored proposed version when the current version changes', async () => {
		const user = userEvent.setup();
		const { rerender } = render( body() );

		const [ restoreYours ] = screen.getAllByRole( 'button', {
			name: 'Restore this version',
		} );
		await user.click( restoreYours );
		const restored = merged().textContent;
		rerender( body( { current: peerEdit } ) );

		expect( merged().textContent ).toBe( restored );
		expect( screen.getByText( KEPT_NOTICE, NOTICE ) ).toBeVisible();
	} );
} );

// The stand-in writes blocks out with the real serializer.
describe( 'the merged editor stand-in', () => {
	it( 'writes a block out as markup', () => {
		expect(
			serialize( [ createBlock( 'core/paragraph', { content: 'x' } ) ] )
		).toContain( '<p>x</p>' );
	} );
} );
