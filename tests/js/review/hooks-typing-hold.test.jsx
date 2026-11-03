import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { applyFilters } from '@wordpress/hooks';

// A record that keeps up with typing, on a block someone is typing in:
// the hold answers whatever it is asked to consider.
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
	useBlockConflictsOfKind: ( clientId, kind ) => {
		if ( 'merge' !== kind ) {
			return [];
		}
		return [
			{
				...jest.requireActual( './fixtures' ).PARAGRAPH_CONFLICT,
				followsTyping: 'follows' === clientId,
			},
		];
	},
} ) );
jest.mock( '../../../src/review/typing-hold', () => ( {
	__esModule: true,
	useTypingHold: ( clientId, canHold ) => canHold,
} ) );

// eslint-disable-next-line import/first -- After the mocks.
import '../../../src/review/hooks/review-cards';

const BlockEdit = () => <p>block content</p>;

describe( 'the review card filters and typing', () => {
	it( 'keep the block editable while its record follows the typing', () => {
		const Filtered = applyFilters( 'editor.BlockEdit', BlockEdit );
		render( <Filtered clientId="follows" name="core/paragraph" /> );

		expect( screen.getByText( 'block content' ) ).toBeVisible();
		expect( screen.queryByText( 'conflict card' ) ).not.toBeInTheDocument();
	} );

	it( 'show the card at once when the engine does not follow the typing', () => {
		const Filtered = applyFilters( 'editor.BlockEdit', BlockEdit );
		render( <Filtered clientId="plain" name="core/paragraph" /> );

		expect( screen.getByText( 'conflict card' ) ).toBeVisible();
	} );
} );
