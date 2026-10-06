import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { applyFilters } from '@wordpress/hooks';
import { ReviewSurface } from '../../../src/review/components/review-surface';
import { PARAGRAPH_CONFLICT } from './fixtures';

// Every block reads as conflicted and as held, so the filters' only way
// out is the review surface.
jest.mock( '../../../src/review/components/conflict-block', () => ( {
	__esModule: true,
	default: () => <p>conflict card</p>,
} ) );
jest.mock( '../../../src/review/components/sequestered-block', () => ( {
	__esModule: true,
	default: () => <p>held card</p>,
} ) );
// Only the hook the filter reads; the real module would load the
// editor packages and their own BlockEdit filters.
jest.mock( '../../../src/review/components/review-data', () => ( {
	__esModule: true,
	useBlockConflictsOfKind: ( clientId, kind ) =>
		'merge' === kind
			? [ jest.requireActual( './fixtures' ).PARAGRAPH_CONFLICT ]
			: [],
} ) );

// eslint-disable-next-line import/first -- After the mocks.
import '../../../src/review/hooks/review-cards';

const BlockEdit = () => <p>block content</p>;

describe( 'the review card filters', () => {
	it( 'replace a conflicted block with its card in the document', () => {
		const Filtered = applyFilters( 'editor.BlockEdit', BlockEdit );
		render( <Filtered clientId="c1" name="core/paragraph" /> );

		expect( screen.getByText( 'conflict card' ) ).toBeVisible();
		expect( screen.queryByText( 'block content' ) ).not.toBeInTheDocument();
	} );

	it( 'stand down inside a review dialog, whose editors show the sides', () => {
		// The record's sides carry the conflicted blocks' own ids, so the
		// dialog's editors hold blocks the filters would match.
		expect( PARAGRAPH_CONFLICT.target.ids ).toHaveLength( 1 );
		const Filtered = applyFilters( 'editor.BlockEdit', BlockEdit );
		render(
			<ReviewSurface>
				<Filtered clientId="c1" name="core/paragraph" />
			</ReviewSurface>
		);

		expect( screen.getByText( 'block content' ) ).toBeVisible();
		expect( screen.queryByText( 'conflict card' ) ).not.toBeInTheDocument();
	} );
} );
